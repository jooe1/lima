package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

const (
	workflowEnqueueAttempts   = 3
	workflowEnqueueRetryDelay = 250 * time.Millisecond
)

var errWorkflowQueueUnavailable = errors.New("workflow queue unavailable")

var cronFieldPattern = regexp.MustCompile(`^[0-9*/,-]+$`)

// ListWorkflows returns all workflows for an app.
func ListWorkflows(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")

		workflows, err := s.ListWorkflows(r.Context(), workspaceID, appID)
		if err != nil {
			log.Error("list workflows", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list workflows")
			return
		}
		if workflows == nil {
			workflows = []model.Workflow{}
		}
		respond(w, http.StatusOK, map[string]any{"workflows": workflows})
	}
}

// GetWorkflow returns a single workflow with its ordered steps.
func GetWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		wf, err := s.GetWorkflowWithSteps(r.Context(), workspaceID, workflowID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, wf)
	}
}

// CreateWorkflow creates a new workflow (always starts as draft).
// Builders may create; admins may create. The request may include an initial
// set of steps. All steps received from the builder are marked ai_generated=false
// unless explicitly flagged; steps injected by the AI generation layer should
// set ai_generated=true so they show up for builder review.
func CreateWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			Name             string                `json:"name"`
			Description      *string               `json:"description"`
			TriggerType      model.WorkflowTrigger `json:"trigger_type"`
			TriggerConfig    map[string]any        `json:"trigger_config"`
			RequiresApproval *bool                 `json:"requires_approval"`
			Steps            []workflowStepInput   `json:"steps"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "name is required")
			return
		}
		if req.TriggerType == "" {
			req.TriggerType = model.TriggerManual
		}
		if req.TriggerConfig == nil {
			req.TriggerConfig = map[string]any{}
		}
		normalizedTriggerConfig, err := normalizeWorkflowTriggerConfig(req.TriggerType, req.TriggerConfig)
		if err != nil {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
			return
		}
		req.TriggerConfig = normalizedTriggerConfig
		requiresApproval := true
		if req.RequiresApproval != nil {
			requiresApproval = *req.RequiresApproval
		}

		steps := stepsFromInput(req.Steps)

		wf, err := s.CreateWorkflow(r.Context(), workspaceID, appID, req.Name, req.Description,
			req.TriggerType, req.TriggerConfig, requiresApproval, claims.UserID, steps)
		if err != nil {
			log.Error("create workflow", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create workflow")
			return
		}
		respond(w, http.StatusCreated, wf)
	}
}

// PatchWorkflow updates mutable fields on a workflow. Steps are managed via
// the dedicated steps endpoint.
func PatchWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		var req struct {
			Name             *string                `json:"name"`
			Description      *string                `json:"description"`
			TriggerType      *model.WorkflowTrigger `json:"trigger_type"`
			TriggerConfig    map[string]any         `json:"trigger_config"`
			RequiresApproval *bool                  `json:"requires_approval"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Name != nil {
			*req.Name = strings.TrimSpace(*req.Name)
			if *req.Name == "" {
				respondErr(w, http.StatusBadRequest, "bad_request", "name cannot be empty")
				return
			}
		}

		if req.TriggerType != nil || req.TriggerConfig != nil {
			currentWorkflow, err := s.GetWorkflowWithSteps(r.Context(), workspaceID, workflowID)
			if err != nil {
				handleStoreErr(w, err)
				return
			}

			effectiveTriggerType := currentWorkflow.TriggerType
			if req.TriggerType != nil {
				effectiveTriggerType = *req.TriggerType
			}

			effectiveTriggerConfig := currentWorkflow.TriggerConfig
			if req.TriggerConfig != nil {
				effectiveTriggerConfig = req.TriggerConfig
			}

			normalizedTriggerConfig, err := normalizeWorkflowTriggerConfig(effectiveTriggerType, effectiveTriggerConfig)
			if err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
				return
			}

			req.TriggerConfig = normalizedTriggerConfig
		}

		wf, err := s.PatchWorkflow(r.Context(), workspaceID, workflowID,
			req.Name, req.Description, req.TriggerType, req.TriggerConfig, req.RequiresApproval)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, wf)
	}
}

// ActivateWorkflow transitions a draft workflow to active. Only workspace_admins
// may activate, enforced by the RBAC middleware in the router. Activation fails
// if any AI-generated step has not yet been reviewed.
func ActivateWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		// Guard: all AI-generated steps must be reviewed before activation.
		wf, err := s.GetWorkflowWithSteps(r.Context(), workspaceID, workflowID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		for _, step := range wf.Steps {
			if step.AIGenerated && step.ReviewedBy == nil {
				respondErr(w, http.StatusUnprocessableEntity, "unreviewed_steps",
					"all AI-generated steps must be reviewed before activation")
				return
			}
		}

		updated, err := s.ActivateWorkflow(r.Context(), workspaceID, workflowID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, updated)
	}
}

// ArchiveWorkflow sets status to archived.
func ArchiveWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		updated, err := s.ArchiveWorkflow(r.Context(), workspaceID, workflowID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, updated)
	}
}

// DeleteWorkflow removes a workflow and its steps/runs.
func DeleteWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		if err := s.DeleteWorkflow(r.Context(), workspaceID, workflowID); err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

// PutWorkflowSteps replaces the full step list for a workflow.
func PutWorkflowSteps(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		var req struct {
			Steps []workflowStepInput `json:"steps"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		steps, err := s.UpsertWorkflowSteps(r.Context(), workspaceID, workflowID, stepsFromInput(req.Steps))
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]any{"steps": steps})
	}
}

// ReviewStep marks an AI-generated step as reviewed by the current builder.
// Any authenticated app_builder or workspace_admin may review steps.
func ReviewStep(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")
		stepID := chi.URLParam(r, "stepID")
		claims, _ := ClaimsFromContext(r.Context())

		step, err := s.ReviewStep(r.Context(), workspaceID, workflowID, stepID, claims.UserID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, step)
	}
}

// TriggerWorkflow creates a new run record for a workflow. For active workflows
// this creates a run with status=pending that the worker will pick up. For draft
// workflows the run is still created so builders can test the flow manually.
// If the execution job cannot be queued after retries, the run is cleaned up
// and the request fails.
func TriggerWorkflow(cfg *config.Config, s triggerWorkflowStore, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			InputData map[string]any `json:"input_data"`
		}
		_ = decodeJSON(r, &req) // input is optional
		if req.InputData == nil {
			req.InputData = map[string]any{}
		}

		// Determine the caller's workspace role to decide the execution path.
		callerRole, err := s.GetMemberRole(r.Context(), workspaceID, claims.UserID)
		if err != nil {
			respondErr(w, http.StatusForbidden, "not_a_member", "you are not a member of this workspace")
			return
		}

		// end_user path: enforce per-connector mutate grants and force approval gating.
		if callerRole == model.RoleEndUser {
			run, trigErr := triggerEndUserWorkflowRun(
				r.Context(), s, cfg.CredentialsEncryptionKey,
				claims.CompanyID, workspaceID, workflowID, claims.UserID, req.InputData,
			)
			if trigErr != nil {
				var grantErr *errMutateGrantRequired
				if errors.As(trigErr, &grantErr) {
					respond(w, http.StatusForbidden, map[string]string{
						"error":        "mutate_grant_required",
						"connector_id": grantErr.ConnectorID,
					})
					return
				}
				log.Error("end_user trigger workflow", zap.Error(trigErr))
				respondErr(w, http.StatusInternalServerError, "internal_error", "failed to trigger workflow")
				return
			}
			respond(w, http.StatusAccepted, run)
			return
		}

		// app_builder / workspace_admin path: existing behavior — enqueue immediately.
		run, err := s.CreateWorkflowRun(r.Context(), workspaceID, workflowID, &claims.UserID, req.InputData)
		if err != nil {
			log.Error("trigger workflow", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create workflow run")
			return
		}

		payload := model.WorkflowJobPayload{
			RunID:       run.ID,
			WorkflowID:  workflowID,
			WorkspaceID: workspaceID,
		}
		if err := enqueueWorkflowJob(r.Context(), workflowEnqueueAttempts, workflowEnqueueRetryDelay, func(ctx context.Context) error {
			if enq == nil {
				return errWorkflowQueueUnavailable
			}
			return enq.EnqueueWorkflow(ctx, payload)
		}); err != nil {
			log.Warn("workflow job enqueue failed after retries", zap.String("run_id", run.ID), zap.Error(err))
			if cleanupErr := cleanupTriggeredWorkflowRun(r.Context(), s, workspaceID, run.ID); cleanupErr != nil {
				log.Error("workflow run cleanup failed after enqueue error",
					zap.String("run_id", run.ID), zap.Error(cleanupErr))
			}
			respondErr(w, http.StatusServiceUnavailable, "queue_unavailable", "workflow trigger unavailable")
			return
		}

		respond(w, http.StatusCreated, run)
	}
}

// ListWorkflowRuns returns the most recent runs for a workflow.
func ListWorkflowRuns(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		workflowID := chi.URLParam(r, "workflowID")

		runs, err := s.ListWorkflowRuns(r.Context(), workspaceID, workflowID)
		if err != nil {
			log.Error("list runs", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list runs")
			return
		}
		if runs == nil {
			runs = []model.WorkflowRun{}
		}
		respond(w, http.StatusOK, map[string]any{"runs": runs})
	}
}

// ---- helpers ----------------------------------------------------------------

type workflowStepInput struct {
	Name              string                 `json:"name"`
	StepType          model.WorkflowStepType `json:"step_type"`
	Config            map[string]any         `json:"config"`
	AIGenerated       bool                   `json:"ai_generated"`
	NextStepID        *string                `json:"next_step_id,omitempty"`
	FalseBranchStepID *string                `json:"false_branch_step_id,omitempty"`
}

type workflowRunCleanupStore interface {
	DeleteWorkflowRun(ctx context.Context, workspaceID, runID string) error
	UpdateWorkflowRunStatus(ctx context.Context, runID string, status model.WorkflowRunStatus) error
}

func enqueueWorkflowJob(ctx context.Context, attempts int, retryDelay time.Duration, enqueue func(context.Context) error) error {
	if attempts < 1 {
		attempts = 1
	}

	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err = enqueue(ctx); err == nil {
			return nil
		}
		if attempt == attempts || retryDelay <= 0 {
			continue
		}

		timer := time.NewTimer(time.Duration(attempt) * retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}

	return err
}

func cleanupTriggeredWorkflowRun(ctx context.Context, s workflowRunCleanupStore, workspaceID, runID string) error {
	err := s.DeleteWorkflowRun(ctx, workspaceID, runID)
	if err == nil || errors.Is(err, store.ErrNotFound) {
		return nil
	}

	statusErr := s.UpdateWorkflowRunStatus(ctx, runID, model.RunStatusFailed)
	if statusErr == nil || errors.Is(statusErr, store.ErrNotFound) {
		return nil
	}

	return errors.Join(err, statusErr)
}

func normalizeWorkflowTriggerConfig(triggerType model.WorkflowTrigger, config map[string]any) (map[string]any, error) {
	if err := validateWorkflowTriggerType(triggerType); err != nil {
		return nil, err
	}
	if config == nil {
		config = map[string]any{}
	}

	switch triggerType {
	case model.TriggerManual:
		if err := validateTriggerConfigKeys(config); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	case model.TriggerSchedule:
		if err := validateTriggerConfigKeys(config, "cron"); err != nil {
			return nil, err
		}
		cron, err := requiredTriggerConfigString(config, "cron")
		if err != nil {
			return nil, err
		}
		if err := validateCronExpression(cron); err != nil {
			return nil, err
		}
		return map[string]any{"cron": cron}, nil
	case model.TriggerWebhook:
		if err := validateTriggerConfigKeys(config, "secret_token_hash"); err != nil {
			return nil, err
		}
		secret, err := requiredTriggerConfigString(config, "secret_token_hash")
		if err != nil {
			return nil, err
		}
		if strings.Contains(secret, " ") {
			return nil, fmt.Errorf("webhook secret cannot contain spaces")
		}
		if len(secret) < 8 {
			return nil, fmt.Errorf("webhook secret must be at least 8 characters")
		}
		return map[string]any{"secret_token_hash": secret}, nil
	case model.TriggerFormSubmit, model.TriggerButtonClick:
		if err := validateTriggerConfigKeys(config, "widget_id"); err != nil {
			return nil, err
		}
		widgetID, err := requiredTriggerConfigString(config, "widget_id")
		if err != nil {
			return nil, err
		}
		return map[string]any{"widget_id": widgetID}, nil
	default:
		return nil, fmt.Errorf("unsupported trigger_type %q", triggerType)
	}
}

func validateWorkflowTriggerType(triggerType model.WorkflowTrigger) error {
	switch triggerType {
	case model.TriggerManual,
		model.TriggerFormSubmit,
		model.TriggerButtonClick,
		model.TriggerSchedule,
		model.TriggerWebhook:
		return nil
	default:
		return fmt.Errorf("unsupported trigger_type %q", triggerType)
	}
}

func validateTriggerConfigKeys(config map[string]any, allowedKeys ...string) error {
	allowed := make(map[string]struct{}, len(allowedKeys))
	for _, key := range allowedKeys {
		allowed[key] = struct{}{}
	}

	var unexpected []string
	for key := range config {
		if _, ok := allowed[key]; ok {
			continue
		}
		unexpected = append(unexpected, key)
	}

	if len(unexpected) == 0 {
		return nil
	}

	sort.Strings(unexpected)
	return fmt.Errorf("unsupported trigger_config fields: %s", strings.Join(unexpected, ", "))
}

func requiredTriggerConfigString(config map[string]any, key string) (string, error) {
	value, ok := config[key]
	if !ok {
		return "", fmt.Errorf("trigger_config.%s is required", key)
	}

	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("trigger_config.%s must be a string", key)
	}

	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", fmt.Errorf("trigger_config.%s cannot be empty", key)
	}

	return trimmed, nil
}

func validateCronExpression(cron string) error {
	fields := strings.Fields(strings.TrimSpace(cron))
	if len(fields) != 5 {
		return fmt.Errorf("trigger_config.cron must use five cron fields")
	}

	for _, field := range fields {
		if !cronFieldPattern.MatchString(field) {
			return fmt.Errorf("trigger_config.cron field %q contains unsupported characters", field)
		}
	}

	return nil
}

func stepsFromInput(inputs []workflowStepInput) []model.WorkflowStep {
	steps := make([]model.WorkflowStep, 0, len(inputs))
	for _, inp := range inputs {
		config := inp.Config
		if config == nil {
			config = map[string]any{}
		}
		steps = append(steps, model.WorkflowStep{
			Name:              strings.TrimSpace(inp.Name),
			StepType:          inp.StepType,
			Config:            config,
			AIGenerated:       inp.AIGenerated,
			NextStepID:        inp.NextStepID,
			FalseBranchStepID: inp.FalseBranchStepID,
		})
	}
	return steps
}

// ---- end_user trigger path --------------------------------------------------

// errMutateGrantRequired is returned by triggerEndUserWorkflowRun when the
// caller lacks a "mutate" resource grant on one of the workflow's connectors.
type errMutateGrantRequired struct {
	ConnectorID string
}

func (e *errMutateGrantRequired) Error() string {
	return fmt.Sprintf("mutate grant required for connector %s", e.ConnectorID)
}

// endUserTriggerStore is the narrow store interface used by triggerEndUserWorkflowRun.
// *store.Store satisfies it; tests can inject a stub.
type endUserTriggerStore interface {
	GetWorkflowWithSteps(ctx context.Context, workspaceID, workflowID string) (*model.WorkflowWithSteps, error)
	HasResourceGrant(ctx context.Context, companyID, resourceKind, resourceID, subjectType, subjectID, action string) (bool, error)
	CreateWorkflowRun(ctx context.Context, workspaceID, workflowID string, triggeredBy *string, inputData map[string]any) (*model.WorkflowRun, error)
	UpdateWorkflowRunStatus(ctx context.Context, runID string, status model.WorkflowRunStatus) error
	CreateApproval(ctx context.Context, workspaceID string, appID, connectorID *string, description string, encryptedPayload []byte, requestedBy string) (*model.Approval, error)
	SetWorkflowRunApproval(ctx context.Context, runID, approvalID string) error
	DeleteWorkflowRun(ctx context.Context, workspaceID, runID string) error
}

// triggerWorkflowStore is the narrow store interface used by TriggerWorkflow.
// It merges the end-user execution sub-path (endUserTriggerStore) with the
// member-role lookup required by both execution paths.
// *store.Store satisfies it; tests can inject a stub.
type triggerWorkflowStore interface {
	endUserTriggerStore
	GetMemberRole(ctx context.Context, workspaceID, userID string) (model.WorkspaceRole, error)
}

// triggerEndUserWorkflowRun implements the end_user execution path for
// TriggerWorkflow. It:
//  1. Loads the workflow steps and checks that the caller holds a "mutate"
//     resource grant on every connector referenced by a mutation step.
//  2. Creates a WorkflowRun and immediately transitions it to awaiting_approval.
//  3. Creates an Approval record with the encrypted input payload.
//  4. Links the approval to the run.
//  5. Returns the updated run — the worker is NOT enqueued.
//
// Returns *errMutateGrantRequired (403) or another error (500).
func triggerEndUserWorkflowRun(
	ctx context.Context,
	s endUserTriggerStore,
	encKey string,
	companyID, workspaceID, workflowID, userID string,
	inputData map[string]any,
) (*model.WorkflowRun, error) {
	// Load the workflow definition including its steps.
	wf, err := s.GetWorkflowWithSteps(ctx, workspaceID, workflowID)
	if err != nil {
		return nil, fmt.Errorf("load workflow: %w", err)
	}

	// Verify the caller has a mutate grant for every mutation-step connector.
	for _, step := range wf.Steps {
		if step.StepType != model.StepTypeMutation {
			continue
		}
		connID, _ := step.Config["connector_id"].(string)
		if connID == "" {
			continue
		}
		ok, err := s.HasResourceGrant(ctx, companyID, "connector", connID, "user", userID, "mutate")
		if err != nil {
			return nil, fmt.Errorf("check resource grant: %w", err)
		}
		if !ok {
			return nil, &errMutateGrantRequired{ConnectorID: connID}
		}
	}

	// Create the run record (status starts as "pending" per DB default).
	run, err := s.CreateWorkflowRun(ctx, workspaceID, workflowID, &userID, inputData)
	if err != nil {
		return nil, fmt.Errorf("create workflow run: %w", err)
	}

	// Transition to awaiting_approval so the worker does not pick it up.
	if err := s.UpdateWorkflowRunStatus(ctx, run.ID, model.RunStatusAwaitingApproval); err != nil {
		_ = s.DeleteWorkflowRun(ctx, workspaceID, run.ID)
		return nil, fmt.Errorf("set run awaiting approval: %w", err)
	}
	run.Status = model.RunStatusAwaitingApproval

	// Encrypt the input data for safe at-rest storage in the approval record.
	payloadBytes, err := json.Marshal(inputData)
	if err != nil {
		_ = s.DeleteWorkflowRun(ctx, workspaceID, run.ID)
		return nil, fmt.Errorf("marshal input data: %w", err)
	}
	encrypted, err := cryptoutil.Encrypt(encKey, payloadBytes)
	if err != nil {
		_ = s.DeleteWorkflowRun(ctx, workspaceID, run.ID)
		return nil, fmt.Errorf("encrypt payload: %w", err)
	}

	// Create the approval record and link it to the run.
	approval, err := s.CreateApproval(ctx, workspaceID, &wf.AppID, nil, "Workflow trigger by end_user", encrypted, userID)
	if err != nil {
		_ = s.DeleteWorkflowRun(ctx, workspaceID, run.ID)
		return nil, fmt.Errorf("create approval: %w", err)
	}
	if err := s.SetWorkflowRunApproval(ctx, run.ID, approval.ID); err != nil {
		_ = s.DeleteWorkflowRun(ctx, workspaceID, run.ID)
		return nil, fmt.Errorf("link approval to run: %w", err)
	}
	run.ApprovalID = &approval.ID

	return run, nil
}
