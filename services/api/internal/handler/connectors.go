package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
