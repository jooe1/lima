package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
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
