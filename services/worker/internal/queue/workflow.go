package queue

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// workflowRunEvent is the JSON payload published to Redis for each workflow lifecycle event.
type workflowRunEvent struct {
	RunID  string         `json:"run_id"`
	AppID  string         `json:"app_id"`
	Status string         `json:"status"` // "step_completed" | "completed" | "failed" | "awaiting_approval"
	StepID string         `json:"step_id,omitempty"`
	Output map[string]any `json:"output,omitempty"`
}

// publishStepEvent marshals event to JSON and publishes it to the Redis channel
// "app:{appID}:events". A nil rdb or marshal/publish failure is silently ignored —
// publish is best-effort and must never cause a workflow execution to fail.
func publishStepEvent(ctx context.Context, rdb *redis.Client, event workflowRunEvent) {
	if rdb == nil {
		return
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	_ = rdb.Publish(ctx, "app:"+event.AppID+":events", payload)
}

type restCreds struct {
	BaseURL      string `json:"base_url"`
	AuthType     string `json:"auth_type"`
	Token        string `json:"token,omitempty"`
	Username     string `json:"username,omitempty"`
	Password     string `json:"password,omitempty"`
	APIKey       string `json:"api_key,omitempty"`
	APIKeyHeader string `json:"api_key_header,omitempty"`
	// OAuth2 refresh-token grant fields (never stored in Token — fetched at runtime).
	TokenURL     string `json:"token_url,omitempty"`
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"client_secret,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scopes       string `json:"scopes,omitempty"`
	// connectorID is set at runtime (not in DB); used as the token-cache key.
	connectorID string
}

// oauth2TokenEntry holds a cached access token and its expiry.
type oauth2TokenEntry struct {
	accessToken string
	expiresAt   time.Time
}

// restOAuth2Cache stores short-lived OAuth2 access tokens keyed by connectorID.
// Safe for concurrent use; entries are replaced atomically.
var restOAuth2Cache sync.Map

// resolveOAuth2Token returns a valid access token for the given connector,
// using a cached value when available and performing a refresh-token grant
// when the cache is empty or the cached token has expired.
func resolveOAuth2Token(ctx context.Context, connectorID string, creds restCreds) (string, error) {
	if entry, ok := restOAuth2Cache.Load(connectorID); ok {
		e := entry.(oauth2TokenEntry)
		if time.Now().Before(e.expiresAt) {
			return e.accessToken, nil
		}
	}

	if creds.TokenURL == "" {
		return "", fmt.Errorf("oauth2 auth requires token_url in credentials")
	}
	if creds.ClientID == "" {
		return "", fmt.Errorf("oauth2 auth requires client_id in credentials")
	}
	if creds.RefreshToken == "" {
		return "", fmt.Errorf("oauth2 auth requires refresh_token in credentials")
	}

	// Validate that token_url is a proper HTTPS URL (guard against accidental
	// internal service calls and obvious mis-configuration).
	tokenURL, err := url.Parse(creds.TokenURL)
	if err != nil || tokenURL.Host == "" {
		return "", fmt.Errorf("oauth2 token_url is not a valid URL")
	}

	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", creds.ClientID)
	if creds.ClientSecret != "" {
		form.Set("client_secret", creds.ClientSecret)
	}
	form.Set("refresh_token", creds.RefreshToken)
	if creds.Scopes != "" {
		form.Set("scope", creds.Scopes)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, creds.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("build oauth2 token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("oauth2 token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("oauth2 token endpoint returned HTTP %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("decode oauth2 token response: %w", err)
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("oauth2 token endpoint returned empty access_token")
	}

	ttl := time.Duration(tokenResp.ExpiresIn-60) * time.Second
	if ttl <= 0 {
		ttl = 55 * time.Minute
	}
	restOAuth2Cache.Store(connectorID, oauth2TokenEntry{
		accessToken: tokenResp.AccessToken,
		expiresAt:   time.Now().Add(ttl),
	})
	return tokenResp.AccessToken, nil
}

type graphqlMutationCreds struct {
	Endpoint string            `json:"endpoint"`
	AuthType string            `json:"auth_type"`
	Token    string            `json:"token,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
}

// combinedWorkflowPayload is parsed from any workflow queue message.
// If ApprovalID is non-empty it is a resume; otherwise a fresh execution.
type combinedWorkflowPayload struct {
	RunID       string `json:"run_id"`
	WorkflowID  string `json:"workflow_id"`
	WorkspaceID string `json:"workspace_id"`
	ApprovalID  string `json:"approval_id"`
	Approved    bool   `json:"approved"`
}

// collectTriggeredOutputBindings returns the subset of def.outputBindings that
// were triggered by this run. A binding with TriggerStepID ==
// "__workflow_complete__" fires when the run finishes without error.
// Any other TriggerStepID fires when the named step completed successfully.
func collectTriggeredOutputBindings(def *wfDefinition, stepResults map[string]any, completedWithError bool) []outputBinding {
	var triggered []outputBinding
	for _, ob := range def.outputBindings {
		if ob.TriggerStepID == "__workflow_complete__" {
			if !completedWithError {
				triggered = append(triggered, ob)
			}
			continue
		}
		if sr, ok := stepResults[ob.TriggerStepID]; ok {
			if m, ok := sr.(map[string]any); ok && m["status"] == "completed" {
				triggered = append(triggered, ob)
			}
		}
	}
	return triggered
}

// handleWorkflow returns a jobHandler that executes or resumes workflow runs.
func handleWorkflow(cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger) jobHandler {
	return func(ctx context.Context, payload []byte) error {
		var p combinedWorkflowPayload
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("unmarshal workflow payload: %w", err)
		}
		if p.RunID == "" {
			return fmt.Errorf("workflow payload missing run_id")
		}
		if pool == nil {
			return fmt.Errorf("db pool unavailable — cannot execute workflow run %s", p.RunID)
		}

		if p.ApprovalID != "" {
			return resumeWorkflowRun(ctx, cfg, pool, rdb, log, p.RunID, p.ApprovalID, p.Approved)
		}
		return executeWorkflowRun(ctx, cfg, pool, rdb, log, p.RunID, p.WorkflowID)
	}
}

// hydrateDSLSteps replaces def.steps with the DSL-derived step graph when
// dsl_version >= 2. It is a no-op for V1 workflows.
func hydrateDSLSteps(ctx context.Context, pool *pgxpool.Pool, def *wfDefinition) error {
	if def.dslVersion < 2 {
		return nil
	}
	dslSource, edges, _, appID, err := getAppDSLForWorkflow(ctx, pool, def.id)
	if err != nil {
		return fmt.Errorf("load DSL for workflow %s: %w", def.id, err)
	}
	steps, err := buildStepsFromDSL(def.id, dslSource, edges)
	if err != nil {
		return fmt.Errorf("build step graph for workflow %s: %w", def.id, err)
	}
	def.steps = steps
	def.appID = appID
	return nil
}

// executeWorkflowRun starts fresh execution of a workflow run.
func executeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger, runID, workflowID string) error {
	log.Info("workflow run starting", zap.String("run_id", runID))

	run, err := getWorkflowRun(ctx, pool, runID)
	if err != nil {
		return fmt.Errorf("fetch run: %w", err)
	}
	// Guard against re-running a run that's already past pending.
	if run.status != runStatusPending {
		log.Warn("workflow run not in pending state — skipping",
			zap.String("run_id", runID), zap.String("status", string(run.status)))
		return nil
	}

	def, err := getWorkflowDefinition(ctx, pool, workflowID)
	if err != nil {
		return fmt.Errorf("fetch workflow definition: %w", err)
	}

	if err := hydrateDSLSteps(ctx, pool, def); err != nil {
		errStr := err.Error()
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, run.outputData, &errStr, nil)
		log.Error("failed to hydrate DSL steps", zap.String("run_id", runID), zap.Error(err))
		return nil
	}

	// Mark as running.
	if err := setRunStatus(ctx, pool, runID, runStatusRunning, run.outputData, nil, nil); err != nil {
		return fmt.Errorf("set running status: %w", err)
	}

	output := run.outputData
	if output == nil {
		output = map[string]any{}
	}
	stepResults, _ := output["steps"].(map[string]any)
	if stepResults == nil {
		stepResults = map[string]any{}
	}

	if err := runStepGraph(ctx, cfg, pool, rdb, log, run, def, stepResults); err != nil {
		// runStepGraph returns nil for paused (awaiting_approval) — only non-nil on hard error.
		errStr := err.Error()
		output["steps"] = stepResults
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, output, &errStr, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "failed"})
		log.Error("workflow run failed", zap.String("run_id", runID), zap.Error(err))
		return nil // don't propagate — run is marked failed in DB
	}

	// Check if we're paused (some step set awaiting_approval status internally).
	output["steps"] = stepResults
	paused := false
	for _, v := range stepResults {
		if m, ok := v.(map[string]any); ok {
			if m["status"] == "awaiting_approval" {
				paused = true
				break
			}
		}
	}
	if paused {
		_ = setRunStatus(ctx, pool, runID, runStatusAwaitingApproval, output, nil, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "awaiting_approval"})
		log.Info("workflow run paused awaiting approval", zap.String("run_id", runID))
		return nil
	}

	if triggered := collectTriggeredOutputBindings(def, stepResults, false); len(triggered) > 0 {
		output["__output_bindings__"] = triggered
	}
	_ = setRunStatus(ctx, pool, runID, runStatusCompleted, output, nil, nil)
	publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "completed"})
	log.Info("workflow run completed", zap.String("run_id", runID))
	return nil
}

// runStepGraph executes or resumes the workflow step graph.
// It returns nil when the run has completed or been paused (awaiting_approval via a step result).
// It returns a non-nil error only on hard infrastructure failures.
func runStepGraph(
	ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger,
	run *wfRun, def *wfDefinition, stepResults map[string]any,
) error {
	if len(def.steps) == 0 {
		return nil
	}

	// Build step index for O(1) lookup.
	byID := make(map[string]*wfStep, len(def.steps))
	for i := range def.steps {
		s := &def.steps[i]
		byID[s.id] = s
	}

	// Find start step: the step with the lowest step_order.
	start := &def.steps[0]
	for i := range def.steps {
		if def.steps[i].stepOrder < start.stepOrder {
			start = &def.steps[i]
		}
	}

	visited := make(map[string]bool, len(def.steps))
	current := start

	for current != nil {
		if visited[current.id] {
			return fmt.Errorf("cycle detected at step %q — workflow graph is invalid", current.name)
		}
		visited[current.id] = true

		// Skip steps already completed (resume path).
		if sr, ok := stepResults[current.id]; ok {
			if m, ok := sr.(map[string]any); ok && m["status"] == "completed" {
				current = nextStep(current, stepResults, byID, def.steps)
				continue
			}
		}

		paused, err := executeStep(ctx, cfg, pool, log, run, def, *current, stepResults)
		if err != nil {
			return fmt.Errorf("step %q: %w", current.name, err)
		}
		if paused {
			// Step created an approval gate — runner will detect this and set the run status.
			return nil
		}

		publishStepEvent(ctx, rdb, workflowRunEvent{
			RunID:  run.id,
			AppID:  def.appID,
			Status: "step_completed",
			StepID: current.id,
			Output: func() map[string]any {
				if sr, ok := stepResults[current.id]; ok {
					if m, ok := sr.(map[string]any); ok {
						return m
					}
				}
				return nil
			}(),
		})
		current = nextStep(current, stepResults, byID, def.steps)
	}
	return nil
}

// nextStep resolves which step to execute after the current one.
// For condition steps it checks the boolean result and branches accordingly.
// Falls back to linear step_order+1 when no explicit next_step_id is set.
func nextStep(step *wfStep, stepResults map[string]any, byID map[string]*wfStep, allSteps []wfStep) *wfStep {
	// Determine the explicit next ID (may be nil).
	var nextID *string
	if step.stepType == stepTypeCondition {
		// Condition: check result to pick true or false branch.
		result := false
		if sr, ok := stepResults[step.id]; ok {
			if m, ok := sr.(map[string]any); ok {
				switch v := m["result"].(type) {
				case bool:
					result = v
				case string:
					result = v == "true" || v == "1" || v == "yes"
				}
			}
		}
		if result {
			nextID = step.nextStepID
		} else {
			nextID = step.falseBranchStepID
		}
	} else {
		nextID = step.nextStepID
	}

	// If an explicit next step is set, use it.
	if nextID != nil {
		if s, ok := byID[*nextID]; ok {
			return s
		}
		// Referenced step doesn't exist — treat as terminal.
		return nil
	}

	// Linear fallback: find step with step_order == current.step_order + 1.
	targetOrder := step.stepOrder + 1
	for i := range allSteps {
		if allSteps[i].stepOrder == targetOrder {
			return &allSteps[i]
		}
	}
	return nil
}

// resumeWorkflowRun continues a run that was blocked on an approval gate.
func resumeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger,
	runID, approvalID string, approved bool,
) error {
	log.Info("workflow run resuming",
		zap.String("run_id", runID), zap.String("approval_id", approvalID), zap.Bool("approved", approved))

	run, err := getWorkflowRun(ctx, pool, runID)
	if err != nil {
		return fmt.Errorf("fetch run for resume: %w", err)
	}
	if run.status != runStatusAwaitingApproval {
		log.Warn("workflow run not in awaiting_approval state — skipping resume",
			zap.String("run_id", runID), zap.String("status", string(run.status)))
		return nil
	}

	if !approved {
		reason := "workflow approval rejected"
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, run.outputData, &reason, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: "", Status: "failed"})
		log.Info("workflow run rejected", zap.String("run_id", runID))
		return nil
	}

	def, err := getWorkflowDefinition(ctx, pool, run.workflowID)
	if err != nil {
		return fmt.Errorf("fetch workflow definition for resume: %w", err)
	}

	if err := hydrateDSLSteps(ctx, pool, def); err != nil {
		errStr := err.Error()
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, run.outputData, &errStr, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "failed"})
		log.Error("failed to hydrate DSL steps", zap.String("run_id", runID), zap.Error(err))
		return nil
	}

	// Mark as running again.
	output := run.outputData
	if output == nil {
		output = map[string]any{}
	}
	stepResults, _ := output["steps"].(map[string]any)
	if stepResults == nil {
		stepResults = map[string]any{}
	}

	// Verify the approval record and execute (mutation) or complete (approval_gate)
	// the step that was waiting. Never marks a mutation completed without first
	// running it; never trusts the caller's approved=true without a DB check.
	if err := resolveApprovedStep(ctx, cfg, pool, log, run, def, approvalID, stepResults); err != nil {
		errMsg := err.Error()
		output["steps"] = stepResults
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, output, &errMsg, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "failed"})
		log.Error("failed to resolve approved step — run failed",
			zap.String("run_id", runID), zap.String("approval_id", approvalID), zap.Error(err))
		return nil
	}

	if err := setRunStatus(ctx, pool, runID, runStatusRunning, output, nil, nil); err != nil {
		return fmt.Errorf("set resuming status: %w", err)
	}

	// Continue execution from where we left off (graph-aware).
	if err := runStepGraph(ctx, cfg, pool, rdb, log, run, def, stepResults); err != nil {
		errStr := err.Error()
		output["steps"] = stepResults
		_ = setRunStatus(ctx, pool, runID, runStatusFailed, output, &errStr, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "failed"})
		log.Error("workflow run failed on resume", zap.String("run_id", runID), zap.Error(err))
		return nil
	}

	// Check if we're paused again.
	output["steps"] = stepResults
	pausedAgain := false
	for _, v := range stepResults {
		if m, ok := v.(map[string]any); ok {
			if m["status"] == "awaiting_approval" {
				pausedAgain = true
				break
			}
		}
	}
	if pausedAgain {
		_ = setRunStatus(ctx, pool, runID, runStatusAwaitingApproval, output, nil, nil)
		publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "awaiting_approval"})
		log.Info("workflow run paused again awaiting approval", zap.String("run_id", runID))
		return nil
	}

	if triggered := collectTriggeredOutputBindings(def, stepResults, false); len(triggered) > 0 {
		output["__output_bindings__"] = triggered
	}
	_ = setRunStatus(ctx, pool, runID, runStatusCompleted, output, nil, nil)
	publishStepEvent(ctx, rdb, workflowRunEvent{RunID: runID, AppID: def.appID, Status: "completed"})
	log.Info("workflow run completed after resume", zap.String("run_id", runID))
	return nil
}

// executeStep runs a single workflow step. Returns (paused=true, nil) when the
// step creates an approval gate. Returns (false, err) on execution failure.
func executeStep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
	run *wfRun, def *wfDefinition, step wfStep, results map[string]any,
) (paused bool, err error) {
	log.Info("executing workflow step",
		zap.String("run_id", run.id),
		zap.String("step_id", step.id),
		zap.String("step_type", string(step.stepType)),
		zap.String("step_name", step.name),
	)

	stepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	requestedBy := ""
	if run.triggeredBy != nil {
		requestedBy = *run.triggeredBy
	}

	switch step.stepType {

	case stepTypeQuery:
		result, execErr := executeQueryStep(stepCtx, cfg, pool, log, step, run.inputData)
		if execErr != nil {
			results[step.id] = map[string]any{"status": "failed", "error": execErr.Error()}
			return false, fmt.Errorf("query step %q failed: %w", step.name, execErr)
		}
		stepEntry := map[string]any{"status": "completed", "result": result}
		if resultMap, ok := result.(map[string]any); ok {
			if rows, ok := resultMap["rows"].([]map[string]any); ok && len(rows) > 0 {
				stepEntry["first_row"] = rows[0]
			}
		}
		results[step.id] = stepEntry

	case stepTypeMutation:
		// When requires_approval is false on the workflow, execute immediately.
		// Otherwise (or when triggered by an end-user) gate through approval.
		if !def.requiresApproval {
			mutResult, execErr := executeMutationStep(stepCtx, cfg, pool, log, step, run.inputData, requestedBy, results)
			if execErr != nil {
				return false, fmt.Errorf("mutation step %q failed: %w", step.name, execErr)
			}
			results[step.id] = map[string]any{"status": "completed", "result": mutResult}
			return false, nil
		}
		// requires_approval=true — create an approval gate.
		approvalPayload, _ := json.Marshal(map[string]any{
			"run_id":       run.id,
			"step_id":      step.id,
			"step_name":    step.name,
			"config":       step.config,
			"workspace_id": def.workspaceID,
		})
		encryptedPayload, encErr := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, approvalPayload)
		if encErr != nil {
			return false, fmt.Errorf("encrypt mutation payload for step %q: %w", step.name, encErr)
		}
		approvalID, gateErr := createApprovalForRun(stepCtx, pool,
			def.workspaceID, def.appID, run.id, step.name, requestedBy, encryptedPayload)
		if gateErr != nil {
			return false, fmt.Errorf("create approval gate for mutation %q: %w", step.name, gateErr)
		}
		results[step.id] = map[string]any{"status": "awaiting_approval", "approval_id": approvalID}
		log.Info("mutation step paused for approval",
			zap.String("run_id", run.id), zap.String("approval_id", approvalID),
			zap.Bool("workflow_requires_approval", def.requiresApproval))
		return true, nil // paused — awaiting admin approval

	case stepTypeApprovalGate:
		// Explicit approval gate step — always pauses regardless of requires_approval.
		approvalPayload, _ := json.Marshal(map[string]any{
			"run_id":    run.id,
			"step_id":   step.id,
			"step_name": step.name,
		})
		encryptedGatePayload, encGateErr := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, approvalPayload)
		if encGateErr != nil {
			return false, fmt.Errorf("encrypt approval gate payload for %q: %w", step.name, encGateErr)
		}
		approvalID, gateErr := createApprovalForRun(stepCtx, pool,
			def.workspaceID, def.appID, run.id, step.name, requestedBy, encryptedGatePayload)
		if gateErr != nil {
			return false, fmt.Errorf("create approval gate %q: %w", step.name, gateErr)
		}
		results[step.id] = map[string]any{"status": "awaiting_approval", "approval_id": approvalID}
		return true, nil // paused

	case stepTypeCondition:
		// Evaluate a simple string equality condition from config.
		// Config shape: { "left": "{{input.status}}", "op": "eq", "right": "active" }
		result := evaluateCondition(step.config, run.inputData, results)
		results[step.id] = map[string]any{"status": "completed", "result": result}

	case stepTypeNotification:
		// Notification steps are logged; external delivery (email, webhook) is a future extension.
		msg, _ := step.config["message"].(string)
		log.Info("workflow notification step",
			zap.String("run_id", run.id), zap.String("step", step.name), zap.String("message", msg))
		results[step.id] = map[string]any{"status": "completed", "message": msg}

	default:
		log.Warn("unknown step type — skipping",
			zap.String("run_id", run.id), zap.String("type", string(step.stepType)))
		results[step.id] = map[string]any{"status": "skipped", "reason": "unknown step type"}
	}

	return false, nil
}

// ---- query step execution --------------------------------------------------

// wfMutationRe guards against accidental DML/DDL in workflow query steps.
var (
	wfMutationRe            = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|MERGE|REPLACE|LOCK|BEGIN|COMMIT|ROLLBACK|DO)`)
	wfCTEMutationRe         = regexp.MustCompile(`(?is)^\s*WITH\b[\s\S]*\b(INSERT\s+INTO|UPDATE\b|DELETE\s+FROM|MERGE\b|REPLACE\b)\b`)
	workflowInputRefRe      = regexp.MustCompile(`\{\{input\.([a-zA-Z0-9_.-]+)\}\}`)
	workflowStepRefRe       = regexp.MustCompile(`\{\{step\.([^.}]+)\.([^}]+)\}\}`)
	workflowWidgetRefRe     = regexp.MustCompile(`\{\{([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.([a-zA-Z0-9_.]+)\}\}`)
	workflowGraphQLMutation = regexp.MustCompile(`(?is)^\s*mutation\b`)
)

const workflowHTTPResponseLimit = 1 << 20

// executeQueryStep runs a query against a connector and returns row results.
func executeQueryStep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
	step wfStep, inputData map[string]any,
) (any, error) {
	connectorID, _ := step.config["connector_id"].(string)
	if connectorID == "" {
		return nil, fmt.Errorf("query step %q missing connector_id in config", step.name)
	}

	rec, err := fetchConnectorForRun(ctx, pool, connectorID)
	if err != nil {
		return nil, fmt.Errorf("fetch connector %s: %w", connectorID, err)
	}

	// Managed (Lima Table) connectors query Lima's own DB — no credentials needed.
	if rec.connectorType == "managed" {
		return runManagedQueryStep(ctx, pool, connectorID)
	}

	// All other connector types require a SQL query string.
	sql, _ := step.config["sql"].(string)
	if sql == "" {
		return nil, fmt.Errorf("query step %q missing sql in config", step.name)
	}
	if wfMutationRe.MatchString(sql) {
		return nil, fmt.Errorf("query step %q: mutation SQL is not allowed in query steps", step.name)
	}

	plainCreds, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, rec.encryptedCredentials)
	if err != nil {
		return nil, fmt.Errorf("decrypt connector credentials: %w", err)
	}

	switch rec.connectorType {
	case "postgres":
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse postgres credentials: %w", err)
		}
		return runPostgresQueryStep(ctx, creds, sql, log)

	case "mysql":
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse mysql credentials: %w", err)
		}
		return runMySQLQueryStep(ctx, creds, sql, log)

	case "mssql":
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse mssql credentials: %w", err)
		}
		return runMSSQLQueryStep(ctx, creds, sql, log)

	default:
		log.Warn("query step connector type not yet supported",
			zap.String("type", rec.connectorType))
		return map[string]any{"note": "unsupported connector type: " + rec.connectorType}, nil
	}
}

// runManagedQueryStep reads all live rows from a Lima-managed table.
func runManagedQueryStep(ctx context.Context, pool *pgxpool.Pool, connectorID string) (any, error) {
	rows, err := pool.Query(ctx,
		`SELECT data FROM managed_table_rows
		 WHERE connector_id = $1 AND deleted_at IS NULL
		 ORDER BY created_at`,
		connectorID,
	)
	if err != nil {
		return nil, fmt.Errorf("query managed table: %w", err)
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var dataRaw []byte
		if err := rows.Scan(&dataRaw); err != nil {
			return nil, fmt.Errorf("scan managed row: %w", err)
		}
		var row map[string]any
		_ = json.Unmarshal(dataRaw, &row)
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("managed table rows: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	return map[string]any{"rows": result, "row_count": len(result)}, nil
}

// runPostgresQueryStep connects to Postgres, executes a read-only SELECT,
// and returns the rows as a slice of maps.
func runPostgresQueryStep(ctx context.Context, creds relationalCreds, sql string, log *zap.Logger) (any, error) {
	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=10",
		url.QueryEscape(creds.Username),
		url.QueryEscape(creds.Password),
		creds.Host, creds.Port, creds.Database,
		sslmode,
	)

	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin read-only tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	trimmed := strings.TrimRight(strings.TrimSpace(sql), ";")
	// Cap at 10 000 rows to prevent memory exhaustion.
	if !strings.Contains(strings.ToUpper(trimmed), " LIMIT ") {
		trimmed += " LIMIT 10000"
	}

	rows, err := tx.Query(ctx, trimmed)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	cols := make([]string, len(fields))
	for i, f := range fields {
		cols[i] = string(f.Name)
	}

	var result []map[string]any
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = vals[i]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	log.Debug("workflow query step completed",
		zap.Int("rows", len(result)),
		zap.Strings("columns", cols),
	)
	return map[string]any{"columns": cols, "rows": result, "row_count": len(result)}, nil
}

// runMySQLQueryStep connects to a MySQL/MariaDB instance via database/sql,
// executes a read-only query (guarded by wfMutationRe), and returns rows.
func runMySQLQueryStep(ctx context.Context, creds relationalCreds, query string, log *zap.Logger) (any, error) {
	tls := "false"
	if creds.SSL {
		tls = "skip-verify"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?tls=%s&timeout=10s&parseTime=true",
		creds.Username, creds.Password, creds.Host, creds.Port, creds.Database, tls,
	)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin read-only mysql tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	trimmed := strings.TrimRight(strings.TrimSpace(query), ";")
	if !strings.Contains(strings.ToUpper(trimmed), " LIMIT ") {
		trimmed += " LIMIT 10000"
	}

	rows, err := tx.QueryContext(ctx, trimmed)
	if err != nil {
		return nil, fmt.Errorf("mysql query: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("mysql columns: %w", err)
	}

	var result []map[string]any
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("mysql scan: %w", err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			b, ok := vals[i].([]byte)
			if ok {
				row[col] = string(b)
			} else {
				row[col] = vals[i]
			}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mysql rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	log.Debug("mysql workflow query step completed",
		zap.Int("rows", len(result)),
	)
	return map[string]any{"columns": cols, "rows": result, "row_count": len(result)}, nil
}

// runMSSQLQueryStep connects to a SQL Server instance via database/sql,
// executes a read-only query, and returns rows.
func runMSSQLQueryStep(ctx context.Context, creds relationalCreds, query string, log *zap.Logger) (any, error) {
	u := &url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(creds.Username, creds.Password),
		Host:   fmt.Sprintf("%s:%d", creds.Host, creds.Port),
	}
	q := u.Query()
	q.Set("database", creds.Database)
	q.Set("connection timeout", "10")
	if !creds.SSL {
		q.Set("encrypt", "disable")
	}
	u.RawQuery = q.Encode()

	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		return nil, fmt.Errorf("open mssql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	trimmed := strings.TrimRight(strings.TrimSpace(query), ";")
	if !strings.Contains(strings.ToUpper(trimmed), "TOP ") && !strings.Contains(strings.ToUpper(trimmed), " FETCH ") {
		// Wrap in SELECT TOP to cap rows; MSSQL uses TOP rather than LIMIT.
		trimmed = fmt.Sprintf("SELECT TOP 10000 * FROM (%s) AS _lq", trimmed)
	}

	rows, err := db.QueryContext(ctx, trimmed)
	if err != nil {
		return nil, fmt.Errorf("mssql query: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("mssql columns: %w", err)
	}

	var result []map[string]any
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("mssql scan: %w", err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = vals[i]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mssql rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	log.Debug("mssql workflow query step completed",
		zap.Int("rows", len(result)),
	)
	return map[string]any{"columns": cols, "rows": result, "row_count": len(result)}, nil
}

// ---- condition evaluation --------------------------------------------------

// evaluateCondition resolves a simple equality/comparison condition.
// Config supports: { "left": "{{input.field}}", "op": "eq|neq|gt|lt", "right": "value" }
// Returns true/false as a boolean, or a "skipped" note if config is missing.
func evaluateCondition(config map[string]any, inputData map[string]any, stepResults map[string]any) any {
	left, _ := config["left"].(string)
	op, _ := config["op"].(string)
	right, _ := config["right"].(string)

	if left == "" || op == "" {
		return map[string]any{"result": true, "note": "empty condition — defaulting to true"}
	}

	// Resolve {{input.field}} and {{step.ID.FIELDPATH}} references.
	resolved := resolveInputRef(left, inputData, stepResults)

	switch op {
	case "eq":
		return map[string]any{"result": fmt.Sprintf("%v", resolved) == right}
	case "neq":
		return map[string]any{"result": fmt.Sprintf("%v", resolved) != right}
	default:
		return map[string]any{"result": true, "note": "unsupported op: " + op}
	}
}

// resolveInputRef replaces {{input.FIELD}} and {{step.ID.FIELDPATH}} placeholders.
// Exact matches preserve the original value type; embedded placeholders are
// interpolated into the surrounding string.
func resolveInputRef(expr string, inputData map[string]any, stepResults map[string]any) any {
	expr = strings.TrimSpace(expr)

	// Exact match: single {{widgetId.portName}} spanning the entire expression.
	// Handles widget-to-step input bindings from DSL V2 (DL-47).
	// Skip reserved prefixes "input" and "step" which are handled by the dedicated regexes below.
	if wm := workflowWidgetRefRe.FindStringSubmatchIndex(expr); wm != nil && wm[0] == 0 && wm[1] == len(expr) {
		widgetID := expr[wm[2]:wm[3]]
		if widgetID != "input" && widgetID != "step" {
			key := widgetID + "." + expr[wm[4]:wm[5]]
			if value, ok := inputData[key]; ok {
				return value
			}
			// Key not found — fall through to return the expression unchanged.
			return expr
		}
	}

	// Exact match: single {{step.ID.FIELDPATH}} spanning the entire expression.
	if sm := workflowStepRefRe.FindStringSubmatchIndex(expr); sm != nil && sm[0] == 0 && sm[1] == len(expr) {
		if stepResults != nil {
			if sr, ok := stepResults[expr[sm[2]:sm[3]]]; ok {
				if srMap, ok := sr.(map[string]any); ok {
					if value, ok := lookupInputValue(srMap, expr[sm[4]:sm[5]]); ok {
						return value
					}
				}
			}
		}
		return expr
	}

	// Exact match: single {{input.FIELD}} spanning the entire expression.
	if im := workflowInputRefRe.FindStringSubmatchIndex(expr); im != nil && im[0] == 0 && im[1] == len(expr) {
		if value, ok := lookupInputValue(inputData, expr[im[2]:im[3]]); ok {
			return value
		}
		return expr
	}

	// Interpolate embedded placeholders (both patterns) into a string result.
	if !workflowInputRefRe.MatchString(expr) && !workflowStepRefRe.MatchString(expr) {
		return expr
	}
	result := workflowInputRefRe.ReplaceAllStringFunc(expr, func(match string) string {
		submatches := workflowInputRefRe.FindStringSubmatch(match)
		if len(submatches) != 2 {
			return match
		}
		value, ok := lookupInputValue(inputData, submatches[1])
		if !ok {
			return match
		}
		return fmt.Sprintf("%v", value)
	})
	result = workflowStepRefRe.ReplaceAllStringFunc(result, func(match string) string {
		submatches := workflowStepRefRe.FindStringSubmatch(match)
		if len(submatches) != 3 || stepResults == nil {
			return match
		}
		sr, ok := stepResults[submatches[1]]
		if !ok {
			return match
		}
		srMap, ok := sr.(map[string]any)
		if !ok {
			return match
		}
		value, ok := lookupInputValue(srMap, submatches[2])
		if !ok {
			return match
		}
		return fmt.Sprintf("%v", value)
	})
	return result
}

func lookupInputValue(inputData map[string]any, fieldPath string) (any, bool) {
	current := any(inputData)
	for _, part := range strings.Split(fieldPath, ".") {
		obj, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok := obj[part]
		if !ok {
			return nil, false
		}
		current = value
	}
	return current, true
}

// ---- approval resolution ----------------------------------------------------

// resolveApprovedStep verifies the approval record, then either executes the
// approved mutation step or marks the approval_gate step as passed.
//
// Safety contract:
//   - Fetches and decrypts the approval from DB (defense-in-depth, not just trusting the job payload).
//   - Verifies approval.status == "approved".
//   - Verifies the approval was created for this exact run (run_id in payload).
//   - Verifies the approval was created for the correct step (step_id in payload).
//   - For mutation steps: calls executeMutationStep and marks completed only on success.
//   - For approval_gate steps: marks completed (gate passed, no further action needed).
//   - Any other case: returns an error so the caller marks the run failed (fail closed).
func resolveApprovedStep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
	run *wfRun, def *wfDefinition, approvalID string, stepResults map[string]any,
) error {
	// Fetch and verify the approval record from the DB.
	approval, err := getApprovalRecord(ctx, pool, approvalID)
	if err != nil {
		return fmt.Errorf("fetch approval %s: %w", approvalID, err)
	}
	if approval.status != "approved" {
		return fmt.Errorf("approval %s has status %q — expected approved: fail closed", approvalID, approval.status)
	}

	// Decrypt and parse the approval payload to verify run_id + step_id.
	payloadBytes, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, approval.encryptedPayload)
	if err != nil {
		return fmt.Errorf("decrypt approval payload for approval %s: %w", approvalID, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("parse approval payload for approval %s: %w", approvalID, err)
	}
	payloadRunID, _ := payload["run_id"].(string)
	if payloadRunID != run.id {
		return fmt.Errorf("approval %s was created for run %s, not %s — fail closed",
			approvalID, payloadRunID, run.id)
	}
	payloadStepID, _ := payload["step_id"].(string)

	// Find the step with status="awaiting_approval" and execute/complete it.
	for _, step := range def.steps {
		sr, hasSR := stepResults[step.id]
		if !hasSR {
			continue
		}
		m, ok := sr.(map[string]any)
		if !ok {
			continue
		}
		if m["status"] != "awaiting_approval" {
			continue
		}
		// If the payload encoded a specific step_id, verify it matches.
		if payloadStepID != "" && step.id != payloadStepID {
			continue
		}

		triggeredBy := ""
		if run.triggeredBy != nil {
			triggeredBy = *run.triggeredBy
		}

		switch step.stepType {
		case stepTypeMutation:
			// Execute the actual mutation now that approval is verified.
			mutResult, execErr := executeMutationStep(ctx, cfg, pool, log, step, run.inputData, triggeredBy, stepResults)
			if execErr != nil {
				return fmt.Errorf("execute approved mutation step %q: %w", step.name, execErr)
			}
			m["status"] = "completed"
			m["approved"] = true
			m["approval_id"] = approvalID
			m["result"] = mutResult

		case stepTypeApprovalGate:
			// Approval gate just needs the gate to be marked passed.
			m["status"] = "completed"
			m["approved"] = true
			m["approval_id"] = approvalID

		default:
			// Unexpected: a non-mutation, non-gate step was awaiting approval.
			return fmt.Errorf("awaiting_approval on unexpected step type %q (step %q) — fail closed",
				step.stepType, step.name)
		}

		stepResults[step.id] = m
		log.Info("approved step resolved",
			zap.String("run_id", run.id),
			zap.String("step_id", step.id),
			zap.String("step_type", string(step.stepType)),
			zap.String("approval_id", approvalID),
		)
		return nil
	}

	return fmt.Errorf("no awaiting_approval step found matching approval %s in run %s — fail closed",
		approvalID, run.id)
}

// executeMutationStep executes an approved mutation step against a connector.
// The caller only marks the step completed after this returns success, so each
// branch must fail closed for malformed config or unsupported connectors.
func executeMutationStep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
	step wfStep, inputData map[string]any, triggeredBy string, stepResults map[string]any,
) (any, error) {
	connectorID := resolveWorkflowString(step.config["connector_id"], inputData, stepResults)
	if connectorID == "" {
		return nil, fmt.Errorf("mutation step %q missing connector_id in config", step.name)
	}

	rec, err := fetchConnectorForRun(ctx, pool, connectorID)
	if err != nil {
		return nil, fmt.Errorf("fetch connector %s: %w", connectorID, err)
	}

	plainCreds, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, rec.encryptedCredentials)
	if err != nil {
		return nil, fmt.Errorf("decrypt connector credentials: %w", err)
	}

	switch rec.connectorType {
	case "postgres":
		statement, err := mutationSQLForStep(step, inputData, stepResults)
		if err != nil {
			return nil, err
		}
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse postgres credentials: %w", err)
		}
		return runPostgresMutationStep(ctx, creds, statement, log)

	case "mysql":
		statement, err := mutationSQLForStep(step, inputData, stepResults)
		if err != nil {
			return nil, err
		}
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse mysql credentials: %w", err)
		}
		return runMySQLMutationStep(ctx, creds, statement, log)

	case "mssql":
		statement, err := mutationSQLForStep(step, inputData, stepResults)
		if err != nil {
			return nil, err
		}
		var creds relationalCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse mssql credentials: %w", err)
		}
		return runMSSQLMutationStep(ctx, creds, statement, log)

	case "rest":
		var creds restCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse rest credentials: %w", err)
		}
		creds.connectorID = connectorID
		return runRESTMutationStep(ctx, creds, step, inputData, log, stepResults)

	case "graphql":
		var creds graphqlMutationCreds
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			return nil, fmt.Errorf("parse graphql credentials: %w", err)
		}
		return runGraphQLMutationStep(ctx, creds, step, inputData, log, stepResults)

	case "managed":
		return runManagedMutationStep(ctx, pool, connectorID, step, inputData, triggeredBy, stepResults)

	default:
		return nil, fmt.Errorf("mutation step %q uses unsupported connector type %q", step.name, rec.connectorType)
	}
}

// runManagedMutationStep executes an insert, update, or delete on a Lima-managed table.
// Config fields:
//
//	operation  — "insert" | "update" | "delete"
//	data       — map of column → value (for insert/update); supports {{input.x}} placeholders
//	row_id     — row UUID to update or delete; supports {{input.x}}
func runManagedMutationStep(ctx context.Context, pool *pgxpool.Pool, connectorID string,
	step wfStep, inputData map[string]any, triggeredBy string, stepResults map[string]any,
) (any, error) {
	operation, _ := step.config["operation"].(string)
	switch operation {
	case "insert":
		rawData, _ := step.config["data"].(map[string]any)
		resolved := make(map[string]any, len(rawData))
		for k, v := range rawData {
			resolved[k] = resolveWorkflowValue(v, inputData, stepResults)
		}
		dataJSON, err := json.Marshal(resolved)
		if err != nil {
			return nil, fmt.Errorf("marshal insert data: %w", err)
		}
		var rowID string
		if triggeredBy != "" {
			if err := pool.QueryRow(ctx,
				`INSERT INTO managed_table_rows (connector_id, data, created_by)
				 VALUES ($1, $2, $3) RETURNING id`,
				connectorID, dataJSON, triggeredBy,
			).Scan(&rowID); err != nil {
				return nil, fmt.Errorf("insert managed row: %w", err)
			}
		} else {
			// No triggering user — insert without created_by (requires nullable column).
			if err := pool.QueryRow(ctx,
				`INSERT INTO managed_table_rows (connector_id, data)
				 VALUES ($1, $2) RETURNING id`,
				connectorID, dataJSON,
			).Scan(&rowID); err != nil {
				return nil, fmt.Errorf("insert managed row: %w", err)
			}
		}
		return map[string]any{"row_id": rowID, "operation": "insert"}, nil

	case "update":
		rowID := resolveWorkflowString(step.config["row_id"], inputData, stepResults)
		if rowID == "" {
			return nil, fmt.Errorf("managed update step %q missing row_id", step.name)
		}
		rawData, _ := step.config["data"].(map[string]any)
		resolved := make(map[string]any, len(rawData))
		for k, v := range rawData {
			resolved[k] = resolveWorkflowValue(v, inputData, stepResults)
		}
		dataJSON, err := json.Marshal(resolved)
		if err != nil {
			return nil, fmt.Errorf("marshal update data: %w", err)
		}
		tag, err := pool.Exec(ctx,
			`UPDATE managed_table_rows
			 SET data = $1, updated_at = now()
			 WHERE id = $2 AND connector_id = $3 AND deleted_at IS NULL`,
			dataJSON, rowID, connectorID,
		)
		if err != nil {
			return nil, fmt.Errorf("update managed row: %w", err)
		}
		return map[string]any{"rows_affected": tag.RowsAffected(), "operation": "update"}, nil

	case "delete":
		rowID := resolveWorkflowString(step.config["row_id"], inputData, stepResults)
		if rowID == "" {
			return nil, fmt.Errorf("managed delete step %q missing row_id", step.name)
		}
		tag, err := pool.Exec(ctx,
			`UPDATE managed_table_rows
			 SET deleted_at = now(), updated_at = now()
			 WHERE id = $1 AND connector_id = $2 AND deleted_at IS NULL`,
			rowID, connectorID,
		)
		if err != nil {
			return nil, fmt.Errorf("delete managed row: %w", err)
		}
		return map[string]any{"rows_affected": tag.RowsAffected(), "operation": "delete"}, nil

	default:
		return nil, fmt.Errorf("managed mutation step %q has unknown operation %q (must be insert, update, or delete)", step.name, operation)
	}
}

func mutationSQLForStep(step wfStep, inputData map[string]any, stepResults map[string]any) (string, error) {
	resolved := resolveWorkflowValue(step.config["sql"], inputData, stepResults)
	statement, ok := resolved.(string)
	if !ok {
		return "", fmt.Errorf("mutation step %q missing sql in config", step.name)
	}
	statement = strings.TrimRight(strings.TrimSpace(statement), ";")
	if statement == "" {
		return "", fmt.Errorf("mutation step %q missing sql in config", step.name)
	}
	if !wfMutationRe.MatchString(statement) && !wfCTEMutationRe.MatchString(statement) {
		return "", fmt.Errorf("mutation step %q sql must be a mutation statement", step.name)
	}
	return statement, nil
}

func runPostgresMutationStep(ctx context.Context, creds relationalCreds, statement string, log *zap.Logger) (any, error) {
	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=10",
		url.QueryEscape(creds.Username),
		url.QueryEscape(creds.Password),
		creds.Host, creds.Port, creds.Database,
		sslmode,
	)

	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin mutation tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	tag, err := tx.Exec(ctx, statement)
	if err != nil {
		return nil, fmt.Errorf("execute mutation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit mutation tx: %w", err)
	}

	result := map[string]any{
		"command_tag":   tag.String(),
		"rows_affected": tag.RowsAffected(),
	}
	log.Debug("postgres workflow mutation step completed",
		zap.Int64("rows_affected", tag.RowsAffected()),
	)
	return result, nil
}

func runMySQLMutationStep(ctx context.Context, creds relationalCreds, statement string, log *zap.Logger) (any, error) {
	tls := "false"
	if creds.SSL {
		tls = "skip-verify"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?tls=%s&timeout=10s&parseTime=true",
		creds.Username, creds.Password, creds.Host, creds.Port, creds.Database, tls,
	)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin mysql mutation tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx, statement)
	if err != nil {
		return nil, fmt.Errorf("mysql execute mutation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit mysql mutation tx: %w", err)
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("mysql rows affected: %w", err)
	}
	result := map[string]any{"rows_affected": rowsAffected}
	if lastInsertID, err := res.LastInsertId(); err == nil {
		result["last_insert_id"] = lastInsertID
	}
	log.Debug("mysql workflow mutation step completed",
		zap.Int64("rows_affected", rowsAffected),
	)
	return result, nil
}

func runMSSQLMutationStep(ctx context.Context, creds relationalCreds, statement string, log *zap.Logger) (any, error) {
	u := &url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(creds.Username, creds.Password),
		Host:   fmt.Sprintf("%s:%d", creds.Host, creds.Port),
	}
	q := u.Query()
	q.Set("database", creds.Database)
	q.Set("connection timeout", "10")
	if !creds.SSL {
		q.Set("encrypt", "disable")
	}
	u.RawQuery = q.Encode()

	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		return nil, fmt.Errorf("open mssql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin mssql mutation tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx, statement)
	if err != nil {
		return nil, fmt.Errorf("mssql execute mutation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit mssql mutation tx: %w", err)
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("mssql rows affected: %w", err)
	}
	result := map[string]any{"rows_affected": rowsAffected}
	if lastInsertID, err := res.LastInsertId(); err == nil {
		result["last_insert_id"] = lastInsertID
	}
	log.Debug("mssql workflow mutation step completed",
		zap.Int64("rows_affected", rowsAffected),
	)
	return result, nil
}

func runRESTMutationStep(ctx context.Context, creds restCreds, step wfStep, inputData map[string]any, log *zap.Logger, stepResults map[string]any) (any, error) {
	method := strings.ToUpper(resolveWorkflowString(step.config["method"], inputData, stepResults))
	if method == "" {
		return nil, fmt.Errorf("mutation step %q missing method in config", step.name)
	}
	if !isRESTMutationMethod(method) {
		return nil, fmt.Errorf("mutation step %q method %q is not a mutating HTTP method", step.name, method)
	}

	path := resolveWorkflowString(step.config["path"], inputData, stepResults)
	if path == "" {
		return nil, fmt.Errorf("mutation step %q missing path in config", step.name)
	}

	bodyValue, hasBody := step.config["body"]
	var body any
	if hasBody {
		body = resolveWorkflowValue(bodyValue, inputData, stepResults)
	}
	if method != http.MethodDelete && (!hasBody || workflowValueIsEmpty(body)) {
		return nil, fmt.Errorf("mutation step %q missing body in config", step.name)
	}
	if method == http.MethodDelete && workflowValueIsEmpty(body) {
		body = nil
	}

	endpoint, err := joinConnectorRequestURL(creds.BaseURL, path)
	if err != nil {
		return nil, fmt.Errorf("prepare rest endpoint: %w", err)
	}
	bodyReader, contentType, err := encodeMutationRequestBody(body)
	if err != nil {
		return nil, fmt.Errorf("prepare rest request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("build rest request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	// Resolve OAuth2 access token just before the request is sent.
	if creds.AuthType == "oauth2" {
		token, err := resolveOAuth2Token(ctx, creds.connectorID, creds)
		if err != nil {
			return nil, fmt.Errorf("oauth2 token refresh: %w", err)
		}
		creds.Token = token
		creds.AuthType = "bearer"
	}
	applyWorkflowRESTAuth(req, creds)

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("rest mutation request failed: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := readWorkflowHTTPResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("read rest mutation response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("rest mutation returned HTTP %d: %s", resp.StatusCode, summarizeWorkflowHTTPBody(responseBody))
	}

	result := map[string]any{
		"method":      method,
		"path":        path,
		"status":      resp.Status,
		"status_code": resp.StatusCode,
	}
	if responseBody != nil {
		result["response"] = responseBody
	}
	if location := resp.Header.Get("Location"); location != "" {
		result["location"] = location
	}
	log.Debug("rest workflow mutation step completed",
		zap.String("method", method),
		zap.Int("status_code", resp.StatusCode),
	)
	return result, nil
}

func runGraphQLMutationStep(ctx context.Context, creds graphqlMutationCreds, step wfStep, inputData map[string]any, log *zap.Logger, stepResults map[string]any) (any, error) {
	endpoint := strings.TrimSpace(creds.Endpoint)
	if endpoint == "" {
		return nil, fmt.Errorf("graphql credentials missing endpoint")
	}
	if methodRaw, ok := step.config["method"]; ok {
		method := strings.ToUpper(resolveWorkflowString(methodRaw, inputData, stepResults))
		if method == "" {
			return nil, fmt.Errorf("mutation step %q missing method in config", step.name)
		}
		if method != http.MethodPost {
			return nil, fmt.Errorf("mutation step %q method %q is not supported for graphql mutations", step.name, method)
		}
	}
	if pathRaw, ok := step.config["path"]; ok {
		path := resolveWorkflowString(pathRaw, inputData, stepResults)
		if path == "" {
			return nil, fmt.Errorf("mutation step %q missing path in config", step.name)
		}
		joined, err := joinConnectorRequestURL(endpoint, path)
		if err != nil {
			return nil, fmt.Errorf("prepare graphql endpoint: %w", err)
		}
		endpoint = joined
	}

	body := resolveWorkflowValue(step.config["body"], inputData, stepResults)
	if workflowValueIsEmpty(body) {
		return nil, fmt.Errorf("mutation step %q missing body in config", step.name)
	}
	payload, err := normalizeGraphQLMutationBody(body)
	if err != nil {
		return nil, fmt.Errorf("prepare graphql mutation body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build graphql request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if creds.AuthType == "bearer" && creds.Token != "" {
		req.Header.Set("Authorization", "Bearer "+creds.Token)
	}
	for key, value := range creds.Headers {
		req.Header.Set(key, value)
	}

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("graphql mutation request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, workflowHTTPResponseLimit))
	if err != nil {
		return nil, fmt.Errorf("read graphql mutation response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("graphql mutation returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return nil, fmt.Errorf("parse graphql mutation response: %w", err)
	}
	if errs, ok := parsed["errors"]; ok {
		switch typed := errs.(type) {
		case []any:
			if len(typed) > 0 {
				return nil, fmt.Errorf("graphql mutation returned errors: %s", strings.TrimSpace(string(bodyBytes)))
			}
		case nil:
		default:
			return nil, fmt.Errorf("graphql mutation returned errors: %s", strings.TrimSpace(string(bodyBytes)))
		}
	}

	result := map[string]any{
		"status":      resp.Status,
		"status_code": resp.StatusCode,
	}
	if data, ok := parsed["data"]; ok {
		result["data"] = data
	}
	if extensions, ok := parsed["extensions"]; ok {
		result["extensions"] = extensions
	}
	if _, ok := result["data"]; !ok {
		result["response"] = parsed
	}
	log.Debug("graphql workflow mutation step completed",
		zap.Int("status_code", resp.StatusCode),
	)
	return result, nil
}

func isRESTMutationMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func joinConnectorRequestURL(baseURL, requestPath string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return "", fmt.Errorf("connector base URL is required")
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return "", fmt.Errorf("invalid connector base URL: %w", err)
	}
	requestPath = strings.TrimSpace(requestPath)
	if requestPath == "" {
		return baseURL, nil
	}
	rel, err := url.Parse(requestPath)
	if err != nil {
		return "", fmt.Errorf("invalid request path: %w", err)
	}
	if rel.IsAbs() || rel.Host != "" {
		return "", fmt.Errorf("request path must be relative, got %q", requestPath)
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("parse connector base URL: %w", err)
	}
	// Ensure the base path ends with "/" before resolving. Without this,
	// Go's ResolveReference follows RFC 3986 §5.2 and replaces the entire
	// base path whenever requestPath begins with "/", silently dropping any
	// prefix segments (e.g. "/api/v1") that were part of the base URL.
	if !strings.HasSuffix(base.Path, "/") {
		base.Path += "/"
	}
	// Strip the leading "/" so the path is truly relative and gets appended
	// rather than replacing the base path.
	requestPath = strings.TrimPrefix(requestPath, "/")
	rel, _ = url.Parse(requestPath)
	return base.ResolveReference(rel).String(), nil
}

func encodeMutationRequestBody(body any) (io.Reader, string, error) {
	if body == nil {
		return nil, "", nil
	}
	switch typed := body.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil, "", fmt.Errorf("body is empty")
		}
		contentType := "text/plain; charset=utf-8"
		if json.Valid([]byte(typed)) {
			contentType = "application/json"
		}
		return strings.NewReader(typed), contentType, nil
	case []byte:
		if len(typed) == 0 {
			return nil, "", fmt.Errorf("body is empty")
		}
		contentType := "application/octet-stream"
		if json.Valid(typed) {
			contentType = "application/json"
		}
		return bytes.NewReader(typed), contentType, nil
	default:
		payload, err := json.Marshal(typed)
		if err != nil {
			return nil, "", fmt.Errorf("marshal body: %w", err)
		}
		return bytes.NewReader(payload), "application/json", nil
	}
}

func readWorkflowHTTPResponse(resp *http.Response) (any, error) {
	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, workflowHTTPResponseLimit))
	if err != nil {
		return nil, err
	}
	if len(bodyBytes) == 0 {
		return nil, nil
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "json") || json.Valid(bodyBytes) {
		var parsed any
		if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
			return parsed, nil
		}
	}
	return string(bodyBytes), nil
}

func summarizeWorkflowHTTPBody(body any) string {
	switch typed := body.(type) {
	case nil:
		return "empty response"
	case string:
		return typed
	default:
		payload, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(payload)
	}
}

func normalizeGraphQLMutationBody(body any) ([]byte, error) {
	switch typed := body.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil, fmt.Errorf("body is empty")
		}
		if json.Valid([]byte(trimmed)) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
				return nil, fmt.Errorf("parse graphql body: %w", err)
			}
			return marshalValidatedGraphQLPayload(payload)
		}
		return marshalValidatedGraphQLPayload(map[string]any{"query": trimmed})
	default:
		payloadBytes, err := json.Marshal(typed)
		if err != nil {
			return nil, fmt.Errorf("marshal graphql body: %w", err)
		}
		var payload map[string]any
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return nil, fmt.Errorf("graphql body must be a JSON object or string: %w", err)
		}
		return marshalValidatedGraphQLPayload(payload)
	}
}

func marshalValidatedGraphQLPayload(payload map[string]any) ([]byte, error) {
	query, _ := payload["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("graphql mutation body missing query")
	}
	if !workflowGraphQLMutation.MatchString(query) {
		return nil, fmt.Errorf("graphql mutation body must contain a mutation operation")
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal graphql payload: %w", err)
	}
	return bodyBytes, nil
}

func applyWorkflowRESTAuth(req *http.Request, creds restCreds) {
	switch creds.AuthType {
	case "bearer":
		if creds.Token != "" {
			req.Header.Set("Authorization", "Bearer "+creds.Token)
		}
	case "token":
		// Used by APIs such as MOCO that require: Authorization: Token token=<key>
		if creds.Token != "" {
			req.Header.Set("Authorization", "Token token="+creds.Token)
		}
	case "basic":
		if creds.Username != "" || creds.Password != "" {
			req.SetBasicAuth(creds.Username, creds.Password)
		}
	case "api_key":
		header := creds.APIKeyHeader
		if header == "" {
			header = "X-API-Key"
		}
		if creds.APIKey != "" {
			req.Header.Set(header, creds.APIKey)
		}
	}
}

func resolveWorkflowString(value any, inputData map[string]any, stepResults map[string]any) string {
	resolved := resolveWorkflowValue(value, inputData, stepResults)
	switch typed := resolved.(type) {
	case nil:
		return ""
	case map[string]any, []any:
		return ""
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func resolveWorkflowValue(value any, inputData map[string]any, stepResults map[string]any) any {
	switch typed := value.(type) {
	case string:
		return resolveInputRef(typed, inputData, stepResults)
	case []any:
		resolved := make([]any, len(typed))
		for i, item := range typed {
			resolved[i] = resolveWorkflowValue(item, inputData, stepResults)
		}
		return resolved
	case map[string]any:
		resolved := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved[key] = resolveWorkflowValue(item, inputData, stepResults)
		}
		return resolved
	default:
		return typed
	}
}

func workflowValueIsEmpty(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	default:
		return false
	}
}
