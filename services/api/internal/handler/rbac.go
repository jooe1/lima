package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// RequireWorkspaceRole is middleware that verifies the caller has at least
// the given role in the {workspaceID} path parameter's workspace.
// Roles are ordered: workspace_admin > app_builder > end_user.
func RequireWorkspaceRole(s *store.Store, log *zap.Logger, minimum model.WorkspaceRole) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok {
				respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
				return
			}
			workspaceID := chi.URLParam(r, "workspaceID")
			if workspaceID == "" {
				// Some routes use appID-scoped lookups; skip workspace RBAC here.
				next.ServeHTTP(w, r)
				return
			}
			role, err := s.GetMemberRole(r.Context(), workspaceID, claims.UserID)
			if err != nil {
				respondErr(w, http.StatusForbidden, "not_a_member", "you are not a member of this workspace")
				return
			}
			if !roleAtLeast(role, minimum) {
				respondErr(w, http.StatusForbidden, "insufficient_role", "your role does not permit this action")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// roleAtLeast returns true when actual >= required in the RBAC hierarchy.
func roleAtLeast(actual, required model.WorkspaceRole) bool {
	order := map[model.WorkspaceRole]int{
		model.RoleEndUser:        1,
		model.RoleAppBuilder:     2,
		model.RoleWorkspaceAdmin: 3,
	}
	return order[actual] >= order[required]
}

// RequireCompanyClaim checks that the {companyID} path param matches the
// company in the JWT, preventing cross-tenant access.
func RequireCompanyClaim(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
			return
		}
		companyID := chi.URLParam(r, "companyID")
		if companyID != "" && companyID != claims.CompanyID {
			respondErr(w, http.StatusForbidden, "wrong_company", "access denied")
			return
		}
		next.ServeHTTP(w, r)
	})
}
