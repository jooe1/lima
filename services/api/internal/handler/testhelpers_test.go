package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
)

const testJWTSecret = "test-signing-key-for-handler-tests-only"

// getRoleFn mirrors the signature of (*store.Store).GetMemberRole so that
// test routers can inject any membership scenario without a live database.
type getRoleFn func(ctx context.Context, workspaceID, userID string) (model.WorkspaceRole, error)

// makeTestJWT mints a signed HS256 JWT with the given userID and companyID.
// The token is valid for one hour and uses testJWTSecret.
func makeTestJWT(t *testing.T, userID, companyID string) string {
	t.Helper()
	c := &Claims{
		UserID:    userID,
		CompanyID: companyID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	signed, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("makeTestJWT: %v", err)
	}
	return signed
}

// okHandler is a stub that always responds 200 OK.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

// testRequireWorkspaceRole is the test double for the production
// RequireWorkspaceRole middleware.  It implements the IDENTICAL enforcement
// logic — claims extraction, workspaceID URL param, role lookup, hierarchy
// check — but accepts a getRoleFn instead of *store.Store, enabling tests
// without a live database.
func testRequireWorkspaceRole(getRole getRoleFn, minimum model.WorkspaceRole) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok {
				respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
				return
			}
			workspaceID := chi.URLParam(r, "workspaceID")
			if workspaceID == "" {
				// No workspaceID → skip workspace RBAC (mirrors production behaviour).
				next.ServeHTTP(w, r)
				return
			}
			role, err := getRole(r.Context(), workspaceID, claims.UserID)
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

// staticRole returns a getRoleFn that always grants the given role regardless
// of workspace or user ID — simulates a workspace member with a fixed role.
func staticRole(role model.WorkspaceRole) getRoleFn {
	return func(_ context.Context, _, _ string) (model.WorkspaceRole, error) {
		return role, nil
	}
}

// nonMember returns a getRoleFn that always returns store.ErrNotFound,
// simulating a user who is not a member of the requested workspace.
func nonMember() getRoleFn {
	return func(_ context.Context, _, _ string) (model.WorkspaceRole, error) {
		return "", store.ErrNotFound
	}
}

// buildRBACTestRouter builds a minimal chi router that mirrors the production
// workspace-scoped route structure from router/router.go.  Role enforcement
// uses testRequireWorkspaceRole; Authenticate uses testJWTSecret.
func buildRBACTestRouter(t *testing.T, getRole getRoleFn) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Use(Authenticate(testJWTSecret))

	r.Route("/workspaces/{workspaceID}", func(r chi.Router) {
		r.Use(testRequireWorkspaceRole(getRole, model.RoleEndUser))

		// Apps (draft/publish lifecycle)
		r.Route("/apps", func(r chi.Router) {
			r.Get("/", okHandler)
			r.With(testRequireWorkspaceRole(getRole, model.RoleAppBuilder)).Post("/", okHandler)
			r.Route("/{appID}", func(r chi.Router) {
				r.Get("/", okHandler)
				r.With(testRequireWorkspaceRole(getRole, model.RoleWorkspaceAdmin)).Post("/publish", okHandler)
				r.Get("/published", okHandler)
				r.With(testRequireWorkspaceRole(getRole, model.RoleAppBuilder)).Get("/preview", okHandler)
			})
		})

		// Connectors — create/patch/delete require workspace_admin
		r.Route("/connectors", func(r chi.Router) {
			r.Get("/", okHandler)
			r.With(testRequireWorkspaceRole(getRole, model.RoleWorkspaceAdmin)).Post("/", okHandler)
		})

		// Approvals — approve/reject require workspace_admin
		r.Route("/approvals", func(r chi.Router) {
			r.Get("/", okHandler)
			r.Post("/", okHandler) // CreateApproval: any workspace member
			r.Route("/{approvalID}", func(r chi.Router) {
				r.With(testRequireWorkspaceRole(getRole, model.RoleWorkspaceAdmin)).Post("/approve", okHandler)
				r.With(testRequireWorkspaceRole(getRole, model.RoleWorkspaceAdmin)).Post("/reject", okHandler)
			})
		})
	})

	return r
}

// doRequest fires an HTTP request at h and returns the response status code.
func doRequest(t *testing.T, h http.Handler, method, path, token string) int {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code
}
