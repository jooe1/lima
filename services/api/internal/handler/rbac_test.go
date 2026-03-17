package handler

// rbac_test.go — integration tests for workspace role enforcement.
//
// Coverage:
//   1. WorkspaceRole hierarchy (roleAtLeast private helper)
//   2. end_user role: blocked on create/publish/approve/reject, allowed on reads
//   3. app_builder role: blocked on publish/approve/reject/create-connector
//   4. workspace_admin role: passes RBAC on every protected endpoint
//   5. Unauthenticated requests: rejected with 401 before reaching RBAC

import (
	"net/http"
	"testing"

	"github.com/lima/api/internal/model"
)

// TestRoleAtLeast verifies the workspace role hierarchy:
// workspace_admin > app_builder > end_user.
func TestRoleAtLeast(t *testing.T) {
	tests := []struct {
		actual   model.WorkspaceRole
		required model.WorkspaceRole
		want     bool
	}{
		// workspace_admin satisfies every level
		{model.RoleWorkspaceAdmin, model.RoleWorkspaceAdmin, true},
		{model.RoleWorkspaceAdmin, model.RoleAppBuilder, true},
		{model.RoleWorkspaceAdmin, model.RoleEndUser, true},
		// app_builder satisfies builder and below
		{model.RoleAppBuilder, model.RoleWorkspaceAdmin, false},
		{model.RoleAppBuilder, model.RoleAppBuilder, true},
		{model.RoleAppBuilder, model.RoleEndUser, true},
		// end_user satisfies only end_user
		{model.RoleEndUser, model.RoleWorkspaceAdmin, false},
		{model.RoleEndUser, model.RoleAppBuilder, false},
		{model.RoleEndUser, model.RoleEndUser, true},
	}
	for _, tc := range tests {
		got := roleAtLeast(tc.actual, tc.required)
		if got != tc.want {
			t.Errorf("roleAtLeast(%s, %s) = %v, want %v",
				tc.actual, tc.required, got, tc.want)
		}
	}
}

// TestEndUserForbiddenEndpoints verifies that the end_user role is blocked on
// all privileged mutation endpoints and permitted on read-only / member-level
// ones (FR-04, FR-15).
func TestEndUserForbiddenEndpoints(t *testing.T) {
	token := makeTestJWT(t, "user-eu", "company-1")
	h := buildRBACTestRouter(t, staticRole(model.RoleEndUser))

	blocked := []struct{ method, path string }{
		{"POST", "/workspaces/ws-1/apps"},                    // requires app_builder+
		{"POST", "/workspaces/ws-1/connectors"},              // requires workspace_admin
		{"POST", "/workspaces/ws-1/apps/app-1/publish"},      // requires workspace_admin
		{"POST", "/workspaces/ws-1/approvals/apv-1/approve"}, // requires workspace_admin
		{"POST", "/workspaces/ws-1/approvals/apv-1/reject"},  // requires workspace_admin
		{"GET", "/workspaces/ws-1/apps/app-1/preview"},       // requires app_builder+
	}
	for _, e := range blocked {
		if got := doRequest(t, h, e.method, e.path, token); got != http.StatusForbidden {
			t.Errorf("end_user %s %s = %d, want 403", e.method, e.path, got)
		}
	}

	allowed := []struct{ method, path string }{
		{"GET", "/workspaces/ws-1/apps"},
		{"GET", "/workspaces/ws-1/apps/app-1"},
		{"GET", "/workspaces/ws-1/apps/app-1/published"},
		{"GET", "/workspaces/ws-1/connectors"},
		{"GET", "/workspaces/ws-1/approvals"},
		{"POST", "/workspaces/ws-1/approvals"}, // CreateApproval: any member
	}
	for _, e := range allowed {
		if got := doRequest(t, h, e.method, e.path, token); got == http.StatusForbidden {
			t.Errorf("end_user %s %s = 403, want not-403", e.method, e.path)
		}
	}
}

// TestAppBuilderForbiddenEndpoints verifies that app_builder is blocked on
// admin-only endpoints (publish, approve, reject, create-connector) but may
// create apps and access read endpoints.
func TestAppBuilderForbiddenEndpoints(t *testing.T) {
	token := makeTestJWT(t, "user-ab", "company-1")
	h := buildRBACTestRouter(t, staticRole(model.RoleAppBuilder))

	blocked := []struct{ method, path string }{
		{"POST", "/workspaces/ws-1/apps/app-1/publish"},      // admin only
		{"POST", "/workspaces/ws-1/connectors"},              // admin only
		{"POST", "/workspaces/ws-1/approvals/apv-1/approve"}, // admin only
		{"POST", "/workspaces/ws-1/approvals/apv-1/reject"},  // admin only
	}
	for _, e := range blocked {
		if got := doRequest(t, h, e.method, e.path, token); got != http.StatusForbidden {
			t.Errorf("app_builder %s %s = %d, want 403", e.method, e.path, got)
		}
	}

	// app_builder CAN create apps.
	if got := doRequest(t, h, "POST", "/workspaces/ws-1/apps", token); got == http.StatusForbidden {
		t.Errorf("app_builder POST /apps = 403, want not-403")
	}
	// app_builder CAN preview drafts.
	if got := doRequest(t, h, "GET", "/workspaces/ws-1/apps/app-1/preview", token); got == http.StatusForbidden {
		t.Errorf("app_builder GET /preview = 403, want not-403")
	}
}

// TestAdminCanCallAllEndpoints verifies that workspace_admin passes RBAC on
// every role-protected route.  Stub handlers return 200 so any non-403 is
// sufficient (production handlers would return 404/422 if resources don't
// exist, which is also acceptable).
func TestAdminCanCallAllEndpoints(t *testing.T) {
	token := makeTestJWT(t, "user-admin", "company-1")
	h := buildRBACTestRouter(t, staticRole(model.RoleWorkspaceAdmin))

	endpoints := []struct{ method, path string }{
		{"GET", "/workspaces/ws-1/apps"},
		{"POST", "/workspaces/ws-1/apps"},
		{"GET", "/workspaces/ws-1/apps/app-1"},
		{"POST", "/workspaces/ws-1/apps/app-1/publish"},
		{"GET", "/workspaces/ws-1/apps/app-1/published"},
		{"GET", "/workspaces/ws-1/apps/app-1/preview"},
		{"GET", "/workspaces/ws-1/connectors"},
		{"POST", "/workspaces/ws-1/connectors"},
		{"GET", "/workspaces/ws-1/approvals"},
		{"POST", "/workspaces/ws-1/approvals"},
		{"POST", "/workspaces/ws-1/approvals/apv-1/approve"},
		{"POST", "/workspaces/ws-1/approvals/apv-1/reject"},
	}
	for _, e := range endpoints {
		if got := doRequest(t, h, e.method, e.path, token); got == http.StatusForbidden {
			t.Errorf("workspace_admin %s %s = 403, want not-403", e.method, e.path)
		}
	}
}

// TestUnauthenticatedRequestsRejected verifies that the Authenticate middleware
// returns 401 before RBAC is ever evaluated when no JWT is supplied.
func TestUnauthenticatedRequestsRejected(t *testing.T) {
	h := buildRBACTestRouter(t, staticRole(model.RoleEndUser))

	for _, e := range []struct{ method, path string }{
		{"GET", "/workspaces/ws-1/apps"},
		{"POST", "/workspaces/ws-1/apps"},
		{"POST", "/workspaces/ws-1/apps/app-1/publish"},
	} {
		if got := doRequest(t, h, e.method, e.path, ""); got != http.StatusUnauthorized {
			t.Errorf("no-JWT %s %s = %d, want 401", e.method, e.path, got)
		}
	}
}
