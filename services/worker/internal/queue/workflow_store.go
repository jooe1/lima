package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ---- domain types (worker-local mirrors of the API model) ------------------

type workflowStepType string

const (
	stepTypeQuery        workflowStepType = "query"
	stepTypeMutation     workflowStepType = "mutation"
	stepTypeCondition    workflowStepType = "condition"
	stepTypeApprovalGate workflowStepType = "approval_gate"
	stepTypeNotification workflowStepType = "notification"
)

type workflowRunStatus string

const (
	runStatusPending          workflowRunStatus = "pending"
	runStatusRunning          workflowRunStatus = "running"
	runStatusAwaitingApproval workflowRunStatus = "awaiting_approval"
	runStatusCompleted        workflowRunStatus = "completed"
	runStatusFailed           workflowRunStatus = "failed"
)

type wfRun struct {
	id          string
	workflowID  string
	workspaceID string
	status      workflowRunStatus
	inputData   map[string]any
	outputData  map[string]any
}

type wfStep struct {
	id          string
	workflowID  string
	stepOrder   int
	name        string
	stepType    workflowStepType
	config      map[string]any
	aiGenerated bool
	reviewedBy  *string
}

type wfDefinition struct {
	id               string
	workspaceID      string
	appID            string
	requiresApproval bool
	steps            []wfStep
}

// ---- database helpers -------------------------------------------------------

// getWorkflowRun fetches a run record by its ID.
func getWorkflowRun(ctx context.Context, pool *pgxpool.Pool, runID string) (*wfRun, error) {
	var r wfRun
	var inputJSON, outputJSON []byte
	err := pool.QueryRow(ctx, `
		SELECT id, workflow_id, workspace_id, status, input_data, output_data
		FROM workflow_runs WHERE id = $1`,
		runID,
	).Scan(&r.id, &r.workflowID, &r.workspaceID, &r.status, &inputJSON, &outputJSON)
	if err != nil {
		return nil, fmt.Errorf("get workflow run %s: %w", runID, err)
	}
	if inputJSON != nil {
		_ = json.Unmarshal(inputJSON, &r.inputData)
	}
	if outputJSON != nil {
		_ = json.Unmarshal(outputJSON, &r.outputData)
	}
	if r.inputData == nil {
		r.inputData = map[string]any{}
	}
	if r.outputData == nil {
		r.outputData = map[string]any{}
	}
	return &r, nil
}

// getWorkflowDefinition fetches the workflow and its ordered steps.
func getWorkflowDefinition(ctx context.Context, pool *pgxpool.Pool, workflowID string) (*wfDefinition, error) {
	var def wfDefinition
	err := pool.QueryRow(ctx, `
		SELECT id, workspace_id, app_id, requires_approval
		FROM workflows WHERE id = $1`,
		workflowID,
	).Scan(&def.id, &def.workspaceID, &def.appID, &def.requiresApproval)
	if err != nil {
		return nil, fmt.Errorf("get workflow %s: %w", workflowID, err)
	}

	rows, err := pool.Query(ctx, `
		SELECT id, workflow_id, step_order, name, step_type, config, ai_generated, reviewed_by
		FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order`,
		workflowID,
	)
	if err != nil {
		return nil, fmt.Errorf("list steps for workflow %s: %w", workflowID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var s wfStep
		var cfgBytes []byte
		if err := rows.Scan(
			&s.id, &s.workflowID, &s.stepOrder, &s.name, &s.stepType,
			&cfgBytes, &s.aiGenerated, &s.reviewedBy,
		); err != nil {
			return nil, fmt.Errorf("scan step: %w", err)
		}
		if cfgBytes != nil {
			_ = json.Unmarshal(cfgBytes, &s.config)
		}
		if s.config == nil {
			s.config = map[string]any{}
		}
		def.steps = append(def.steps, s)
	}
	return &def, rows.Err()
}

// setRunStatus updates the status, output_data, error_message, and
// optionally approval_id + completed_at of a workflow run.
func setRunStatus(ctx context.Context, pool *pgxpool.Pool, runID string,
	status workflowRunStatus, outputData map[string]any,
	errMsg *string, approvalID *string,
) error {
	outBytes, err := json.Marshal(outputData)
	if err != nil {
		outBytes = []byte("{}")
	}

	var completedAt *time.Time
	if status == runStatusCompleted || status == runStatusFailed {
		now := time.Now()
		completedAt = &now
	}

	_, err = pool.Exec(ctx, `
		UPDATE workflow_runs
		SET status       = $2,
		    output_data  = $3,
		    error_message= $4,
		    approval_id  = COALESCE($5, approval_id),
		    completed_at = $6,
		    updated_at   = now()
		WHERE id = $1`,
		runID, status, outBytes, errMsg, approvalID, completedAt,
	)
	return err
}

// createApprovalForRun inserts a new pending approval and links the run to it.
// Returns the new approval ID.
func createApprovalForRun(ctx context.Context, pool *pgxpool.Pool,
	workspaceID, appID, runID, stepName string,
	payloadBytes []byte,
) (string, error) {
	description := fmt.Sprintf("Workflow approval required: %s (run %s)", stepName, runID[:8])

	var approvalID string
	err := pool.QueryRow(ctx, `
		INSERT INTO approvals
		    (workspace_id, app_id, description, encrypted_payload, requested_by)
		VALUES ($1, $2, $3, $4, 'system')
		RETURNING id`,
		workspaceID, appID, description, payloadBytes,
	).Scan(&approvalID)
	if err != nil {
		return "", fmt.Errorf("insert approval for run %s: %w", runID, err)
	}

	// Link run → approval
	if _, err := pool.Exec(ctx,
		`UPDATE workflow_runs SET approval_id=$2 WHERE id=$1`,
		runID, approvalID,
	); err != nil {
		return "", fmt.Errorf("link approval to run: %w", err)
	}

	return approvalID, nil
}

// fetchConnectorForRun retrieves a connector record for step execution.
// Identical to fetchConnectorRecord in schema.go but lives here to keep
// workflow_store self-contained.
func fetchConnectorForRun(ctx context.Context, pool *pgxpool.Pool, connectorID string) (*connectorRow, error) {
	row, err := pool.Query(ctx,
		`SELECT id, type, encrypted_credentials FROM connectors WHERE id = $1`,
		connectorID,
	)
	if err != nil {
		return nil, fmt.Errorf("query connector %s: %w", connectorID, err)
	}
	defer row.Close()
	if !row.Next() {
		return nil, fmt.Errorf("connector %s not found", connectorID)
	}
	var rec connectorRow
	if err := row.Scan(&rec.id, &rec.connectorType, &rec.encryptedCredentials); err != nil {
		return nil, fmt.Errorf("scan connector: %w", err)
	}
	return &rec, nil
}

// ---- approval verification --------------------------------------------------

// approvalVerification holds the minimal approval fields needed to verify an
// approval before executing an approved mutation or gate step.
type approvalVerification struct {
	id               string
	status           string
	encryptedPayload []byte
}

// getApprovalRecord fetches status + encrypted_payload for a single approval.
// Used in resumeWorkflowRun to verify the approval before executing a mutation.
func getApprovalRecord(ctx context.Context, pool *pgxpool.Pool, approvalID string) (*approvalVerification, error) {
	var a approvalVerification
	err := pool.QueryRow(ctx,
		`SELECT id, status, encrypted_payload FROM approvals WHERE id = $1`,
		approvalID,
	).Scan(&a.id, &a.status, &a.encryptedPayload)
	if err != nil {
		return nil, fmt.Errorf("fetch approval %s: %w", approvalID, err)
	}
	return &a, nil
}
