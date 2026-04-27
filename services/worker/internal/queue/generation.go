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

// generateGraph calls the configured graph model with the provided messages
// (for OpenAI) or prompt (for Copilot). It returns the raw LLM response text.
func generateGraph(
	ctx context.Context,
	settings userAISettings,
	messages []chatMessage,
	copilotPrompt string,
) (string, error) {
	switch settings.Provider {
	case "openai":
		return callOpenAI(ctx, settings, messages)
	case "github_copilot":
		return callGitHubCopilot(ctx, settings, copilotPrompt, buildGraphSystemPrompt(BuildPortManifest()))
	default:
		return "", fmt.Errorf("unsupported ai provider %q for graph stage", settings.Provider)
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
// columns when generating DSL. Errors are non-fatal - the caller logs and
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
// available and how to reference them in the with clause.
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
	sb.WriteString("Prefer the connector whose name and columns best match the requested entity. If a matching managed connector exists, use it for both the table binding and any create/update/delete step instead of leaving the mutation unconfigured.\n")
	return sb.String()
}

// nodeOnlyDSL strips the ---edges--- separator and everything after it from a
// serialized Aura V2 document.
func nodeOnlyDSL(src string) string {
	const sentinel = "---edges---"
	if idx := strings.Index(src, sentinel); idx >= 0 {
		return strings.TrimSpace(src[:idx])
	}
	return src
}

func buildGraphSystemPrompt(portManifest string) string {
	return strings.Join([]string{
		"You are an AI assistant that generates and modifies user interface definitions for an internal tools platform called Lima.",
		"",
		"Return a single complete Aura document inside one ```aura code block.",
		"",
		"Use canonical Aura syntax only.",
		"Every node header must contain exactly four space-separated parts:",
		"element id @ parentId",
		"",
		"Examples:",
		"container page_shell @ root",
		"  layout direction=\"column\" gap=\"16\"",
		";",
		"form order_form @ page_shell",
		"  text \"Order Form\"",
		"  with fields=\"OrderID,Date,CustomerName,Product,Category,Amount\"",
		"  on submitted -> save_order.run",
		";",
		"table orders_table @ page_shell",
		"  with columns=\"OrderID,Date,CustomerName,Status,Amount\"",
		"  input setRows <- load_orders.rows",
		";",
		"",
		"Top-level nodes must use '@ root' with a space. Never omit the parent, and never compact it as '@root'.",
		"Widget configuration belongs in the 'with' clause using key=\"value\" pairs.",
		"For example: forms use 'with fields=\"name,email\"' and tables use 'with columns=\"id,name,status\"'.",
		"Do NOT invent standalone clauses such as 'fields ...' or 'columns ...'.",
		"Do not emit angle-bracket placeholder tokens anywhere in the DSL.",
		"",
		"Use these inline connection clauses:",
		"- on submitted -> save_order.run",
		"- input setRows <- load_orders.rows",
		"- output rows -> orders_table.setRows",
		"",
		"Use inline step:* nodes for workflows unless the plan explicitly says managed CRUD behavior will be synthesized for you.",
		"Do NOT emit a \"page\" element.",
		"Exception: if you are intentionally returning a layout-only flat authoring document, you may emit page/widget/field/column/option/bind lines, but only when no run/effect lines or query-style action kinds are needed.",
		"Exception: if the managed CRUD plan context explicitly authorizes flat authoring Aura, that plan override wins and you may emit page/widget/field/column/action lines for the managed CRUD subset.",
		"Do NOT emit a separate edges section.",
		"Do NOT emit flowX, flowY, flowW, or flowH style keys.",
		"Do NOT emit legacy action fields that point to workflow IDs.",
		"Do NOT use square-bracket metadata or XML-like attribute syntax.",
		"",
		"Available widget and step ports:",
		portManifest,
	}, "\n")
}

func buildGraphMessages(
	currentDSL, latestUserPrompt string,
	history []msgRow,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
	plan *appPlan,
) []chatMessage {
	msgs := []chatMessage{
		{Role: "system", Content: buildGraphSystemPrompt(BuildPortManifest())},
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
	msgs = append(msgs, chatMessage{Role: "user", Content: latestUserPrompt + "\n\nReturn the complete updated Aura document only."})
	return msgs
}

func buildGraphCopilotPrompt(
	currentDSL, latestUserPrompt string,
	history []msgRow,
	connectors []genConnector,
	existingWorkflows []existingWorkflowInfo,
	plan *appPlan,
) string {
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
	builder.WriteString("\nRules:\n")
	builder.WriteString("- Do not use square-bracket metadata.\n")
	builder.WriteString("- do not emit a page wrapper node.\n")
	if plan != nil && plan.isCRUD() && plan.ConnectorType == "managed" {
		builder.WriteString("- For managed CRUD plans, you may use the flat authoring subset with page/widget/field/column/action lines. Prefer that format for first-generation CRUD screens and focus on layout, field lists, and widget IDs. The worker synthesizes the managed data binding and save step.\n")
	} else {
		builder.WriteString("- For layout-only screens or widget-to-widget wiring with no executable actions, you may use the flat authoring subset with page/widget/field/column/option/bind lines. Otherwise use inline step:* nodes and inline links, not legacy flow action references.\n")
	}
	builder.WriteString("- Do not emit a separate edges section.\n")
	builder.WriteString("- Do not emit flowX, flowY, flowW, or flowH style keys.\n")
	builder.WriteString("\nLatest request:\n")
	builder.WriteString(latestUserPrompt)
	builder.WriteString("\n\nReturn the complete updated Aura document only.\n")
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
// injected into the AI prompt as reference context only.
func buildWorkflowContextBlock(workflows []existingWorkflowInfo) string {
	if len(workflows) == 0 {
		return "No workflows exist for this app yet. Prefer inline step:* nodes in the generated Aura graph.\n"
	}
	var sb strings.Builder
	sb.WriteString("Existing workflows for this app (reference context only):\n")
	for _, w := range workflows {
		fmt.Fprintf(&sb, "- id=%q  name=%q  trigger_type=%s\n", w.id, w.name, w.triggerType)
	}
	sb.WriteString("Prefer inline step:* nodes in the generated Aura graph over external workflow references.\n")
	return sb.String()
}

// appPlan is the structured output of the planning stage. It grounds graph
// generation in a specific connector and CRUD contract.
type appPlan struct {
	Intent          string   `json:"intent"`
	ConnectorID     string   `json:"connector_id"`
	ConnectorType   string   `json:"connector_type"`
	Entity          string   `json:"entity"`
	FormFields      []string `json:"form_fields"`
	TableFields     []string `json:"table_fields"`
	CRUDMode        string   `json:"crud_mode"`
	PrimaryKeyField string   `json:"primary_key_field"`
	WorkflowName    string   `json:"workflow_name"`
	WorkflowRef     string   `json:"workflow_ref"`
}

func (p *appPlan) isCRUD() bool {
	return p != nil && p.Intent == "crud"
}

const planSystemPrompt = `You are the planning stage of an AI-driven UI generator for an internal tools platform called Lima.

Your sole output is a single JSON object. No explanation, no markdown, no code fences.

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
- For update/upsert CRUD plans, form_fields MUST include primary_key_field so the submitted values object contains the row identifier.
- Output JSON only. No other text before or after.
`

func buildPlanMessages(userPrompt string, connectors []genConnector) []chatMessage {
	return []chatMessage{
		{Role: "system", Content: planSystemPrompt},
		{Role: "system", Content: buildConnectorContextBlock(connectors)},
		{Role: "user", Content: userPrompt},
	}
}

// parsePlanResponse decodes a raw LLM response from the planning stage.
func parsePlanResponse(raw string) (*appPlan, error) {
	raw = strings.TrimSpace(raw)
	for _, fence := range []string{"```json", "```"} {
		raw = strings.TrimPrefix(raw, fence)
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

// generatePlan runs the planning stage and returns a grounded appPlan.
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
// injected into the graph-generation prompt.
func buildPlanContextBlock(plan *appPlan) string {
	if plan == nil || plan.Intent == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("## Generation plan - follow exactly\n")
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
		fmt.Fprintf(&sb, "workflow_ref: %s\n", plan.WorkflowRef)
	}
	if plan.WorkflowName != "" {
		fmt.Fprintf(&sb, "workflow_name: %s\n", plan.WorkflowName)
	}
	if plan.isCRUD() && plan.ConnectorType == "managed" {
		sb.WriteString("For managed CRUD plans, you may return the flat managed CRUD authoring subset instead of canonical runtime Aura. Prefer that authoring form for first-generation CRUD screens. Use page/widget/field/column/action lines, focus on the planned layout only, place delete/danger buttons where needed, and do not emit managed save step nodes or legacy flow action syntax. Example authoring lines: page main title=\"Orders\" and action save_order @ main kind=managed_crud entity=order mode=upsert form=order_form table=orders. The worker will lower that subset. The worker will synthesize the managed table binding, save behavior, and delete-button wiring.\n")
	} else {
		sb.WriteString("If the app needs write behavior, model it with explicit step:* nodes and inline on/input/output links, not legacy flow action syntax.\n")
	}
	return sb.String()
}

// applyPlanToFlows patches AI-generated workflows using the plan to fill in any
// connector_id and config fields that the model failed to emit. This preserves
// the legacy flow-path tests while the single-graph path remains primary.
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
			if cid, _ := step.Config["connector_id"].(string); cid == "" {
				step.Config["connector_id"] = plan.ConnectorID
			}
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

		// ── Stage 1: graph (single-pass layout + wiring) ──────────────────────────
		graphMessages := buildGraphMessages(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows, plan)
		graphCopilotPrompt := buildGraphCopilotPrompt(currentDSL, latestUserPrompt, messages, connectors, existingWorkflows, plan)
		graphStart := time.Now()
		graphResponse, graphErr := generateGraph(ctx, layoutSettings, graphMessages, graphCopilotPrompt)
		if graphErr != nil {
			log.Error("graph stage failed", zap.Error(graphErr))
			writeErrorMessage(ctx, pool, payload.ThreadID, graphErr.Error())
			return graphErr
		}
		if cfg.LogLLMOutput {
			log.Info("graph stage raw output",
				zap.String("provider", layoutSettings.Provider),
				zap.String("model", layoutSettings.Model),
				zap.String("response", graphResponse),
			)
		}
		log.Info("graph stage complete",
			zap.Duration("elapsed", time.Since(graphStart)),
			zap.String("provider", layoutSettings.Provider),
			zap.String("model", layoutSettings.Model),
		)

		newDSL := extractDSL(graphResponse)
		if newDSL == "" {
			// Model returned explanation text with no DSL code block. Store as a
			// patch-free message so the UI does not misleadingly show "canvas updated"
			// and so the frontend cannot accidentally revert unsaved canvas edits.
			_, writeErr := pool.Exec(ctx,
				`INSERT INTO thread_messages (thread_id, role, content) VALUES ($1, 'assistant', $2)`,
				payload.ThreadID, graphResponse)
			if writeErr != nil {
				log.Error("write assistant prose message", zap.Error(writeErr))
			}
			_, _ = pool.Exec(ctx, `UPDATE conversation_threads SET updated_at = now() WHERE id = $1`, payload.ThreadID)
			return nil
		}

		// ── Stage 2: normalize inline links → edges ────────────────────────────────
		// Parse the DSL into structured statements, extract inline on/input/output
		// link clauses and convert them into canonical dslEdge entries.
		compiledAuthoringDSL, authoringNotes, compiledAuthoring, authoringErr := compileManagedCRUDAuthoringRuntimeDSL(newDSL)
		if authoringErr != nil {
			log.Warn("flat authoring compile failed after graph stage",
				zap.String("thread_id", payload.ThreadID),
				zap.Error(authoringErr),
			)
			writeErrorMessage(ctx, pool, payload.ThreadID, "generated flat Aura authoring is not supported by the worker yet: "+authoringErr.Error())
			return authoringErr
		}
		if compiledAuthoring {
			newDSL = compiledAuthoringDSL
			for _, note := range authoringNotes {
				log.Info("authoring compiler note",
					zap.String("thread_id", payload.ThreadID),
					zap.String("note", note),
				)
			}
		}

		repairedDSL, repairNotes := repairGeneratedDSLCommonSyntax(newDSL)
		if len(repairNotes) > 0 {
			for _, note := range repairNotes {
				log.Warn("repaired generated dsl syntax",
					zap.String("thread_id", payload.ThreadID),
					zap.String("repair", note),
				)
			}
			newDSL = repairedDSL
		}

		var stashedCompilerEdges []dslEdge

		compiledDSL, compilerEdges, compileNotes, compiledManaged, compileErr := compileManagedCRUDAuthoringDSL(newDSL, plan, connectors)
		if compileErr != nil {
			log.Warn("managed crud compile skipped after graph stage",
				zap.String("thread_id", payload.ThreadID),
				zap.Error(compileErr),
			)
		} else if compiledManaged {
			newDSL = compiledDSL
			for _, note := range compileNotes {
				log.Info("managed crud compiler note",
					zap.String("thread_id", payload.ThreadID),
					zap.String("note", note),
				)
			}
			stashedCompilerEdges = compilerEdges
		}

		stmts, parseErr := parseDSLStatementsStructured(newDSL)
		if parseErr != nil {
			log.Warn("inline-link parse error (non-fatal)", zap.Error(parseErr))
		}
		normalizedEdges, normWarnings := normalizeInlineLinksGo(stmts, stashedCompilerEdges)
		for _, w := range normWarnings {
			log.Warn("inline-link normalization warning", zap.String("warning", w))
		}
		log.Info("inline links normalized",
			zap.Int("edges", len(normalizedEdges)),
			zap.String("app_id", payload.AppID),
		)

		// Build allEdges: start from the normalized inline-link edges.
		// Any manually-added edges already in the DB are preserved by the
		// frontend when it re-saves, so we replace with the full AI-generated set.
		allEdges := normalizedEdges

		// Validation gate: refuse to persist structurally malformed DSL.
		if err := validateDSL(newDSL); err != nil {
			log.Warn("candidate DSL is malformed; refusing to persist",
				zap.String("thread_id", payload.ThreadID),
				zap.Error(err))
			writeErrorMessage(ctx, pool, payload.ThreadID, "generated DSL was malformed and could not be applied: "+err.Error())
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

		explanation := strings.TrimSpace(auraBlockRe.ReplaceAllString(graphResponse, ""))
		if explanation == "" {
			explanation = "Updated the app."
		}

		if err := writeAssistantMessage(ctx, pool, payload.ThreadID, explanation, resultDSL, allEdges); err != nil {
			log.Error("write assistant message", zap.Error(err))
			return err
		}

		log.Info("generation job complete",
			zap.String("thread_id", payload.ThreadID),
			zap.String("provider", settings.Provider),
			zap.String("model", settings.Model),
		)
		return nil
	}
}
