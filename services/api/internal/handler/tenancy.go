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

		if _, err := s.EnsureWorkspaceSyncGroup(r.Context(), ws.ID); err != nil {
			log.Error("ensure workspace sync group", zap.Error(err), zap.String("workspace_id", ws.ID))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to initialize workspace access")
			return
		}

		// Auto-enroll the creator as workspace_admin via an explicit bootstrap grant.
		claims, _ := ClaimsFromContext(r.Context())
		if claims != nil {
			createdBy := claims.UserID
			if _, err := s.ApplyWorkspaceMemberGrant(
				r.Context(),
				ws.ID,
				claims.UserID,
				model.RoleWorkspaceAdmin,
				model.WorkspaceGrantSourceSystemBootstrap,
				model.WorkspaceGrantSourceRefSystemBootstrap,
				&createdBy,
			); err != nil {
				log.Error("apply workspace bootstrap grant", zap.Error(err), zap.String("workspace_id", ws.ID), zap.String("user_id", claims.UserID))
				respondErr(w, http.StatusInternalServerError, "db_error", "failed to initialize workspace membership")
				return
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
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		if _, err := s.GetWorkspace(r.Context(), companyID, workspaceID); err != nil {
			handleStoreErr(w, err)
			return
		}
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

// UpsertMember creates or updates a manual workspace membership grant.
func UpsertMember(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		if _, err := s.GetWorkspace(r.Context(), companyID, workspaceID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if !isCompanyAdminOrWorkspaceAdmin(s, w, r, companyID, workspaceID) {
			return
		}

		var req struct {
			UserID string              `json:"user_id"`
			Role   model.WorkspaceRole `json:"role"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.UserID == "" || !isValidWorkspaceRole(req.Role) {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "user_id and a valid role are required")
			return
		}

		user, err := s.GetUser(r.Context(), req.UserID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if user.CompanyID != companyID {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "user must belong to the workspace company")
			return
		}

		claims, _ := ClaimsFromContext(r.Context())
		var createdBy *string
		if claims != nil {
			createdBy = &claims.UserID
		}

		grant, err := s.ApplyWorkspaceMemberGrant(
			r.Context(),
			workspaceID,
			req.UserID,
			req.Role,
			model.WorkspaceGrantSourceManual,
			model.WorkspaceGrantSourceRefManual,
			createdBy,
		)
		if err != nil {
			log.Error("apply manual workspace member grant", zap.Error(err), zap.String("workspace_id", workspaceID), zap.String("user_id", req.UserID))
			handleStoreErr(w, err)
			return
		}

		respond(w, http.StatusOK, map[string]any{"grant": grant})
	}
}

// DeleteMember removes only the manual workspace membership grant for a user.
func DeleteMember(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		userID := chi.URLParam(r, "userID")
		if _, err := s.GetWorkspace(r.Context(), companyID, workspaceID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if !isCompanyAdminOrWorkspaceAdmin(s, w, r, companyID, workspaceID) {
			return
		}
		if err := s.DeleteWorkspaceMemberGrantAndRecompute(r.Context(), workspaceID, userID, model.WorkspaceGrantSourceManual, model.WorkspaceGrantSourceRefManual); err != nil {
			log.Error("delete manual workspace member grant", zap.Error(err), zap.String("workspace_id", workspaceID), zap.String("user_id", userID))
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// GetAccessPolicy lists the workspace access policy rules for a workspace.
func GetAccessPolicy(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		if _, err := s.GetWorkspace(r.Context(), companyID, workspaceID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if !isCompanyAdminOrWorkspaceAdmin(s, w, r, companyID, workspaceID) {
			return
		}
		rules, err := s.ListWorkspaceAccessPolicyRules(r.Context(), workspaceID)
		if err != nil {
			log.Error("list workspace access policy rules", zap.Error(err), zap.String("workspace_id", workspaceID))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list workspace access policy")
			return
		}
		if rules == nil {
			rules = []model.WorkspaceAccessPolicyRule{}
		}
		respond(w, http.StatusOK, map[string]any{"rules": rules})
	}
}

// PutAccessPolicy replaces the workspace access policy rules and reconciles effective access.
func PutAccessPolicy(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		workspaceID := chi.URLParam(r, "workspaceID")
		if _, err := s.GetWorkspace(r.Context(), companyID, workspaceID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if !isCompanyAdminOrWorkspaceAdmin(s, w, r, companyID, workspaceID) {
			return
		}

		var req struct {
			Rules []model.WorkspaceAccessPolicyRuleInput `json:"rules"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		seen := make(map[string]struct{}, len(req.Rules))
		for idx := range req.Rules {
			rule := &req.Rules[idx]
			if rule.GroupID != nil && *rule.GroupID == "" {
				rule.GroupID = nil
			}
			if !isValidWorkspaceRole(rule.Role) {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", "each rule must include a valid role")
				return
			}
			switch rule.MatchKind {
			case model.WorkspaceAccessPolicyMatchAllCompanyMembers:
				if rule.GroupID != nil {
					respondErr(w, http.StatusUnprocessableEntity, "validation_error", "all_company_members rules must not include group_id")
					return
				}
			case model.WorkspaceAccessPolicyMatchCompanyGroup:
				if rule.GroupID == nil {
					respondErr(w, http.StatusUnprocessableEntity, "validation_error", "company_group rules require group_id")
					return
				}
				group, err := s.GetCompanyGroup(r.Context(), companyID, *rule.GroupID)
				if err != nil {
					handleStoreErr(w, err)
					return
				}
				if model.IsIDPGroupSource(group.SourceType) {
					respondErr(w, http.StatusUnprocessableEntity, "validation_error", "company_group rules must target non-idp groups")
					return
				}
			case model.WorkspaceAccessPolicyMatchIDPGroup:
				if rule.GroupID == nil {
					respondErr(w, http.StatusUnprocessableEntity, "validation_error", "idp_group rules require group_id")
					return
				}
				group, err := s.GetCompanyGroup(r.Context(), companyID, *rule.GroupID)
				if err != nil {
					handleStoreErr(w, err)
					return
				}
				if !model.IsIDPGroupSource(group.SourceType) {
					respondErr(w, http.StatusUnprocessableEntity, "validation_error", "idp_group rules must target idp groups")
					return
				}
			default:
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", "unsupported match_kind")
				return
			}

			key := string(rule.MatchKind) + ":"
			if rule.GroupID != nil {
				key += *rule.GroupID
			}
			if _, ok := seen[key]; ok {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error", "duplicate access-policy rules are not allowed")
				return
			}
			seen[key] = struct{}{}
		}

		claims, _ := ClaimsFromContext(r.Context())
		actorID := ""
		if claims != nil {
			actorID = claims.UserID
		}
		rules, err := s.ReplaceWorkspaceAccessPolicyRules(r.Context(), workspaceID, actorID, req.Rules)
		if err != nil {
			log.Error("replace workspace access policy rules", zap.Error(err), zap.String("workspace_id", workspaceID))
			handleStoreErr(w, err)
			return
		}
		if err := s.ReconcileWorkspacePoliciesForAllCompanyUsers(r.Context(), workspaceID); err != nil {
			log.Error("reconcile workspace access policy rules", zap.Error(err), zap.String("workspace_id", workspaceID))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to reconcile workspace access policy")
			return
		}
		respond(w, http.StatusOK, map[string]any{"rules": rules})
	}
}

func isValidWorkspaceRole(role model.WorkspaceRole) bool {
	switch role {
	case model.RoleWorkspaceAdmin, model.RoleAppBuilder, model.RoleEndUser:
		return true
	default:
		return false
	}
}
