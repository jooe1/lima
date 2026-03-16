package queue

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	"go.uber.org/zap"
)

// combinedWorkflowPayload is parsed from any workflow queue message.
// If ApprovalID is non-empty it is a resume; otherwise a fresh execution.
type combinedWorkflowPayload struct {
	RunID       string `json:"run_id"`
	WorkflowID  string `json:"workflow_id"`
	WorkspaceID string `json:"workspace_id"`
	ApprovalID  string `json:"approval_id"`
	Approved    bool   `json:"approved"`
}

// handleWorkflow returns a jobHandler that executes or resumes workflow runs.
func handleWorkflow(cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger) jobHandler {
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
			return resumeWorkflowRun(ctx, cfg, pool, log, p.RunID, p.ApprovalID, p.Approved)
		}
		return executeWorkflowRun(ctx, cfg, pool, log, p.RunID, p.WorkflowID)
	}
}

// executeWorkflowRun starts fresh execution of a workflow run.
func executeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger, runID, workflowID string) error {
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

	for _, step := range def.steps {
		// Skip steps already completed (shouldn't happen on fresh run, but defensive).
		if sr, ok := stepResults[step.id]; ok {
			if m, ok := sr.(map[string]any); ok {
				if m["status"] == "completed" {
					continue
				}
			}
		}

		paused, err := executeStep(ctx, cfg, pool, log, run, def, step, stepResults)
		if err != nil {
			errStr := err.Error()
			output["steps"] = stepResults
			_ = setRunStatus(ctx, pool, runID, runStatusFailed, output, &errStr, nil)
			log.Error("workflow run failed", zap.String("run_id", runID), zap.String("step", step.name), zap.Error(err))
			return nil // don't propagate — run is marked failed in DB
		}
		if paused {
			// Step created an approval gate; run is now awaiting_approval.
			output["steps"] = stepResults
			// approvalID was linked inside executeStep via createApprovalForRun.
			_ = setRunStatus(ctx, pool, runID, runStatusAwaitingApproval, output, nil, nil)
			log.Info("workflow run paused awaiting approval",
				zap.String("run_id", runID), zap.String("step", step.name))
			return nil
		}
	}

	output["steps"] = stepResults
	_ = setRunStatus(ctx, pool, runID, runStatusCompleted, output, nil, nil)
	log.Info("workflow run completed", zap.String("run_id", runID))
	return nil
}

// resumeWorkflowRun continues a run that was blocked on an approval gate.
func resumeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
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
		log.Info("workflow run rejected", zap.String("run_id", runID))
		return nil
	}

	def, err := getWorkflowDefinition(ctx, pool, run.workflowID)
	if err != nil {
		return fmt.Errorf("fetch workflow definition for resume: %w", err)
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

	// Mark the approval_gate step that was waiting as completed.
	for _, step := range def.steps {
		if sr, ok := stepResults[step.id]; ok {
			if m, ok := sr.(map[string]any); ok {
				if m["status"] == "awaiting_approval" {
					m["status"] = "completed"
					m["approved"] = true
					stepResults[step.id] = m
				}
			}
		}
	}

	if err := setRunStatus(ctx, pool, runID, runStatusRunning, output, nil, nil); err != nil {
		return fmt.Errorf("set resuming status: %w", err)
	}

	for _, step := range def.steps {
		if sr, ok := stepResults[step.id]; ok {
			if m, ok := sr.(map[string]any); ok {
				if m["status"] == "completed" {
					continue
				}
			}
		}

		paused, err := executeStep(ctx, cfg, pool, log, run, def, step, stepResults)
		if err != nil {
			errStr := err.Error()
			output["steps"] = stepResults
			_ = setRunStatus(ctx, pool, runID, runStatusFailed, output, &errStr, nil)
			log.Error("workflow run failed after resume",
				zap.String("run_id", runID), zap.String("step", step.name), zap.Error(err))
			return nil
		}
		if paused {
			output["steps"] = stepResults
			_ = setRunStatus(ctx, pool, runID, runStatusAwaitingApproval, output, nil, nil)
			log.Info("workflow run paused again awaiting approval",
				zap.String("run_id", runID), zap.String("step", step.name))
			return nil
		}
	}

	output["steps"] = stepResults
	_ = setRunStatus(ctx, pool, runID, runStatusCompleted, output, nil, nil)
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

	switch step.stepType {

	case stepTypeQuery:
		result, execErr := executeQueryStep(stepCtx, cfg, pool, log, step, run.inputData)
		if execErr != nil {
			results[step.id] = map[string]any{"status": "failed", "error": execErr.Error()}
			return false, fmt.Errorf("query step %q failed: %w", step.name, execErr)
		}
		results[step.id] = map[string]any{"status": "completed", "result": result}

	case stepTypeMutation:
		// Mutations that require approval create an approval gate and pause.
		if def.requiresApproval {
			approvalPayload, _ := json.Marshal(map[string]any{
				"run_id":       run.id,
				"step_id":      step.id,
				"step_name":    step.name,
				"config":       step.config,
				"workspace_id": def.workspaceID,
			})
			approvalID, gateErr := createApprovalForRun(stepCtx, pool,
				def.workspaceID, def.appID, run.id, step.name, approvalPayload)
			if gateErr != nil {
				return false, fmt.Errorf("create approval gate for mutation %q: %w", step.name, gateErr)
			}
			results[step.id] = map[string]any{"status": "awaiting_approval", "approval_id": approvalID}
			log.Info("mutation step paused for approval",
				zap.String("run_id", run.id), zap.String("approval_id", approvalID))
			return true, nil // paused
		}
		// Mutations without approval gate are logged but not executed autonomously.
		log.Warn("mutation step executed without approval gate (requires_approval=false)",
			zap.String("run_id", run.id), zap.String("step", step.name))
		results[step.id] = map[string]any{"status": "completed", "note": "executed without approval gate"}

	case stepTypeApprovalGate:
		// Explicit approval gate step — always pauses regardless of requires_approval.
		approvalPayload, _ := json.Marshal(map[string]any{
			"run_id":    run.id,
			"step_id":   step.id,
			"step_name": step.name,
		})
		approvalID, gateErr := createApprovalForRun(stepCtx, pool,
			def.workspaceID, def.appID, run.id, step.name, approvalPayload)
		if gateErr != nil {
			return false, fmt.Errorf("create approval gate %q: %w", step.name, gateErr)
		}
		results[step.id] = map[string]any{"status": "awaiting_approval", "approval_id": approvalID}
		return true, nil // paused

	case stepTypeCondition:
		// Evaluate a simple string equality condition from config.
		// Config shape: { "left": "{{input.status}}", "op": "eq", "right": "active" }
		// For now we resolve {{input.*}} expressions from run.inputData.
		result := evaluateCondition(step.config, run.inputData)
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
var wfMutationRe = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|MERGE|REPLACE|LOCK)`)

// executeQueryStep runs a SQL query against a connector and returns row results.
// Only Postgres is supported in the first pass; other types return a stub.
func executeQueryStep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger,
	step wfStep, inputData map[string]any,
) (any, error) {
	connectorID, _ := step.config["connector_id"].(string)
	if connectorID == "" {
		return nil, fmt.Errorf("query step %q missing connector_id in config", step.name)
	}
	sql, _ := step.config["sql"].(string)
	if sql == "" {
		return nil, fmt.Errorf("query step %q missing sql in config", step.name)
	}
	if wfMutationRe.MatchString(sql) {
		return nil, fmt.Errorf("query step %q: mutation SQL is not allowed in query steps", step.name)
	}

	rec, err := fetchConnectorForRun(ctx, pool, connectorID)
	if err != nil {
		return nil, fmt.Errorf("fetch connector %s: %w", connectorID, err)
	}

	plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.encryptedCredentials)
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
func evaluateCondition(config map[string]any, inputData map[string]any) any {
	left, _ := config["left"].(string)
	op, _ := config["op"].(string)
	right, _ := config["right"].(string)

	if left == "" || op == "" {
		return map[string]any{"result": true, "note": "empty condition — defaulting to true"}
	}

	// Resolve {{input.field}} references.
	resolved := resolveInputRef(left, inputData)

	switch op {
	case "eq":
		return map[string]any{"result": fmt.Sprintf("%v", resolved) == right}
	case "neq":
		return map[string]any{"result": fmt.Sprintf("%v", resolved) != right}
	default:
		return map[string]any{"result": true, "note": "unsupported op: " + op}
	}
}

// resolveInputRef replaces {{input.field}} with the corresponding value
// from inputData, returning the original string if no match.
func resolveInputRef(expr string, inputData map[string]any) any {
	expr = strings.TrimSpace(expr)
	if strings.HasPrefix(expr, "{{input.") && strings.HasSuffix(expr, "}}") {
		field := strings.TrimSuffix(strings.TrimPrefix(expr, "{{input."), "}}")
		if v, ok := inputData[field]; ok {
			return v
		}
	}
	return expr
}
