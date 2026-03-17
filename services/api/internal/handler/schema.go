package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// GetConnectorSchema returns the cached schema if available.
//
// For REST connectors with no cache, schema discovery is attempted synchronously
// by probing standard OpenAPI/Swagger spec endpoints.
//
// For all other connector types with no cache, a background schema-discovery job
// is enqueued and HTTP 202 Accepted is returned immediately.
func GetConnectorSchema(cfg *config.Config, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
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

		// For REST connectors: discover schema synchronously by probing OpenAPI endpoints.
		if conn.Type == model.ConnectorTypeREST {
			rec, err := s.GetConnectorRecord(r.Context(), workspaceID, connectorID)
			if err != nil {
				handleStoreErr(w, err)
				return
			}
			plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.EncryptedCredentials)
			if err != nil {
				log.Error("decrypt connector credentials for REST schema", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
				return
			}
			var creds model.RestCredentials
			if err := json.Unmarshal(plainCreds, &creds); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse REST credentials")
				return
			}
			schema, err := discoverRESTSchema(r.Context(), creds)
			if err != nil {
				log.Warn("REST schema discovery failed",
					zap.String("connector_id", connectorID), zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "schema_error",
					"REST schema discovery failed: "+err.Error())
				return
			}
			// Persist the result so subsequent calls return from cache.
			if schemaJSON, merr := json.Marshal(schema); merr == nil {
				if err := s.UpdateConnectorSchema(r.Context(), connectorID, schemaJSON); err != nil {
					log.Warn("failed to persist REST schema cache",
						zap.String("connector_id", connectorID), zap.Error(err))
				}
			}
			respond(w, http.StatusOK, map[string]any{"schema": schema})
			return
		}

		// For all other connector types: enqueue a background discovery job.
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

// discoverRESTSchema probes the connector's base URL for an OpenAPI 3.x or
// Swagger 2.x spec. It tries the following paths in order:
//  1. {base_url}/openapi.json
//  2. {base_url}/swagger.json
//  3. {base_url}/api-docs
//
// On success it parses the paths object and returns a list of
// {path, method, summary, parameters} entries. If none of the probe URLs returns
// a parseable spec, an empty paths list is returned with discovery_method="manual".
func discoverRESTSchema(ctx context.Context, creds model.RestCredentials) (map[string]any, error) {
	if _, err := url.ParseRequestURI(creds.BaseURL); err != nil {
		return nil, fmt.Errorf("invalid base URL: %w", err)
	}
	baseURL := strings.TrimRight(creds.BaseURL, "/")

	candidates := []string{
		baseURL + "/openapi.json",
		baseURL + "/swagger.json",
		baseURL + "/api-docs",
	}

	client := &http.Client{}
	for _, candidate := range candidates {
		paths, method, err := tryFetchOpenAPISpec(ctx, client, candidate, creds)
		if err != nil {
			continue
		}
		return map[string]any{
			"discovery_method": method,
			"spec_url":         candidate,
			"paths":            paths,
		}, nil
	}

	// None of the standard paths returned a parseable spec.
	return map[string]any{
		"discovery_method": "manual",
		"paths":            []any{},
		"note":             "No OpenAPI/Swagger spec found at standard paths. Define the schema manually.",
	}, nil
}

// tryFetchOpenAPISpec GETs the given URL and attempts to parse it as an
// OpenAPI 3.x or Swagger 2.x document. On success it returns the flattened
// list of path-operation entries and a discovery-method label.
// Returns an error (without logging) on any failure so the caller can try the next URL.
func tryFetchOpenAPISpec(
	ctx context.Context,
	client *http.Client,
	specURL string,
	creds model.RestCredentials,
) ([]map[string]any, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, specURL, nil)
	if err != nil {
		return nil, "", err
	}
	applyRestAuth(req, creds)

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20)) // 4 MB cap
	if err != nil {
		return nil, "", err
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, "", fmt.Errorf("not valid JSON: %w", err)
	}

	discoveryMethod := "openapi_3"
	if _, isSwagger := raw["swagger"]; isSwagger {
		discoveryMethod = "swagger_2"
	}

	paths, ok := raw["paths"].(map[string]any)
	if !ok || len(paths) == 0 {
		return nil, "", fmt.Errorf("spec has no paths object")
	}

	var pathItems []map[string]any
	for path, methodsRaw := range paths {
		methods, ok := methodsRaw.(map[string]any)
		if !ok {
			continue
		}
		for method, opRaw := range methods {
			op, ok := opRaw.(map[string]any)
			if !ok {
				continue
			}
			item := map[string]any{
				"path":   path,
				"method": strings.ToUpper(method),
			}
			if summary, ok := op["summary"].(string); ok {
				item["summary"] = summary
			}
			if params, ok := op["parameters"]; ok {
				item["parameters"] = params
			}
			pathItems = append(pathItems, item)
		}
	}
	return pathItems, discoveryMethod, nil
}
