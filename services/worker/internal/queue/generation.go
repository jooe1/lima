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
var actionTokenRe = regexp.MustCompile(`(?m)^\s*action\s+([^\s;]+)`)

// genWorkflowStep is the shape the AI emits for a single workflow step.
type genWorkflowStep struct {
	Ref                string         `json:"ref,omitempty"`
	Name               string         `json:"name"`
	StepType           string         `json:"step_type"`
	Config             map[string]any `json:"config"`
	NextStepRef        string         `json:"next_step_ref,omitempty"`
	FalseBranchStepRef string         `json:"false_branch_step_ref,omitempty"`
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
	sb.WriteString("Prefer the connector whose name and columns best match the requested entity. If a matching managed connector exists, use it for both the table binding and any create/update/delete workflow instead of leaving the mutation step unconfigured.\n")
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

func buildLayoutCopilotPrompt(currentDSL, latestUserPrompt string, history []msgRow, connectors []genConnector, existingWorkflows []existingWorkflowInfo, plan *appPlan) string {
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	if planCtx := buildPlanContextBlock(plan); planCtx != "" {
		builder.WriteString("\n")
		builder.WriteString(planCtx)
	}
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

func buildCopilotPrompt(currentDSL, latestUserPrompt string, history []msgRow, connectors []genConnector, existingWorkflows []existingWorkflowInfo, plan *appPlan) string {
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	if planCtx := buildPlanContextBlock(plan); planCtx != "" {
		builder.WriteString("\n")
		builder.WriteString(planCtx)
	}
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
	plan *appPlan,
) []chatMessage {
	msgs := []chatMessage{
		{Role: "system", Content: layoutSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "system", Content: buildWorkflowContextBlock(existingWorkflows)},
	}
	if planCtx := buildPlanContextBlock(plan); planCtx != "" {
		msgs = append(msgs, chatMessage{Role: "system", Content: planCtx})
	}
	msgs = append(msgs, chatMessage{Role: "system", Content: "Current app DSL:\n```aura\n" + nodeOnlyDSL(currentDSL) + "\n```"})
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
	plan *appPlan,
) []chatMessage {
	portManifest := BuildPortManifest()
	msgs := []chatMessage{
		{Role: "system", Content: flowSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "system", Content: buildWorkflowContextBlock(existingWorkflows)},
		{Role: "system", Content: "## Widget port reference\n\n" + portManifest},
	}
	if planCtx := buildFlowPlanContextBlock(plan); planCtx != "" {
		msgs = append(msgs, chatMessage{Role: "system", Content: planCtx})
	}
	msgs = append(msgs, chatMessage{Role: "system", Content: "Finalised widget layout (Stage 1 output):\n```aura\n" + validatedDSL + "\n```"})
	msgs = append(msgs, chatMessage{Role: "user", Content: "Original user intent: " + latestUserPrompt + "\n\nEmit only the wiring (edges and/or flows blocks) required by the user's intent. If no wiring is needed, respond with a single sentence explaining why."})
	return msgs
}

// buildFlowCopilotPrompt constructs the Copilot prompt string for the flow
// generation stage.
func buildFlowCopilotPrompt(
	validatedDSL, latestUserPrompt string,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
	plan *appPlan,
) string {
	portManifest := BuildPortManifest()
	var builder strings.Builder
	builder.WriteString(buildConnectorContextBlock(connectors))
	builder.WriteString("\n")
	builder.WriteString(buildWorkflowContextBlock(existingWorkflows))
	builder.WriteString("\n## Widget port reference\n\n")
	builder.WriteString(portManifest)
	if planCtx := buildFlowPlanContextBlock(plan); planCtx != "" {
		builder.WriteString("\n")
		builder.WriteString(planCtx)
	}
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
	sb.WriteString("Existing workflows for this app (reference these UUIDs directly in the action clause — do NOT wrap them in {{flow:...}}):\n")
	for _, w := range workflows {
		fmt.Fprintf(&sb, "- id=%q  name=%q  trigger_type=%s\n", w.id, w.name, w.triggerType)
	}
	return sb.String()
}

// ── Stage 0: planning ─────────────────────────────────────────────────────────

// appPlan is the structured output of Stage 0 (the planning stage). It grounds
// layout and flow generation in a specific connector and CRUD contract so the
// model does not have to infer data-source intent from prose alone.
type appPlan struct {
	Intent          string   `json:"intent"` // "crud", "read_only", "informational"
	ConnectorID     string   `json:"connector_id"`
	ConnectorType   string   `json:"connector_type"`
	Entity          string   `json:"entity"`
	FormFields      []string `json:"form_fields"`
	TableFields     []string `json:"table_fields"`
	CRUDMode        string   `json:"crud_mode"` // "insert", "update", "upsert"
	PrimaryKeyField string   `json:"primary_key_field"`
	WorkflowName    string   `json:"workflow_name"`
	WorkflowRef     string   `json:"workflow_ref"`
}

func (p *appPlan) isCRUD() bool {
	return p != nil && p.Intent == "crud"
}

// planSystemPrompt is the system prompt for Stage 0 (planning).
const planSystemPrompt = `You are the planning stage of an AI-driven UI generator for an internal tools platform called Lima.

Your sole output is a single JSON object — no explanation, no markdown, no code fences.

Given a user request and a list of available connectors, decide:
1. Is this a CRUD (create/update/delete) request, a read-only dashboard, or something else?
2. If CRUD: which connector best matches the entity being operated on?
3. Which of that connector's columns belong in the form vs the table?

Output a JSON object with exactly these keys:
{
  "intent": "crud" | "read_only" | "informational",
  "connector_id": "<exact id from the connector list, or empty string>",
  "connector_type": "<managed | postgres | mysql | mssql | csv | rest | graphql, or empty>",
  "entity": "<lowercase singular entity name, e.g. order, lead, contact>",
  "form_fields": ["<column>", ...],
  "table_fields": ["<column>", ...],
  "crud_mode": "insert" | "update" | "upsert" | "",
  "primary_key_field": "<column used as row identifier for update/upsert, or empty>",
  "workflow_name": "<Human readable name, e.g. Save Order>",
  "workflow_ref": "<camelCase slug matching workflow_name, e.g. saveOrder>"
}

Rules:
- connector_id MUST be an exact id value from the connector list. Never invent one.
- If the request involves saving, creating, updating, or deleting data and a matching connector exists, set intent to "crud".
- form_fields and table_fields must be column names from that connector's columns list.
- If intent is not "crud", set connector_id, form_fields, table_fields, crud_mode, primary_key_field, workflow_name, workflow_ref all to empty string or empty array.
- For managed connectors: if a column is obviously a primary key (named id, ID, OrderID, row_id, etc.), set crud_mode to "upsert" and primary_key_field to that column. Otherwise set crud_mode to "insert".
- For update/upsert CRUD plans, form_fields MUST include primary_key_field so the submitted form values contain the row identifier.
- Output JSON only. No other text before or after.
`

// buildPlanMessages constructs the message slice for Stage 0 (planning).
func buildPlanMessages(userPrompt string, connectors []genConnector) []chatMessage {
	return []chatMessage{
		{Role: "system", Content: planSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "user", Content: userPrompt},
	}
}

// parsePlanResponse decodes a raw LLM response from Stage 0 into an appPlan.
// The model may wrap the JSON in markdown fences despite the instruction; this
// function strips them before parsing.
func parsePlanResponse(raw string) (*appPlan, error) {
	raw = strings.TrimSpace(raw)
	for _, fence := range []string{"```json", "```"} {
		if strings.HasPrefix(raw, fence) {
			raw = strings.TrimPrefix(raw, fence)
		}
	}
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)
	var plan appPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		return nil, fmt.Errorf("parse plan JSON: %w", err)
	}
	normalizeAppPlan(&plan)
	return &plan, nil
}

func normalizeAppPlan(plan *appPlan) {
	if plan == nil || !plan.isCRUD() || plan.PrimaryKeyField == "" {
		return
	}
	if plan.CRUDMode != "update" && plan.CRUDMode != "upsert" {
		return
	}
	for _, field := range plan.FormFields {
		if field == plan.PrimaryKeyField {
			return
		}
	}
	plan.FormFields = append([]string{plan.PrimaryKeyField}, plan.FormFields...)
}

// generatePlan runs Stage 0 and returns a grounded appPlan.
// Returns nil, nil for unsupported providers.
func generatePlan(ctx context.Context, settings userAISettings, userPrompt string, connectors []genConnector) (*appPlan, error) {
	var raw string
	var err error
	switch settings.Provider {
	case "openai":
		raw, err = callOpenAI(ctx, settings, buildPlanMessages(userPrompt, connectors))
	case "github_copilot":
		var sb strings.Builder
		sb.WriteString(buildConnectorContextBlock(connectors))
		sb.WriteString("\n\nUser request: ")
		sb.WriteString(userPrompt)
		raw, err = callGitHubCopilot(ctx, settings, sb.String(), planSystemPrompt)
	default:
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parsePlanResponse(raw)
}

// buildPlanContextBlock renders an appPlan into a concise instruction block
// injected into the layout-generation prompt.
func buildPlanContextBlock(plan *appPlan) string {
	if plan == nil || plan.Intent == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("## Generation plan — follow exactly\n")
	fmt.Fprintf(&sb, "intent: %s\n", plan.Intent)
	if plan.ConnectorID != "" {
		fmt.Fprintf(&sb, "connector_id: %s\n", plan.ConnectorID)
		fmt.Fprintf(&sb, "connector_type: %s\n", plan.ConnectorType)
	}
	if plan.Entity != "" {
		fmt.Fprintf(&sb, "entity: %s\n", plan.Entity)
	}
	if len(plan.FormFields) > 0 {
		fmt.Fprintf(&sb, "form_fields: %s\n", strings.Join(plan.FormFields, ", "))
	}
	if len(plan.TableFields) > 0 {
		fmt.Fprintf(&sb, "table_fields: %s\n", strings.Join(plan.TableFields, ", "))
	}
	if plan.CRUDMode != "" {
		fmt.Fprintf(&sb, "crud_mode: %s\n", plan.CRUDMode)
	}
	if plan.PrimaryKeyField != "" {
		fmt.Fprintf(&sb, "primary_key_field: %s\n", plan.PrimaryKeyField)
		if plan.CRUDMode == "update" || plan.CRUDMode == "upsert" {
			fmt.Fprintf(&sb, "For update/upsert forms, include %s in form_fields so the submitted values object carries the row identifier.\n", plan.PrimaryKeyField)
		}
	}
	if plan.WorkflowRef != "" {
		fmt.Fprintf(&sb, "workflow_ref: %s — use as action {{flow:%s}} on the triggering form or button\n", plan.WorkflowRef, plan.WorkflowRef)
	}
	if plan.WorkflowName != "" {
		fmt.Fprintf(&sb, "workflow_name: %s\n", plan.WorkflowName)
	}
	return sb.String()
}

// buildFlowPlanContextBlock renders an appPlan into a strict constraint block
// for the flow-generation stage, requiring exact connector binding.
func buildFlowPlanContextBlock(plan *appPlan) string {
	if !plan.isCRUD() || plan.ConnectorID == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("## REQUIRED: generation plan — follow exactly\n")
	fmt.Fprintf(&sb, "This is a CRUD app for entity '%s'. You MUST emit a flows block.\n", plan.Entity)
	fmt.Fprintf(&sb, "Every mutation step config MUST include connector_id: %q\n", plan.ConnectorID)
	fmt.Fprintf(&sb, "connector_type: %s\n", plan.ConnectorType)
	if plan.ConnectorType == "managed" {
		crudMode := plan.CRUDMode
		if crudMode == "" {
			crudMode = "insert"
		}
		if crudMode == "upsert" {
			fmt.Fprintf(&sb, "operation_goal: create_or_update\n")
			if plan.PrimaryKeyField != "" {
				fmt.Fprintf(&sb, "For managed connectors, do NOT emit mutation operation \"upsert\". Instead emit a condition step that checks {{input.%s}} and branches to an update step on true and an insert step on false.\n", plan.PrimaryKeyField)
			}
		} else {
			fmt.Fprintf(&sb, "operation: %s\n", crudMode)
		}
		if plan.PrimaryKeyField != "" {
			fmt.Fprintf(&sb, "primary_key_field: %s — set row_id to {{input.%s}} in update/delete steps.\n", plan.PrimaryKeyField, plan.PrimaryKeyField)
			fmt.Fprintf(&sb, "For form_submit workflows, the workflow input already is the submitted form values object. No extra prep step is needed before the flow.\n")
		}
		if len(plan.FormFields) > 0 {
			fmt.Fprintf(&sb, "data fields: %s — bind each to {{input.<field>}} in the data map.\n", strings.Join(plan.FormFields, ", "))
		}
	}
	if plan.WorkflowRef != "" {
		fmt.Fprintf(&sb, "workflow_ref: %s — emit a flow with this exact ref to match the action placeholder in the layout.\n", plan.WorkflowRef)
	}
	if plan.WorkflowName != "" {
		fmt.Fprintf(&sb, "workflow_name: %s\n", plan.WorkflowName)
	}
	return sb.String()
}

// applyPlanToFlows patches AI-generated workflows using the plan to fill in any
// connector_id and config fields that the model failed to emit. This ensures
// that even a half-configured mutation step ends up with the correct connector
// and a usable config.
func applyPlanToFlows(flows []genWorkflow, plan *appPlan) {
	if !plan.isCRUD() || plan.ConnectorID == "" {
		return
	}
	for i := range flows {
		expandManagedUpsertFlow(&flows[i], plan)
		for j := range flows[i].Steps {
			step := &flows[i].Steps[j]
			if step.StepType != "mutation" {
				continue
			}
			if step.Config == nil {
				step.Config = map[string]any{}
			}
			// Fill missing connector_id from plan.
			if cid, _ := step.Config["connector_id"].(string); cid == "" {
				step.Config["connector_id"] = plan.ConnectorID
			}
			// For managed connectors, fill missing operation and data.
			if plan.ConnectorType == "managed" {
				if op, _ := step.Config["operation"].(string); op == "" {
					mode := plan.CRUDMode
					if mode == "" || mode == "upsert" {
						mode = "insert"
					}
					step.Config["operation"] = mode
				}
				if _, ok := step.Config["data"]; !ok && len(plan.FormFields) > 0 {
					step.Config["data"] = buildManagedMutationData(plan)
				}
				if plan.PrimaryKeyField != "" {
					if op, _ := step.Config["operation"].(string); op == "update" || op == "delete" {
						if rid, _ := step.Config["row_id"].(string); rid == "" {
							step.Config["row_id"] = "{{input." + plan.PrimaryKeyField + "}}"
						}
					}
				}
			}
		}
	}
}

func buildManagedMutationData(plan *appPlan) map[string]any {
	data := make(map[string]any, len(plan.FormFields))
	for _, field := range plan.FormFields {
		data[field] = "{{input." + field + "}}"
	}
	return data
}

func cloneConfig(src map[string]any) map[string]any {
	if len(src) == 0 {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for key, value := range src {
		dst[key] = value
	}
	return dst
}

func expandManagedUpsertFlow(flow *genWorkflow, plan *appPlan) {
	if plan == nil || plan.ConnectorType != "managed" || plan.CRUDMode != "upsert" || plan.PrimaryKeyField == "" {
		return
	}
	if len(flow.Steps) != 1 || flow.Steps[0].StepType != "mutation" {
		return
	}
	base := flow.Steps[0]
	baseConfig := cloneConfig(base.Config)
	if _, ok := baseConfig["data"]; !ok && len(plan.FormFields) > 0 {
		baseConfig["data"] = buildManagedMutationData(plan)
	}
	baseConfig["connector_id"] = plan.ConnectorID

	conditionRef := flow.Ref + "_hasExistingRow"
	updateRef := flow.Ref + "_update"
	insertRef := flow.Ref + "_insert"

	updateConfig := cloneConfig(baseConfig)
	updateConfig["operation"] = "update"
	updateConfig["row_id"] = "{{input." + plan.PrimaryKeyField + "}}"

	insertConfig := cloneConfig(baseConfig)
	insertConfig["operation"] = "insert"
	delete(insertConfig, "row_id")

	flow.Steps = []genWorkflowStep{
		{
			Ref:      conditionRef,
			Name:     "Existing row?",
			StepType: "condition",
			Config: map[string]any{
				"left":  "{{input." + plan.PrimaryKeyField + "}}",
				"op":    "neq",
				"right": "",
			},
			NextStepRef:        updateRef,
			FalseBranchStepRef: insertRef,
		},
		{
			Ref:      updateRef,
			Name:     "Update row",
			StepType: "mutation",
			Config:   updateConfig,
		},
		{
			Ref:      insertRef,
			Name:     "Insert row",
			StepType: "mutation",
			Config:   insertConfig,
		},
	}
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
	for fi := range flows {
		f := &flows[fi]
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

		stepRefToID := make(map[string]string, len(f.Steps))
		stepIDsByIndex := make([]string, len(f.Steps))
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
			var stepID string
			if err := pool.QueryRow(ctx, `
				INSERT INTO workflow_steps
				    (workflow_id, step_order, name, step_type, config, ai_generated)
				VALUES ($1,$2,$3,$4,$5,true)
				RETURNING id`,
				wfID, i, name, step.StepType, cfgBytes,
			).Scan(&stepID); err != nil {
				return nil, fmt.Errorf("insert step %d for workflow %q: %w", i, f.Ref, err)
			}
			stepIDsByIndex[i] = stepID
			stepRef := strings.TrimSpace(step.Ref)
			if stepRef == "" {
				stepRef = fmt.Sprintf("%s_step_%d", f.Ref, i)
			}
			stepRefToID[stepRef] = stepID
		}

		for i, step := range f.Steps {
			if !validStepTypes[step.StepType] || stepIDsByIndex[i] == "" {
				continue
			}
			var nextStepID *string
			if targetID, ok := stepRefToID[strings.TrimSpace(step.NextStepRef)]; ok {
				nextStepID = &targetID
			}
			var falseBranchStepID *string
			if targetID, ok := stepRefToID[strings.TrimSpace(step.FalseBranchStepRef)]; ok {
				falseBranchStepID = &targetID
			}
			if nextStepID == nil && falseBranchStepID == nil {
				continue
			}
			if _, err := pool.Exec(ctx, `
				UPDATE workflow_steps
				SET next_step_id = $2,
				    false_branch_step_id = $3
				WHERE id = $1`,
				stepIDsByIndex[i], nextStepID, falseBranchStepID,
			); err != nil {
				return nil, fmt.Errorf("link step branches for workflow %q: %w", f.Ref, err)
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

// deriveActionWidgetRefs scans DSL statements and returns action token -> widget
// id for nodes that declare an action clause.
func deriveActionWidgetRefs(dsl string) map[string]string {
	stmts, order, err := parseDSLStatements(dsl)
	if err != nil || len(order) == 0 {
		return nil
	}

	result := make(map[string]string)
	for _, nodeID := range order {
		stmt := stmts[nodeID]
		match := actionTokenRe.FindStringSubmatch(stmt)
		if len(match) != 2 {
			continue
		}
		result[match[1]] = nodeID
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// reconcileGeneratedFlowTriggerRefs aligns generated flow trigger widget refs
// with the authoritative layout DSL before workflows are persisted.
func reconcileGeneratedFlowTriggerRefs(flows []genWorkflow, dsl string) {
	actionToWidget := deriveActionWidgetRefs(dsl)
	if len(actionToWidget) == 0 {
		return
	}
	for i := range flows {
		token := "{{flow:" + flows[i].Ref + "}}"
		if widgetID := actionToWidget[token]; widgetID != "" {
			flows[i].TriggerWidgetRef = widgetID
		}
	}
}

// deriveTriggerWidgets scans a substituted DSL (where {{flow:ref}} has already
// been replaced with real UUIDs) for `action <uuid>` clauses and returns a map
// of workflow UUID → triggering widget ID. This is used as a reliable fallback
// when the AI did not emit trigger_widget_ref, or emitted the wrong value.
func deriveTriggerWidgets(dsl string, refToID map[string]string) map[string]string {
	actionToWidget := deriveActionWidgetRefs(dsl)
	if len(actionToWidget) == 0 {
		return nil
	}

	result := make(map[string]string)
	for _, wfUUID := range refToID {
		if widgetID := actionToWidget[wfUUID]; widgetID != "" {
			result[wfUUID] = widgetID
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func defaultAsyncSourcePort(stepType string) string {
	switch stepType {
	case "query":
		return "result"
	case "mutation":
		return "result"
	case "condition":
		return "trueBranch"
	case "approval_gate":
		return "approved"
	case "notification":
		return "sent"
	case "transform":
		return "output"
	case "http":
		return "ok"
	default:
		return "result"
	}
}

// buildFlowNodesAndEdges generates Aura DSL statements (flow:group + step:*
// nodes) and async edges for every persisted workflow. The dsl parameter is
// the substituted layout DSL ({{flow:ref}} already replaced) used to derive
// trigger widget refs when the AI omitted trigger_widget_ref.
func buildFlowNodesAndEdges(flows []genWorkflow, refToID map[string]string, dsl string) (string, []dslEdge) {
	// Derive trigger widgets from the DSL as a reliable fallback.
	derived := deriveTriggerWidgets(dsl, refToID)
	var dslParts []string
	var edges []dslEdge

	for gi, f := range flows {
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

		// Position the group in the flow canvas. Multiple groups are laid out
		// side-by-side with enough vertical space for their steps.
		stepCount := len(f.Steps)
		groupH := 80 + stepCount*140
		groupX := 520 + gi*380
		groupY := 40

		// Flow group node (visual container in the Flow View). Uses @ root and
		// carries its own flowX/Y/W/H positioning via the style clause.
		dslParts = append(dslParts, fmt.Sprintf(
			"flow:group %s @ root\n  text %q\n  style { flowX: %q; flowY: %q; flowW: \"300\"; flowH: %q }\n;",
			groupID, name,
			fmt.Sprintf("%d", groupX), fmt.Sprintf("%d", groupY),
			fmt.Sprintf("%d", groupH),
		))

		// Step nodes + step-to-step edges.
		stepRefToNodeID := make(map[string]string, len(f.Steps))
		for i, step := range f.Steps {
			stepNodeID := fmt.Sprintf("%s_step%d", f.Ref, i)
			stepRef := strings.TrimSpace(step.Ref)
			if stepRef == "" {
				stepRef = fmt.Sprintf("%s_step_%d", f.Ref, i)
			}
			stepRefToNodeID[stepRef] = stepNodeID
		}
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

			// Embed key config fields as with keys so the Flow canvas can
			// display a config summary (e.g. "connector: conn_abc123") instead
			// of "Not configured". Only top-level string scalars are inlined;
			// complex nested objects (data, params) are skipped.
			withLine := buildStepWithLine(step.Config)

			// Step nodes use @ root in the DSL but carry style.parentGroupId so
			// the React Flow canvas correctly places them inside the group node.
			// flowX/flowY are relative to the group's top-left corner.
			stepX := 30
			stepY := 60 + i*140
			dslParts = append(dslParts, fmt.Sprintf(
				"step:%s %s @ root\n  text %q\n%s  style { parentGroupId: %q; flowX: %q; flowY: %q }\n;",
				stepType, stepNodeID, stepName,
				withLine,
				groupID,
				fmt.Sprintf("%d", stepX), fmt.Sprintf("%d", stepY),
			))
		}
		for i, step := range f.Steps {
			stepNodeID := fmt.Sprintf("%s_step%d", f.Ref, i)
			stepType := step.StepType
			if !validStepTypes[stepType] {
				stepType = "query"
			}
			defaultPort := defaultAsyncSourcePort(stepType)

			if step.StepType == "condition" {
				if targetID, ok := stepRefToNodeID[strings.TrimSpace(step.NextStepRef)]; ok {
					edges = append(edges, dslEdge{
						ID:         fmt.Sprintf("edge_%s_trueBranch_%s_run", stepNodeID, targetID),
						FromNodeID: stepNodeID,
						FromPort:   "trueBranch",
						ToNodeID:   targetID,
						ToPort:     "run",
						EdgeType:   "async",
					})
				} else if i+1 < len(f.Steps) {
					targetID := fmt.Sprintf("%s_step%d", f.Ref, i+1)
					edges = append(edges, dslEdge{
						ID:         fmt.Sprintf("edge_%s_trueBranch_%s_run", stepNodeID, targetID),
						FromNodeID: stepNodeID,
						FromPort:   "trueBranch",
						ToNodeID:   targetID,
						ToPort:     "run",
						EdgeType:   "async",
					})
				}
				if targetID, ok := stepRefToNodeID[strings.TrimSpace(step.FalseBranchStepRef)]; ok {
					edges = append(edges, dslEdge{
						ID:         fmt.Sprintf("edge_%s_falseBranch_%s_run", stepNodeID, targetID),
						FromNodeID: stepNodeID,
						FromPort:   "falseBranch",
						ToNodeID:   targetID,
						ToPort:     "run",
						EdgeType:   "async",
					})
				}
				continue
			}

			if targetID, ok := stepRefToNodeID[strings.TrimSpace(step.NextStepRef)]; ok {
				edges = append(edges, dslEdge{
					ID:         fmt.Sprintf("edge_%s_%s_%s_run", stepNodeID, defaultPort, targetID),
					FromNodeID: stepNodeID,
					FromPort:   defaultPort,
					ToNodeID:   targetID,
					ToPort:     "run",
					EdgeType:   "async",
				})
			} else if i+1 < len(f.Steps) {
				targetID := fmt.Sprintf("%s_step%d", f.Ref, i+1)
				edges = append(edges, dslEdge{
					ID:         fmt.Sprintf("edge_%s_%s_%s_run", stepNodeID, defaultPort, targetID),
					FromNodeID: stepNodeID,
					FromPort:   defaultPort,
					ToNodeID:   targetID,
					ToPort:     "run",
					EdgeType:   "async",
				})
			}
		}

		// Widget trigger edge: form.values / button.clicked → first step.run.
		// Use the AI-provided TriggerWidgetRef when available, falling back to
		// the widget that has `action <workflowUUID>` in the DSL.
		triggerRef := f.TriggerWidgetRef
		wfUUID := refToID[f.Ref]
		if triggerRef == "" && wfUUID != "" {
			triggerRef = derived[wfUUID]
		}
		if triggerRef != "" {
			firstStepID := fmt.Sprintf("%s_step0", f.Ref)
			// The form widget fires its current values on submit via the "values"
			// output port (the form has no "submitted" port in the widget catalog).
			// Buttons fire via "clicked".
			fromPort := "values"
			if f.TriggerType == "button_click" {
				fromPort = "clicked"
			}
			edges = append(edges, dslEdge{
				ID:         fmt.Sprintf("edge_%s_%s_%s_run", triggerRef, fromPort, firstStepID),
				FromNodeID: triggerRef,
				FromPort:   fromPort,
				ToNodeID:   firstStepID,
				ToPort:     "run",
				EdgeType:   "async",
			})
		}
	}

	return strings.Join(dslParts, "\n"), edges
}

// buildStepWithLine produces a DSL "with ..." line from the top-level scalar
// fields of a step config map. Returns an empty string when there is nothing
// to embed. Only fields used by the Flow canvas config-summary logic are
// included (connector_id, operation, sql, row_id). Complex nested values
// (data, params) are intentionally omitted — they live in the DB config column.
func buildStepWithLine(config map[string]any) string {
	if len(config) == 0 {
		return ""
	}
	// Priority order matches what FlowCanvas configSummary reads first.
	keys := []string{"connector_id", "operation", "sql", "row_id"}
	var parts []string
	for _, k := range keys {
		v, ok := config[k]
		if !ok {
			continue
		}
		sv, isStr := v.(string)
		if !isStr || sv == "" {
			continue
		}
		// Escape any embedded double-quotes in the value.
		parts = append(parts, fmt.Sprintf("%s=%q", k, sv))
	}
	if len(parts) == 0 {
		return ""
	}
	return "  with " + strings.Join(parts, " ") + "\n"
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
  - Optional with keys: direction ("row" or "column", default "column"), gap (CSS value, default "16px").
  - All other widgets that sit inside it visually still use @ root as their parent (the canvas is always flat).
  - Do NOT set other widgets' parent to a container id — they must stay @ root.
- text: static or dynamic label
- button: clickable action
  - Use the text clause for the visible label.
  - If the button should run a workflow, use the action clause with either an existing workflow UUID or a placeholder such as action {{flow:deleteOrder}}.
- table: data grid — MUST include with connector, connectorType, and (for SQL connectors) sql keys.
- form: data-entry form — MUST include a fields key listing every input field name.
  - Required with keys: fields (comma-separated field names, e.g. with fields="name,email,phone").
  - Optional style key: submitLabel (button text, default "Submit").
  - If the form should submit to a workflow, use the action clause with either an existing workflow UUID or a placeholder such as action {{flow:saveOrder}}.
	- For update/upsert CRUD forms, include the primary key field in fields so the submit values object contains the row identifier.
- chart: chart widget — same connector binding keys as table.
- kpi: single metric display
- filter: filter control — can be linked to a table/chart with filterWidgets/filterWidgetColumns on that table.
- modal: overlay dialog (not yet supported — do not use)
- tabs: tabbed container (not yet supported — do not use)
- markdown: rich text block

## Data Binding (connecting widgets to connectors)

### Connecting a table or chart to a data source

Use these with keys to bind a table or chart widget to a connector:

    with connector="<connector-id>"
         connectorType="<csv|managed|postgres|mysql|mssql|rest|graphql>"
         sql="<value>"

The meaning of sql depends on the connector type:
- csv:                  sql must be exactly: SELECT * FROM csv  (required sentinel value)
- managed:              omit sql entirely; Lima returns all rows from the managed table directly
- postgres/mysql/mssql: sql is a full SELECT statement, e.g. SELECT id, name, email FROM users ORDER BY created_at DESC
- rest:                 sql is the endpoint path, e.g. /users or /orders/recent  (not SQL)
- graphql:              tables cannot be bound to graphql connectors — do not attempt

Always use the exact connector id from the connector list provided in context. Never invent an id.

### Linking a filter widget to a table or chart

Add these with keys to the table or chart (not the filter) to make it react to a filter widget:

    with filterWidgets="<filterId>"           (semicolon-separated for multiple filters)
         filterWidgetColumns="<columnName>"   (semicolon-separated, same order as filterWidgets)

### Populating a filter widget's dropdown from a connector

Add these with keys to the filter widget itself:

For csv and managed connectors:

    with optionsConnector="<connector-id>"
         optionsColumn="<column-name>"
         optionsConnectorType="csv"    (or "managed")

For rest connectors:

    with optionsConnector="<connector-id>"
         optionsEndpoint="<endpoint-path>"
         optionsColumn="<field-name>"
         optionsConnectorType="rest"

## Workflow trigger placeholders in layout stage

If the user's request includes create/save/update/delete behavior, the triggering form or button MUST include an action placeholder in the layout DSL so the flow stage can resolve it later.

    form orderForm @ root
      with fields="customer,amount"
      action {{flow:saveOrder}}
      style { submitLabel: "Save Order"; gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
    ;

    button deleteBtn @ root
      text "Delete"
      action {{flow:deleteOrder}}
      style { gridX: "0"; gridY: "11"; gridW: "4"; gridH: "2" }
    ;

When editing an existing app, preserve a valid action UUID or replace it with a new {{flow:ref}} placeholder only if the requested workflow behavior is changing.

## Worked example: table bound to a managed connector

A table showing all orders from a managed connector:

` + "```" + `aura
table ordersTable @ root
  with connector="conn_abc123"
       connectorType="managed"
  style { gridX: "0"; gridY: "0"; gridW: "24"; gridH: "12" }
;
` + "```" + `

## Worked example: table bound to a postgres connector

` + "```" + `aura
table ordersTable @ root
  with connector="conn_pg001"
       connectorType="postgres"
       sql="SELECT id, customer, amount, status FROM orders ORDER BY created_at DESC"
  style { gridX: "0"; gridY: "0"; gridW: "24"; gridH: "12" }
;
` + "```" + `

## Worked example: table with a filter

` + "```" + `aura
filter statusFilter @ root
  text "Status"
  with optionsConnector="conn_abc123"
       optionsColumn="status"
       optionsConnectorType="managed"
  style { gridX: "0"; gridY: "0"; gridW: "6"; gridH: "2" }
;
table ordersTable @ root
  with connector="conn_abc123"
       connectorType="managed"
       filterWidgets="statusFilter"
       filterWidgetColumns="status"
  style { gridX: "0"; gridY: "2"; gridW: "24"; gridH: "12" }
;
` + "```" + `

## Worked example: CRUD app (table + form, clicking a row pre-populates the form)

` + "```" + `aura
table ordersTable @ root
  with connector="conn_abc123"
       connectorType="managed"
  style { gridX: "0"; gridY: "0"; gridW: "14"; gridH: "14" }
;
form editOrderForm @ root
  text "Edit Order"
	with fields="id,customer,amount,status"
  action {{flow:saveOrder}}
  style { submitLabel: "Save Order"; gridX: "15"; gridY: "0"; gridW: "9"; gridH: "12" }
;
` + "```" + `

## Rules

1. Always return the complete updated DSL document, not just a diff.
2. Always return the DSL inside a fenced ` + "```" + `aura ... ` + "```" + ` code block.
3. You may include a short explanation before the code block.
4. Preserve nodes marked manuallyEdited unless the user explicitly asks to change them.
5. Keep grid placements non-overlapping. The grid is 24 columns wide.
6. Keep IDs short and descriptive (e.g. ordersTable, editForm, statusFilter).
7. Every table or chart MUST include with connector, connectorType (and sql for SQL connectors). A table without a connector binding shows no data.
8. Every form MUST include with fields="..." listing at least one field name.
9. Every widget's parent must be @ root. Never use a container's id as a parent.
10. Do not use modal or tabs widgets — not yet supported.
11. Do not include an edges block or a flows block — those are handled in the next stage.
12. Always use exact connector IDs from the provided connector list. Never invent IDs.
13. If the generation plan specifies connector_id and table_fields, bind the table to that connector and include those columns in the sql SELECT (for SQL connectors) or omit sql (for managed connectors).
14. If the generation plan specifies form_fields, use exactly those field names in with fields="...".
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
- The edges block is an array, not a single connection. Emit as many edge objects as needed.
- A single widget may participate in multiple edges at once, as a source and/or as a target. Fan-out and fan-in are both valid.
- Do not collapse several required connections into one edge. If one widget needs to drive two targets, emit two separate edge objects.
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
				"ref": "stepRef",
        "name": "Step name",
        "step_type": "query|mutation|condition|approval_gate|notification",
				"config": {},
				"next_step_ref": "nextStepRef",
				"false_branch_step_ref": "falseStepRef"
      }
    ]
  }
]
` + "```" + `

Rules:
- trigger_type must be one of: manual, form_submit, button_click, schedule, webhook.
- step_type must be one of: query, mutation, condition, approval_gate, notification.
- The layout stage references workflows through the action clause, e.g. action {{flow:saveOrder}}.
- If the layout already contains an action {{flow:ref}} placeholder, emit a flow with that exact ref.
- If the user's intent includes create/save/update/delete behavior and the layout contains a form or button trigger, a flows block is REQUIRED. Returning only edges is invalid.
- If no workflow is needed, omit the flows block entirely.
- requires_approval must be true for any flow with mutation steps.
- Never leave a mutation step without connector_id. Use the exact connector id from the connector list.
- Use ` + "`ref`" + ` on steps whenever another step branches to them.
- Use ` + "`next_step_ref`" + ` to point to the success / true branch target.
- Use ` + "`false_branch_step_ref`" + ` only on condition steps.
- For ` + "`form_submit`" + ` flows, the workflow input already is the submitted form values object. Do not add a prep step just to expose form values; use ` + "`{{input.field}}`" + ` directly.
- Managed connector mutation operations are only ` + "`insert`" + `, ` + "`update`" + `, or ` + "`delete`" + `. Do NOT emit ` + "`upsert`" + ` as a mutation operation.
- If the goal is create-or-update on a managed connector, emit a condition step that checks whether the input row id is present, then branch to an update step on true and an insert step on false.

### Step config by type

mutation step on a managed connector:
` + "```" + `json
{
  "connector_id": "<exact id from context>",
  "operation": "insert",
  "data": { "col1": "{{input.col1}}", "col2": "{{input.col2}}" }
}
` + "```" + `
For update/upsert, also include "row_id": "{{input.<pk_field>}}"

mutation step on a postgres/mysql/mssql connector:
` + "```" + `json
{
  "connector_id": "<exact id from context>",
  "sql": "INSERT INTO table (col1, col2) VALUES ('{{input.col1}}', '{{input.col2}}')"
}
` + "```" + `

query step:
` + "```" + `json
{ "connector_id": "<id>", "sql": "SELECT ..." }
` + "```" + `

condition step:
` + "```" + `json
{ "left": "{{input.id}}", "op": "neq", "right": "" }
` + "```" + `

approval_gate step:
` + "```" + `json
{ "description": "Describe what will happen when approved" }
` + "```" + `

## Worked example: form that inserts into a managed connector

Layout stage emitted:
` + "```" + `aura
form newOrderForm @ root
  text "New Order"
  with fields="customer,amount"
  action {{flow:placeOrder}}
  style { submitLabel: "Place Order"; gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
;
` + "```" + `

Correct flows block:
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
          "connector_id": "conn_abc123",
          "operation": "insert",
          "data": {
            "customer": "{{input.customer}}",
            "amount": "{{input.amount}}"
          }
        }
      }
    ]
  }
]
` + "```" + `

## Worked example: table row selection pre-populates a form

This requires a reactive edge so clicking a table row sets form field values.

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

## Worked example: one widget drives multiple edges

If selecting a row should both populate a form and refresh a details panel, emit two edges. The same source node can appear multiple times in the array.

` + "```edges" + `
[
	{
		"id": "edge_ordersTable_selectedRow_editOrderForm_setValues",
		"fromNodeId": "ordersTable",
		"fromPort": "selectedRow",
		"toNodeId": "editOrderForm",
		"toPort": "setValues",
		"edgeType": "reactive"
	},
	{
		"id": "edge_ordersTable_selectedRow_orderDetails_setContent",
		"fromNodeId": "ordersTable",
		"fromPort": "selectedRow",
		"toNodeId": "orderDetails",
		"toPort": "setContent",
		"edgeType": "reactive"
	}
]
` + "```" + `

## Worked example: managed connector create-or-update flow

When the same form must create a new managed row or update an existing one, do not use a mutation operation named ` + "`upsert`" + `. Emit a condition step and branch to separate update and insert steps.
The triggering form must include the primary key field in ` + "`with fields=...`" + ` so ` + "`{{input.id}}`" + ` is present on submit.

` + "```flows" + `
[
	{
		"ref": "saveOrder",
		"name": "Save Order",
		"trigger_type": "form_submit",
		"trigger_widget_ref": "orderForm",
		"requires_approval": true,
		"steps": [
			{
				"ref": "hasExistingRow",
				"name": "Existing row?",
				"step_type": "condition",
				"config": {
					"left": "{{input.id}}",
					"op": "neq",
					"right": ""
				},
				"next_step_ref": "updateOrder",
				"false_branch_step_ref": "insertOrder"
			},
			{
				"ref": "updateOrder",
				"name": "Update order row",
				"step_type": "mutation",
				"config": {
					"connector_id": "conn_abc123",
					"operation": "update",
					"row_id": "{{input.id}}",
					"data": {
						"customer": "{{input.customer}}",
						"amount": "{{input.amount}}"
					}
				}
			},
			{
				"ref": "insertOrder",
				"name": "Insert order row",
				"step_type": "mutation",
				"config": {
					"connector_id": "conn_abc123",
					"operation": "insert",
					"data": {
						"customer": "{{input.customer}}",
						"amount": "{{input.amount}}"
					}
				}
			}
		]
	}
]
` + "```" + `

## Response format

Return ONLY edges and/or flows blocks (or nothing). Do not emit an aura block. A brief one-sentence explanation is acceptable before any code blocks.
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
	- Optional style key: submitLabel (button text, default "Submit").
	- If the form should run a workflow, use the action clause with a workflow UUID or a {{flow:ref}} placeholder.
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
	action {{flow:updateOrder}}
	style { submitLabel: "Update Order"; gridX: "16"; gridY: "0"; gridW: "8"; gridH: "8" }
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
	          "operation": "update",
	          "row_id": "{{input.OrderID}}",
	          "data": {
	            "customer": "{{input.customer}}",
	            "amount": "{{input.amount}}"
	          }
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
	         connectorType="<csv|managed|postgres|mysql|mssql|rest|graphql>"
         sql="<value>"

The meaning of the sql field depends on the connector type:
- csv:                  sql is always: SELECT * FROM csv  (the backend ignores this value; it is a required sentinel)
- managed:              omit sql (or leave it empty); Lima returns all rows from the managed table directly
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
	style { submitLabel: "Send"; gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
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

In the Aura DSL, refer to a generated workflow by its ` + "`ref`" + ` using the action clause with the placeholder ` + "`{{flow:refName}}`" + `:

    form myForm @ root
			with fields="name,email"
			action {{flow:submitContact}}
			style { submitLabel: "Send"; ... }
    ;

    button myBtn @ root
      text "Delete"
			action {{flow:deleteRecord}}
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
	          "operation": "insert",
	          "data": {
	            "col": "{{input.col}}"
	          }
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
- If the DSL already contains ` + "`action {{flow:someRef}}`" + ` on a form or button, emit a flow whose ` + "`ref`" + ` is ` + "`someRef`" + `.
- If the request involves create/save/update/delete behavior and the layout contains the triggering form or button, a flows block is mandatory.
- ` + "`requires_approval`" + `: set ` + "`true`" + ` for any workflow with mutation steps; set ` + "`false`" + ` for query-only flows.
- ` + "`step_type`" + `: one of ` + "`query`" + `, ` + "`mutation`" + `, ` + "`condition`" + `, ` + "`approval_gate`" + `, ` + "`notification`" + `.
- ` + "`config`" + ` for ` + "`query`" + ` steps: ` + "`{ \"connector_id\": \"...\", \"sql\": \"SELECT ...\" }`" + `.
- ` + "`config`" + ` for ` + "`mutation`" + ` steps on managed connectors: ` + "`{ \"connector_id\": \"...\", \"operation\": \"insert|update|delete\", \"data\": { ... }, \"row_id\": \"{{input.id}}\" }`" + `.
- ` + "`config`" + ` for ` + "`mutation`" + ` steps on postgres/mysql/mssql connectors: ` + "`{ \"connector_id\": \"...\", \"sql\": \"UPDATE ...\" }`" + `.
- If a matching managed connector already exists in the connector context, prefer it over inventing SQL.
- Never leave a mutation step without connector_id and the required config fields when a matching connector exists in context.
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
	action {{flow:placeOrder}}
	style { submitLabel: "Place Order"; gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
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
	          "operation": "insert",
	          "data": {
	            "customer_name": "{{input.customer_name}}",
	            "amount": "{{input.amount}}"
	          }
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

		// ── Stage 0: planning ──────────────────────────────────────────────────────
		// Run a lightweight planning pass to ground layout and flow generation in a
		// specific connector and CRUD contract. Non-fatal: if planning fails, we
		// proceed without a plan and fall back to inference-based behavior.
		var plan *appPlan
		if len(connectors) > 0 {
			planResult, planErr := generatePlan(ctx, layoutSettings, latestUserPrompt, connectors)
			if planErr != nil {
				log.Warn("plan stage failed (non-fatal)", zap.Error(planErr))
			} else if planResult != nil {
				plan = planResult
				log.Info("plan stage complete",
					zap.String("intent", plan.Intent),
					zap.String("entity", plan.Entity),
					zap.String("connector_id", plan.ConnectorID),
					zap.String("workflow_ref", plan.WorkflowRef),
				)
			}
		}

		// ── Stage 1: layout ────────────────────────────────────────────────────────
		layoutMessages := buildLayoutMessages(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows, plan)
		layoutCopilotPrompt := buildLayoutCopilotPrompt(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows, plan)
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
		flowMessages := buildFlowMessages(newDSL, latestUserPrompt, connectors, existingWorkflows, plan)
		flowCopilotPrompt := buildFlowCopilotPrompt(newDSL, latestUserPrompt, connectors, existingWorkflows, plan)
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

		// Apply plan-driven corrections to any incomplete mutation steps.
		applyPlanToFlows(generatedFlows, plan)
		if plan.isCRUD() && len(generatedFlows) == 0 {
			log.Warn("CRUD plan produced no workflows — flow stage may have omitted the flows block",
				zap.String("entity", plan.Entity),
				zap.String("expected_connector_id", plan.ConnectorID),
			)
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
				reconcileGeneratedFlowTriggerRefs(generatedFlows, newDSL)

				refToID, persistErr := persistGeneratedFlows(ctx, pool, payload.WorkspaceID, payload.AppID, payload.UserID, generatedFlows)
				if persistErr != nil {
					log.Warn("persist generated flows (non-fatal)", zap.Error(persistErr))
				} else if len(refToID) > 0 {
					newDSL = substituteFlowRefs(newDSL, refToID)

					// Build flow group + step node DSL and async trigger edges.
					flowNodesDSL, flowEdges := buildFlowNodesAndEdges(generatedFlows, refToID, newDSL)
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
