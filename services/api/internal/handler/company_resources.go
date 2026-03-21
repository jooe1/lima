package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListCompanyResources returns all company-scoped connectors (resources).
func ListCompanyResources(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resources, err := s.ListConnectorsByCompany(r.Context(), companyID)
		if err != nil {
			log.Error("list company resources", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list resources")
			return
		}
		if resources == nil {
			resources = []model.Connector{}
		}
		respond(w, http.StatusOK, map[string]any{"resources": resources})
	}
}

// createCompanyResourceBody is the request payload for resource creation.
type createCompanyResourceBody struct {
	WorkspaceID string              `json:"workspace_id"`
	Name        string              `json:"name"`
	Type        model.ConnectorType `json:"type"`
	Credentials json.RawMessage     `json:"credentials"`
}

// CreateCompanyResource creates a company-scoped connector tied to a workspace.
func CreateCompanyResource(cfg *config.Config, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")

		if !isCompanyAdminOrResourceAdmin(s, w, r, companyID) {
			return
		}
		claims, _ := ClaimsFromContext(r.Context())

		var body createCompanyResourceBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.WorkspaceID == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "workspace_id is required")
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

		// Validate that the workspace belongs to this company.
		if _, err := s.GetWorkspace(r.Context(), companyID, body.WorkspaceID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", "workspace not found in company")
				return
			}
			log.Error("validate workspace for company resource", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to validate workspace")
			return
		}

		encCreds, err := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, body.Credentials)
		if err != nil {
			log.Error("encrypt resource credentials", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "credential encryption failed")
			return
		}

		conn, err := s.CreateCompanyConnector(r.Context(), companyID, body.WorkspaceID, body.Name, body.Type, encCreds, claims.UserID)
		if err != nil {
			log.Error("create company resource", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create resource")
			return
		}

		if enq != nil {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: conn.ID,
				WorkspaceID: body.WorkspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed", zap.Error(err))
			}
		}

		respond(w, http.StatusCreated, map[string]any{"resource": conn})
	}
}

// GetCompanyResource returns a single company-scoped connector.
func GetCompanyResource(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resourceID := chi.URLParam(r, "resourceID")
		conn, err := s.GetConnectorByCompany(r.Context(), companyID, resourceID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]any{"resource": conn})
	}
}

// patchCompanyResourceBody is the request payload for resource updates.
type patchCompanyResourceBody struct {
	Name        *string         `json:"name"`
	Credentials json.RawMessage `json:"credentials"`
}

// UpdateCompanyResource applies a partial update to a company-scoped connector.
func UpdateCompanyResource(cfg *config.Config, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resourceID := chi.URLParam(r, "resourceID")

		if !isCompanyAdminOrResourceAdmin(s, w, r, companyID) {
			return
		}

		var body patchCompanyResourceBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		var encCreds []byte
		if len(body.Credentials) > 0 {
			var err error
			encCreds, err = cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, body.Credentials)
			if err != nil {
				log.Error("encrypt resource credentials", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "internal_error", "credential encryption failed")
				return
			}
		}

		conn, err := s.PatchCompanyConnector(r.Context(), companyID, resourceID, body.Name, encCreds)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		if len(encCreds) > 0 && enq != nil {
			if err := enq.EnqueueSchema(r.Context(), model.SchemaJobPayload{
				ConnectorID: resourceID,
				WorkspaceID: conn.WorkspaceID,
			}); err != nil {
				log.Warn("schema job enqueue failed after patch", zap.Error(err))
			}
		}

		respond(w, http.StatusOK, map[string]any{"resource": conn})
	}
}

// DeleteCompanyResource removes a company-scoped connector.
func DeleteCompanyResource(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resourceID := chi.URLParam(r, "resourceID")

		if !isCompanyAdminOrResourceAdmin(s, w, r, companyID) {
			return
		}

		if err := s.DeleteCompanyConnector(r.Context(), companyID, resourceID); err != nil {
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ListResourceGrants returns all grants for a company-scoped connector.
func ListResourceGrants(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resourceID := chi.URLParam(r, "resourceID")
		grants, err := s.ListResourceGrants(r.Context(), companyID, "connector", resourceID)
		if err != nil {
			log.Error("list resource grants", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list grants")
			return
		}
		if grants == nil {
			grants = []model.ResourceGrant{}
		}
		respond(w, http.StatusOK, map[string]any{"grants": grants})
	}
}

// createResourceGrantBody is the request payload for adding a resource grant.
type createResourceGrantBody struct {
	SubjectType string  `json:"subject_type"`
	SubjectID   string  `json:"subject_id"`
	Action      string  `json:"action"`
	ScopeJSON   *string `json:"scope_json,omitempty"`
	Effect      string  `json:"effect"`
}

// CreateResourceGrant adds a new ACL entry for a company-scoped connector.
func CreateResourceGrant(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		resourceID := chi.URLParam(r, "resourceID")

		if !isCompanyAdminOrResourceAdmin(s, w, r, companyID) {
			return
		}
		claims, _ := ClaimsFromContext(r.Context())

		var body createResourceGrantBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.SubjectType == "" || body.SubjectID == "" || body.Action == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "subject_type, subject_id, and action are required")
			return
		}
		effect := body.Effect
		if effect == "" {
			effect = "allow"
		}

		grant, err := s.CreateResourceGrant(r.Context(), companyID, "connector", resourceID, body.SubjectType, body.SubjectID, body.Action, body.ScopeJSON, effect, claims.UserID)
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				respondErr(w, http.StatusConflict, "conflict", "grant already exists")
				return
			}
			log.Error("create resource grant", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create grant")
			return
		}
		respond(w, http.StatusCreated, map[string]any{"grant": grant})
	}
}

// DeleteResourceGrant removes an ACL entry by ID.
func DeleteResourceGrant(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		grantID := chi.URLParam(r, "grantID")

		if !isCompanyAdminOrResourceAdmin(s, w, r, companyID) {
			return
		}

		if err := s.DeleteResourceGrant(r.Context(), companyID, grantID); err != nil {
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
