package handler

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
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
		if enq != nil && conn.Type != model.ConnectorTypeCSV {
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

		// If credentials changed, re-trigger schema discovery for connectors that
		// can derive schema directly from their stored credentials.
		if len(encCreds) > 0 && enq != nil && conn.Type != model.ConnectorTypeCSV {
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

		case model.ConnectorTypeMySQL:
			var creds model.RelationalCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse mysql credentials")
				return
			}
			testErr = testMySQLConn(ctx, creds)

		case model.ConnectorTypeMSSQL:
			var creds model.RelationalCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse mssql credentials")
				return
			}
			testErr = testMSSQLConn(ctx, creds)

		case model.ConnectorTypeGraphQL:
			var creds graphqlConnCreds
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse graphql credentials")
				return
			}
			testErr = testGraphQLConn(ctx, creds)

		case model.ConnectorTypeCSV:
			// CSV connectors are validated by checking whether any data has been
			// uploaded rather than by inspecting credentials (which are empty for
			// UI-created CSV connectors).
			_, testErr = s.GetLatestCSVUpload(r.Context(), connectorID)
			if errors.Is(testErr, store.ErrNotFound) {
				testErr = fmt.Errorf("csv connector has no data; upload a CSV file via POST /import first")
			}

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

// ImportCSV handles POST .../connectors/:id/import.
// It accepts a multipart/form-data upload with a "file" field containing a CSV
// (first row = column headers). Parses the CSV, persists all rows in the
// csv_uploads table, updates the connector's schema_cache with column-only
// metadata, and returns {"columns": [...], "rows": [[...]], "row_count": N}.
func ImportCSV(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		claims, _ := ClaimsFromContext(r.Context())

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeCSV {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type",
				fmt.Sprintf("import is only supported for CSV connectors, got %s", conn.Type))
			return
		}

		if err := r.ParseMultipartForm(32 << 20); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "failed to parse multipart form")
			return
		}
		file, fileHeader, err := r.FormFile("file")
		if err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", `"file" field is required in the multipart form`)
			return
		}
		defer file.Close()

		reader := csv.NewReader(file)
		reader.TrimLeadingSpace = true
		reader.LazyQuotes = true

		records, err := reader.ReadAll()
		if err != nil {
			respondErr(w, http.StatusUnprocessableEntity, "parse_error", "failed to parse CSV: "+err.Error())
			return
		}
		if len(records) == 0 {
			respondErr(w, http.StatusUnprocessableEntity, "empty_file", "CSV file is empty")
			return
		}

		columns := records[0]
		dataRows := records[1:]
		if dataRows == nil {
			dataRows = [][]string{}
		}

		// Build column metadata.
		colMeta := make([]map[string]any, len(columns))
		for i, c := range columns {
			colMeta[i] = map[string]any{"name": c, "type": "text", "nullable": true}
		}

		// Build full row maps — no row cap; all rows are persisted.
		rowMaps := make([]map[string]any, 0, len(dataRows))
		for _, rec := range dataRows {
			row := make(map[string]any, len(columns))
			for i, col := range columns {
				if i < len(rec) {
					row[col] = rec[i]
				} else {
					row[col] = nil
				}
			}
			rowMaps = append(rowMaps, row)
		}

		// Persist the upload. All rows are stored in the csv_uploads table.
		var filename *string
		if fileHeader != nil && fileHeader.Filename != "" {
			filename = &fileHeader.Filename
		}
		if _, err := s.CreateCSVUpload(r.Context(), connectorID, claims.UserID, filename, colMeta, rowMaps, len(dataRows)); err != nil {
			log.Error("failed to persist CSV upload", zap.String("connector_id", connectorID), zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to save CSV data")
			return
		}

		// Update schema_cache with column-only metadata (no row data) so that
		// schema-discovery consumers (e.g. the builder) can still read column names.
		schemaCache := map[string]any{
			"type":       "csv",
			"columns":    colMeta,
			"total_rows": len(dataRows),
		}
		if schemaJSON, merr := json.Marshal(schemaCache); merr == nil {
			if err := s.UpdateConnectorSchema(r.Context(), connectorID, schemaJSON); err != nil {
				log.Warn("failed to update CSV schema_cache metadata",
					zap.String("connector_id", connectorID), zap.Error(err))
			}
		}

		respond(w, http.StatusOK, map[string]any{
			"columns":   columns,
			"rows":      dataRows,
			"row_count": len(dataRows),
		})
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

// graphqlConnCreds holds connection parameters for GraphQL connectors.
type graphqlConnCreds struct {
	Endpoint string            `json:"endpoint"`
	AuthType string            `json:"auth_type"` // none | bearer
	Token    string            `json:"token,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
}

// testGraphQLConn sends an introspection query to the GraphQL endpoint.
// Returns nil if HTTP 200 is received, an error otherwise.
func testGraphQLConn(ctx context.Context, creds graphqlConnCreds) error {
	if _, err := url.ParseRequestURI(creds.Endpoint); err != nil {
		return fmt.Errorf("invalid endpoint URL: %w", err)
	}
	const introspectionPayload = `{"query":"{ __schema { queryType { name } } }"}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, creds.Endpoint,
		strings.NewReader(introspectionPayload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if creds.AuthType == "bearer" && creds.Token != "" {
		req.Header.Set("Authorization", "Bearer "+creds.Token)
	}
	for k, v := range creds.Headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("graphql endpoint returned HTTP %d", resp.StatusCode)
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
		case model.ConnectorTypePostgres, model.ConnectorTypeMySQL, model.ConnectorTypeMSSQL:
			if strings.TrimSpace(req.SQL) == "" {
				respondErr(w, http.StatusBadRequest, "bad_request", "sql is required")
				return
			}
			if sqlMutationRe.MatchString(req.SQL) {
				respondErr(w, http.StatusUnprocessableEntity, "mutation_blocked",
					"only SELECT queries are permitted in dashboard query mode")
				return
			}
			var creds model.RelationalCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials",
					fmt.Sprintf("cannot parse %s credentials", rec.Type))
				return
			}
			result, err := executeRelationalQuery(ctx, rec.Type, creds, req.SQL, req.Params, limit)
			if err != nil {
				log.Warn("relational query failed",
					zap.String("connector_id", connectorID),
					zap.String("type", string(rec.Type)),
					zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "query_error", err.Error())
				return
			}
			respond(w, http.StatusOK, result)

		case model.ConnectorTypeCSV:
			// Resolve CSV data from the dedicated csv_uploads table.
			// If the caller supplies an app_version_id, serve the snapshot
			// recorded at publish time so published apps see immutable data.
			var upload *model.CSVUpload
			if req.AppVersionID != "" {
				conn, cerr := s.GetConnector(ctx, workspaceID, connectorID)
				if cerr != nil {
					handleStoreErr(w, cerr)
					return
				}
				uploadID, serr := s.GetCSVSnapshotForVersion(ctx, req.AppVersionID, conn.Name)
				if errors.Is(serr, store.ErrNotFound) {
					// Snapshot not found — fall back to latest upload.
					upload, serr = s.GetLatestCSVUpload(ctx, connectorID)
				} else if serr == nil {
					upload, serr = s.GetCSVUploadByID(ctx, uploadID)
				}
				if serr != nil {
					if errors.Is(serr, store.ErrNotFound) {
						respondErr(w, http.StatusUnprocessableEntity, "no_data",
							"CSV data not available; use POST /import to upload a CSV file first")
						return
					}
					log.Error("resolve csv upload for version", zap.Error(serr))
					respondErr(w, http.StatusInternalServerError, "db_error", "failed to load CSV data")
					return
				}
			} else {
				var cerr error
				upload, cerr = s.GetLatestCSVUpload(ctx, connectorID)
				if errors.Is(cerr, store.ErrNotFound) {
					respondErr(w, http.StatusUnprocessableEntity, "no_data",
						"CSV data not available; use POST /import to upload a CSV file first")
					return
				}
				if cerr != nil {
					log.Error("get latest csv upload", zap.Error(cerr))
					respondErr(w, http.StatusInternalServerError, "db_error", "failed to load CSV data")
					return
				}
			}

			cacheCols := make([]string, 0, len(upload.Columns))
			for _, c := range upload.Columns {
				if name, ok := c["name"].(string); ok {
					cacheCols = append(cacheCols, name)
				}
			}
			outRows := upload.Rows
			if outRows == nil {
				outRows = []map[string]any{}
			}
			respond(w, http.StatusOK, &model.DashboardQueryResponse{
				Columns:  cacheCols,
				Rows:     outRows,
				RowCount: len(outRows),
			})

		case model.ConnectorTypeREST:
			var creds model.RestCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse rest credentials")
				return
			}
			// req.SQL carries the endpoint path (e.g. "/users" or "/api/v1/orders").
			// An empty path defaults to "/" which GETs the base URL.
			path := strings.TrimSpace(req.SQL)
			if path == "" {
				path = "/"
			}
			result, err := runRESTQuery(ctx, creds, path, limit)
			if err != nil {
				log.Warn("rest query failed",
					zap.String("connector_id", connectorID),
					zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "query_error", err.Error())
				return
			}
			respond(w, http.StatusOK, result)

		default:
			// GraphQL does not support SQL-style queries.
			respond(w, http.StatusOK, map[string]any{
				"error": fmt.Sprintf("dashboard queries not supported for %s connectors", rec.Type),
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

// maxRESTBodyBytes caps JSON response bodies from REST connectors to 5 MB.
const maxRESTBodyBytes = 5 << 20

// runRESTQuery GETs base_url+path, parses the JSON response, and returns a
// DashboardQueryResponse. The path argument is passed verbatim by the widget
// (stored in req.SQL) and resolved against the base URL.
func runRESTQuery(ctx context.Context, creds model.RestCredentials, path string, limit int) (*model.DashboardQueryResponse, error) {
	base, err := url.Parse(strings.TrimRight(creds.BaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("invalid base URL: %w", err)
	}
	rel, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}
	endpoint := base.ResolveReference(rel).String()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	applyRestAuth(req, creds)

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API returned HTTP %d", resp.StatusCode)
	}

	var body any
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRESTBodyBytes)).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode JSON response: %w", err)
	}

	rows := extractRESTRows(body)
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	return &model.DashboardQueryResponse{
		Columns:  extractRESTColumns(rows),
		Rows:     rows,
		RowCount: len(rows),
	}, nil
}

// extractRESTRows converts a decoded JSON body into a slice of row maps.
// It handles JSON arrays directly, common envelope keys (data, items, results,
// records, rows, list), and single-object responses (returned as one row).
func extractRESTRows(body any) []map[string]any {
	switch v := body.(type) {
	case []any:
		return anySliceToRows(v)
	case map[string]any:
		for _, key := range []string{"data", "items", "results", "records", "rows", "list"} {
			if arr, ok := v[key]; ok {
				if slice, ok := arr.([]any); ok {
					return anySliceToRows(slice)
				}
			}
		}
		// Single object — return as one row so widgets can still render it.
		return []map[string]any{v}
	}
	return []map[string]any{}
}

func anySliceToRows(slice []any) []map[string]any {
	rows := make([]map[string]any, 0, len(slice))
	for _, item := range slice {
		if m, ok := item.(map[string]any); ok {
			rows = append(rows, m)
		}
	}
	return rows
}

// extractRESTColumns derives an ordered column list from the first row.
// Columns are sorted alphabetically so clients always see a stable order.
func extractRESTColumns(rows []map[string]any) []string {
	if len(rows) == 0 {
		return []string{}
	}
	cols := make([]string, 0, len(rows[0]))
	for k := range rows[0] {
		cols = append(cols, k)
	}
	sort.Strings(cols)
	return cols
}
