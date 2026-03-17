package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// ---- Workflow ---------------------------------------------------------------

// ListWorkflows returns all workflows for a given app, ordered by name.
func (s *Store) ListWorkflows(ctx context.Context, workspaceID, appID string) ([]model.Workflow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, workspace_id, app_id, name, description,
		       trigger_type, trigger_config, status, requires_approval,
		       created_by, created_at, updated_at
		FROM workflows
		WHERE workspace_id = $1 AND app_id = $2
		ORDER BY name`,
		workspaceID, appID,
	)
	if err != nil {
		return nil, fmt.Errorf("list workflows: %w", err)
	}
	defer rows.Close()

	var workflows []model.Workflow
	for rows.Next() {
		var w model.Workflow
		var cfgBytes []byte
		if err := rows.Scan(
			&w.ID, &w.WorkspaceID, &w.AppID, &w.Name, &w.Description,
			&w.TriggerType, &cfgBytes, &w.Status, &w.RequiresApproval,
			&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list workflows scan: %w", err)
		}
		if err := json.Unmarshal(cfgBytes, &w.TriggerConfig); err != nil {
			w.TriggerConfig = map[string]any{}
		}
		workflows = append(workflows, w)
	}
	return workflows, rows.Err()
}

// GetWorkflowWithSteps returns a single workflow and all its ordered steps.
// Returns ErrNotFound if no matching workflow exists for the given workspace.
func (s *Store) GetWorkflowWithSteps(ctx context.Context, workspaceID, workflowID string) (*model.WorkflowWithSteps, error) {
	var w model.WorkflowWithSteps
	var cfgBytes []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, workspace_id, app_id, name, description,
		       trigger_type, trigger_config, status, requires_approval,
		       created_by, created_at, updated_at
		FROM workflows
		WHERE id = $1 AND workspace_id = $2`,
		workflowID, workspaceID,
	).Scan(
		&w.ID, &w.WorkspaceID, &w.AppID, &w.Name, &w.Description,
		&w.TriggerType, &cfgBytes, &w.Status, &w.RequiresApproval,
		&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get workflow: %w", err)
	}
	if err := json.Unmarshal(cfgBytes, &w.TriggerConfig); err != nil {
		w.TriggerConfig = map[string]any{}
	}

	steps, err := s.listWorkflowSteps(ctx, workflowID)
	if err != nil {
		return nil, err
	}
	w.Steps = steps
	return &w, nil
}

// CreateWorkflow inserts a new workflow and its initial steps in a transaction.
// Steps are inserted in the order they appear in the slice; step_order is
// derived from their position (0-based) so callers do not need to set it.
func (s *Store) CreateWorkflow(ctx context.Context, workspaceID, appID, name string, description *string,
	triggerType model.WorkflowTrigger, triggerConfig map[string]any,
	requiresApproval bool, createdBy string, steps []model.WorkflowStep,
) (*model.WorkflowWithSteps, error) {
	cfgBytes, err := json.Marshal(triggerConfig)
	if err != nil {
		return nil, fmt.Errorf("marshal trigger config: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var w model.Workflow
	err = tx.QueryRow(ctx, `
		INSERT INTO workflows
		    (workspace_id, app_id, name, description,
		     trigger_type, trigger_config, status, requires_approval, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8)
		RETURNING id, workspace_id, app_id, name, description,
		          trigger_type, trigger_config, status, requires_approval,
		          created_by, created_at, updated_at`,
		workspaceID, appID, name, description,
		triggerType, cfgBytes, requiresApproval, createdBy,
	).Scan(
		&w.ID, &w.WorkspaceID, &w.AppID, &w.Name, &w.Description,
		&w.TriggerType, &cfgBytes, &w.Status, &w.RequiresApproval,
		&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert workflow: %w", err)
	}
	if err := json.Unmarshal(cfgBytes, &w.TriggerConfig); err != nil {
		w.TriggerConfig = map[string]any{}
	}

	inserted := make([]model.WorkflowStep, 0, len(steps))
	for i, step := range steps {
		s2, err := insertWorkflowStep(ctx, tx, w.ID, i, step.Name, step.StepType, step.Config, step.AIGenerated)
		if err != nil {
			return nil, err
		}
		inserted = append(inserted, *s2)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit workflow: %w", err)
	}

	return &model.WorkflowWithSteps{Workflow: w, Steps: inserted}, nil
}

// PatchWorkflow updates the mutable fields of a workflow. Only non-nil pointer
// or non-zero-value fields are applied; status and steps are managed separately.
func (s *Store) PatchWorkflow(ctx context.Context, workspaceID, workflowID string,
	name *string, description *string,
	triggerType *model.WorkflowTrigger, triggerConfig map[string]any,
	requiresApproval *bool,
) (*model.Workflow, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, workspace_id, app_id, name, description,
		       trigger_type, trigger_config, status, requires_approval,
		       created_by, created_at, updated_at
		FROM workflows WHERE id = $1 AND workspace_id = $2`,
		workflowID, workspaceID,
	)
	var w model.Workflow
	var cfgBytes []byte
	if err := row.Scan(
		&w.ID, &w.WorkspaceID, &w.AppID, &w.Name, &w.Description,
		&w.TriggerType, &cfgBytes, &w.Status, &w.RequiresApproval,
		&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, fmt.Errorf("get workflow for patch: %w", err)
	}

	if name != nil {
		w.Name = *name
	}
	if description != nil {
		w.Description = description
	}
	if triggerType != nil {
		w.TriggerType = *triggerType
	}
	if triggerConfig != nil {
		w.TriggerConfig = triggerConfig
	}
	if requiresApproval != nil {
		w.RequiresApproval = *requiresApproval
	}

	newCfg, err := json.Marshal(w.TriggerConfig)
	if err != nil {
		return nil, fmt.Errorf("marshal trigger config: %w", err)
	}

	_, err = s.pool.Exec(ctx, `
		UPDATE workflows
		SET name=$1, description=$2, trigger_type=$3, trigger_config=$4,
		    requires_approval=$5, updated_at=now()
		WHERE id=$6 AND workspace_id=$7`,
		w.Name, w.Description, w.TriggerType, newCfg, w.RequiresApproval,
		workflowID, workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("patch workflow: %w", err)
	}
	w.UpdatedAt = time.Now()
	return &w, nil
}

// ActivateWorkflow sets a workflow to 'active'. Returns ErrNotFound if no
// matching workflow exists. Only callable by workspace_admin (enforced in router).
func (s *Store) ActivateWorkflow(ctx context.Context, workspaceID, workflowID string) (*model.Workflow, error) {
	return s.setWorkflowStatus(ctx, workspaceID, workflowID, model.WorkflowStatusActive)
}

// ArchiveWorkflow sets a workflow to 'archived'.
func (s *Store) ArchiveWorkflow(ctx context.Context, workspaceID, workflowID string) (*model.Workflow, error) {
	return s.setWorkflowStatus(ctx, workspaceID, workflowID, model.WorkflowStatusArchived)
}

func (s *Store) setWorkflowStatus(ctx context.Context, workspaceID, workflowID string, status model.WorkflowStatus) (*model.Workflow, error) {
	var w model.Workflow
	var cfgBytes []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE workflows SET status=$1, updated_at=now()
		WHERE id=$2 AND workspace_id=$3
		RETURNING id, workspace_id, app_id, name, description,
		          trigger_type, trigger_config, status, requires_approval,
		          created_by, created_at, updated_at`,
		status, workflowID, workspaceID,
	).Scan(
		&w.ID, &w.WorkspaceID, &w.AppID, &w.Name, &w.Description,
		&w.TriggerType, &cfgBytes, &w.Status, &w.RequiresApproval,
		&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("set workflow status: %w", err)
	}
	if err := json.Unmarshal(cfgBytes, &w.TriggerConfig); err != nil {
		w.TriggerConfig = map[string]any{}
	}
	return &w, nil
}

// DeleteWorkflow removes a workflow. Cascades to steps and runs.
func (s *Store) DeleteWorkflow(ctx context.Context, workspaceID, workflowID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM workflows WHERE id=$1 AND workspace_id=$2`,
		workflowID, workspaceID,
	)
	if err != nil {
		return fmt.Errorf("delete workflow: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Workflow steps ---------------------------------------------------------

// listWorkflowSteps returns the ordered steps for a workflow.
func (s *Store) listWorkflowSteps(ctx context.Context, workflowID string) ([]model.WorkflowStep, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, workflow_id, step_order, name, step_type, config,
		       ai_generated, reviewed_by, reviewed_at, created_at, updated_at
		FROM workflow_steps
		WHERE workflow_id = $1
		ORDER BY step_order`,
		workflowID,
	)
	if err != nil {
		return nil, fmt.Errorf("list steps: %w", err)
	}
	defer rows.Close()

	var steps []model.WorkflowStep
	for rows.Next() {
		var step model.WorkflowStep
		var cfgBytes []byte
		if err := rows.Scan(
			&step.ID, &step.WorkflowID, &step.StepOrder, &step.Name, &step.StepType,
			&cfgBytes, &step.AIGenerated, &step.ReviewedBy, &step.ReviewedAt,
			&step.CreatedAt, &step.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list steps scan: %w", err)
		}
		if err := json.Unmarshal(cfgBytes, &step.Config); err != nil {
			step.Config = map[string]any{}
		}
		steps = append(steps, step)
	}
	return steps, rows.Err()
}

// UpsertWorkflowSteps replaces all steps for a workflow in a single transaction.
// Callers pass the full desired slice; step_order is derived from position.
func (s *Store) UpsertWorkflowSteps(ctx context.Context, workspaceID, workflowID string, steps []model.WorkflowStep) ([]model.WorkflowStep, error) {
	// Verify ownership
	var count int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM workflows WHERE id=$1 AND workspace_id=$2`,
		workflowID, workspaceID,
	).Scan(&count); err != nil || count == 0 {
		return nil, ErrNotFound
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `DELETE FROM workflow_steps WHERE workflow_id=$1`, workflowID); err != nil {
		return nil, fmt.Errorf("delete steps: %w", err)
	}

	inserted := make([]model.WorkflowStep, 0, len(steps))
	for i, step := range steps {
		s2, err := insertWorkflowStep(ctx, tx, workflowID, i, step.Name, step.StepType, step.Config, step.AIGenerated)
		if err != nil {
			return nil, err
		}
		inserted = append(inserted, *s2)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit steps: %w", err)
	}
	return inserted, nil
}

// ReviewStep marks an AI-generated step as reviewed by a builder.
func (s *Store) ReviewStep(ctx context.Context, workspaceID, workflowID, stepID, reviewerID string) (*model.WorkflowStep, error) {
	var step model.WorkflowStep
	var cfgBytes []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE workflow_steps ws
		SET reviewed_by=$1, reviewed_at=now(), updated_at=now()
		FROM workflows w
		WHERE ws.id=$2
		  AND ws.workflow_id=w.id
		  AND w.id=$3
		  AND w.workspace_id=$4
		RETURNING ws.id, ws.workflow_id, ws.step_order, ws.name, ws.step_type,
		          ws.config, ws.ai_generated, ws.reviewed_by, ws.reviewed_at,
		          ws.created_at, ws.updated_at`,
		reviewerID, stepID, workflowID, workspaceID,
	).Scan(
		&step.ID, &step.WorkflowID, &step.StepOrder, &step.Name, &step.StepType,
		&cfgBytes, &step.AIGenerated, &step.ReviewedBy, &step.ReviewedAt,
		&step.CreatedAt, &step.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("review step: %w", err)
	}
	if err := json.Unmarshal(cfgBytes, &step.Config); err != nil {
		step.Config = map[string]any{}
	}
	return &step, nil
}

// ---- Workflow runs ----------------------------------------------------------

// CreateWorkflowRun inserts a new run record with status='pending'.
func (s *Store) CreateWorkflowRun(ctx context.Context, workspaceID, workflowID string, triggeredBy *string, inputData map[string]any) (*model.WorkflowRun, error) {
	inputBytes, err := json.Marshal(inputData)
	if err != nil {
		return nil, fmt.Errorf("marshal input: %w", err)
	}

	var run model.WorkflowRun
	var inputJSON []byte
	err = s.pool.QueryRow(ctx, `
		INSERT INTO workflow_runs (workflow_id, workspace_id, triggered_by, input_data)
		VALUES ($1,$2,$3,$4)
		RETURNING id, workflow_id, workspace_id, status, triggered_by,
		          input_data, output_data, error_message, approval_id,
		          started_at, completed_at`,
		workflowID, workspaceID, triggeredBy, inputBytes,
	).Scan(
		&run.ID, &run.WorkflowID, &run.WorkspaceID, &run.Status, &run.TriggeredBy,
		&inputJSON, &run.OutputData, &run.ErrorMessage, &run.ApprovalID,
		&run.StartedAt, &run.CompletedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create run: %w", err)
	}
	if err := json.Unmarshal(inputJSON, &run.InputData); err != nil {
		run.InputData = map[string]any{}
	}
	return &run, nil
}

// ListWorkflowRuns returns runs for a workflow, newest first.
func (s *Store) ListWorkflowRuns(ctx context.Context, workspaceID, workflowID string) ([]model.WorkflowRun, error) {
	// Verify workspaceID ownership
	rows, err := s.pool.Query(ctx, `
		SELECT r.id, r.workflow_id, r.workspace_id, r.status, r.triggered_by,
		       r.input_data, r.output_data, r.error_message, r.approval_id,
		       r.started_at, r.completed_at
		FROM workflow_runs r
		JOIN workflows w ON w.id = r.workflow_id
		WHERE r.workflow_id=$1 AND r.workspace_id=$2
		ORDER BY r.started_at DESC
		LIMIT 100`,
		workflowID, workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()

	var runs []model.WorkflowRun
	for rows.Next() {
		var run model.WorkflowRun
		var inputJSON, outputJSON []byte
		if err := rows.Scan(
			&run.ID, &run.WorkflowID, &run.WorkspaceID, &run.Status, &run.TriggeredBy,
			&inputJSON, &outputJSON, &run.ErrorMessage, &run.ApprovalID,
			&run.StartedAt, &run.CompletedAt,
		); err != nil {
			return nil, fmt.Errorf("list runs scan: %w", err)
		}
		if inputJSON != nil {
			_ = json.Unmarshal(inputJSON, &run.InputData)
		}
		if outputJSON != nil {
			_ = json.Unmarshal(outputJSON, &run.OutputData)
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

// GetWorkflowRun returns a single workflow run.
func (s *Store) GetWorkflowRun(ctx context.Context, workspaceID, runID string) (*model.WorkflowRun, error) {
	var run model.WorkflowRun
	var inputJSON, outputJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, workflow_id, workspace_id, status, triggered_by,
		       input_data, output_data, error_message, approval_id,
		       started_at, completed_at
		FROM workflow_runs
		WHERE id=$1 AND workspace_id=$2`,
		runID, workspaceID,
	).Scan(
		&run.ID, &run.WorkflowID, &run.WorkspaceID, &run.Status, &run.TriggeredBy,
		&inputJSON, &outputJSON, &run.ErrorMessage, &run.ApprovalID,
		&run.StartedAt, &run.CompletedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get run: %w", err)
	}
	if inputJSON != nil {
		_ = json.Unmarshal(inputJSON, &run.InputData)
	}
	if outputJSON != nil {
		_ = json.Unmarshal(outputJSON, &run.OutputData)
	}
	return &run, nil
}

// GetWorkflowRunByApproval returns the workflow run blocked on the given approval_id.
// Returns ErrNotFound if no run is awaiting that approval.
func (s *Store) GetWorkflowRunByApproval(ctx context.Context, approvalID string) (*model.WorkflowRun, error) {
	var run model.WorkflowRun
	var inputJSON, outputJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, workflow_id, workspace_id, status, triggered_by,
		       input_data, output_data, error_message, approval_id,
		       started_at, completed_at
		FROM workflow_runs
		WHERE approval_id=$1 AND status='awaiting_approval'`,
		approvalID,
	).Scan(
		&run.ID, &run.WorkflowID, &run.WorkspaceID, &run.Status, &run.TriggeredBy,
		&inputJSON, &outputJSON, &run.ErrorMessage, &run.ApprovalID,
		&run.StartedAt, &run.CompletedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get run by approval: %w", err)
	}
	if inputJSON != nil {
		_ = json.Unmarshal(inputJSON, &run.InputData)
	}
	if outputJSON != nil {
		_ = json.Unmarshal(outputJSON, &run.OutputData)
	}
	return &run, nil
}

// ---- internal helpers -------------------------------------------------------

type execer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func insertWorkflowStep(ctx context.Context, tx execer, workflowID string, order int,
	name string, stepType model.WorkflowStepType, config map[string]any, aiGenerated bool,
) (*model.WorkflowStep, error) {
	cfgBytes, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("marshal step config: %w", err)
	}

	var step model.WorkflowStep
	var cfgOut []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO workflow_steps
		    (workflow_id, step_order, name, step_type, config, ai_generated)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, workflow_id, step_order, name, step_type, config,
		          ai_generated, reviewed_by, reviewed_at, created_at, updated_at`,
		workflowID, order, name, stepType, cfgBytes, aiGenerated,
	).Scan(
		&step.ID, &step.WorkflowID, &step.StepOrder, &step.Name, &step.StepType,
		&cfgOut, &step.AIGenerated, &step.ReviewedBy, &step.ReviewedAt,
		&step.CreatedAt, &step.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert step: %w", err)
	}
	if err := json.Unmarshal(cfgOut, &step.Config); err != nil {
		step.Config = map[string]any{}
	}
	return &step, nil
}

// UpdateWorkflowRunStatus sets the status of a workflow run.
// Terminal statuses (completed, failed, cancelled) also set completed_at.
func (s *Store) UpdateWorkflowRunStatus(ctx context.Context, runID string, status model.WorkflowRunStatus) error {
	var completedAt *time.Time
	switch status {
	case model.RunStatusCompleted, model.RunStatusFailed, model.RunStatusCancelled:
		now := time.Now()
		completedAt = &now
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE workflow_runs
		SET status=$2, completed_at=COALESCE($3, completed_at), updated_at=now()
		WHERE id=$1`,
		runID, status, completedAt,
	)
	if err != nil {
		return fmt.Errorf("update run status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetWorkflowRunApproval links a workflow run to an approval record.
// Called after an approval gate is created so callers can look up runs by
// their pending approval.
func (s *Store) SetWorkflowRunApproval(ctx context.Context, runID, approvalID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE workflow_runs SET approval_id=$2, updated_at=now() WHERE id=$1`,
		runID, approvalID,
	)
	if err != nil {
		return fmt.Errorf("set run approval: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
