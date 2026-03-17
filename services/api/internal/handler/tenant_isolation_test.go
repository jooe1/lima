package handler

// tenant_isolation_test.go — integration tests for tenancy isolation and
// the published-only runtime access rule.
//
// Coverage:
//   1. RequireCompanyClaim (real production middleware): company-A JWT cannot
//      reach /companies/company-B/... endpoints → 403.
//   2. Workspace non-membership (simulated via nonMember getRoleFn): a user
//      whose JWT is for company-B cannot access a workspace in company-A
//      because GetMemberRole would return ErrNotFound → 403.
//   3. Same-tenant workspace access: a legitimate member gets through (200).
//   4. GET /workspaces/:wid/apps/:id/published returns 404 for a draft app
//      and 200 for a published app (uses real handleStoreErr + respond helpers).
//   5. end_user role can access the /published endpoint (no extra role gate).

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
)

// --------------------------------------------------------------------------
// Test router helpers
// --------------------------------------------------------------------------

// buildTenantTestRouter constructs a router with:
//   - /companies/{companyID}/workspaces protected by the REAL RequireCompanyClaim
//     (production code, no DB needed — it only inspects JWT claims vs URL param)
//   - /workspaces/{workspaceID}/apps protected by testRequireWorkspaceRole
func buildTenantTestRouter(t *testing.T, getRole getRoleFn) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Use(Authenticate(testJWTSecret))

	// Company-scoped routes use the REAL RequireCompanyClaim middleware.
	r.Route("/companies/{companyID}", func(r chi.Router) {
		r.Use(RequireCompanyClaim)
		r.Get("/workspaces", okHandler)
	})

	// Workspace-scoped apps route; role enforcement via test double.
	r.Route("/workspaces/{workspaceID}/apps", func(r chi.Router) {
		r.Use(testRequireWorkspaceRole(getRole, model.RoleEndUser))
		r.Get("/", okHandler)
	})

	return r
}

// testPublishedHandler mirrors the GetPublishedApp handler using an injectable
// function instead of *store.Store.  It uses the real handleStoreErr and
// respond helpers from the handler package so the error-to-status mapping is
// identical to production code.
func testPublishedHandler(
	getPublished func(ctx context.Context, workspaceID, appID string) (*model.AppVersion, error),
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wsID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		v, err := getPublished(r.Context(), wsID, appID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, v)
	}
}

// buildPublishedTestRouter creates a router that exposes the /published
// endpoint using the provided handler, gated by testRequireWorkspaceRole at
// end_user level.
func buildPublishedTestRouter(t *testing.T, getRole getRoleFn, published http.HandlerFunc) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Use(Authenticate(testJWTSecret))
	r.Route("/workspaces/{workspaceID}", func(r chi.Router) {
		r.Use(testRequireWorkspaceRole(getRole, model.RoleEndUser))
		r.Route("/apps/{appID}", func(r chi.Router) {
			r.Get("/published", published)
		})
	})
	return r
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

// TestTenantIsolation_CompanyClaim verifies that RequireCompanyClaim (real
// production middleware) blocks a company-A JWT from accessing a company-B URL
// and permits access to the correct company URL.
func TestTenantIsolation_CompanyClaim(t *testing.T) {
	companyAJWT := makeTestJWT(t, "user-a", "company-A")
	h := buildTenantTestRouter(t, staticRole(model.RoleEndUser))

	// Cross-tenant: JWT company-A → URL company-B  →  403.
	if got := doRequest(t, h, "GET", "/companies/company-B/workspaces", companyAJWT); got != http.StatusForbidden {
		t.Errorf("cross-tenant /companies/company-B with company-A JWT = %d, want 403", got)
	}

	// Same-tenant: JWT company-A → URL company-A  →  200.
	if got := doRequest(t, h, "GET", "/companies/company-A/workspaces", companyAJWT); got != http.StatusOK {
		t.Errorf("same-tenant /companies/company-A with company-A JWT = %d, want 200", got)
	}
}

// TestTenantIsolation_CompanyClaim_BothDirections confirms that company-B JWT
// is likewise blocked from company-A and allowed on company-B.
func TestTenantIsolation_CompanyClaim_BothDirections(t *testing.T) {
	companyBJWT := makeTestJWT(t, "user-b", "company-B")
	h := buildTenantTestRouter(t, staticRole(model.RoleEndUser))

	if got := doRequest(t, h, "GET", "/companies/company-A/workspaces", companyBJWT); got != http.StatusForbidden {
		t.Errorf("company-B JWT → company-A URL = %d, want 403", got)
	}
	if got := doRequest(t, h, "GET", "/companies/company-B/workspaces", companyBJWT); got != http.StatusOK {
		t.Errorf("company-B JWT → company-B URL = %d, want 200", got)
	}
}

// TestTenantIsolation_CrossTenantWorkspace verifies that a user (company-B)
// who is NOT a member of a workspace (belonging to company-A) cannot reach the
// workspace apps endpoint.  Enforcement happens via GetMemberRole → ErrNotFound
// in production; here we use nonMember() to inject that exact error.
func TestTenantIsolation_CrossTenantWorkspace(t *testing.T) {
	token := makeTestJWT(t, "user-b", "company-B")
	h := buildTenantTestRouter(t, nonMember())

	if got := doRequest(t, h, "GET", "/workspaces/ws-company-A/apps", token); got != http.StatusForbidden {
		t.Errorf("non-member GET /workspaces/ws-company-A/apps = %d, want 403", got)
	}
}

// TestTenantIsolation_SameTenantWorkspace verifies that a legitimate workspace
// member can reach the workspace apps endpoint (200, not 403).
func TestTenantIsolation_SameTenantWorkspace(t *testing.T) {
	token := makeTestJWT(t, "user-a", "company-A")
	h := buildTenantTestRouter(t, staticRole(model.RoleEndUser))

	if got := doRequest(t, h, "GET", "/workspaces/ws-company-A/apps", token); got != http.StatusOK {
		t.Errorf("same-tenant member GET /workspaces/ws-company-A/apps = %d, want 200", got)
	}
}

// TestPublishedOnlyRuntime_DraftReturns404 verifies that the /published
// endpoint returns 404 when the app has no published version (draft state).
// This uses the real handleStoreErr helper so the store.ErrNotFound → 404
// mapping is exercised through production code.
func TestPublishedOnlyRuntime_DraftReturns404(t *testing.T) {
	published := testPublishedHandler(func(_ context.Context, _, _ string) (*model.AppVersion, error) {
		return nil, store.ErrNotFound // simulates: no published version exists
	})
	token := makeTestJWT(t, "user-eu", "company-1")
	h := buildPublishedTestRouter(t, staticRole(model.RoleEndUser), published)

	if got := doRequest(t, h, "GET", "/workspaces/ws-1/apps/draft-app/published", token); got != http.StatusNotFound {
		t.Errorf("draft app GET /published = %d, want 404", got)
	}
}

// TestPublishedOnlyRuntime_PublishedReturns200 verifies that the /published
// endpoint returns 200 when the app has a published version.
func TestPublishedOnlyRuntime_PublishedReturns200(t *testing.T) {
	published := testPublishedHandler(func(_ context.Context, _, appID string) (*model.AppVersion, error) {
		return &model.AppVersion{
			ID:          "ver-1",
			AppID:       appID,
			VersionNum:  1,
			DSLSource:   "text label hello @ root ;",
			PublishedBy: "user-admin",
			PublishedAt: time.Now(),
		}, nil
	})
	token := makeTestJWT(t, "user-eu", "company-1")
	h := buildPublishedTestRouter(t, staticRole(model.RoleEndUser), published)

	if got := doRequest(t, h, "GET", "/workspaces/ws-1/apps/pub-app/published", token); got != http.StatusOK {
		t.Errorf("published app GET /published = %d, want 200", got)
	}
}

// TestPublishedOnlyRuntime_EndUserCanAccess verifies that end_user role is
// permitted to reach the /published endpoint (no extra role gate on that route
// in the production router — any workspace member may view published apps).
func TestPublishedOnlyRuntime_EndUserCanAccess(t *testing.T) {
	published := testPublishedHandler(func(_ context.Context, _, appID string) (*model.AppVersion, error) {
		return &model.AppVersion{ID: "v1", AppID: appID}, nil
	})
	token := makeTestJWT(t, "user-eu", "company-1")
	h := buildPublishedTestRouter(t, staticRole(model.RoleEndUser), published)

	if got := doRequest(t, h, "GET", "/workspaces/ws-1/apps/app-1/published", token); got != http.StatusOK {
		t.Errorf("end_user GET /published = %d, want 200", got)
	}
}
