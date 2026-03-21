package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// CreatePublication creates a new app publication with audience groups.
// Requires workspace_admin or builder role (enforced in router via middleware).
func CreatePublication(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			AppVersionID string                         `json:"app_version_id"`
			Audiences    []model.AppPublicationAudience `json:"audiences"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.AppVersionID == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "app_version_id is required")
			return
		}

		// Validate the app belongs to the workspace in the URL.
		if _, err := s.GetApp(r.Context(), workspaceID, appID); err != nil {
			handleStoreErr(w, err)
			return
		}

		// Resolve the companyID from the workspace.
		ws, err := s.GetWorkspaceByID(r.Context(), workspaceID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		pub, err := s.CreatePublication(r.Context(), appID, req.AppVersionID, workspaceID, ws.CompanyID, claims.UserID, req.Audiences)
		if err != nil {
			log.Error("create publication", zap.Error(err))
			handleStoreErr(w, err)
			return
		}

		respond(w, http.StatusCreated, pub)
	}
}

// ListPublications returns all active publications for an app.
func ListPublications(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "appID")

		pubs, err := s.ListPublications(r.Context(), appID)
		if err != nil {
			log.Error("list publications", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list publications")
			return
		}
		if pubs == nil {
			pubs = []model.AppPublication{}
		}
		respond(w, http.StatusOK, map[string]any{"publications": pubs})
	}
}

// ArchivePublication sets an app publication's status to archived.
// Requires workspace_admin or builder role (enforced in router via middleware).
func ArchivePublication(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		publicationID := chi.URLParam(r, "publicationID")

		// Derive companyID from the workspace so ArchivePublication enforces tenancy.
		ws, err := s.GetWorkspaceByID(r.Context(), workspaceID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		if err := s.ArchivePublication(r.Context(), ws.CompanyID, publicationID); err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "archived"})
	}
}

// ListCompanyTools returns all active publications visible to the calling user
// through their group memberships within a company (tool discovery endpoint).
func ListCompanyTools(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		claims, _ := ClaimsFromContext(r.Context())

		tools, err := s.ListCompanyPublishedTools(r.Context(), companyID, claims.UserID)
		if err != nil {
			log.Error("list company tools", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list tools")
			return
		}
		if tools == nil {
			tools = []model.AppPublication{}
		}
		respond(w, http.StatusOK, map[string]any{"tools": tools})
	}
}
