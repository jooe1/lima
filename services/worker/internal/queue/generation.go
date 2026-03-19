package queue

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	copilot "github.com/github/copilot-sdk/go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	"go.uber.org/zap"
)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type appRow struct {
	id           string
	dslSource    string
	nodeMetadata map[string]nodeMeta
}

type msgRow struct {
	role    string
	content string
}

type userAIProviderConfig struct {
	OpenAIBaseURL *string `json:"openai_base_url,omitempty"`
}

type userAICredentials struct {
	APIKey      string `json:"api_key,omitempty"`
	GitHubToken string `json:"github_token,omitempty"`
}

type userAISettings struct {
	Provider      string
	Model         string
	OpenAIBaseURL *string
	Credentials   userAICredentials
}

var auraBlockRe = regexp.MustCompile("(?s)```(?:aura)?\\s*\n(.*?)\\s*```")

func callOpenAI(ctx context.Context, settings userAISettings, messages []chatMessage) (string, error) {
	body, err := json.Marshal(chatRequest{
		Model:       settings.Model,
		Messages:    messages,
		Temperature: 0.2,
		MaxTokens:   4096,
	})
	if err != nil {
		return "", fmt.Errorf("marshal llm request: %w", err)
	}

	baseURL := "https://api.openai.com/v1"
	if settings.OpenAIBaseURL != nil && strings.TrimSpace(*settings.OpenAIBaseURL) != "" {
		baseURL = strings.TrimSpace(*settings.OpenAIBaseURL)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build llm request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if settings.Credentials.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+settings.Credentials.APIKey)
	}

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("llm http call: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read llm response: %w", err)
	}

	var parsed chatResponse
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return "", fmt.Errorf("unmarshal llm response: %w", err)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		if parsed.Error != nil {
			return "", fmt.Errorf("llm api error: %s", parsed.Error.Message)
		}
		return "", fmt.Errorf("llm api error: status %d", resp.StatusCode)
	}
	if parsed.Error != nil {
		return "", fmt.Errorf("llm api error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return "", errors.New("llm returned no choices")
	}
	return parsed.Choices[0].Message.Content, nil
}

func callGitHubCopilot(ctx context.Context, settings userAISettings, prompt string) (content string, err error) {
	if settings.Credentials.GitHubToken == "" {
		return "", errors.New("github_token is not configured for the selected Copilot provider")
	}

	client := copilot.NewClient(&copilot.ClientOptions{
		GitHubToken:     settings.Credentials.GitHubToken,
		UseLoggedInUser: copilot.Bool(false),
		LogLevel:        "error",
	})
	if err := client.Start(ctx); err != nil {
		return "", fmt.Errorf("start copilot sdk client: %w", err)
	}
	defer func() {
		if stopErr := client.Stop(); stopErr != nil {
			err = errors.Join(err, fmt.Errorf("stop copilot sdk client: %w", stopErr))
		}
	}()

	session, err := client.CreateSession(ctx, &copilot.SessionConfig{
		Model:               settings.Model,
		OnPermissionRequest: copilot.PermissionHandler.ApproveAll,
		AvailableTools:      []string{},
		SystemMessage: &copilot.SystemMessageConfig{
			Mode:    "replace",
			Content: systemPrompt,
		},
	})
	if err != nil {
		return "", fmt.Errorf("create copilot session: %w", err)
	}
	defer func() {
		if disconnectErr := session.Disconnect(); disconnectErr != nil {
			err = errors.Join(err, fmt.Errorf("disconnect copilot session: %w", disconnectErr))
		}
	}()

	response, err := session.SendAndWait(ctx, copilot.MessageOptions{Prompt: prompt})
	if err != nil {
		return "", fmt.Errorf("copilot sdk send: %w", err)
	}
	if response == nil || response.Data.Content == nil {
		return "", errors.New("copilot sdk returned no content")
	}
	return *response.Data.Content, nil
}

func extractDSL(content string) string {
	if match := auraBlockRe.FindStringSubmatch(content); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	if strings.Contains(content, ";") {
		return strings.TrimSpace(content)
	}
	return ""
}

func buildCopilotPrompt(currentDSL, latestUserPrompt string, history []msgRow) string {
	var builder strings.Builder
	builder.WriteString("Current app DSL:\n```aura\n")
	builder.WriteString(currentDSL)
	builder.WriteString("\n```\n\nConversation history:\n")
	for _, message := range history {
		role := titleCaseFirst(message.role)
		builder.WriteString(role)
		builder.WriteString(": ")
		builder.WriteString(message.content)
		builder.WriteString("\n")
	}
	builder.WriteString("\nLatest request:\n")
	builder.WriteString(latestUserPrompt)
	builder.WriteString("\n\nReturn the complete updated Aura DSL document.")
	return builder.String()
}

func titleCaseFirst(value string) string {
	if value == "" {
		return ""
	}
	firstRune, size := utf8.DecodeRuneInString(value)
	if size == 0 {
		return value
	}
	return string(unicode.ToTitle(firstRune)) + value[size:]
}

const systemPrompt = `You are an AI assistant that generates and modifies user interface definitions for an internal tools platform called Lima.

You produce UI definitions using the Aura DSL, a flat, statement-based syntax where every widget is a standalone declaration terminated by a semicolon.

## Aura DSL Syntax

Each widget declaration looks like:

    <element> <id> @ <parent>
      [text "<literal text>"]
      [value "{{expression}}"]
      [forEach <variable> key <keyField>]
      [key <keyField>]
      [if "{{condition}}"]
      [with <key>="<value>" ...]
      [transform "{{expression}}"]
      [style { <key>: "<value>"; ... }]
    ;

- Clauses must appear in the order shown above.
- Every widget must have a unique id within the document.
- Top-level widgets use @ root as their parent.
- Nested widgets reference their parent's id.
- style uses { key: "value"; key: "value" } syntax.
- Grid layout uses style keys gridX, gridY, gridW, gridH as integer strings.

## Available Widget Types

- container: layout wrapper
- text: static or dynamic label
- button: clickable action
- table: data grid
- form: input form
- chart: chart widget
- kpi: single metric display
- filter: filter control
- modal: overlay dialog
- tabs: tabbed container
- markdown: rich text block

## Rules

1. Always return the complete updated DSL document, not just a diff.
2. Return valid Aura DSL inside a fenced code block.
3. You may include a short plain-language explanation before the code block.
4. Preserve nodes marked manuallyEdited unless the user explicitly asks to change them.
5. Keep grid placements non-overlapping.
6. For CRUD pages, prefer sensible tables, forms, and actions.
7. Keep IDs short and descriptive.
`

func fetchAppAndMessages(ctx context.Context, pool *pgxpool.Pool, payload GenerationPayload) (appRow, []msgRow, error) {
	var app appRow
	var nodeMetaRaw []byte
	err := pool.QueryRow(ctx, `SELECT id, dsl_source, node_metadata FROM apps WHERE id = $1`, payload.AppID).Scan(&app.id, &app.dslSource, &nodeMetaRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return appRow{}, nil, fmt.Errorf("app %s not found", payload.AppID)
	}
	if err != nil {
		return appRow{}, nil, fmt.Errorf("fetch app: %w", err)
	}
	if nodeMetaRaw != nil {
		_ = json.Unmarshal(nodeMetaRaw, &app.nodeMetadata)
	}

	rows, err := pool.Query(ctx, `SELECT role, content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at ASC`, payload.ThreadID)
	if err != nil {
		return appRow{}, nil, fmt.Errorf("fetch messages: %w", err)
	}
	defer rows.Close()

	var messages []msgRow
	for rows.Next() {
		var message msgRow
		if err := rows.Scan(&message.role, &message.content); err != nil {
			return appRow{}, nil, fmt.Errorf("scan message: %w", err)
		}
		messages = append(messages, message)
	}
	return app, messages, rows.Err()
}

func fetchUserAISettings(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, userID string) (userAISettings, error) {
	var settings userAISettings
	var providerConfigRaw []byte
	var encryptedCredentials []byte
	err := pool.QueryRow(ctx,
		`SELECT provider, model, provider_config, encrypted_credentials FROM user_ai_settings WHERE user_id = $1`,
		userID,
	).Scan(&settings.Provider, &settings.Model, &providerConfigRaw, &encryptedCredentials)
	if errors.Is(err, pgx.ErrNoRows) {
		return userAISettings{}, errors.New("the user has not configured AI settings yet")
	}
	if err != nil {
		return userAISettings{}, fmt.Errorf("fetch user ai settings: %w", err)
	}
	if len(providerConfigRaw) > 0 {
		var providerConfig userAIProviderConfig
		if err := json.Unmarshal(providerConfigRaw, &providerConfig); err != nil {
			return userAISettings{}, fmt.Errorf("unmarshal provider config: %w", err)
		}
		settings.OpenAIBaseURL = providerConfig.OpenAIBaseURL
	}
	if len(encryptedCredentials) > 0 {
		plaintext, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, encryptedCredentials)
		if err != nil {
			return userAISettings{}, fmt.Errorf("decrypt ai credentials: %w", err)
		}
		if err := json.Unmarshal(plaintext, &settings.Credentials); err != nil {
			return userAISettings{}, fmt.Errorf("unmarshal ai credentials: %w", err)
		}
	}
	return settings, nil
}

func writeAssistantMessage(ctx context.Context, pool *pgxpool.Pool, threadID, content, newDSL string) error {
	type dslPatch struct {
		NewSource string `json:"new_source"`
	}
	patch, err := json.Marshal(dslPatch{NewSource: newDSL})
	if err != nil {
		return fmt.Errorf("marshal dsl patch: %w", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO thread_messages (thread_id, role, content, dsl_patch) VALUES ($1, 'assistant', $2, $3)`, threadID, content, patch)
	if err != nil {
		return fmt.Errorf("insert assistant message: %w", err)
	}
	_, _ = pool.Exec(ctx, `UPDATE conversation_threads SET updated_at = now() WHERE id = $1`, threadID)
	return nil
}

func updateAppDSL(ctx context.Context, pool *pgxpool.Pool, appID, newDSL string) error {
	_, err := pool.Exec(ctx, `UPDATE apps SET dsl_source = $1, updated_at = now() WHERE id = $2`, newDSL, appID)
	return err
}

func writeErrorMessage(ctx context.Context, pool *pgxpool.Pool, threadID, errMsg string) {
	_, _ = pool.Exec(ctx, `INSERT INTO thread_messages (thread_id, role, content) VALUES ($1, 'assistant', $2)`, threadID, "Sorry, I encountered an error generating the app: "+errMsg)
	_, _ = pool.Exec(ctx, `UPDATE conversation_threads SET updated_at = now() WHERE id = $1`, threadID)
}

func handleGeneration(cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger) jobHandler {
	return func(ctx context.Context, payloadBytes []byte) error {
		if pool == nil {
			return errors.New("database is unavailable for generation")
		}

		var payload GenerationPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return fmt.Errorf("unmarshal generation payload: %w", err)
		}

		log.Info("generation job started", zap.String("thread_id", payload.ThreadID), zap.String("user_id", payload.UserID))

		app, messages, err := fetchAppAndMessages(ctx, pool, payload)
		if err != nil {
			log.Error("fetch app context", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, err.Error())
			return err
		}

		settings, err := fetchUserAISettings(ctx, cfg, pool, payload.UserID)
		if err != nil {
			log.Error("fetch user ai settings", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, err.Error())
			return err
		}

		currentDSL := strings.TrimSpace(app.dslSource)
		if currentDSL == "" {
			currentDSL = "[empty - generate an initial layout]"
		}

		latestUserPrompt := "Generate an appropriate initial layout."
		if len(messages) > 0 {
			last := messages[len(messages)-1]
			if last.role == "user" && strings.TrimSpace(last.content) != "" {
				latestUserPrompt = last.content
			}
		}

		var responseText string
		switch settings.Provider {
		case "openai":
			requestMessages := []chatMessage{
				{Role: "system", Content: systemPrompt},
				{Role: "system", Content: "Current app DSL:\n```aura\n" + currentDSL + "\n```"},
			}
			for index, message := range messages {
				if index == len(messages)-1 && message.role == "user" {
					break
				}
				requestMessages = append(requestMessages, chatMessage{Role: message.role, Content: message.content})
			}
			requestMessages = append(requestMessages, chatMessage{Role: "user", Content: latestUserPrompt})
			responseText, err = callOpenAI(ctx, settings, requestMessages)
		case "github_copilot":
			responseText, err = callGitHubCopilot(ctx, settings, buildCopilotPrompt(currentDSL, latestUserPrompt, messages))
		default:
			err = fmt.Errorf("unsupported ai provider %q", settings.Provider)
		}
		if err != nil {
			log.Error("generation call failed", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, err.Error())
			return err
		}

		newDSL := extractDSL(responseText)
		if newDSL == "" {
			if err := writeAssistantMessage(ctx, pool, payload.ThreadID, responseText, currentDSL); err != nil {
				log.Error("write assistant prose message", zap.Error(err))
			}
			return nil
		}

		// Validation gate: refuse to persist structurally malformed DSL.
		if err := validateDSL(newDSL); err != nil {
			log.Warn("candidate DSL is malformed; refusing to persist",
				zap.String("thread_id", payload.ThreadID),
				zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, "generated DSL was malformed and could not be applied")
			return err
		}

		// Protected diff: preserve manually-edited nodes from the current document
		// unless the caller set force_overwrite.
		resultDSL, err := applyProtectedDiff(app.dslSource, newDSL, app.nodeMetadata, payload.ForceOverwrite)
		if err != nil {
			log.Error("apply protected diff", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, "failed to apply revision safely")
			return err
		}

		if err := updateAppDSL(ctx, pool, payload.AppID, resultDSL); err != nil {
			log.Error("update app dsl", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, "failed to save generated layout")
			return err
		}

		explanation := strings.TrimSpace(auraBlockRe.ReplaceAllString(responseText, ""))
		if explanation == "" {
			explanation = "Updated the app layout."
		}

		if err := writeAssistantMessage(ctx, pool, payload.ThreadID, explanation, resultDSL); err != nil {
			log.Error("write assistant message", zap.Error(err))
			return err
		}

		log.Info("generation job complete", zap.String("thread_id", payload.ThreadID), zap.String("provider", settings.Provider), zap.String("model", settings.Model))
		return nil
	}
}
