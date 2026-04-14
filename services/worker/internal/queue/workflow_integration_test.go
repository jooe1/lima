package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	workerdb "github.com/lima/worker/internal/db"
	"go.uber.org/zap"
)

const workflowDBIntegrationEnv = "LIMA_RUN_DB_INTEGRATION_TESTS"

type workflowIntegrationFixtureIDs struct {
	company   string
	workspace string
	user      string
	app       string
	connector string
	workflow  string
	step      string
	approval  string
	run       string
}

type workflowIntegrationMutationFixture struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	cfg       *config.Config
	ids       workflowIntegrationFixtureIDs
	tableName string
	markerID  string
}

func TestResumeWorkflowRunApprovedPostgresMutation(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'approved-resume')", tableName, markerID)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireMarkerPhase(t, fixture, "approved-resume")

	run, err := getWorkflowRun(fixture.ctx, fixture.pool, fixture.ids.run)
	if err != nil {
		t.Fatalf("getWorkflowRun() error = %v", err)
	}
	if run.status != runStatusCompleted {
		t.Fatalf("run status = %q, want %q", run.status, runStatusCompleted)
	}

	var errorMessage string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COALESCE(error_message, '') FROM workflow_runs WHERE id = $1`, fixture.ids.run).Scan(&errorMessage); err != nil {
		t.Fatalf("query workflow run error message: %v", err)
	}
	if errorMessage != "" {
		t.Fatalf("workflow run error_message = %q, want empty string", errorMessage)
	}

	stepResult := workflowIntegrationStepResult(t, run.outputData, fixture.ids.step)
	if got := stepResult["status"]; got != "completed" {
		t.Fatalf("step status = %#v, want completed", got)
	}
	if got := stepResult["approved"]; got != true {
		t.Fatalf("step approved = %#v, want true", got)
	}
	if got := stepResult["approval_id"]; got != approvalID {
		t.Fatalf("step approval_id = %#v, want %s", got, approvalID)
	}

	result, ok := stepResult["result"].(map[string]any)
	if !ok {
		t.Fatalf("step result type = %T, want map[string]any", stepResult["result"])
	}
	if got := result["rows_affected"]; got != float64(1) {
		t.Fatalf("rows_affected = %#v, want 1", got)
	}
	if got := result["command_tag"]; got != "INSERT 0 1" {
		t.Fatalf("command_tag = %#v, want INSERT 0 1", got)
	}
	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
}

func TestResumeWorkflowRunApprovalNotApprovedFailsClosed(t *testing.T) {
	t.Run("rejected approval", func(t *testing.T) {
		fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
			return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'should-not-run')", tableName, markerID)
		})

		approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
		workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "rejected")

		if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, false); err != nil {
			t.Fatalf("resumeWorkflowRun() error = %v", err)
		}

		workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "rejected")
		workflowIntegrationRequireRunFailure(t, fixture, "workflow approval rejected")
		workflowIntegrationRequireMutationRowCount(t, fixture, 0)
	})

	t.Run("approved payload against pending approval", func(t *testing.T) {
		fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
			return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'should-not-run')", tableName, markerID)
		})

		approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)

		if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
			t.Fatalf("resumeWorkflowRun() error = %v", err)
		}

		workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "pending")
		workflowIntegrationRequireRunFailure(t, fixture, "expected approved", "fail closed")
		workflowIntegrationRequireMutationRowCount(t, fixture, 0)
	})
}

func TestResumeWorkflowRunConnectorLookupFailureFailsClosed(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'connector-missing')", tableName, markerID)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationExec(t, fixture.ctx, fixture.pool, `DELETE FROM connectors WHERE id = $1`, fixture.ids.connector)

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationRequireRunFailure(t, fixture, "fetch connector", "not found")
	workflowIntegrationRequireMutationRowCount(t, fixture, 0)
}

func TestResumeWorkflowRunApprovalPayloadDecryptionFailureFailsClosed(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'approval-payload-corrupt')", tableName, markerID)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationExec(t, fixture.ctx, fixture.pool,
		`UPDATE approvals SET encrypted_payload = $2 WHERE id = $1`,
		approvalID, []byte("short"),
	)

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationRequireRunFailure(t, fixture, "decrypt approval payload")
	workflowIntegrationRequireMutationRowCount(t, fixture, 0)
}

func TestResumeWorkflowRunApprovalPayloadRunIntegrityMismatchFailsClosed(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'approval-run-mismatch')", tableName, markerID)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationExec(t, fixture.ctx, fixture.pool,
		`UPDATE approvals SET encrypted_payload = $2 WHERE id = $1`,
		approvalID,
		workflowIntegrationEncryptJSON(t, fixture.cfg.CredentialsEncryptionKey, map[string]any{
			"run_id":       fixture.ids.approval,
			"step_id":      fixture.ids.step,
			"step_name":    "approved integration mutation",
			"config":       map[string]any{"connector_id": fixture.ids.connector},
			"workspace_id": fixture.ids.workspace,
		}),
	)

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationRequireRunFailure(t, fixture, "created for run", "fail closed")
	workflowIntegrationRequireMutationRowCount(t, fixture, 0)
}

func TestResumeWorkflowRunConnectorCredentialDecryptionFailureFailsClosed(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf("INSERT INTO %s (id, phase) VALUES ('%s', 'connector-creds-corrupt')", tableName, markerID)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationExec(t, fixture.ctx, fixture.pool,
		`UPDATE connectors SET encrypted_credentials = $2 WHERE id = $1`,
		fixture.ids.connector, []byte("short"),
	)

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationRequireRunFailure(t, fixture, "execute approved mutation step", "decrypt connector credentials")
	workflowIntegrationRequireMutationRowCount(t, fixture, 0)
}

func TestResumeWorkflowRunMutationFailureRollsBackAndPersistsRunFailure(t *testing.T) {
	fixture := workflowIntegrationNewPostgresMutationFixture(t, func(tableName, markerID string) string {
		return fmt.Sprintf(`
			WITH first_insert AS (
				INSERT INTO %s (id, phase) VALUES ('%s', 'before-rollback') RETURNING id
			)
			INSERT INTO %s (id, phase)
			SELECT id, 'duplicate' FROM first_insert
		`, tableName, markerID, tableName)
	})

	approvalID := workflowIntegrationExecuteAndAwaitApproval(t, fixture)
	workflowIntegrationSetApprovalStatus(t, fixture, approvalID, "approved")

	if err := resumeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, approvalID, true); err != nil {
		t.Fatalf("resumeWorkflowRun() error = %v", err)
	}

	workflowIntegrationRequireApprovalStatus(t, fixture, approvalID, "approved")
	workflowIntegrationRequireRunFailure(t, fixture, "execute approved mutation step", "duplicate key value")
	workflowIntegrationRequireMutationRowCount(t, fixture, 0)
	var phase string
	if err := fixture.pool.QueryRow(fixture.ctx, fmt.Sprintf(`SELECT COALESCE(MAX(phase), '') FROM %s`, fixture.tableName)).Scan(&phase); err != nil {
		t.Fatalf("query rollback marker table: %v", err)
	}
	if phase != "" {
		t.Fatalf("rollback marker phase = %q, want empty string", phase)
	}
}

func workflowIntegrationNewPostgresMutationFixture(t *testing.T, buildSQL func(tableName, markerID string) string) *workflowIntegrationMutationFixture {
	t.Helper()

	ctx, pool, databaseURL := workflowIntegrationOpenPool(t)
	creds := workflowIntegrationPostgresCreds(t, databaseURL)

	const encryptionKey = "workflow-integration-test-key"
	base := uint64(time.Now().UnixNano())
	ids := workflowIntegrationIDs(base)
	tableName := fmt.Sprintf("workflow_integration_%x", base)
	markerID := fmt.Sprintf("marker-%x", base)
	workspaceSlug := fmt.Sprintf("workflow-it-%x", base)
	companySlug := fmt.Sprintf("workflow-company-%x", base)
	appName := fmt.Sprintf("Workflow Integration %x", base)
	connectorName := fmt.Sprintf("workflow-connector-%x", base)
	workflowName := fmt.Sprintf("workflow-%x", base)
	userEmail := fmt.Sprintf("workflow-%x@example.test", base)

	workflowIntegrationExec(t, ctx, pool, fmt.Sprintf(`
		CREATE TABLE %s (
			id TEXT PRIMARY KEY,
			phase TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`, tableName))
	t.Cleanup(func() {
		workflowIntegrationCleanup(t, pool, tableName, ids)
	})

	encryptedConnectorCreds := workflowIntegrationEncryptJSON(t, encryptionKey, creds)
	stepConfigJSON := workflowIntegrationJSON(t, map[string]any{
		"connector_id": ids.connector,
		"sql":          buildSQL(tableName, markerID),
	})
	inputDataJSON := workflowIntegrationJSON(t, map[string]any{})

	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)`,
		ids.company, "Workflow Integration Company", companySlug,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workspaces (id, company_id, name, slug) VALUES ($1, $2, $3, $4)`,
		ids.workspace, ids.company, "Workflow Integration Workspace", workspaceSlug,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO users (id, company_id, email, name) VALUES ($1, $2, $3, $4)`,
		ids.user, ids.company, userEmail, "Workflow Integration User",
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO apps (id, workspace_id, name, status, dsl_source, created_by) VALUES ($1, $2, $3, 'draft', '', $4)`,
		ids.app, ids.workspace, appName, ids.user,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO connectors (id, workspace_id, name, type, encrypted_credentials, created_by) VALUES ($1, $2, $3, 'postgres', $4, $5)`,
		ids.connector, ids.workspace, connectorName, encryptedConnectorCreds, ids.user,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflows (id, workspace_id, app_id, name, trigger_type, trigger_config, status, requires_approval, created_by) VALUES ($1, $2, $3, $4, 'manual', '{}', 'active', true, $5)`,
		ids.workflow, ids.workspace, ids.app, workflowName, ids.user,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflow_steps (id, workflow_id, step_order, name, step_type, config, ai_generated) VALUES ($1, $2, 1, $3, 'mutation', $4, false)`,
		ids.step, ids.workflow, "approved integration mutation", stepConfigJSON,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflow_runs (id, workflow_id, workspace_id, status, triggered_by, input_data) VALUES ($1, $2, $3, 'pending', $4, $5)`,
		ids.run, ids.workflow, ids.workspace, ids.user, inputDataJSON,
	)

	return &workflowIntegrationMutationFixture{
		ctx:       ctx,
		pool:      pool,
		cfg:       &config.Config{CredentialsEncryptionKey: encryptionKey},
		ids:       ids,
		tableName: tableName,
		markerID:  markerID,
	}
}

func workflowIntegrationOpenPool(t *testing.T) (context.Context, *pgxpool.Pool, string) {
	t.Helper()

	if os.Getenv(workflowDBIntegrationEnv) != "1" {
		t.Skipf("set %s=1 and DATABASE_URL to run DB-backed workflow integration tests", workflowDBIntegrationEnv)
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)

	pool, err := workerdb.Connect(workerdb.ConnConfig{URL: databaseURL, MaxConns: 4, MinConns: 1})
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
	})

	workflowIntegrationRequireSchema(t, ctx, pool)
	return ctx, pool, databaseURL
}

func workflowIntegrationExecuteAndAwaitApproval(t *testing.T, fixture *workflowIntegrationMutationFixture) string {
	t.Helper()

	if err := executeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, fixture.ids.workflow); err != nil {
		t.Fatalf("executeWorkflowRun() error = %v", err)
	}

	run, err := getWorkflowRun(fixture.ctx, fixture.pool, fixture.ids.run)
	if err != nil {
		t.Fatalf("getWorkflowRun() after execute error = %v", err)
	}
	if run.status != runStatusAwaitingApproval {
		t.Fatalf("run status after execute = %q, want %q", run.status, runStatusAwaitingApproval)
	}

	var approvalID string
	var errorMessage string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COALESCE(approval_id::text, ''), COALESCE(error_message, '') FROM workflow_runs WHERE id = $1`, fixture.ids.run).Scan(&approvalID, &errorMessage); err != nil {
		t.Fatalf("query workflow run pause state: %v", err)
	}
	if approvalID == "" {
		t.Fatal("workflow run approval_id is empty after pause")
	}
	if errorMessage != "" {
		t.Fatalf("workflow run error_message after pause = %q, want empty string", errorMessage)
	}

	stepResult := workflowIntegrationStepResult(t, run.outputData, fixture.ids.step)
	if got := stepResult["status"]; got != "awaiting_approval" {
		t.Fatalf("step status after execute = %#v, want awaiting_approval", got)
	}
	if got := stepResult["approval_id"]; got != approvalID {
		t.Fatalf("step approval_id after execute = %#v, want %s", got, approvalID)
	}
	if got, ok := stepResult["result"]; ok {
		t.Fatalf("step result after execute = %#v, want absent", got)
	}

	workflowIntegrationRequireMutationRowCount(t, fixture, 0)

	var approvalStatus string
	var requestedBy string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status::text, requested_by::text FROM approvals WHERE id = $1`, approvalID).Scan(&approvalStatus, &requestedBy); err != nil {
		t.Fatalf("query approval created by executeWorkflowRun: %v", err)
	}
	if approvalStatus != "pending" {
		t.Fatalf("approval status after execute = %q, want pending", approvalStatus)
	}
	if requestedBy != fixture.ids.user {
		t.Fatalf("approval requested_by = %q, want %s", requestedBy, fixture.ids.user)
	}

	return approvalID
}

func workflowIntegrationSetApprovalStatus(t *testing.T, fixture *workflowIntegrationMutationFixture, approvalID, status string) {
	t.Helper()

	workflowIntegrationExec(t, fixture.ctx, fixture.pool,
		`UPDATE approvals SET status = $2::approval_status, reviewed_by = $3, reviewed_at = now() WHERE id = $1`,
		approvalID, status, fixture.ids.user,
	)
}

func workflowIntegrationRequireApprovalStatus(t *testing.T, fixture *workflowIntegrationMutationFixture, approvalID, want string) {
	t.Helper()

	var got string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status::text FROM approvals WHERE id = $1`, approvalID).Scan(&got); err != nil {
		t.Fatalf("query approval status: %v", err)
	}
	if got != want {
		t.Fatalf("approval status = %q, want %q", got, want)
	}
}

func workflowIntegrationRequireRunFailure(t *testing.T, fixture *workflowIntegrationMutationFixture, wantErrorSubstrings ...string) {
	t.Helper()

	run, err := getWorkflowRun(fixture.ctx, fixture.pool, fixture.ids.run)
	if err != nil {
		t.Fatalf("getWorkflowRun() error = %v", err)
	}
	if run.status != runStatusFailed {
		t.Fatalf("run status = %q, want %q", run.status, runStatusFailed)
	}

	var errorMessage string
	var completed bool
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COALESCE(error_message, ''), completed_at IS NOT NULL FROM workflow_runs WHERE id = $1`, fixture.ids.run).Scan(&errorMessage, &completed); err != nil {
		t.Fatalf("query failed workflow run state: %v", err)
	}
	if errorMessage == "" {
		t.Fatal("workflow run error_message is empty after failure")
	}
	if !completed {
		t.Fatal("workflow run completed_at is NULL after failure")
	}

	lowerMessage := strings.ToLower(errorMessage)
	for _, want := range wantErrorSubstrings {
		if !strings.Contains(lowerMessage, strings.ToLower(want)) {
			t.Fatalf("workflow run error_message = %q, want substring %q", errorMessage, want)
		}
	}
}

func workflowIntegrationRequireMutationRowCount(t *testing.T, fixture *workflowIntegrationMutationFixture, want int) {
	t.Helper()

	var got int
	if err := fixture.pool.QueryRow(fixture.ctx, fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE id = $1`, fixture.tableName), fixture.markerID).Scan(&got); err != nil {
		t.Fatalf("count mutation target rows: %v", err)
	}
	if got != want {
		t.Fatalf("mutation target row count = %d, want %d", got, want)
	}
}

func workflowIntegrationRequireMarkerPhase(t *testing.T, fixture *workflowIntegrationMutationFixture, want string) {
	t.Helper()

	var phase string
	if err := fixture.pool.QueryRow(fixture.ctx, fmt.Sprintf(`SELECT phase FROM %s WHERE id = $1`, fixture.tableName), fixture.markerID).Scan(&phase); err != nil {
		t.Fatalf("query mutation target row: %v", err)
	}
	if phase != want {
		t.Fatalf("mutation target phase = %q, want %s", phase, want)
	}
}

func workflowIntegrationRequireSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()

	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.companies') IS NOT NULL
		   AND to_regclass('public.workspaces') IS NOT NULL
		   AND to_regclass('public.users') IS NOT NULL
		   AND to_regclass('public.apps') IS NOT NULL
		   AND to_regclass('public.connectors') IS NOT NULL
		   AND to_regclass('public.approvals') IS NOT NULL
		   AND to_regclass('public.workflows') IS NOT NULL
		   AND to_regclass('public.workflow_steps') IS NOT NULL
		   AND to_regclass('public.workflow_runs') IS NOT NULL
	`).Scan(&ok)
	if err != nil {
		t.Fatalf("check Lima schema prerequisites: %v", err)
	}
	if !ok {
		t.Skip("DATABASE_URL is reachable but Lima tables are missing; point it at a migrated Lima Postgres database")
	}
}

func workflowIntegrationPostgresCreds(t *testing.T, databaseURL string) relationalCreds {
	t.Helper()

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	if cfg.ConnConfig.Host == "" || cfg.ConnConfig.Port == 0 || cfg.ConnConfig.Database == "" || cfg.ConnConfig.User == "" {
		t.Skip("DATABASE_URL must use a TCP Postgres connection with host, port, database, and user values")
	}

	return relationalCreds{
		Host:     cfg.ConnConfig.Host,
		Port:     int(cfg.ConnConfig.Port),
		Database: cfg.ConnConfig.Database,
		Username: cfg.ConnConfig.User,
		Password: cfg.ConnConfig.Password,
		SSL:      cfg.ConnConfig.TLSConfig != nil,
	}
}

func workflowIntegrationEncryptJSON(t *testing.T, secret string, value any) []byte {
	t.Helper()

	plaintext := workflowIntegrationJSON(t, value)
	ciphertext, err := cryptoutil.Encrypt(secret, []byte(plaintext))
	if err != nil {
		t.Fatalf("encrypt integration payload: %v", err)
	}
	return ciphertext
}

func workflowIntegrationJSON(t *testing.T, value any) string {
	t.Helper()

	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal integration payload: %v", err)
	}
	return string(payload)
}

func workflowIntegrationExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()

	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

func workflowIntegrationStepResult(t *testing.T, outputData map[string]any, stepID string) map[string]any {
	t.Helper()

	steps, ok := outputData["steps"].(map[string]any)
	if !ok {
		t.Fatalf("output_data.steps type = %T, want map[string]any", outputData["steps"])
	}
	stepResult, ok := steps[stepID].(map[string]any)
	if !ok {
		t.Fatalf("step result type = %T, want map[string]any", steps[stepID])
	}
	return stepResult
}

func workflowIntegrationCleanup(t *testing.T, pool *pgxpool.Pool, tableName string, ids workflowIntegrationFixtureIDs) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	statements := []struct {
		sql  string
		args []any
	}{
		{sql: fmt.Sprintf(`DROP TABLE IF EXISTS %s`, tableName)},
		{sql: `DELETE FROM workflow_runs WHERE id = $1`, args: []any{ids.run}},
		{sql: `DELETE FROM approvals WHERE workspace_id = $1`, args: []any{ids.workspace}},
		{sql: `DELETE FROM workflow_steps WHERE id = $1`, args: []any{ids.step}},
		{sql: `DELETE FROM workflows WHERE id = $1`, args: []any{ids.workflow}},
		{sql: `DELETE FROM connectors WHERE id = $1`, args: []any{ids.connector}},
		{sql: `DELETE FROM apps WHERE id = $1`, args: []any{ids.app}},
		{sql: `DELETE FROM workspaces WHERE id = $1`, args: []any{ids.workspace}},
		{sql: `DELETE FROM users WHERE id = $1`, args: []any{ids.user}},
		{sql: `DELETE FROM companies WHERE id = $1`, args: []any{ids.company}},
	}

	for _, stmt := range statements {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Logf("cleanup %q: %v", stmt.sql, err)
		}
	}
}

func workflowIntegrationIDs(base uint64) workflowIntegrationFixtureIDs {
	return workflowIntegrationFixtureIDs{
		company:   workflowIntegrationUUID(base + 1),
		workspace: workflowIntegrationUUID(base + 2),
		user:      workflowIntegrationUUID(base + 3),
		app:       workflowIntegrationUUID(base + 4),
		connector: workflowIntegrationUUID(base + 5),
		workflow:  workflowIntegrationUUID(base + 6),
		step:      workflowIntegrationUUID(base + 7),
		approval:  workflowIntegrationUUID(base + 8),
		run:       workflowIntegrationUUID(base + 9),
	}
}

func workflowIntegrationUUID(value uint64) string {
	return fmt.Sprintf("00000000-0000-0000-0000-%012x", value&0xffffffffffff)
}

// ---- output binding integration test ---------------------------------------

type workflowIntegrationOutputBindingFixture struct {
	ctx  context.Context
	pool *pgxpool.Pool
	cfg  *config.Config
	ids  workflowIntegrationFixtureIDs
}

// TestExecuteWorkflowRunOutputBindingsStoredInOutputData verifies that when a
// workflow with output_bindings completes successfully the triggered bindings
// are persisted under output_data["__output_bindings__"].
func TestExecuteWorkflowRunOutputBindingsStoredInOutputData(t *testing.T) {
	fixture := workflowIntegrationNewOutputBindingFixture(t)

	if err := executeWorkflowRun(fixture.ctx, fixture.cfg, fixture.pool, nil, zap.NewNop(), fixture.ids.run, fixture.ids.workflow); err != nil {
		t.Fatalf("executeWorkflowRun() error = %v", err)
	}

	run, err := getWorkflowRun(fixture.ctx, fixture.pool, fixture.ids.run)
	if err != nil {
		t.Fatalf("getWorkflowRun() error = %v", err)
	}
	if run.status != runStatusCompleted {
		t.Fatalf("run status = %q, want %q", run.status, runStatusCompleted)
	}

	// __output_bindings__ must be present.
	bindingsAny, ok := run.outputData["__output_bindings__"]
	if !ok {
		t.Fatal("output_data.__output_bindings__ is missing")
	}

	// Re-marshal/unmarshal to get a typed slice (JSON round-trip through map[string]any).
	bindingsJSON, err := json.Marshal(bindingsAny)
	if err != nil {
		t.Fatalf("marshal __output_bindings__: %v", err)
	}
	var bindings []outputBinding
	if err := json.Unmarshal(bindingsJSON, &bindings); err != nil {
		t.Fatalf("unmarshal __output_bindings__: %v", err)
	}
	if len(bindings) != 2 {
		t.Fatalf("len(__output_bindings__) = %d, want 2", len(bindings))
	}

	foundComplete, foundStep := false, false
	for _, b := range bindings {
		switch b.TriggerStepID {
		case "__workflow_complete__":
			foundComplete = true
			if b.WidgetID != "widget-wc" {
				t.Errorf("workflow_complete binding widget_id = %q, want widget-wc", b.WidgetID)
			}
		case fixture.ids.step:
			foundStep = true
			if b.WidgetID != "widget-step" {
				t.Errorf("step binding widget_id = %q, want widget-step", b.WidgetID)
			}
		}
	}
	if !foundComplete {
		t.Error("__output_bindings__ missing __workflow_complete__ entry")
	}
	if !foundStep {
		t.Errorf("__output_bindings__ missing step-specific entry for step %s", fixture.ids.step)
	}
}

func workflowIntegrationNewOutputBindingFixture(t *testing.T) *workflowIntegrationOutputBindingFixture {
	t.Helper()

	ctx, pool, _ := workflowIntegrationOpenPool(t)

	// Require migration 019 (output_bindings column).
	var hasCol bool
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) > 0
		FROM information_schema.columns
		WHERE table_name = 'workflows' AND column_name = 'output_bindings'
	`).Scan(&hasCol); err != nil {
		t.Fatalf("check output_bindings column: %v", err)
	}
	if !hasCol {
		t.Skip("workflows.output_bindings column not found — apply migration 019 first")
	}

	const encryptionKey = "workflow-integration-test-key"
	base := uint64(time.Now().UnixNano())
	ids := workflowIntegrationIDs(base)

	workspaceSlug := fmt.Sprintf("wf-ob-it-%x", base)
	companySlug := fmt.Sprintf("wf-ob-company-%x", base)
	appName := fmt.Sprintf("WF Output Binding %x", base)
	workflowName := fmt.Sprintf("wf-ob-%x", base)
	userEmail := fmt.Sprintf("wf-ob-%x@example.test", base)

	t.Cleanup(func() {
		workflowIntegrationOutputBindingCleanup(t, pool, ids)
	})

	outputBindingsJSON := workflowIntegrationJSON(t, []map[string]any{
		{
			"trigger_step_id": "__workflow_complete__",
			"widget_id":       "widget-wc",
			"port":            "data",
			"page_id":         "page-1",
		},
		{
			"trigger_step_id": ids.step,
			"widget_id":       "widget-step",
			"port":            "rows",
			"page_id":         "page-1",
		},
	})
	stepConfigJSON := workflowIntegrationJSON(t, map[string]any{
		"message": "output binding integration test notification",
	})
	inputDataJSON := workflowIntegrationJSON(t, map[string]any{})

	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)`,
		ids.company, "WF Output Binding Company", companySlug,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workspaces (id, company_id, name, slug) VALUES ($1, $2, $3, $4)`,
		ids.workspace, ids.company, "WF Output Binding Workspace", workspaceSlug,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO users (id, company_id, email, name) VALUES ($1, $2, $3, $4)`,
		ids.user, ids.company, userEmail, "WF Output Binding User",
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO apps (id, workspace_id, name, status, dsl_source, created_by) VALUES ($1, $2, $3, 'draft', '', $4)`,
		ids.app, ids.workspace, appName, ids.user,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflows (id, workspace_id, app_id, name, trigger_type, trigger_config, status, requires_approval, output_bindings, created_by) VALUES ($1, $2, $3, $4, 'manual', '{}', 'active', false, $5, $6)`,
		ids.workflow, ids.workspace, ids.app, workflowName, outputBindingsJSON, ids.user,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflow_steps (id, workflow_id, step_order, name, step_type, config, ai_generated) VALUES ($1, $2, 1, $3, 'notification', $4, false)`,
		ids.step, ids.workflow, "output binding notification step", stepConfigJSON,
	)
	workflowIntegrationExec(t, ctx, pool,
		`INSERT INTO workflow_runs (id, workflow_id, workspace_id, status, triggered_by, input_data) VALUES ($1, $2, $3, 'pending', $4, $5)`,
		ids.run, ids.workflow, ids.workspace, ids.user, inputDataJSON,
	)

	return &workflowIntegrationOutputBindingFixture{
		ctx:  ctx,
		pool: pool,
		cfg:  &config.Config{CredentialsEncryptionKey: encryptionKey},
		ids:  ids,
	}
}

func workflowIntegrationOutputBindingCleanup(t *testing.T, pool *pgxpool.Pool, ids workflowIntegrationFixtureIDs) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	statements := []struct {
		sql  string
		args []any
	}{
		{sql: `DELETE FROM workflow_runs WHERE id = $1`, args: []any{ids.run}},
		{sql: `DELETE FROM workflow_steps WHERE id = $1`, args: []any{ids.step}},
		{sql: `DELETE FROM workflows WHERE id = $1`, args: []any{ids.workflow}},
		{sql: `DELETE FROM apps WHERE id = $1`, args: []any{ids.app}},
		{sql: `DELETE FROM workspaces WHERE id = $1`, args: []any{ids.workspace}},
		{sql: `DELETE FROM users WHERE id = $1`, args: []any{ids.user}},
		{sql: `DELETE FROM companies WHERE id = $1`, args: []any{ids.company}},
	}

	for _, stmt := range statements {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Logf("cleanup %q: %v", stmt.sql, err)
		}
	}
}
