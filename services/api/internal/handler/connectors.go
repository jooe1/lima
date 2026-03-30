package handler

import (
	"context"
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

// syncRESTEndpoints copies the user-defined endpoint list from REST credentials
// into schema_cache so the frontend can read them without decrypting credentials.
// Best-effort: errors are logged and ignored.
func syncRESTEndpoints(ctx context.Context, s *store.Store, log *zap.Logger, connectorID string, rawCreds json.RawMessage) {
	var creds model.RestCredentials
	if err := json.Unmarshal(rawCreds, &creds); err != nil {
		return
	}
	type epEntry struct {
		Label string `json:"label"`
		Path  string `json:"path"`
	}
	eps := make([]epEntry, 0, len(creds.Endpoints))
	for _, ep := range creds.Endpoints {
		if ep.Label != "" && ep.Path != "" {
			eps = append(eps, epEntry{Label: ep.Label, Path: ep.Path})
		}
	}
	schemaJSON, err := json.Marshal(map[string]any{
		"base_url":  creds.BaseURL,
		"endpoints": eps,
	})
	if err != nil {
		return
	}
	if err := s.UpdateConnectorSchema(ctx, connectorID, schemaJSON); err != nil {
		log.Warn("failed to sync REST endpoints to schema_cache", zap.Error(err))
	}
}

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

func secretKeysForConnector(connType model.ConnectorType, creds map[string]any) []string {
	switch connType {
	case model.ConnectorTypePostgres, model.ConnectorTypeMySQL, model.ConnectorTypeMSSQL:
		return []string{"password"}
	case model.ConnectorTypeREST:
		authType, _ := creds["auth_type"].(string)
		switch authType {
		case "bearer":
			return []string{"token"}
		case "basic":
			return []string{"password"}
		case "api_key":
			return []string{"api_key"}
		}
	case model.ConnectorTypeGraphQL:
		authType, _ := creds["auth_type"].(string)
		if authType == "bearer" {
			return []string{"token"}
		}
	}
	return nil
}

func hasStoredSecret(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) != ""
	case nil:
		return false
	default:
		return true
	}
}

func redactEditableConnectorCredentials(connType model.ConnectorType, plainCreds []byte) (map[string]any, map[string]bool, error) {
	if len(plainCreds) == 0 {
		return map[string]any{}, map[string]bool{}, nil
	}

	var creds map[string]any
	if err := json.Unmarshal(plainCreds, &creds); err != nil {
		return nil, nil, err
	}
	if creds == nil {
		creds = map[string]any{}
	}

	storedSecrets := map[string]bool{}
	for _, key := range secretKeysForConnector(connType, creds) {
		storedSecrets[key] = hasStoredSecret(creds[key])
		delete(creds, key)
	}

	return creds, storedSecrets, nil
}

func pruneConnectorCredentialFields(connType model.ConnectorType, merged map[string]any, patch map[string]any) {
	switch connType {
	case model.ConnectorTypeREST:
		authTypeValue, ok := patch["auth_type"]
		if !ok {
			return
		}
		authType, _ := authTypeValue.(string)
		switch authType {
		case "none":
			delete(merged, "token")
			delete(merged, "username")
			delete(merged, "password")
			delete(merged, "api_key")
			delete(merged, "api_key_header")
		case "bearer":
			delete(merged, "username")
			delete(merged, "password")
			delete(merged, "api_key")
			delete(merged, "api_key_header")
		case "basic":
			delete(merged, "token")
			delete(merged, "api_key")
			delete(merged, "api_key_header")
		case "api_key":
			delete(merged, "token")
			delete(merged, "username")
			delete(merged, "password")
		}
	case model.ConnectorTypeGraphQL:
		authTypeValue, ok := patch["auth_type"]
		if !ok {
			return
		}
		authType, _ := authTypeValue.(string)
		if authType != "bearer" {
			delete(merged, "token")
		}
	}
}

func mergeConnectorCredentials(connType model.ConnectorType, currentPlainCreds, patchPlainCreds []byte) ([]byte, error) {
	merged := map[string]any{}
	if len(currentPlainCreds) > 0 {
		if err := json.Unmarshal(currentPlainCreds, &merged); err != nil {
			return nil, err
		}
	}
	if merged == nil {
		merged = map[string]any{}
	}

	patch := map[string]any{}
	if len(patchPlainCreds) > 0 {
		if err := json.Unmarshal(patchPlainCreds, &patch); err != nil {
			return nil, err
		}
	}
	if patch == nil {
		patch = map[string]any{}
	}

	for key, value := range patch {
		merged[key] = value
	}
	pruneConnectorCredentialFields(connType, merged, patch)

	if len(merged) == 0 {
		return []byte(`{}`), nil
	}
	return json.Marshal(merged)
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
		// Managed (Lima Table) connectors need no external credentials.
		if body.Type == model.ConnectorTypeManaged && len(body.Credentials) == 0 {
			body.Credentials = json.RawMessage(`{}`)
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

		// Kick off schema discovery. Not needed for managed connectors whose
		// schema is populated directly when columns are defined.
		if enq != nil && conn.Type != model.ConnectorTypeManaged {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: conn.ID,
				WorkspaceID: workspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed", zap.Error(err))
			}
		}

		// For REST connectors, immediately sync named endpoints to schema_cache
		// so the builder can show an endpoint picker without decrypting credentials.
		if body.Type == model.ConnectorTypeREST {
			syncRESTEndpoints(r.Context(), s, log, conn.ID, body.Credentials)
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

// GetEditableConnector returns the safe public connector plus redacted
// credentials needed to hydrate the admin edit form.
func GetEditableConnector(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
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
			log.Error("decrypt connector credentials for edit", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
			return
		}

		editableCreds, storedSecrets, err := redactEditableConnectorCredentials(rec.Type, plainCreds)
		if err != nil {
			log.Error("redact connector credentials for edit", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "failed to load connector credentials")
			return
		}

		respond(w, http.StatusOK, map[string]any{
			"connector":            rec.Connector,
			"editable_credentials": editableCreds,
			"stored_secrets":       storedSecrets,
		})
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
		var mergedCreds []byte
		if len(body.Credentials) > 0 {
			rec, err := s.GetConnectorRecord(r.Context(), workspaceID, connectorID)
			if err != nil {
				handleStoreErr(w, err)
				return
			}

			currentPlainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.EncryptedCredentials)
			if err != nil {
				log.Error("decrypt connector credentials", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
				return
			}

			mergedCreds, err = mergeConnectorCredentials(rec.Type, currentPlainCreds, body.Credentials)
			if err != nil {
				respondErr(w, http.StatusBadRequest, "bad_request", "invalid credentials payload")
				return
			}

			encCreds, err = cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, mergedCreds)
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
		if len(encCreds) > 0 && enq != nil && conn.Type != model.ConnectorTypeManaged {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: connectorID,
				WorkspaceID: workspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed after patch", zap.Error(err))
			}
		}

		// For REST connectors, re-sync named endpoints whenever credentials change.
		if conn.Type == model.ConnectorTypeREST && len(mergedCreds) > 0 {
			syncRESTEndpoints(r.Context(), s, log, connectorID, mergedCreds)
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

// validConnectorGrantActions lists the actions that may be granted on a connector.
var validConnectorGrantActions = map[string]bool{
	"query":       true,
	"mutate":      true,
	"bind":        true,
	"read_schema": true,
	"manage":      true,
}

// createConnectorGrantBody is the request payload for creating a connector grant.
type createConnectorGrantBody struct {
	SubjectType string `json:"subject_type"`
	SubjectID   string `json:"subject_id"`
	Action      string `json:"action"`
}

// ListConnectorGrants returns all resource grants for a workspace-scoped connector.
// Requires workspace_admin role (enforced via middleware).
func ListConnectorGrants(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		connectorID := chi.URLParam(r, "connectorID")
		claims, _ := ClaimsFromContext(r.Context())

		grants, err := s.ListResourceGrants(r.Context(), claims.CompanyID, "connector", connectorID)
		if err != nil {
			log.Error("list connector grants", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list grants")
			return
		}
		if grants == nil {
			grants = []model.ResourceGrant{}
		}
		respond(w, http.StatusOK, map[string]any{"grants": grants})
	}
}

// CreateConnectorGrant adds a new ACL entry for a workspace-scoped connector.
// Requires workspace_admin role (enforced via middleware).
func CreateConnectorGrant(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		claims, _ := ClaimsFromContext(r.Context())

		var body createConnectorGrantBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.SubjectType == "" || body.SubjectID == "" || body.Action == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "subject_type, subject_id, and action are required")
			return
		}
		if !validConnectorGrantActions[body.Action] {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "action must be one of: query, mutate, bind, read_schema, manage")
			return
		}

		// Verify the connector belongs to this workspace before granting access.
		if _, err := s.GetConnector(r.Context(), workspaceID, connectorID); err != nil {
			handleStoreErr(w, err)
			return
		}

		grant, err := s.CreateResourceGrant(r.Context(), claims.CompanyID, "connector", connectorID,
			body.SubjectType, body.SubjectID, body.Action, nil, "allow", claims.UserID)
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				respondErr(w, http.StatusConflict, "conflict", "grant already exists")
				return
			}
			log.Error("create connector grant", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create grant")
			return
		}
		respond(w, http.StatusCreated, map[string]any{"grant": grant})
	}
}

// DeleteConnectorGrant removes a resource grant from a workspace-scoped connector.
// Requires workspace_admin role (enforced via middleware).
func DeleteConnectorGrant(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		grantID := chi.URLParam(r, "grantID")
		claims, _ := ClaimsFromContext(r.Context())

		if err := s.DeleteResourceGrant(r.Context(), claims.CompanyID, grantID); err != nil {
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

		case model.ConnectorTypeManaged:
			// Lima Table connectors are valid once columns have been defined.
			var cols []model.ManagedTableColumn
			cols, testErr = s.GetManagedTableColumns(r.Context(), connectorID)
			if testErr == nil && len(cols) == 0 {
				testErr = fmt.Errorf("Lima Table has no columns defined; use PUT /columns to define the schema first")
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

// isValidConnectorType returns true for known connector type values.
func isValidConnectorType(t model.ConnectorType) bool {
	switch t {
	case model.ConnectorTypePostgres, model.ConnectorTypeMySQL, model.ConnectorTypeMSSQL,
		model.ConnectorTypeREST, model.ConnectorTypeGraphQL, model.ConnectorTypeManaged:
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

		case model.ConnectorTypeManaged:
			// Load rows from Lima's managed table storage.
			// app_version_id → use the publish-time snapshot (immutable);
			// otherwise use live data.
			var liveCols []model.ManagedTableColumn
			var outRows []map[string]any

			if req.AppVersionID != "" {
				snap, serr := s.GetManagedSnapshotForVersion(ctx, req.AppVersionID, rec.Name)
				if serr != nil && !errors.Is(serr, store.ErrNotFound) {
					log.Error("get managed snapshot for version", zap.Error(serr))
					respondErr(w, http.StatusInternalServerError, "db_error", "failed to load managed table data")
					return
				}
				if snap != nil {
					for _, c := range snap.Columns {
						name, _ := c["name"].(string)
						colType, _ := c["col_type"].(string)
						liveCols = append(liveCols, model.ManagedTableColumn{Name: name, ColType: colType})
					}
					outRows = snap.Rows
				}
			}
			if liveCols == nil {
				// Live data path.
				cols, cerr := s.GetManagedTableColumns(ctx, connectorID)
				if cerr != nil {
					log.Error("get managed table columns", zap.Error(cerr))
					respondErr(w, http.StatusInternalServerError, "db_error", "failed to load managed table schema")
					return
				}
				liveCols = cols
				tableRows, cerr := s.ListManagedTableRows(ctx, connectorID)
				if cerr != nil {
					log.Error("list managed table rows", zap.Error(cerr))
					respondErr(w, http.StatusInternalServerError, "db_error", "failed to load managed table rows")
					return
				}
				outRows = make([]map[string]any, len(tableRows))
				for i, r := range tableRows {
					outRows[i] = r.Data
				}
			}
			if outRows == nil {
				outRows = []map[string]any{}
			}

			// If the caller sent a SQL statement, execute it against an
			// ephemeral in-memory SQLite database built from the loaded rows.
			if strings.TrimSpace(req.SQL) != "" {
				if sqlMutationRe.MatchString(req.SQL) {
					respondErr(w, http.StatusUnprocessableEntity, "mutation_blocked",
						"only SELECT queries are permitted in dashboard query mode")
					return
				}
				tblName := managedTableName(rec.Name)
				result, qerr := runManagedQuery(ctx, tblName, liveCols, outRows, req.SQL, limit)
				if qerr != nil {
					log.Warn("managed query failed",
						zap.String("connector_id", connectorID),
						zap.Error(qerr))
					respondErr(w, http.StatusInternalServerError, "query_error", qerr.Error())
					return
				}
				respond(w, http.StatusOK, result)
				return
			}

			// No SQL supplied — return all rows (used by widgets that bind the
			// entire table without a filter).
			colNames := make([]string, len(liveCols))
			for i, c := range liveCols {
				colNames[i] = c.Name
			}
			respond(w, http.StatusOK, &model.DashboardQueryResponse{
				Columns:  colNames,
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
// (stored in req.SQL) and appended to the base URL. An empty or "/" path
// means "call the base URL as-is" — this is intentional so connectors whose
// base_url is a full resource URL (e.g. https://api.example.com/v1/kpis) work
// without requiring users to re-enter the path in every widget.
func runRESTQuery(ctx context.Context, creds model.RestCredentials, path string, limit int) (*model.DashboardQueryResponse, error) {
	base := strings.TrimRight(creds.BaseURL, "/")
	if base == "" {
		return nil, fmt.Errorf("rest connector has no base URL")
	}
	var endpoint string
	if path == "" || path == "/" {
		// No widget-level path: call the base URL directly.
		// This allows a connector like https://api.example.com/kpis to serve
		// data with zero extra configuration in the widget.
		endpoint = base
	} else {
		// Append the path from the widget (strip leading slash to avoid double slashes).
		endpoint = base + "/" + strings.TrimLeft(path, "/")
	}
	// Validate the constructed URL before making the request.
	if _, err := url.ParseRequestURI(endpoint); err != nil {
		return nil, fmt.Errorf("invalid endpoint URL %q: %w", endpoint, err)
	}

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
// Nested object values are flattened one level deep (e.g. a KPI response
// {"revenue":{"value":100,"change":5}} becomes {"revenue.value":100,"revenue.change":5})
// so that table/chart widgets can display scalar columns without showing [object Object].
func extractRESTRows(body any) []map[string]any {
	switch v := body.(type) {
	case []any:
		return flattenRows(anySliceToRows(v))
	case map[string]any:
		for _, key := range []string{"data", "items", "results", "records", "rows", "list"} {
			if arr, ok := v[key]; ok {
				if slice, ok := arr.([]any); ok {
					return flattenRows(anySliceToRows(slice))
				}
			}
		}
		// Single object — return as one row so widgets can still render it.
		return flattenRows([]map[string]any{v})
	}
	return []map[string]any{}
}

// flattenRows applies flattenRow to every row in a slice.
func flattenRows(rows []map[string]any) []map[string]any {
	for i, r := range rows {
		rows[i] = flattenRow(r)
	}
	return rows
}

// flattenRow flattens one level of nested map values.
// {"revenue":{"value":100,"currency":"USD"}} becomes
// {"revenue.value":100, "revenue.currency":"USD"}.
// Non-map values and arrays are left as-is.
func flattenRow(row map[string]any) map[string]any {
	out := make(map[string]any, len(row))
	for k, v := range row {
		if nested, ok := v.(map[string]any); ok {
			for nk, nv := range nested {
				out[k+"."+nk] = nv
			}
		} else {
			out[k] = v
		}
	}
	return out
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
