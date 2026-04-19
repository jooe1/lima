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
	MaxTokens   int           `json:"max_tokens,omitempty"`
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

// genConnector holds the connector metadata surfaced to the AI model so it can
// reference real connector IDs and column names in generated DSL.
type genConnector struct {
	id      string
	name    string
	cType   string
	columns []string // column names extracted from schema_cache (CSV connectors)
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
	TavilyMCPURL  string
}

// stageSettings returns a copy of base with the model overridden to override
// if override is non-empty, otherwise returns base unchanged.
func stageSettings(base userAISettings, override string) userAISettings {
	if override == "" {
		return base
	}
	cp := base
	cp.Model = override
	return cp
}

var auraBlockRe = regexp.MustCompile("(?s)```(?:aura)?\\s*\n(.*?)\\s*```")
var flowsBlockRe = regexp.MustCompile("(?s)```flows\\s*\n(.*?)\\s*```")
var edgesBlockRe = regexp.MustCompile("(?s)```edges\\s*\n(.*?)\\s*```")

// genWorkflowStep is the shape the AI emits for a single workflow step.
type genWorkflowStep struct {
	Name     string         `json:"name"`
	StepType string         `json:"step_type"`
	Config   map[string]any `json:"config"`
}

// genWorkflow is the shape the AI emits for a complete workflow.
type genWorkflow struct {
	Ref              string            `json:"ref"`
	Name             string            `json:"name"`
	TriggerType      string            `json:"trigger_type"`
	TriggerWidgetRef string            `json:"trigger_widget_ref,omitempty"`
	RequiresApproval bool              `json:"requires_approval"`
	Steps            []genWorkflowStep `json:"steps"`
}

// existingWorkflowInfo holds lightweight info about a workflow already in the DB.
type existingWorkflowInfo struct {
	id          string
	name        string
	triggerType string
}

// validStepTypes is the set of step_type values accepted by the DB enum.
var validStepTypes = map[string]bool{
	"query": true, "mutation": true, "condition": true,
	"approval_gate": true, "notification": true,
}

// validTriggerTypes is the set of trigger_type values accepted by the DB enum.
var validTriggerTypes = map[string]bool{
	"manual": true, "form_submit": true, "button_click": true,
	"schedule": true, "webhook": true,
}

func callOpenAI(ctx context.Context, settings userAISettings, messages []chatMessage) (string, error) {
	body, err := json.Marshal(chatRequest{
		Model:       settings.Model,
		Messages:    messages,
		Temperature: 0.2,
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

func callGitHubCopilot(ctx context.Context, settings userAISettings, prompt string, systemMsg string) (content string, err error) {
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

	sessionCfg := &copilot.SessionConfig{
		Model:               settings.Model,
		OnPermissionRequest: copilot.PermissionHandler.ApproveAll,
		AvailableTools:      []string{},
		SystemMessage: &copilot.SystemMessageConfig{
			Mode:    "replace",
			Content: systemMsg,
		},
	}
	if settings.TavilyMCPURL != "" {
		sessionCfg.MCPServers = map[string]copilot.MCPServerConfig{
			"tavily": {
				"type": "http",
				"url":  settings.TavilyMCPURL,
			},
		}
	}

	session, err := client.CreateSession(ctx, sessionCfg)
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

// generateLayout calls the configured layout model with the provided messages
// (for OpenAI) or prompt (for Copilot). It returns the raw LLM response text.
func generateLayout(
	ctx context.Context,
	settings userAISettings,
	messages []chatMessage,
	copilotPrompt string,
) (string, error) {
	switch settings.Provider {
	case "openai":
		return callOpenAI(ctx, settings, messages)
	case "github_copilot":
		return callGitHubCopilot(ctx, settings, copilotPrompt, layoutSystemPrompt)
	default:
		return "", fmt.Errorf("unsupported ai provider %q for layout stage", settings.Provider)
	}
}

// generateFlow calls the configured flow model with the provided messages
// (for OpenAI) or prompt (for Copilot). It returns the raw LLM response text.
func generateFlow(
	ctx context.Context,
	settings userAISettings,
	messages []chatMessage,
	copilotPrompt string,
) (string, error) {
	switch settings.Provider {
	case "openai":
		return callOpenAI(ctx, settings, messages)
	case "github_copilot":
		return callGitHubCopilot(ctx, settings, copilotPrompt, flowSystemPrompt)
	default:
		return "", fmt.Errorf("unsupported ai provider %q for flow stage", settings.Provider)
	}
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

// fetchWorkspaceConnectors loads lightweight connector metadata (id, name, type,
// and column names for CSV connectors) for the given workspace. The result is
// passed to the AI model so it can reference real connector IDs and schema
// columns when generating DSL. Errors are non-fatal — the caller logs and
// proceeds with an empty slice.
func fetchWorkspaceConnectors(ctx context.Context, pool *pgxpool.Pool, workspaceID string) ([]genConnector, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, name, type, schema_cache FROM connectors WHERE workspace_id = $1 ORDER BY name`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch connectors: %w", err)
	}
	defer rows.Close()

	var result []genConnector
	for rows.Next() {
		var c genConnector
		var schemaRaw []byte
		if err := rows.Scan(&c.id, &c.name, &c.cType, &schemaRaw); err != nil {
			return nil, fmt.Errorf("scan connector: %w", err)
		}
		if len(schemaRaw) > 0 {
			switch c.cType {
			case "csv", "managed":
				var sch struct {
					Columns []struct {
						Name string `json:"name"`
					} `json:"columns"`
				}
				if jsonErr := json.Unmarshal(schemaRaw, &sch); jsonErr == nil {
					for _, col := range sch.Columns {
						c.columns = append(c.columns, col.Name)
					}
				}
			case "postgres", "mysql", "mssql":
				var sch struct {
					Tables map[string]struct {
						Columns []struct {
							Name string `json:"name"`
						} `json:"columns"`
					} `json:"tables"`
				}
				if jsonErr := json.Unmarshal(schemaRaw, &sch); jsonErr == nil {
					seen := map[string]bool{}
					for _, tbl := range sch.Tables {
						for _, col := range tbl.Columns {
							if !seen[col.Name] {
								c.columns = append(c.columns, col.Name)
								seen[col.Name] = true
							}
						}
					}
				}
			}
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// buildConnectorContextBlock renders the connector list into a plain-text block
// that is injected into the AI prompt so the model knows what data sources are
// available and how to reference them in the `with` clause.
func buildConnectorContextBlock(connectors []genConnector) string {
	if len(connectors) == 0 {
		return "No connectors are configured for this workspace yet.\nDo not invent connector IDs; tell the user they need to add a connector first."
	}
	var sb strings.Builder
	sb.WriteString("Available connectors in this workspace (use the exact IDs below):\n")
	for _, c := range connectors {
		fmt.Fprintf(&sb, "- id=%q  name=%q  type=%s", c.id, c.name, c.cType)
		if len(c.columns) > 0 {
			sb.WriteString("  columns=[")
			sb.WriteString(strings.Join(c.columns, ", "))
			sb.WriteString("]")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// nodeOnlyDSL strips the ---edges--- separator and everything after it from a
// serialised Aura V2 document. The layout model only needs the widget/node
// declarations; sending it the edge section can confuse it into reproducing
// that section in its output, which would then fail Go's DSL validator.
func nodeOnlyDSL(src string) string {
	const sentinel = "---edges---"
	if idx := strings.Index(src, sentinel); idx >= 0 {
		return strings.TrimSpace(src[:idx])
	}
	return src
}

func buildLayoutCopilotPrompt(currentDSL, latestUserPrompt string, history []msgRow, connectors []genConnector, existingWorkflows []existingWorkflowInfo) string {
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	builder.WriteString("\nCurrent app DSL:\n```aura\n")
	builder.WriteString(nodeOnlyDSL(currentDSL))
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
	builder.WriteString("\n\nReturn the complete updated Aura DSL document only. Do not include an edges block or a flows block.")
	return builder.String()
}

func buildCopilotPrompt(currentDSL, latestUserPrompt string, history []msgRow, connectors []genConnector, existingWorkflows []existingWorkflowInfo) string {
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	builder.WriteString("\nCurrent app DSL:\n```aura\n")
	builder.WriteString(nodeOnlyDSL(currentDSL))
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
	builder.WriteString("\n\nReturn the complete updated Aura DSL document and, when the app requires write actions, a flows block.")
	return builder.String()
}

// buildLayoutMessages constructs the OpenAI chat message slice for the layout
// generation stage. Uses the dedicated layoutSystemPrompt so the model only
// produces the Aura DSL block (no edges, no flows).
func buildLayoutMessages(
	currentDSL, latestUserPrompt string,
	history []msgRow,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
) []chatMessage {
	msgs := []chatMessage{
		{Role: "system", Content: layoutSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "system", Content: buildWorkflowContextBlock(existingWorkflows)},
		{Role: "system", Content: "Current app DSL:\n```aura\n" + nodeOnlyDSL(currentDSL) + "\n```"},
	}
	for i, m := range history {
		if i == len(history)-1 && m.role == "user" {
			break
		}
		msgs = append(msgs, chatMessage{Role: m.role, Content: m.content})
	}
	msgs = append(msgs, chatMessage{Role: "user", Content: latestUserPrompt})
	return msgs
}

// buildFlowMessages constructs the OpenAI chat message slice for the flow
// generation stage. It sends the validated layout DSL (from Stage 1) as
// context so the flow model knows which widget IDs and fields exist.
func buildFlowMessages(
	validatedDSL, latestUserPrompt string,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
) []chatMessage {
	portManifest := BuildPortManifest()
	return []chatMessage{
		{Role: "system", Content: flowSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "system", Content: buildWorkflowContextBlock(existingWorkflows)},
		{Role: "system", Content: "## Widget port reference\n\n" + portManifest},
		{Role: "system", Content: "Finalised widget layout (Stage 1 output):\n```aura\n" + validatedDSL + "\n```"},
		{Role: "user", Content: "Original user intent: " + latestUserPrompt + "\n\nEmit only the wiring (edges and/or flows blocks) required by the user's intent. If no wiring is needed, respond with a single sentence explaining why."},
	}
}

// buildFlowCopilotPrompt constructs the Copilot prompt string for the flow
// generation stage.
func buildFlowCopilotPrompt(
	validatedDSL, latestUserPrompt string,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
) string {
	portManifest := BuildPortManifest()
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	builder.WriteString("\n## Widget port reference\n\n")
	builder.WriteString(portManifest)
	builder.WriteString("\nFinalised widget layout:\n```aura\n")
	builder.WriteString(validatedDSL)
	builder.WriteString("\n```\n\nOriginal user intent: ")
	builder.WriteString(latestUserPrompt)
	builder.WriteString("\n\nEmit only the wiring (edges and/or flows blocks) required. If no wiring is needed, say so briefly.")
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

// fetchExistingWorkflows returns lightweight workflow info for all non-archived
// workflows belonging to the given app.
func fetchExistingWorkflows(ctx context.Context, pool *pgxpool.Pool, appID string) ([]existingWorkflowInfo, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, name, trigger_type FROM workflows WHERE app_id = $1 AND status != 'archived' ORDER BY name`,
		appID,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch existing workflows: %w", err)
	}
	defer rows.Close()

	var result []existingWorkflowInfo
	for rows.Next() {
		var w existingWorkflowInfo
		if err := rows.Scan(&w.id, &w.name, &w.triggerType); err != nil {
			return nil, fmt.Errorf("scan workflow: %w", err)
		}
		result = append(result, w)
	}
	return result, rows.Err()
}

// buildWorkflowContextBlock renders existing workflows into a plain-text block
// injected into the AI prompt so the model can reference them by real UUID.
func buildWorkflowContextBlock(workflows []existingWorkflowInfo) string {
	if len(workflows) == 0 {
		return "No workflows exist for this app yet.\n"
	}
	var sb strings.Builder
	sb.WriteString("Existing workflows for this app (reference these UUIDs directly in onSubmit/onClick — do NOT wrap them in {{flow:...}}):\n")
	for _, w := range workflows {
		fmt.Fprintf(&sb, "- id=%q  name=%q  trigger_type=%s\n", w.id, w.name, w.triggerType)
	}
	return sb.String()
}

// extractFlows parses the AI-generated flows JSON block from the response text.
// Returns nil, nil when no flows block is present.
func extractFlows(content string) ([]genWorkflow, error) {
	match := flowsBlockRe.FindStringSubmatch(content)
	if len(match) < 2 {
		return nil, nil
	}
	raw := strings.TrimSpace(match[1])
	if raw == "" || raw == "[]" {
		return nil, nil
	}
	var flows []genWorkflow
	if err := json.Unmarshal([]byte(raw), &flows); err != nil {
		return nil, fmt.Errorf("parse flows block: %w", err)
	}
	return flows, nil
}

// extractEdges parses a ```edges JSON block from the AI response.
// Returns nil (no error) if no edges block is present.
func extractEdges(content string) ([]dslEdge, error) {
	match := edgesBlockRe.FindStringSubmatch(content)
	if len(match) < 2 {
		return nil, nil
	}
	raw := strings.TrimSpace(match[1])
	if raw == "" || raw == "[]" {
		return nil, nil
	}
	var edges []dslEdge
	if err := json.Unmarshal([]byte(raw), &edges); err != nil {
		return nil, fmt.Errorf("parse edges block: %w", err)
	}
	// Assign stable IDs to any edge that omitted one.
	for i := range edges {
		if edges[i].ID == "" {
			edges[i].ID = fmt.Sprintf("edge_%s_%s_%s_%s",
				edges[i].FromNodeID, edges[i].FromPort,
				edges[i].ToNodeID, edges[i].ToPort)
		}
	}
	return edges, nil
}

// persistGeneratedFlows inserts AI-generated workflows and their steps into the
// DB (status='draft', ai_generated=true on each step). Returns a map of
// ref → real UUID so callers can substitute {{flow:ref}} placeholders in DSL.
func persistGeneratedFlows(ctx context.Context, pool *pgxpool.Pool, workspaceID, appID, userID string, flows []genWorkflow) (map[string]string, error) {
	refToID := make(map[string]string, len(flows))
	for _, f := range flows {
		if strings.TrimSpace(f.Ref) == "" || strings.TrimSpace(f.Name) == "" {
			continue
		}

		triggerType := f.TriggerType
		if !validTriggerTypes[triggerType] {
			triggerType = "manual"
		}

		triggerConfig := map[string]any{}
		if (triggerType == "form_submit" || triggerType == "button_click") && f.TriggerWidgetRef != "" {
			triggerConfig["widget_id"] = f.TriggerWidgetRef
		}
		triggerConfigBytes, err := json.Marshal(triggerConfig)
		if err != nil {
			return nil, fmt.Errorf("marshal trigger config for ref %q: %w", f.Ref, err)
		}

		var sourceWidgetID *string
		if f.TriggerWidgetRef != "" {
			sourceWidgetID = &f.TriggerWidgetRef
		}

		var wfID string
		err = pool.QueryRow(ctx, `
			INSERT INTO workflows
			    (workspace_id, app_id, name, trigger_type, trigger_config,
			     status, requires_approval, created_by, source_widget_id)
			VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8)
			RETURNING id`,
			workspaceID, appID, f.Name,
			triggerType, triggerConfigBytes,
			f.RequiresApproval, userID, sourceWidgetID,
		).Scan(&wfID)
		if err != nil {
			return nil, fmt.Errorf("insert workflow %q: %w", f.Ref, err)
		}
		refToID[f.Ref] = wfID

		for i, step := range f.Steps {
			if !validStepTypes[step.StepType] {
				continue
			}
			name := strings.TrimSpace(step.Name)
			if name == "" {
				name = fmt.Sprintf("Step %d", i+1)
			}
			cfgBytes, err := json.Marshal(step.Config)
			if err != nil {
				cfgBytes = []byte("{}")
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO workflow_steps
				    (workflow_id, step_order, name, step_type, config, ai_generated)
				VALUES ($1,$2,$3,$4,$5,true)`,
				wfID, i, name, step.StepType, cfgBytes,
			); err != nil {
				return nil, fmt.Errorf("insert step %d for workflow %q: %w", i, f.Ref, err)
			}
		}
	}
	return refToID, nil
}

// substituteFlowRefs replaces {{flow:ref}} placeholders in DSL with real UUIDs.
func substituteFlowRefs(dsl string, refToID map[string]string) string {
	for ref, id := range refToID {
		dsl = strings.ReplaceAll(dsl, "{{flow:"+ref+"}}", id)
	}
	return dsl
}

// buildFlowNodesAndEdges generates Aura DSL statements (flow:group + step:*
// nodes) and async edges for every persisted workflow. The DSL is appended to
// the widget DSL so the Flow View canvas can render the step nodes. The edges
// wire each widget's submit/click output port to the first step's "run" input,
// and connect consecutive steps to each other.
func buildFlowNodesAndEdges(flows []genWorkflow, refToID map[string]string) (string, []dslEdge) {
	var dslParts []string
	var edges []dslEdge

	for _, f := range flows {
		if _, ok := refToID[f.Ref]; !ok {
			continue
		}
		if len(f.Steps) == 0 {
			continue
		}

		groupID := f.Ref + "_group"
		name := f.Name
		if name == "" {
			name = f.Ref
		}

		// Flow group node (visual container in the Flow View).
		dslParts = append(dslParts, fmt.Sprintf("flow:group %s @ root\n  text %q\n;", groupID, name))

		// Step nodes + step-to-step edges.
		prevStepID := ""
		for i, step := range f.Steps {
			stepNodeID := fmt.Sprintf("%s_step%d", f.Ref, i)
			stepType := step.StepType
			if !validStepTypes[stepType] {
				stepType = "query"
			}
			stepName := strings.TrimSpace(step.Name)
			if stepName == "" {
				stepName = fmt.Sprintf("Step %d", i+1)
			}
			dslParts = append(dslParts,
				fmt.Sprintf("step:%s %s @ %s\n  text %q\n;", stepType, stepNodeID, groupID, stepName))

			if prevStepID != "" {
				edges = append(edges, dslEdge{
					ID:         fmt.Sprintf("edge_%s_output_%s_run", prevStepID, stepNodeID),
					FromNodeID: prevStepID,
					FromPort:   "output",
					ToNodeID:   stepNodeID,
					ToPort:     "run",
					EdgeType:   "async",
				})
			}
			prevStepID = stepNodeID
		}

		// Widget trigger edge: widget.submitted (or .clicked) → first step.run.
		if f.TriggerWidgetRef != "" {
			firstStepID := fmt.Sprintf("%s_step0", f.Ref)
			fromPort := "submitted"
			if f.TriggerType == "button_click" {
				fromPort = "clicked"
			}
			edges = append(edges, dslEdge{
				ID:         fmt.Sprintf("edge_%s_%s_%s_run", f.TriggerWidgetRef, fromPort, firstStepID),
				FromNodeID: f.TriggerWidgetRef,
				FromPort:   fromPort,
				ToNodeID:   firstStepID,
				ToPort:     "run",
				EdgeType:   "async",
			})
		}
	}

	return strings.Join(dslParts, "\n"), edges
}

// fetchAppEdges loads the current dsl_edges from an app row.
func fetchAppEdges(ctx context.Context, pool *pgxpool.Pool, appID string) ([]dslEdge, error) {
	var edgesRaw []byte
	err := pool.QueryRow(ctx, `SELECT dsl_edges FROM apps WHERE id = $1`, appID).Scan(&edgesRaw)
	if err != nil {
		return nil, fmt.Errorf("fetch app edges: %w", err)
	}
	if len(edgesRaw) == 0 {
		return nil, nil
	}
	var edges []dslEdge
	if err := json.Unmarshal(edgesRaw, &edges); err != nil {
		return nil, fmt.Errorf("unmarshal app edges: %w", err)
	}
	return edges, nil
}

const layoutSystemPrompt = `You are an AI assistant that generates and modifies user interface definitions for an internal tools platform called Lima.

Your job in this stage is ONLY to produce the widget layout — the Aura DSL block. Do NOT emit an edges block or a flows block in this stage; those are handled separately.

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

- container: flex layout container — use as a visual background or grouping panel.
  - Required with keys: none.
  - Optional with keys: direction ("row" or "column", default "column"), gap (CSS value, default "16px").
  - All other widgets that sit inside it visually still use @ root as their parent (the canvas is always flat).
  - Do NOT set other widgets' parent to a container id — they must stay @ root.
- text: static or dynamic label
- button: clickable action
- table: data grid
- form: data-entry form — MUST include a fields key listing every input field name.
  - Required with keys: fields (comma-separated field names, e.g. with fields="name,email,phone").
  - Optional with keys: submitLabel (button text, default "Submit").
  - Optional with keys: onSubmit (workflow ID to trigger on submit).
- chart: chart widget
- kpi: single metric display
- filter: filter control
- modal: overlay dialog (not yet supported in the production runtime — do not use)
- tabs: tabbed container (not yet supported in the production runtime — do not use)
- markdown: rich text block

## Response format

Return ONLY the Aura DSL inside a fenced code block and optionally a brief explanation before or after it. Do NOT include an edges block or a flows block.

` + "```" + `aura
<your DSL here>
` + "```" + `

If the user's request does not require any layout change (e.g. a pure data-wiring question), return the existing DSL unchanged inside the code block with a brief explanation of why no layout change is needed.
`

const flowSystemPrompt = `You are an AI assistant specialised in wiring widgets and workflow steps together for the Lima internal tools platform.

You receive a finalised Aura DSL layout (the widgets are already decided) and the user's original intent. Your job is to emit ONLY the wiring — an edges block and/or a flows block. Do NOT emit an aura block.

## Your inputs

- The finalised widget layout (provided as context).
- The full widget and step port reference (provided as context).
- The user's original intent.

## Widget-to-widget wiring (edges block)

Emit a JSON edges block when the user's intent requires widgets to exchange data at runtime (e.g. clicking a table row populates a form, a filter value updates a table).

` + "```edges" + `
[
  {
    "id": "edge_<fromId>_<fromPort>_<toId>_<toPort>",
    "fromNodeId": "<source widget id>",
    "fromPort": "<output port name>",
    "toNodeId": "<target widget id>",
    "toPort": "<input port name>",
    "edgeType": "reactive"
  }
]
` + "```" + `

Rules:
- Use edgeType "reactive" for all widget-to-widget data connections.
- id must be unique and follow the naming convention above.
- fromNodeId and toNodeId must be widget IDs that exist in the layout above.
- fromPort must be an output port and toPort must be an input port listed in the port reference.
- Only emit an edges block if explicit wiring is needed. If not, omit it entirely.

## Workflow definition (flows block)

Emit a flows block only when the user's intent requires persisting data to a connector (INSERT/UPDATE/DELETE) or running a multi-step process.

` + "```flows" + `
[
  {
    "ref": "camelCaseRef",
    "name": "Human readable name",
    "trigger_type": "form_submit|button_click|manual|schedule|webhook",
    "trigger_widget_ref": "<widget id if form_submit or button_click>",
    "requires_approval": true,
    "steps": [
      {
        "name": "Step name",
        "step_type": "query|mutation|condition|approval_gate|notification",
        "config": {}
      }
    ]
  }
]
` + "```" + `

Rules:
- trigger_type must be one of: manual, form_submit, button_click, schedule, webhook.
- step_type must be one of: query, mutation, condition, approval_gate, notification.
- Use {{flow:ref}} in the widget DSL onSubmit/onClick to reference a flow by ref.
- If no workflow is needed, omit the flows block entirely.

## Response format

Return ONLY edges and/or flows blocks (or nothing). Do not explain the layout. A brief one-sentence explanation is acceptable if helpful, but keep it before any code blocks.
`

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

- container: flex layout container — use as a visual background or grouping panel.
  - Required with keys: none.
  - Optional with keys: direction ("row" or "column", default "column"), gap (CSS value, default "16px").
  - All other widgets that sit inside it visually still use @ root as their parent (the canvas is always flat).
  - Do NOT set other widgets' parent to a container id — they must stay @ root.
- text: static or dynamic label
- button: clickable action
- table: data grid
- form: data-entry form — MUST include a fields key listing every input field name.
  - Required with keys: fields (comma-separated field names, e.g. with fields="name,email,phone").
  - Optional with keys: submitLabel (button text, default "Submit").
  - Optional with keys: onSubmit (workflow ID to trigger on submit).
- chart: chart widget
- kpi: single metric display
- filter: filter control
- modal: overlay dialog (not yet supported in the production runtime — do not use)
- tabs: tabbed container (not yet supported in the production runtime — do not use)
- markdown: rich text block

## Widget Port Wiring

Widgets communicate by firing named output ports and receiving values on named input ports.
These connections are expressed as a separate ` + "```edges" + ` JSON block (see below).

### table widget ports

Output ports (fired by user interactions):
- ` + "`selectedRow`" + ` — the full row object when the user clicks a row (e.g. ` + "`{ id: 1, name: \"Alice\" }`" + `)
- ` + "`selectedRowIndex`" + ` — the clicked row's zero-based integer index
- ` + "`selectedRow.<column>`" + ` — the value of a specific column in the clicked row (e.g. ` + "`selectedRow.id`" + `)
- ` + "`rows`" + ` — the currently displayed rows array (fires when data loads or is filtered)

### form widget ports

Input ports (set by wiring another widget's output to them):
- ` + "`setValues`" + ` — populate all form fields at once; accepts an object whose keys match field names
- ` + "`setValues.<field>`" + ` — populate a single named field (e.g. ` + "`setValues.email`" + `)
- ` + "`reset`" + ` — clear all fields when triggered with any value

Output ports (fired by user interactions):
- ` + "`submitted`" + ` — fires the form values object when the user clicks Submit
- ` + "`values`" + ` — same payload as ` + "`submitted`" + `
- ` + "`<fieldName>`" + ` — fires the individual field value (e.g. ` + "`email`" + `)

### button widget ports

Output ports:
- ` + "`clicked`" + ` — fires when the user clicks the button

### Edges block format

Emit an ` + "```edges" + ` block **after** the ` + "```aura" + ` block to declare widget-to-widget wiring edges.
Each edge routes an output port from one widget to an input port of another.

Supported ` + "`edgeType`" + ` values:
- ` + "`reactive`" + ` — wire a widget output directly to another widget input (e.g. table row → form fields).
  Use this for most widget-to-widget connections.
- ` + "`async`" + ` — trigger step execution; used automatically by the workflow engine.
- ` + "`binding`" + ` — carry SQL parameter values into a step; used automatically by the workflow engine.

` + "```edges" + `
[
  {
    "id": "edge_unique_id",
    "fromNodeId": "sourceWidgetId",
    "fromPort": "selectedRow",
    "toNodeId": "targetWidgetId",
    "toPort": "setValues",
    "edgeType": "reactive"
  }
]
` + "```" + `

Rules for edges:
- ` + "`id`" + ` must be unique. Use ` + "`edge_<fromId>_<fromPort>_<toId>_<toPort>`" + ` as a naming convention.
- Emit ` + "`edgeType`" + ` as ` + "`\"reactive\"`" + ` for all widget-to-widget data wiring.
- Only emit edges for explicit wiring you are adding; the workflow engine manages flow edges automatically.
- Do NOT emit an edges block if there is no widget-to-widget wiring needed.

### Worked example: table row selection populates a form

When the user clicks a row in an orders table, the fields of an edit form are pre-populated with
that row's data. Include the wiring edge in an ` + "```edges" + ` block:

` + "```aura" + `
table ordersTable @ root
  with connector="CONNECTOR_ID"
       connectorType="postgres"
       sql="SELECT id, customer, amount FROM orders ORDER BY created_at DESC"
  style { gridX: "0"; gridY: "0"; gridW: "16"; gridH: "12" }
;
form editOrderForm @ root
  text "Edit Order"
  with fields="customer,amount"
       submitLabel="Update Order"
       onSubmit="{{flow:updateOrder}}"
  style { gridX: "16"; gridY: "0"; gridW: "8"; gridH: "8" }
;
` + "```" + `

` + "```edges" + `
[
  {
    "id": "edge_ordersTable_selectedRow_editOrderForm_setValues",
    "fromNodeId": "ordersTable",
    "fromPort": "selectedRow",
    "toNodeId": "editOrderForm",
    "toPort": "setValues",
    "edgeType": "reactive"
  }
]
` + "```" + `

` + "```flows" + `
[
  {
    "ref": "updateOrder",
    "name": "Update Order",
    "trigger_type": "form_submit",
    "trigger_widget_ref": "editOrderForm",
    "requires_approval": true,
    "steps": [
      {
        "name": "Update order row",
        "step_type": "mutation",
        "config": {
          "connector_id": "CONNECTOR_ID",
          "query": "UPDATE orders SET customer = :customer, amount = :amount WHERE id = :id",
          "params": {}
        }
      }
    ]
  }
]
` + "```" + `

## Data Binding (with clause)

### Connecting a table or chart to a data source

Use these ` + "`with`" + ` keys to bind a table or chart widget to a connector:

    with connector="<connector-id>"
         connectorType="<csv|postgres|mysql|mssql|rest|graphql>"
         sql="<value>"

The meaning of the sql field depends on the connector type:
- csv:                  sql is always: SELECT * FROM csv  (the backend ignores this value; it is a required sentinel)
- postgres/mysql/mssql: sql is a normal SQL SELECT statement, e.g. SELECT * FROM users ORDER BY created_at DESC
- rest:                 sql is the endpoint path to call on the base URL, e.g. /users or /orders/recent  (not SQL)
- graphql:              dashboard queries are not supported; do not bind a table to a graphql connector

### Linking a filter widget to a table or chart

Add these ` + "`with`" + ` keys to the table or chart to make it react to a filter:

    with filterWidgets="<filterId>"          (semicolon-separated for multiple)
         filterWidgetColumns="<columnName>"  (semicolon-separated, matching order)

When the user selects a value in the filter widget, the table/chart will only
show rows where ` + "`columnName`" + ` equals that value.  An empty selection shows all rows.

### Populating filter dropdown options from a connector

Add these ` + "`with`" + ` keys to the filter widget to auto-populate its dropdown from a
connector column. Supported connector types: csv, managed (Lima Table), rest.

For CSV and managed connectors:

    with optionsConnector="<connector-id>"
         optionsColumn="<column-name>"
         optionsConnectorType="csv"         ← or "managed"

For REST connectors, also specify which endpoint to call:

    with optionsConnector="<connector-id>"
         optionsEndpoint="<endpoint-path>"  ← e.g. "/categories"
         optionsColumn="<field-name>"
         optionsConnectorType="rest"

## Worked example: table with filter

A table showing all leads from a CSV connector, filtered by industry:

` + "```aura" + `
filter industryFilter @ root
  text "Industry"
  with optionsConnector="CONNECTOR_ID"
       optionsColumn="Industry"
       optionsConnectorType="csv"
  style { gridX: "0"; gridY: "0"; gridW: "6"; gridH: "2" }
;
table leadsTable @ root
  with connector="CONNECTOR_ID"
       connectorType="csv"
       sql="SELECT * FROM csv"
       filterWidgets="industryFilter"
       filterWidgetColumns="Industry"
  style { gridX: "0"; gridY: "2"; gridW: "24"; gridH: "14" }
;
` + "```" + `

Replace CONNECTOR_ID with the actual connector id provided in the context.

## Worked example: form widget

A form that collects name, email, and message fields:

` + "```aura" + `
form contactForm @ root
  text "Contact Us"
  with fields="name,email,message"
       submitLabel="Send"
  style { gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
;
` + "```" + `

The fields key is REQUIRED for every form widget. It must be a comma-separated list of
field names. Omitting it produces an empty form with no inputs.

## Worked example: container as a background panel

A container used as a background card behind a set of KPI tiles:

` + "```aura" + `
container kpiBackground @ root
  with direction="row" gap="16px"
  style { gridX: "0"; gridY: "0"; gridW: "24"; gridH: "4" }
;
kpi activeUsers @ root
  text "Active Users"
  value "{{query.count}}"
  style { gridX: "1"; gridY: "1"; gridW: "6"; gridH: "2" }
;
` + "```" + `

Note: child widgets always use @ root, never @ containerId.
The container is purely a visual layer placed behind other widgets via grid position.

## Rules

1. Always return the complete updated DSL document, not just a diff.
2. Always return the DSL inside a fenced code block (` + "```aura" + ` ... ` + "```" + `). Do not respond with prose only.
3. You may include a short plain-language explanation before the code block.
4. Preserve nodes marked manuallyEdited unless the user explicitly asks to change them.
5. Keep grid placements non-overlapping.
6. For CRUD pages, prefer sensible tables, forms, and actions.
7. Keep IDs short and descriptive.
8. Always use the exact connector IDs from the provided connector list. Do not invent IDs.
9. If the user references a connector by name, match it to the closest name in the available connectors list.
10. Every form widget MUST include with fields="..." listing at least one field name. A form without fields is invalid.
11. Every widget's parent must be @ root. Never use a container's id as a parent — all widgets are siblings at the root level. Use grid coordinates to position widgets on top of or next to a container.
12. Do not use modal or tabs widgets — they are not yet supported in the production runtime.

## Workflow (flow) generation

When the user's request requires a form submission or button click to **write data or run business logic**, you must also generate a workflow. Emit the workflow definitions in a fenced ` + "```flows" + ` code block (JSON array) that appears **after** the ` + "```aura" + ` block.

### When to generate a flows block

Generate a flows block whenever:
- The app has a form that should write to a database or API (use trigger_type: "form_submit")
- The app has a button that should trigger an action (use trigger_type: "button_click")

Do NOT generate a flows block for read-only apps (tables, charts, KPI tiles, filters with no write actions).

### DSL reference syntax

In the Aura DSL, refer to a generated workflow by its ` + "`ref`" + ` using the placeholder ` + "`{{flow:refName}}`" + `:

    form myForm @ root
      with fields="name,email"
           onSubmit="{{flow:submitContact}}"
      style { ... }
    ;

    button myBtn @ root
      text "Delete"
      with onClick="{{flow:deleteRecord}}"
      style { ... }
    ;

The placeholder will be replaced with the real workflow UUID before the DSL is saved.

If an existing workflow is listed in the context block below, reference its real UUID directly in the DSL instead of using a ` + "`{{flow:...}}`" + ` placeholder.

### Flows block format

` + "```flows" + `
[
  {
    "ref": "shortCamelCaseSlug",
    "name": "Human readable workflow name",
    "trigger_type": "form_submit",
    "trigger_widget_ref": "widgetIdFromDSL",
    "requires_approval": true,
    "steps": [
      {
        "name": "Step name",
        "step_type": "mutation",
        "config": {
          "connector_id": "<connector-id-from-context>",
          "query": "INSERT INTO table (col) VALUES (:col)",
          "params": {}
        }
      }
    ]
  }
]
` + "```" + `

### Flows rules

- ` + "`ref`" + `: short camelCase slug, unique within the response. Used in ` + "`{{flow:ref}}`" + ` DSL placeholders.
- ` + "`trigger_type`" + `: one of ` + "`form_submit`" + `, ` + "`button_click`" + `, ` + "`manual`" + `. Match the widget type.
- ` + "`trigger_widget_ref`" + `: the widget id from the DSL that triggers this workflow.
- ` + "`requires_approval`" + `: set ` + "`true`" + ` for any workflow with mutation steps; set ` + "`false`" + ` for query-only flows.
- ` + "`step_type`" + `: one of ` + "`query`" + `, ` + "`mutation`" + `, ` + "`condition`" + `, ` + "`approval_gate`" + `, ` + "`notification`" + `.
- ` + "`config`" + ` for ` + "`query`" + `/` + "`mutation`" + ` steps: ` + "`{ \"connector_id\": \"...\", \"query\": \"...\", \"params\": {} }`" + `.
- ` + "`config`" + ` for ` + "`condition`" + ` steps: ` + "`{ \"expression\": \"<JS expression>\" }`" + `.
- ` + "`config`" + ` for ` + "`approval_gate`" + ` steps: ` + "`{ \"description\": \"...\" }`" + `.
- ` + "`config`" + ` for ` + "`notification`" + ` steps: ` + "`{ \"message\": \"...\" }`" + `.
- Always use the exact connector IDs from the provided connector list. Do not invent IDs.
- Generated workflows are created as ` + "`draft`" + ` and require a builder to review and activate them.

### Worked example: form that inserts a row

` + "```aura" + `
form newOrderForm @ root
  text "New Order"
  with fields="customer_name,amount"
       submitLabel="Place Order"
       onSubmit="{{flow:placeOrder}}"
  style { gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
;
` + "```" + `

` + "```flows" + `
[
  {
    "ref": "placeOrder",
    "name": "Place Order",
    "trigger_type": "form_submit",
    "trigger_widget_ref": "newOrderForm",
    "requires_approval": true,
    "steps": [
      {
        "name": "Insert order row",
        "step_type": "mutation",
        "config": {
          "connector_id": "CONNECTOR_ID",
          "query": "INSERT INTO orders (customer_name, amount) VALUES (:customer_name, :amount)",
          "params": {}
        }
      }
    ]
  }
]
` + "```" + `
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
	settings.TavilyMCPURL = cfg.TavilyMCPURL
	return settings, nil
}

func writeAssistantMessage(ctx context.Context, pool *pgxpool.Pool, threadID, content, newDSL string, edges []dslEdge) error {
	type dslPatch struct {
		NewSource string    `json:"new_source"`
		NewEdges  []dslEdge `json:"new_edges,omitempty"`
	}
	patch, err := json.Marshal(dslPatch{NewSource: newDSL, NewEdges: edges})
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

func updateAppDSL(ctx context.Context, pool *pgxpool.Pool, appID, newDSL string, edges []dslEdge) error {
	var edgesBytes []byte
	if edges != nil {
		var err error
		edgesBytes, err = json.Marshal(edges)
		if err != nil {
			return fmt.Errorf("marshal dsl_edges: %w", err)
		}
	}
	_, err := pool.Exec(ctx,
		`UPDATE apps SET
		    dsl_source = $1,
		    dsl_edges  = COALESCE($3::jsonb, dsl_edges),
		    updated_at = now()
		 WHERE id = $2`,
		newDSL, appID, edgesBytes)
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

		layoutSettings := stageSettings(settings, cfg.LayoutModel)
		flowSettings := stageSettings(settings, cfg.FlowModel)
		if cfg.FlowModel == "" {
			flowSettings = layoutSettings // inherit layout model when flow model not configured
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

		connectors, connErr := fetchWorkspaceConnectors(ctx, pool, payload.WorkspaceID)
		if connErr != nil {
			log.Warn("fetch workspace connectors for generation (non-fatal)", zap.Error(connErr))
		}

		existingWorkflows, wfErr := fetchExistingWorkflows(ctx, pool, payload.AppID)
		if wfErr != nil {
			log.Warn("fetch existing workflows for generation (non-fatal)", zap.Error(wfErr))
		}

		// ── Stage 1: layout ────────────────────────────────────────────────────────
		layoutMessages := buildLayoutMessages(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows)
		layoutCopilotPrompt := buildLayoutCopilotPrompt(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows)
		layoutStart := time.Now()
		layoutResponse, layoutErr := generateLayout(ctx, layoutSettings, layoutMessages, layoutCopilotPrompt)
		if layoutErr != nil {
			log.Error("layout stage failed", zap.Error(layoutErr))
			writeErrorMessage(ctx, pool, payload.ThreadID, layoutErr.Error())
			return layoutErr
		}
		if cfg.LogLLMOutput {
			log.Info("layout stage raw output",
				zap.String("provider", layoutSettings.Provider),
				zap.String("model", layoutSettings.Model),
				zap.String("response", layoutResponse),
			)
		}
		log.Info("layout stage complete",
			zap.Duration("elapsed", time.Since(layoutStart)),
			zap.String("provider", layoutSettings.Provider),
			zap.String("model", layoutSettings.Model),
		)
		responseText := layoutResponse

		newDSL := extractDSL(responseText)
		if newDSL == "" {
			// Model returned explanation text with no DSL code block. Store as a
			// patch-free message so the UI does not misleadingly show "canvas updated"
			// and so the frontend cannot accidentally revert unsaved canvas edits.
			_, writeErr := pool.Exec(ctx,
				`INSERT INTO thread_messages (thread_id, role, content) VALUES ($1, 'assistant', $2)`,
				payload.ThreadID, responseText)
			if writeErr != nil {
				log.Error("write assistant prose message", zap.Error(writeErr))
			}
			_, _ = pool.Exec(ctx, `UPDATE conversation_threads SET updated_at = now() WHERE id = $1`, payload.ThreadID)
			return nil
		}

		// ── Stage 2: flow wiring ──────────────────────────────────────────────────
		// Run the flow model against the validated layout DSL and merge its output
		// (edges/flows blocks) into responseText so the existing extraction path
		// processes it transparently.
		flowMessages := buildFlowMessages(newDSL, latestUserPrompt, connectors, existingWorkflows)
		flowCopilotPrompt := buildFlowCopilotPrompt(newDSL, latestUserPrompt, connectors, existingWorkflows)
		flowStart := time.Now()
		flowFailed := false
		flowResponse, flowErr := generateFlow(ctx, flowSettings, flowMessages, flowCopilotPrompt)
		if flowErr != nil {
			flowFailed = true
			// Flow stage failure is non-fatal: log and continue with layout-only result.
			log.Warn("flow stage failed; continuing with layout-only result",
				zap.Error(flowErr),
				zap.Duration("elapsed", time.Since(flowStart)),
			)
		} else {
			if cfg.LogLLMOutput {
				log.Info("flow stage raw output",
					zap.String("provider", flowSettings.Provider),
					zap.String("model", flowSettings.Model),
					zap.String("response", flowResponse),
				)
			}
			log.Info("flow stage complete",
				zap.Duration("elapsed", time.Since(flowStart)),
				zap.String("provider", flowSettings.Provider),
				zap.String("model", flowSettings.Model),
			)
			// Merge the flow response's edges/flows blocks into responseText.
			// The existing extractFlows / extractEdges calls below will parse them.
			responseText = responseText + "\n" + flowResponse
		}
		if flowFailed {
			responseText += "\n\n_Note: widget wiring could not be generated automatically. You can wire widgets manually in the canvas._"
		}

		// Extract and persist AI-generated workflows. Must happen before DSL
		// validation so that {{flow:ref}} placeholders can be substituted with
		// real UUIDs, producing a valid DSL document.
		generatedFlows, flowsErr := extractFlows(responseText)
		if flowsErr != nil {
			log.Warn("flows block parse error (non-fatal)", zap.Error(flowsErr))
		}

		// Extract any explicit widget-to-widget wiring edges the AI emitted.
		generatedEdges, edgesErr := extractEdges(responseText)
		if edgesErr != nil {
			log.Warn("edges block parse error (non-fatal)", zap.Error(edgesErr))
		}

		var allEdges []dslEdge // nil → keep existing dsl_edges untouched
		if len(generatedFlows) > 0 || len(generatedEdges) > 0 {
			// Fetch existing edges once; we'll merge everything into them.
			existing, existingEdgeErr := fetchAppEdges(ctx, pool, payload.AppID)
			if existingEdgeErr != nil {
				log.Warn("fetch existing edges (non-fatal)", zap.Error(existingEdgeErr))
			}
			allEdges = existing

			if len(generatedFlows) > 0 {
				refToID, persistErr := persistGeneratedFlows(ctx, pool, payload.WorkspaceID, payload.AppID, payload.UserID, generatedFlows)
				if persistErr != nil {
					log.Warn("persist generated flows (non-fatal)", zap.Error(persistErr))
				} else if len(refToID) > 0 {
					newDSL = substituteFlowRefs(newDSL, refToID)

					// Build flow group + step node DSL and async trigger edges.
					flowNodesDSL, flowEdges := buildFlowNodesAndEdges(generatedFlows, refToID)
					if flowNodesDSL != "" {
						newDSL = newDSL + "\n" + flowNodesDSL
					}
					allEdges = append(allEdges, flowEdges...)

					log.Info("generated workflows persisted",
						zap.Int("count", len(refToID)),
						zap.Int("flow_edges", len(flowEdges)),
						zap.String("app_id", payload.AppID))
				}
			}

			// Append explicit wiring edges emitted by the AI (e.g. table.selectedRow → form.setValues).
			if len(generatedEdges) > 0 {
				allEdges = append(allEdges, generatedEdges...)
				log.Info("applied explicit widget edges",
					zap.Int("count", len(generatedEdges)),
					zap.String("app_id", payload.AppID))
			}
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

		if err := updateAppDSL(ctx, pool, payload.AppID, resultDSL, allEdges); err != nil {
			log.Error("update app dsl", zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, "failed to save generated layout")
			return err
		}

		// Log enough of resultDSL to identify model-specific format issues.
		dslPreview := resultDSL
		if len(dslPreview) > 300 {
			dslPreview = dslPreview[:300] + "…"
		}
		log.Debug("storing result DSL",
			zap.Int("bytes", len(resultDSL)),
			zap.Int("edges", len(allEdges)),
			zap.String("preview", dslPreview),
		)

		explanation := strings.TrimSpace(auraBlockRe.ReplaceAllString(flowsBlockRe.ReplaceAllString(edgesBlockRe.ReplaceAllString(responseText, ""), ""), ""))
		if explanation == "" {
			explanation = "Updated the app layout."
		}

		if err := writeAssistantMessage(ctx, pool, payload.ThreadID, explanation, resultDSL, allEdges); err != nil {
			log.Error("write assistant message", zap.Error(err))
			return err
		}

		log.Info("generation job complete", zap.String("thread_id", payload.ThreadID), zap.String("provider", settings.Provider), zap.String("model", settings.Model), zap.Bool("flowFailed", flowFailed))
		return nil
	}
}
