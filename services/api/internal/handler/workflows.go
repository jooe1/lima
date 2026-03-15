package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

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
			Name             string                 `json:"name"`
			Description      *string                `json:"description"`
			TriggerType      model.WorkflowTrigger  `json:"trigger_type"`
			TriggerConfig    map[string]any         `json:"trigger_config"`
			RequiresApproval *bool                  `json:"requires_approval"`
			Steps            []workflowStepInput    `json:"steps"`
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
func TriggerWorkflow(s *store.Store, log *zap.Logger) http.HandlerFunc {
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

		run, err := s.CreateWorkflowRun(r.Context(), workspaceID, workflowID, &claims.UserID, req.InputData)
		if err != nil {
			log.Error("trigger workflow", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create workflow run")
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
	Name        string                 `json:"name"`
	StepType    model.WorkflowStepType `json:"step_type"`
	Config      map[string]any         `json:"config"`
	AIGenerated bool                   `json:"ai_generated"`
}

func stepsFromInput(inputs []workflowStepInput) []model.WorkflowStep {
	steps := make([]model.WorkflowStep, 0, len(inputs))
	for _, inp := range inputs {
		config := inp.Config
		if config == nil {
			config = map[string]any{}
		}
		steps = append(steps, model.WorkflowStep{
			Name:        strings.TrimSpace(inp.Name),
			StepType:    inp.StepType,
			Config:      config,
			AIGenerated: inp.AIGenerated,
		})
	}
	return steps
}
