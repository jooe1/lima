package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// validHTTPMethods are the methods permitted for action definitions.
var validHTTPMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true,
}

// ListConnectorActions returns the full action catalog for a connector.
//
//	GET /workspaces/{workspaceID}/connectors/{connectorID}/actions
func ListConnectorActions(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		actions, err := s.ListConnectorActions(r.Context(), workspaceID, connectorID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				respondErr(w, http.StatusNotFound, "not_found", "connector not found")
				return
			}
			log.Error("list connector actions", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list actions")
			return
		}
		respond(w, http.StatusOK, map[string]any{"actions": actions})
	}
}

// UpsertConnectorAction creates or updates a single action definition.
//
//	PUT /workspaces/{workspaceID}/connectors/{connectorID}/actions
func UpsertConnectorAction(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		var body model.ActionDefinitionInput
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if err := validateActionInput(&body); err != nil {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
			return
		}

		action, err := s.UpsertConnectorAction(r.Context(), workspaceID, connectorID, body)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				respondErr(w, http.StatusNotFound, "not_found", "connector not found")
				return
			}
			log.Error("upsert connector action", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to save action")
			return
		}
		respond(w, http.StatusOK, map[string]any{"action": action})
	}
}

// BulkReplaceConnectorActions replaces the full action catalog in one call.
//
//	PUT /workspaces/{workspaceID}/connectors/{connectorID}/actions/bulk
func BulkReplaceConnectorActions(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		var body struct {
			Actions []model.ActionDefinitionInput `json:"actions"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		for i := range body.Actions {
			if err := validateActionInput(&body.Actions[i]); err != nil {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
				return
			}
		}

		actions, err := s.BulkReplaceConnectorActions(r.Context(), workspaceID, connectorID, body.Actions)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				respondErr(w, http.StatusNotFound, "not_found", "connector not found")
				return
			}
			log.Error("bulk replace connector actions", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to replace actions")
			return
		}
		respond(w, http.StatusOK, map[string]any{"actions": actions})
	}
}

// DeleteConnectorAction removes a single action definition.
//
//	DELETE /workspaces/{workspaceID}/connectors/{connectorID}/actions/{actionID}
func DeleteConnectorAction(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		actionID := chi.URLParam(r, "actionID")

		if err := s.DeleteConnectorAction(r.Context(), workspaceID, connectorID, actionID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				respondErr(w, http.StatusNotFound, "not_found", "action not found")
				return
			}
			log.Error("delete connector action", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to delete action")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func validateActionInput(in *model.ActionDefinitionInput) error {
	in.ResourceName = strings.TrimSpace(in.ResourceName)
	in.ActionKey = strings.TrimSpace(in.ActionKey)
	in.ActionLabel = strings.TrimSpace(in.ActionLabel)
	in.HTTPMethod = strings.ToUpper(strings.TrimSpace(in.HTTPMethod))
	in.PathTemplate = strings.TrimSpace(in.PathTemplate)

	if in.ResourceName == "" {
		return fmt.Errorf("resource_name is required")
	}
	if in.ActionKey == "" {
		return fmt.Errorf("action_key is required")
	}
	if in.ActionLabel == "" {
		return fmt.Errorf("action_label is required")
	}
	if !validHTTPMethods[in.HTTPMethod] {
		return fmt.Errorf("http_method must be one of GET, POST, PUT, PATCH, DELETE")
	}
	if in.PathTemplate == "" {
		return fmt.Errorf("path_template is required")
	}
	if !strings.HasPrefix(in.PathTemplate, "/") {
		return fmt.Errorf("path_template must start with /")
	}
	for i, f := range in.InputFields {
		if strings.TrimSpace(f.Key) == "" {
			return fmt.Errorf("input_fields[%d].key is required", i)
		}
		if strings.TrimSpace(f.Label) == "" {
			return fmt.Errorf("input_fields[%d].label is required", i)
		}
	}
	if in.InputFields == nil {
		in.InputFields = []model.ActionFieldDef{}
	}
	return nil
}

// maxActionProbePreviewBytes caps how much of the API response body is returned
// as a preview in TestConnectorAction.
const maxActionProbePreviewBytes = 4 * 1024

// TestConnectorAction performs a live probe against a single action definition.
// An optional request body `{"input_values": {"key": "value"}}` can supply values
// to substitute into path params (e.g. {id}) and, for mutating methods, the JSON body.
// Returns {"ok": true, "status": 200, "response_preview": "..."} or {"ok": false, ...}.
//
//	POST /workspaces/{workspaceID}/connectors/{connectorID}/actions/{actionID}/test
func TestConnectorAction(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		actionID := chi.URLParam(r, "actionID")

		// Only REST connectors have actions backed by HTTP endpoints.
		rec, err := s.GetConnectorRecord(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if rec.Type != model.ConnectorTypeREST {
			respondErr(w, http.StatusBadRequest, "unsupported_type",
				"action test is only supported for REST connectors")
			return
		}

		plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.EncryptedCredentials)
		if err != nil {
			log.Error("decrypt connector credentials for action test", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential decryption failed")
			return
		}
		var creds model.RestCredentials
		if err := json.Unmarshal(plainCreds, &creds); err != nil {
			respondErr(w, http.StatusUnprocessableEntity, "invalid_credentials", "cannot parse REST credentials")
			return
		}

		action, err := s.GetConnectorAction(r.Context(), workspaceID, connectorID, actionID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		// Optional input_values — ignore decode errors (caller may send empty body).
		var body struct {
			InputValues map[string]string `json:"input_values"`
		}
		_ = decodeJSON(r, &body)
		if body.InputValues == nil {
			body.InputValues = map[string]string{}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		status, finalURL, preview, probeErr := executeActionProbe(ctx, creds, action, body.InputValues)
		if probeErr != nil {
			res := map[string]any{"ok": false, "status": status, "error": probeErr.Error(), "url": finalURL}
			if preview != "" {
				res["response_preview"] = preview
			}
			respond(w, http.StatusOK, res)
			return
		}
		res := map[string]any{"ok": true, "status": status, "url": finalURL}
		if preview != "" {
			res["response_preview"] = preview
		}
		respond(w, http.StatusOK, res)
	}
}

// executeActionProbe builds and fires the HTTP request for an action definition,
// substituting path params from inputValues and placing remaining values in the
// JSON body (for POST/PUT/PATCH) or as query params (for GET/DELETE).
// Returns (httpStatus, finalURL, truncatedResponseBody, error).
func executeActionProbe(
	ctx context.Context,
	creds model.RestCredentials,
	action *model.ActionDefinition,
	inputValues map[string]string,
) (int, string, string, error) {
	// Substitute {param} placeholders in the path template.
	pathStr := action.PathTemplate
	pathParams := map[string]bool{}
	for k, v := range inputValues {
		placeholder := "{" + k + "}"
		if strings.Contains(pathStr, placeholder) {
			pathStr = strings.ReplaceAll(pathStr, placeholder, url.PathEscape(v))
			pathParams[k] = true
		}
	}

	base := strings.TrimRight(creds.BaseURL, "/")
	endpoint := base + "/" + strings.TrimLeft(pathStr, "/")
	if _, err := url.ParseRequestURI(endpoint); err != nil {
		return 0, endpoint, "", fmt.Errorf("invalid endpoint URL: %w", err)
	}

	// Build the request body / query params from the remaining input values.
	var reqBody io.Reader
	method := strings.ToUpper(action.HTTPMethod)
	switch method {
	case "POST", "PUT", "PATCH":
		// Send non-path fields as a JSON object.
		bodyMap := make(map[string]any)
		for _, f := range action.InputFields {
			if pathParams[f.Key] {
				continue
			}
			if v, ok := inputValues[f.Key]; ok {
				bodyMap[f.Key] = v
			}
		}
		if len(bodyMap) > 0 {
			b, _ := json.Marshal(bodyMap)
			reqBody = bytes.NewReader(b)
		}
	case "GET", "DELETE":
		// Append non-path fields as query parameters.
		q := url.Values{}
		for _, f := range action.InputFields {
			if pathParams[f.Key] {
				continue
			}
			if v, ok := inputValues[f.Key]; ok && v != "" {
				q.Set(f.Key, v)
			}
		}
		if len(q) > 0 {
			endpoint += "?" + q.Encode()
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reqBody)
	if err != nil {
		return 0, endpoint, "", fmt.Errorf("build request: %w", err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	applyRestAuth(req, creds)

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return 0, endpoint, "", fmt.Errorf("%s", classifyNetError(err))
	}
	defer resp.Body.Close()

	previewBytes, _ := io.ReadAll(io.LimitReader(resp.Body, maxActionProbePreviewBytes))
	preview := strings.TrimSpace(string(previewBytes))

	if resp.StatusCode >= 400 {
		return resp.StatusCode, endpoint, preview, fmt.Errorf("%s", describeHTTPError(resp.StatusCode, preview))
	}
	return resp.StatusCode, endpoint, preview, nil
}

// httpStatusHint returns a short human-readable description for common HTTP error codes.
func httpStatusHint(code int) string {
	switch code {
	case 400:
		return "Bad request — check the field values you provided"
	case 401:
		return "Unauthorized — check your credentials or token"
	case 403:
		return "Forbidden — your credentials don't have access to this resource"
	case 404:
		return "Not found — check the path and any ID/path parameters"
	case 405:
		return "Method not allowed — this endpoint may not support this HTTP method"
	case 409:
		return "Conflict — the resource may already exist"
	case 422:
		return "Validation error — the API rejected the input values"
	case 429:
		return "Rate limited — too many requests, try again later"
	case 500:
		return "Server error — the remote API returned an internal error"
	case 502:
		return "Bad gateway — could not reach the upstream API"
	case 503:
		return "Service unavailable — the remote API is down or overloaded"
	default:
		return ""
	}
}

// extractAPIErrorMessage attempts to parse a JSON body and return the first
// error string found under common error field names used by REST APIs.
func extractAPIErrorMessage(body string) string {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return ""
	}
	for _, key := range []string{"message", "error", "detail", "errors", "msg", "reason", "description"} {
		v, ok := parsed[key]
		if !ok {
			continue
		}
		switch val := v.(type) {
		case string:
			if val != "" {
				return val
			}
		case []any:
			if len(val) == 0 {
				break
			}
			if s, ok := val[0].(string); ok && s != "" {
				return s
			}
			// e.g. {"errors": [{"message": "field required"}]}
			if m, ok := val[0].(map[string]any); ok {
				for _, mk := range []string{"message", "msg", "detail"} {
					if s, ok := m[mk].(string); ok && s != "" {
						return s
					}
				}
			}
		}
	}
	return ""
}

// describeHTTPError builds a human-readable error message for an HTTP error
// response by combining the status code hint with any API-provided error text.
func describeHTTPError(status int, body string) string {
	msg := fmt.Sprintf("HTTP %d", status)
	if hint := httpStatusHint(status); hint != "" {
		msg += " — " + hint
	}
	if apiMsg := extractAPIErrorMessage(body); apiMsg != "" {
		msg += ". API says: " + apiMsg
	}
	return msg
}

// classifyNetError returns a human-readable message for common network errors.
func classifyNetError(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "context deadline exceeded") || strings.Contains(s, "timeout"):
		return "Request timed out — the API did not respond within 10 seconds"
	case strings.Contains(s, "connection refused"):
		return "Connection refused — nothing is listening at that address"
	case strings.Contains(s, "no such host") || strings.Contains(s, "lookup"):
		return "DNS lookup failed — check that the base URL hostname is correct"
	case strings.Contains(s, "connection reset"):
		return "Connection reset by the remote server"
	case strings.Contains(s, "tls") || strings.Contains(s, "certificate"):
		return "TLS/certificate error — " + s
	default:
		return s
	}
}
