package model

import "testing"

func TestHighestWorkspaceRole(t *testing.T) {
	role, ok := HighestWorkspaceRole([]WorkspaceRole{RoleEndUser, RoleAppBuilder, RoleWorkspaceAdmin})
	if !ok {
		t.Fatal("expected a highest role")
	}
	if role != RoleWorkspaceAdmin {
		t.Fatalf("HighestWorkspaceRole() = %q, want %q", role, RoleWorkspaceAdmin)
	}

	if _, ok := HighestWorkspaceRole(nil); ok {
		t.Fatal("HighestWorkspaceRole(nil) should report no role")
	}
}

func TestWorkspacePolicyGrantSourceRef(t *testing.T) {
	groupID := "group-123"
	tests := []struct {
		name      string
		matchKind WorkspaceAccessPolicyMatchKind
		groupID   *string
		want      string
	}{
		{name: "all company members", matchKind: WorkspaceAccessPolicyMatchAllCompanyMembers, want: "all_company_members"},
		{name: "company group", matchKind: WorkspaceAccessPolicyMatchCompanyGroup, groupID: &groupID, want: "company_group:group-123"},
		{name: "idp group", matchKind: WorkspaceAccessPolicyMatchIDPGroup, groupID: &groupID, want: "idp_group:group-123"},
	}

	for _, tt := range tests {
		if got := WorkspacePolicyGrantSourceRef(tt.matchKind, tt.groupID); got != tt.want {
			t.Fatalf("%s: WorkspacePolicyGrantSourceRef() = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestCompanyGroupSourceHelpers(t *testing.T) {
	if !IsIDPGroupSource(CompanyGroupSourceIDP) {
		t.Fatal("expected idp groups to be treated as idp-managed")
	}
	if !IsIDPGroupSource(CompanyGroupSourceLegacyExternal) {
		t.Fatal("expected legacy external groups to be treated as idp-managed")
	}
	if IsIDPGroupSource(CompanyGroupSourceManual) {
		t.Fatal("manual groups must not be treated as idp-managed")
	}

	for _, source := range []string{CompanyGroupSourceCompanySynthetic, CompanyGroupSourceWorkspaceSync, CompanyGroupSourceIDP, CompanyGroupSourceLegacyExternal} {
		if !IsReadOnlyCompanyGroupSource(source) {
			t.Fatalf("expected %q to be read-only", source)
		}
	}
	if IsReadOnlyCompanyGroupSource(CompanyGroupSourceManual) {
		t.Fatal("manual groups must remain editable")
	}
}
