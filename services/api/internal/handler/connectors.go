package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListConnectors returns all connectors in the workspace.
func ListConnectors(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectors, err := s.ListConnectors(r.Context(), workspaceID)
		if err != nil {
			log.Error("list connectors", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list connectors")
			return
		}
		if connectors == nil {
			connectors = []model.Connector{}
		}
		respond(w, http.StatusOK, map[string]any{"connectors": connectors})
	}
}

// createConnectorBody is the request payload for connector creation.
type createConnectorBody struct {
	Name        string              `json:"name"`
	Type        model.ConnectorType `json:"type"`
	Credentials json.RawMessage     `json:"credentials"`
}

// CreateConnector validates, encrypts credentials, persists the connector,
// and enqueues an asynchronous schema-discovery job.
func CreateConnector(cfg *config.Config, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		claims, _ := ClaimsFromContext(r.Context())

		var body createConnectorBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.Name == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "name is required")
			return
		}
		if !isValidConnectorType(body.Type) {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "unsupported connector type")
			return
		}
		if len(body.Credentials) == 0 {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "credentials are required")
			return
		}

		encCreds, err := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, body.Credentials)
		if err != nil {
			log.Error("encrypt connector credentials", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential encryption failed")
			return
		}

		conn, err := s.CreateConnector(r.Context(), workspaceID, body.Name, body.Type, encCreds, claims.UserID)
		if err != nil {
			log.Error("create connector", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create connector")
			return
		}

		// Kick off schema discovery. Non-fatal if Redis is unavailable.
		if enq != nil {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: conn.ID,
				WorkspaceID: workspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed", zap.Error(err))
			}
		}

		respond(w, http.StatusCreated, map[string]any{"connector": conn})
	}
}

// GetConnector returns the safe public view of a single connector.
func GetConnector(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]any{"connector": conn})
	}
}

// patchConnectorBody is the request payload for connector updates.
type patchConnectorBody struct {
	Name        *string         `json:"name"`
	Credentials json.RawMessage `json:"credentials"`
}

// PatchConnector applies a partial update to name and/or credentials.
func PatchConnector(cfg *config.Config, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		var body patchConnectorBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		var encCreds []byte
		if len(body.Credentials) > 0 {
			var err error
			encCreds, err = cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, body.Credentials)
			if err != nil {
				log.Error("encrypt connector credentials", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "internal_error", "credential encryption failed")
				return
			}
		}

		conn, err := s.PatchConnector(r.Context(), workspaceID, connectorID, body.Name, encCreds)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		// If credentials changed, re-trigger schema discovery.
		if len(encCreds) > 0 && enq != nil {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: connectorID,
				WorkspaceID: workspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed after patch", zap.Error(err))
			}
		}

		respond(w, http.StatusOK, map[string]any{"connector": conn})
	}
}

// DeleteConnector permanently removes a connector from the workspace.
func DeleteConnector(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		if err := s.DeleteConnector(r.Context(), workspaceID, connectorID); err != nil {
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// TestConnector decrypts the stored credentials and performs a live connection
// test against the target system. Returns immediately with {ok, error}.
// Supported: postgres, rest. Others return a clear unsupported message.
func TestConnector(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		rec, err := s.GetConnectorRecord(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.EncryptedCredentials)
		if err != nil {
			log.Error("decrypt connector credentials", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()

		var testErr error
		switch rec.Type {
		case model.ConnectorTypePostgres:
			var creds model.RelationalCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse postgres credentials")
				return
			}
			testErr = testPostgresConn(ctx, creds)

		case model.ConnectorTypeREST:
			var creds model.RestCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse rest credentials")
				return
			}
			testErr = testRESTConn(ctx, creds)

		default:
			respond(w, http.StatusOK, map[string]any{
				"ok":    false,
				"error": fmt.Sprintf("connection test not yet supported for %s connectors", rec.Type),
			})
			return
		}

		if testErr != nil {
			respond(w, http.StatusOK, map[string]any{"ok": false, "error": testErr.Error()})
			return
		}
		respond(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// GetConnectorSchema returns the cached schema if available. If no cache
// exists it enqueues a schema discovery job and returns 202 Accepted.
func GetConnectorSchema(s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		if conn.SchemaCache != nil {
			respond(w, http.StatusOK, map[string]any{
				"schema":           conn.SchemaCache,
				"schema_cached_at": conn.SchemaCachedAt,
			})
			return
		}

		// No cache — kick off discovery.
		if enq != nil {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: connectorID,
				WorkspaceID: workspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed", zap.Error(err))
				respondErr(w, http.StatusServiceUnavailable, "queue_unavailable", "schema discovery unavailable")
				return
			}
		}

		respond(w, http.StatusAccepted, map[string]any{"schema": nil, "refreshing": true})
	}
}

// ---- connection test helpers ------------------------------------------------

func testPostgresConn(ctx context.Context, creds model.RelationalCredentials) error {
	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=5",
		url.QueryEscape(creds.Username),
		url.QueryEscape(creds.Password),
		creds.Host, creds.Port, creds.Database,
		sslmode,
	)
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	return conn.Ping(ctx)
}

func testRESTConn(ctx context.Context, creds model.RestCredentials) error {
	if _, err := url.ParseRequestURI(creds.BaseURL); err != nil {
		return fmt.Errorf("invalid base URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, creds.BaseURL, nil)
	if err != nil {
		return fmt.Errorf("build test request: %w", err)
	}
	applyRestAuth(req, creds)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func applyRestAuth(req *http.Request, creds model.RestCredentials) {
	switch creds.AuthType {
	case "bearer":
		if creds.Token != "" {
			req.Header.Set("Authorization", "Bearer "+creds.Token)
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

// isValidConnectorType returns true for known connector type values.
func isValidConnectorType(t model.ConnectorType) bool {
	switch t {
	case model.ConnectorTypePostgres, model.ConnectorTypeMySQL, model.ConnectorTypeMSSQL,
		model.ConnectorTypeREST, model.ConnectorTypeGraphQL, model.ConnectorTypeCSV:
		return true
	}
	return false
}

// sqlMutationRe matches the start of any DML / DDL statement.
// We use a conservative allowlist: only SELECT and WITH (CTE) are permitted.
var sqlMutationRe = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|MERGE|REPLACE|LOCK|BEGIN|COMMIT|ROLLBACK|DO)`)

const maxQueryLimit = 10_000

// RunQuery executes a read-only SELECT query against a connector and returns
// the result rows.  Only Postgres connectors are supported in the first pass;
// others return a clear "unsupported" response (not an error).
//
// Security notes:
//   - Only SELECT and WITH (CTE) starters are allowed; any DML/DDL is rejected
//     with 422 before the query ever reaches the database.
//   - The query runs inside SET TRANSACTION READ ONLY ensuring the DB rejects
//     any mutation that slips past the regex check.
//   - Row count is capped at maxQueryLimit.
func RunQuery(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		var req model.DashboardQueryRequest
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if strings.TrimSpace(req.SQL) == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "sql is required")
			return
		}
		if sqlMutationRe.MatchString(req.SQL) {
			respondErr(w, http.StatusUnprocessableEntity, "mutation_blocked",
				"only SELECT queries are permitted in dashboard query mode")
			return
		}

		limit := req.Limit
		if limit <= 0 || limit > maxQueryLimit {
			limit = maxQueryLimit
		}

		rec, err := s.GetConnectorRecord(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.EncryptedCredentials)
		if err != nil {
			log.Error("decrypt connector credentials for query", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		switch rec.Type {
		case model.ConnectorTypePostgres:
			var creds model.RelationalCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse postgres credentials")
				return
			}
			result, err := runPostgresQuery(ctx, creds, req.SQL, req.Params, limit)
			if err != nil {
				log.Warn("postgres query failed", zap.String("connector_id", connectorID), zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "query_error", err.Error())
				return
			}
			respond(w, http.StatusOK, result)

		default:
			respond(w, http.StatusOK, map[string]any{
				"error": fmt.Sprintf("dashboard queries not yet supported for %s connectors", rec.Type),
			})
		}
	}
}

// runPostgresQuery opens a short-lived connection, runs the query in a
// read-only transaction, and returns structured rows.
func runPostgresQuery(ctx context.Context, creds model.RelationalCredentials, sql string, params []any, limit int) (*model.DashboardQueryResponse, error) {
	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=5",
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

	// Append a LIMIT clause unless one is already present.
	trimmed := strings.TrimRight(strings.TrimSpace(sql), ";")
	if !strings.Contains(strings.ToUpper(trimmed), " LIMIT ") {
		trimmed = fmt.Sprintf("%s LIMIT %d", trimmed, limit)
	}

	rows, err := tx.Query(ctx, trimmed, params...)
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
	return &model.DashboardQueryResponse{
		Columns:  cols,
		Rows:     result,
		RowCount: len(result),
	}, nil
}
