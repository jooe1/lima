package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

const (
	connectorChatRedisTTL       = 30 * time.Minute
	connectorChatMaxIter        = 10
	connectorChatMaxBytes       = 100 * 1024 // 100 KB per fetch
	connectorChatRedisKeyPrefix = "connector_chat:"
)

// --- OpenAI tool-calling types ----------------------------------------------

type ccToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

type ccToolDef struct {
	Type     string         `json:"type"` // "function"
	Function ccToolFunction `json:"function"`
}

type ccToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ccToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"` // "function"
	Function ccToolCallFunction `json:"function"`
}

type ccMessage struct {
	Role       string       `json:"role"`
	Content    *string      `json:"content,omitempty"`
	ToolCalls  []ccToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type ccRequest struct {
	Model       string      `json:"model"`
	Messages    []ccMessage `json:"messages"`
	Tools       []ccToolDef `json:"tools"`
	ToolChoice  string      `json:"tool_choice"`
	Temperature float64     `json:"temperature"`
	MaxTokens   int         `json:"max_tokens,omitempty"`
}

type ccResponse struct {
	Choices []struct {
		Message struct {
			Role      string       `json:"role"`
			Content   *string      `json:"content"`
			ToolCalls []ccToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// --- Conversation state stored in Redis -------------------------------------

type ccConversation struct {
	Messages    []ccMessage `json:"messages"`
	ConnectorID string      `json:"connector_id,omitempty"`
	AuthType    string      `json:"auth_type,omitempty"`
}

// --- Tool definitions -------------------------------------------------------

var connectorChatTools = []ccToolDef{
	{
		Type: "function",
		Function: ccToolFunction{
			Name:        "web_search",
			Description: "Search the web for API documentation, base URLs, and authentication details. Use this when the user has not provided a documentation URL so you can find it yourself.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string", "description": "Search query, e.g. \"Microsoft Graph API documentation base URL\""},
				},
				"required": []string{"query"},
			},
		},
	},
	{
		Type: "function",
		Function: ccToolFunction{
			Name:        "fetch_page",
			Description: "Fetch a public URL and return its text content. Use this to read API documentation pages. HTML is stripped; returns plain text capped at 100 KB.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url": map[string]any{"type": "string", "description": "The URL to fetch"},
				},
				"required": []string{"url"},
			},
		},
	},
	{
		Type: "function",
		Function: ccToolFunction{
			Name:        "create_connector",
			Description: "Create a REST connector in Lima with the base URL and auth type you identified. The user will supply the actual API key separately after setup, so do NOT ask for it.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":     map[string]any{"type": "string", "description": "Human-readable connector name (e.g. 'Stripe')"},
					"base_url": map[string]any{"type": "string", "description": "API base URL without a trailing slash (e.g. https://api.stripe.com/v1)"},
					"auth_type": map[string]any{
						"type":        "string",
						"enum":        []string{"none", "bearer", "api_key"},
						"description": "Authentication method",
					},
				},
				"required": []string{"name", "base_url", "auth_type"},
			},
		},
	},
	{
		Type: "function",
		Function: ccToolFunction{
			Name:        "upsert_action",
			Description: "Add or update an API endpoint (action) on a connector. Call this for each useful endpoint, up to 10 total.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"connector_id":  map[string]any{"type": "string", "description": "The connector ID returned by create_connector"},
					"resource_name": map[string]any{"type": "string", "description": "Snake_case resource name used in Lima (e.g. stripe_customers)"},
					"action_label":  map[string]any{"type": "string", "description": "Human-readable label (e.g. 'List Customers')"},
					"method":        map[string]any{"type": "string", "enum": []string{"GET", "POST", "PUT", "PATCH", "DELETE"}},
					"path":          map[string]any{"type": "string", "description": "URL path template with {param} for path params (e.g. /customers/{id})"},
					"description":   map[string]any{"type": "string", "description": "Brief description of what this endpoint does (optional)"},
				},
				"required": []string{"connector_id", "resource_name", "action_label", "method", "path"},
			},
		},
	},
}

const connectorChatSystemPrompt = `You are an expert API connector assistant for Lima, a data platform for non-technical users.

Your job is to help the user set up a REST API connector by analysing their API documentation.

Workflow:
1. If the user has not provided a documentation URL, call web_search with a targeted query like "{service name} REST API reference endpoints" to find the official API reference. Do NOT ask the user for the URL.
2. From the search results, prefer URLs that look like official API reference pages (e.g. /docs/api, /api/reference, developer.{service}.com). Avoid general marketing or landing pages.
3. Fetch the API reference using fetch_page. If the fetched page is an index with section links but few actual endpoint paths, call fetch_page again on the most relevant linked sub-page (e.g. the "Endpoints", "Resources", or "Reference" section).
4. Identify: the base URL, the authentication method (none / bearer / api_key), and the most useful endpoints.
5. In one sentence, tell the user what you found, then immediately call create_connector.
6. Call upsert_action for each useful endpoint — choose at most 10, preferring reads (GET) and commonly queried resources.
7. After all actions are created, write a brief completion message that:
   - States the connector name and how many endpoints were added.
   - Tells the user what credential they will need to enter to activate it: a Bearer token for bearer auth, an API key for api_key auth, or nothing for public (none) APIs.
   - For bearer or api_key auth, briefly specify where they can typically find the credential (e.g. "Go to the [Service] dashboard → Developers → API Keys") and add: "Not sure where to find it? Just ask and I'll help you locate it."
   - Ends with: "Click **Continue** below to open the connector settings."
   - If the user then asks where to find their credentials, give step-by-step instructions and, if the documentation URL is known, offer to fetch a relevant page.

Rules:
- Only set up REST connectors.
- Copy endpoint paths EXACTLY as documented — do not shorten, generalise, or guess. For example, if the docs show /contacts/people/{id}, use that exact path, not /contacts/{id}.
- Use {paramName} syntax for path parameters (e.g. /customers/{id}).
- Do NOT ask the user for their API key; it will be entered securely outside this chat.
- Be concise. If you can infer something from the docs, do not ask — proceed.
- After calling create_connector, always follow up with at least one upsert_action call.`

// --- SSRF mitigation --------------------------------------------------------

var privateRanges = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

func isPrivateAddr(addr netip.Addr) bool {
	for _, p := range privateRanges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// --- HTML stripping helpers -------------------------------------------------

var ccTagRe = regexp.MustCompile(`<[^>]+>`)
var ccCSSRe = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
// Preserve <pre>/<code> content by wrapping it in backtick markers before
// general tag stripping, so the LLM can identify exact API paths / code.
var ccPreRe = regexp.MustCompile(`(?is)<pre[^>]*>(.*?)</pre>`)
var ccCodeRe = regexp.MustCompile(`(?is)<code[^>]*>(.*?)</code>`)

// Block-level elements that should become newline separators rather than
// collapsing into surrounding prose.  This keeps table rows, list items, and
// paragraphs on their own lines so paths like /contacts/people/{id} are
// visually distinct and not merged with adjacent text.
var ccBlockRe = regexp.MustCompile(`(?i)<(p|div|h[1-6]|tr|li|br|hr|dt|dd|section|article|blockquote)(\s[^>]*)?>`)

func ccStripHTML(s string) string {
	// 1. Remove script and style blocks entirely.
	s = ccCSSRe.ReplaceAllString(s, "")

	// 2. Promote <pre> blocks: strip inner tags, fence with backtick blocks.
	s = ccPreRe.ReplaceAllStringFunc(s, func(m string) string {
		inner := ccPreRe.FindStringSubmatch(m)[1]
		inner = ccTagRe.ReplaceAllString(inner, "")
		inner = strings.TrimSpace(inner)
		if inner == "" {
			return ""
		}
		return "\n```\n" + inner + "\n```\n"
	})

	// 3. Promote inline <code> spans: wrap with backticks.
	s = ccCodeRe.ReplaceAllStringFunc(s, func(m string) string {
		inner := ccCodeRe.FindStringSubmatch(m)[1]
		inner = ccTagRe.ReplaceAllString(inner, "")
		inner = strings.TrimSpace(inner)
		if inner == "" {
			return ""
		}
		return "`" + inner + "`"
	})

	// 4. Block elements → newline so table rows / list items stay separate.
	s = ccBlockRe.ReplaceAllString(s, "\n")

	// 5. Strip all remaining tags.
	s = ccTagRe.ReplaceAllString(s, " ")

	// 6. Collapse whitespace per line; drop blank lines.
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// ccSlugify converts a string to a snake_case identifier.
func ccSlugify(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prev := '_'
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prev = r
		} else if prev != '_' {
			b.WriteByte('_')
			prev = '_'
		}
	}
	res := strings.Trim(b.String(), "_")
	if res == "" {
		return "resource"
	}
	return res
}

// --- HTTP handler types -----------------------------------------------------

type connectorChatRequest struct {
	Message        string `json:"message"`
	ConversationID string `json:"conversationId,omitempty"`
	ConnectorName  string `json:"connectorName,omitempty"`
}

type connectorChatResponse struct {
	ConversationID string `json:"conversationId"`
	Message        string `json:"message"`
	Done           bool   `json:"done"`
	ConnectorID    string `json:"connectorId,omitempty"`
	AuthType       string `json:"authType,omitempty"`
}

// ConnectorChat handles POST /workspaces/{workspaceID}/connectors/chat.
// Each call is one conversation turn: the AI runs a synchronous tool-calling
// loop until it produces a text message, then the final text is returned.
func ConnectorChat(cfg *config.Config, s *store.Store, rdb *goredis.Client, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		claims, _ := ClaimsFromContext(r.Context())

		var body connectorChatRequest
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if strings.TrimSpace(body.Message) == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "message is required")
			return
		}

		// Load the requesting user's AI settings.
		aiRecord, err := s.GetUserAISettings(r.Context(), claims.UserID)
		if errors.Is(err, store.ErrNotFound) {
			respondErr(w, http.StatusUnprocessableEntity, "ai_not_configured", "AI settings not configured — visit Settings to add your API key")
			return
		}
		if err != nil {
			log.Error("get user ai settings for connector chat", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to load AI settings")
			return
		}
		if aiRecord.Provider != model.AIProviderOpenAI {
			respondErr(w, http.StatusUnprocessableEntity, "unsupported_provider", "connector chat requires an OpenAI API key — switch your AI provider to OpenAI in Settings")
			return
		}

		// Decrypt credentials to extract the API key.
		var aiCreds struct {
			APIKey string `json:"api_key"`
		}
		if len(aiRecord.EncryptedCredentials) > 0 {
			plain, err := cryptoutil.DecryptWithRotation(
				cfg.CredentialsEncryptionKey,
				cfg.CredentialsEncryptionKeyPrevious,
				aiRecord.EncryptedCredentials,
			)
			if err != nil {
				log.Error("decrypt ai credentials for connector chat", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "internal_error", "failed to decrypt AI credentials")
				return
			}
			_ = json.Unmarshal(plain, &aiCreds)
		}
		if aiCreds.APIKey == "" {
			respondErr(w, http.StatusUnprocessableEntity, "ai_not_configured", "OpenAI API key not set — visit Settings to configure your key")
			return
		}

		openAIBaseURL := "https://api.openai.com/v1"
		if aiRecord.OpenAIBaseURL != nil && strings.TrimSpace(*aiRecord.OpenAIBaseURL) != "" {
			openAIBaseURL = strings.TrimSpace(*aiRecord.OpenAIBaseURL)
		}

		// Load or initialise conversation state.
		convID := strings.TrimSpace(body.ConversationID)
		var conv ccConversation
		if convID != "" && rdb != nil {
			raw, err := rdb.Get(r.Context(), connectorChatRedisKeyPrefix+convID).Result()
			if err == nil {
				_ = json.Unmarshal([]byte(raw), &conv)
			}
		}
		if convID == "" || len(conv.Messages) == 0 {
			convID = uuid.NewString()
			sysContent := connectorChatSystemPrompt
			if name := strings.TrimSpace(body.ConnectorName); name != "" {
				sysContent += "\n\nIMPORTANT: The user has already named this connector \"" + name + "\". You MUST use this exact name when calling create_connector."
			}
			conv.Messages = []ccMessage{{Role: "system", Content: &sysContent}}
		}

		// Append the user's message.
		userContent := strings.TrimSpace(body.Message)
		conv.Messages = append(conv.Messages, ccMessage{Role: "user", Content: &userContent})

		// Tool-calling loop.
		httpClient := &http.Client{Timeout: 60 * time.Second}
		for iter := 0; iter < connectorChatMaxIter; iter++ {
			turn, err := callOpenAIWithTools(r.Context(), httpClient, openAIBaseURL, aiCreds.APIKey, aiRecord.Model, conv.Messages)
			if err != nil {
				log.Error("openai tool call", zap.Error(err), zap.Int("iter", iter))
				respondErr(w, http.StatusInternalServerError, "ai_error", "AI call failed: "+err.Error())
				return
			}

			if len(turn.ToolCalls) > 0 {
				// Append assistant's tool-call message.
				conv.Messages = append(conv.Messages, ccMessage{
					Role:      "assistant",
					ToolCalls: turn.ToolCalls,
				})
				// Execute each tool and append results.
				for _, tc := range turn.ToolCalls {
					log.Debug("connector chat tool call",
						zap.Int("iter", iter),
						zap.String("tool", tc.Function.Name),
						zap.String("args", tc.Function.Arguments),
					)
					result := executeConnectorChatTool(r.Context(), tc, workspaceID, claims.UserID, cfg, s, &conv, log)
					log.Debug("connector chat tool result",
						zap.String("tool", tc.Function.Name),
						zap.String("result", result),
					)
					conv.Messages = append(conv.Messages, ccMessage{
						Role:       "tool",
						ToolCallID: tc.ID,
						Content:    &result,
					})
				}
				continue
			}

			// Text response — turn is complete.
			assistantContent := ""
			if turn.Content != nil {
				assistantContent = *turn.Content
			}
			conv.Messages = append(conv.Messages, ccMessage{Role: "assistant", Content: &assistantContent})

			saveChatConversation(r.Context(), rdb, convID, conv, log)

			respond(w, http.StatusOK, connectorChatResponse{
				ConversationID: convID,
				Message:        assistantContent,
				Done:           conv.ConnectorID != "",
				ConnectorID:    conv.ConnectorID,
				AuthType:       conv.AuthType,
			})
			return
		}

		// Exceeded maximum tool-call iterations.
		saveChatConversation(r.Context(), rdb, convID, conv, log)
		respondErr(w, http.StatusInternalServerError, "ai_loop_limit", "AI exceeded maximum steps — please try again")
	}
}

// --- OpenAI caller ----------------------------------------------------------

type openAITurnResult struct {
	Content   *string
	ToolCalls []ccToolCall
}

func callOpenAIWithTools(ctx context.Context, httpClient *http.Client, baseURL, apiKey, modelID string, msgs []ccMessage) (*openAITurnResult, error) {
	body, err := json.Marshal(ccRequest{
		Model:       modelID,
		Messages:    msgs,
		Tools:       connectorChatTools,
		ToolChoice:  "auto",
		Temperature: 0.2,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http call: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var parsed ccResponse
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	if resp.StatusCode >= 400 {
		if parsed.Error != nil {
			return nil, fmt.Errorf("openai error: %s", parsed.Error.Message)
		}
		return nil, fmt.Errorf("openai http %d", resp.StatusCode)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("openai error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("openai returned no choices")
	}
	ch := parsed.Choices[0].Message
	return &openAITurnResult{Content: ch.Content, ToolCalls: ch.ToolCalls}, nil
}

// --- Tool execution ---------------------------------------------------------

func executeConnectorChatTool(
	ctx context.Context,
	tc ccToolCall,
	workspaceID, userID string,
	cfg *config.Config,
	s *store.Store,
	conv *ccConversation,
	log *zap.Logger,
) string {
	switch tc.Function.Name {
	case "web_search":
		return ccToolWebSearch(ctx, tc.Function.Arguments, cfg)
	case "fetch_page":
		return ccToolFetchPage(tc.Function.Arguments)
	case "create_connector":
		return ccToolCreateConnector(ctx, tc.Function.Arguments, workspaceID, userID, cfg, s, conv, log)
	case "upsert_action":
		return ccToolUpsertAction(ctx, tc.Function.Arguments, workspaceID, s, log)
	default:
		return fmt.Sprintf(`{"error": "unknown tool %q"}`, tc.Function.Name)
	}
}

func ccToolWebSearch(ctx context.Context, argsJSON string, cfg *config.Config) string {
	if cfg.TavilyAPIKey == "" {
		return `{"error": "web search is not configured on this server"}`
	}
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil || strings.TrimSpace(args.Query) == "" {
		return `{"error": "invalid arguments"}`
	}

	reqBody, err := json.Marshal(map[string]any{
		"api_key":        cfg.TavilyAPIKey,
		"query":          args.Query,
		"search_depth":   "advanced",
		"max_results":    8,
		"include_answer": true,
	})
	if err != nil {
		return `{"error": "failed to build search request"}`
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.tavily.com/search", bytes.NewReader(reqBody))
	if err != nil {
		return `{"error": "failed to create search request"}`
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Sprintf(`{"error": "search request failed: %s"}`, err.Error())
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return `{"error": "failed to read search response"}`
	}

	var result struct {
		Answer  string `json:"answer"`
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return `{"error": "failed to parse search response"}`
	}

	var sb strings.Builder
	if result.Answer != "" {
		sb.WriteString("Summary: ")
		sb.WriteString(result.Answer)
		sb.WriteString("\n\n")
	}
	for i, r := range result.Results {
		fmt.Fprintf(&sb, "%d. %s\n   URL: %s\n   %s\n\n", i+1, r.Title, r.URL, r.Content)
	}
	return sb.String()
}

func ccToolFetchPage(argsJSON string) string {
	var args struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return `{"error": "invalid arguments"}`
	}

	u, err := url.Parse(args.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return `{"error": "invalid or unsupported URL"}`
	}

	// SSRF mitigation: block private address ranges.
	host := u.Hostname()
	addrs, err := net.LookupHost(host)
	if err != nil {
		return fmt.Sprintf(`{"error": "DNS lookup failed: %s"}`, err.Error())
	}
	for _, a := range addrs {
		ip, parseErr := netip.ParseAddr(a)
		if parseErr != nil {
			continue
		}
		if isPrivateAddr(ip) {
			return `{"error": "blocked: private or internal addresses are not allowed"}`
		}
	}

	httpResp, err := (&http.Client{Timeout: 20 * time.Second}).Get(args.URL)
	if err != nil {
		return fmt.Sprintf(`{"error": "fetch failed: %s"}`, err.Error())
	}
	defer httpResp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(httpResp.Body, connectorChatMaxBytes))
	if err != nil {
		return fmt.Sprintf(`{"error": "read failed: %s"}`, err.Error())
	}

	text := ccStripHTML(string(raw))
	if len(text) > connectorChatMaxBytes {
		text = text[:connectorChatMaxBytes]
	}
	return text
}

func ccToolCreateConnector(
	ctx context.Context,
	argsJSON, workspaceID, userID string,
	cfg *config.Config,
	s *store.Store,
	conv *ccConversation,
	log *zap.Logger,
) string {
	var args struct {
		Name     string `json:"name"`
		BaseURL  string `json:"base_url"`
		AuthType string `json:"auth_type"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return `{"error": "invalid arguments"}`
	}
	if args.Name == "" || args.BaseURL == "" || args.AuthType == "" {
		return `{"error": "name, base_url, and auth_type are required"}`
	}

	credsJSON, err := json.Marshal(map[string]any{
		"base_url":  args.BaseURL,
		"auth_type": args.AuthType,
	})
	if err != nil {
		return `{"error": "failed to marshal credentials"}`
	}

	encCreds, err := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, credsJSON)
	if err != nil {
		log.Error("encrypt connector credentials in chat tool", zap.Error(err))
		return `{"error": "credential encryption failed"}`
	}

	conn, err := s.CreateConnector(ctx, workspaceID, args.Name, model.ConnectorTypeREST, encCreds, userID)
	if err != nil {
		log.Error("create connector in chat tool", zap.Error(err))
		return `{"error": "database error creating connector"}`
	}

	conv.ConnectorID = conn.ID
	conv.AuthType = args.AuthType

	return fmt.Sprintf(`{"connector_id": %q, "message": "connector created successfully"}`, conn.ID)
}

func ccToolUpsertAction(ctx context.Context, argsJSON, workspaceID string, s *store.Store, log *zap.Logger) string {
	var args struct {
		ConnectorID  string `json:"connector_id"`
		ResourceName string `json:"resource_name"`
		ActionLabel  string `json:"action_label"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Description  string `json:"description"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return `{"error": "invalid arguments"}`
	}

	actionKey := ccSlugify(args.ActionLabel)
	input := model.ActionDefinitionInput{
		ResourceName: args.ResourceName,
		ActionKey:    actionKey,
		ActionLabel:  args.ActionLabel,
		HTTPMethod:   strings.ToUpper(args.Method),
		PathTemplate: args.Path,
		Description:  args.Description,
		InputFields:  []model.ActionFieldDef{},
	}

	action, err := s.UpsertConnectorAction(ctx, workspaceID, args.ConnectorID, input)
	if err != nil {
		log.Error("upsert action in chat tool", zap.Error(err))
		return `{"error": "failed to upsert action"}`
	}

	return fmt.Sprintf(`{"action_id": %q, "action_key": %q, "message": "action created"}`, action.ID, action.ActionKey)
}

// --- Redis persistence ------------------------------------------------------

func saveChatConversation(ctx context.Context, rdb *goredis.Client, convID string, conv ccConversation, log *zap.Logger) {
	if rdb == nil {
		return
	}
	b, err := json.Marshal(conv)
	if err != nil {
		log.Warn("marshal conversation for redis", zap.Error(err))
		return
	}
	if err := rdb.Set(ctx, connectorChatRedisKeyPrefix+convID, b, connectorChatRedisTTL).Err(); err != nil {
		log.Warn("save conversation to redis", zap.Error(err))
	}
}
