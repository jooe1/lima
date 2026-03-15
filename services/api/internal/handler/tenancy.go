package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// GetCompany returns the company record for the authenticated user.
func GetCompany(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		company, err := s.GetCompany(r.Context(), companyID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, company)
	}
}

// ListWorkspaces returns all workspaces belonging to a company.
func ListWorkspaces(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		wss, err := s.ListWorkspaces(r.Context(), companyID)
		if err != nil {
			log.Error("list workspaces", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list workspaces")
			return
		}
		if wss == nil {
			wss = []model.Workspace{}
		}
		respond(w, http.StatusOK, map[string]any{"workspaces": wss})
	}
}

// CreateWorkspace creates a new workspace within a company.
func CreateWorkspace(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")

		var req struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Name == "" || req.Slug == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "name and slug are required")
			return
		}

		ws, err := s.CreateWorkspace(r.Context(), companyID, req.Name, req.Slug)
		if err != nil {
			if err == store.ErrConflict {
				respondErr(w, http.StatusConflict, "slug_conflict", "a workspace with that slug already exists")
				return
			}
			log.Error("create workspace", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create workspace")
			return
		}

		// Auto-enroll the creator as workspace_admin.
		claims, _ := ClaimsFromContext(r.Context())
		if claims != nil {
			if err := s.EnsureMember(r.Context(), ws.ID, claims.UserID, model.RoleWorkspaceAdmin); err != nil {
				log.Warn("could not enroll creator as admin", zap.Error(err))
			}
		}

		respond(w, http.StatusCreated, ws)
	}
}

// GetWorkspace returns a single workspace.
func GetWorkspace(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		ws, err := s.GetWorkspace(r.Context(), companyID, workspaceID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, ws)
	}
}

// ListMembers returns all workspace members with their roles.
func ListMembers(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		members, err := s.ListMembers(r.Context(), workspaceID)
		if err != nil {
			log.Error("list members", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list members")
			return
		}
		if members == nil {
			members = []model.MemberDetail{}
		}
		respond(w, http.StatusOK, map[string]any{"members": members})
	}
}
