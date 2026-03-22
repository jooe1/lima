package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const workspaceMemberGrantCols = `id, workspace_id, user_id, role, grant_source, source_ref, created_by, created_at, updated_at`
const workspaceAccessPolicyRuleCols = `id, workspace_id, match_kind, group_id, role, created_by, created_at, updated_at`

type matchedWorkspacePolicyRule struct {
	Rule      model.WorkspaceAccessPolicyRule
	GroupName *string
}

type workspaceGrantSummary struct {
	UserID      string
	Role        model.WorkspaceRole
	GrantSource model.WorkspaceGrantSource
	SourceRef   string
	MatchKind   *model.WorkspaceAccessPolicyMatchKind
	GroupID     *string
	GroupName   *string
}

func scanWorkspaceMemberGrant(row pgx.Row) (*model.WorkspaceMemberGrant, error) {
	g := &model.WorkspaceMemberGrant{}
	err := row.Scan(
		&g.ID,
		&g.WorkspaceID,
		&g.UserID,
		&g.Role,
		&g.GrantSource,
		&g.SourceRef,
		&g.CreatedBy,
		&g.CreatedAt,
		&g.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return g, nil
}

func scanWorkspaceAccessPolicyRule(row pgx.Row) (*model.WorkspaceAccessPolicyRule, error) {
	r := &model.WorkspaceAccessPolicyRule{}
	err := row.Scan(
		&r.ID,
		&r.WorkspaceID,
		&r.MatchKind,
		&r.GroupID,
		&r.Role,
		&r.CreatedBy,
		&r.CreatedAt,
		&r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (s *Store) UpsertWorkspaceMemberGrant(ctx context.Context, workspaceID, userID string, role model.WorkspaceRole, grantSource model.WorkspaceGrantSource, sourceRef string, createdBy *string) (*model.WorkspaceMemberGrant, error) {
	grant, err := upsertWorkspaceMemberGrant(ctx, s.pool, workspaceID, userID, role, grantSource, sourceRef, createdBy)
	if err != nil {
		return nil, err
	}
	return grant, nil
}

func (s *Store) ApplyWorkspaceMemberGrant(ctx context.Context, workspaceID, userID string, role model.WorkspaceRole, grantSource model.WorkspaceGrantSource, sourceRef string, createdBy *string) (*model.WorkspaceMemberGrant, error) {
	var grant *model.WorkspaceMemberGrant
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		grant, err = upsertWorkspaceMemberGrant(ctx, tx, workspaceID, userID, role, grantSource, sourceRef, createdBy)
		if err != nil {
			return err
		}
		return recomputeWorkspaceMemberAccess(ctx, tx, workspaceID, userID)
	})
	if err != nil {
		return nil, err
	}
	return grant, nil
}

func (s *Store) DeleteWorkspaceMemberGrant(ctx context.Context, workspaceID, userID string, grantSource model.WorkspaceGrantSource, sourceRef string) error {
	return deleteWorkspaceMemberGrant(ctx, s.pool, workspaceID, userID, grantSource, sourceRef)
}

func (s *Store) DeleteWorkspaceMemberGrantAndRecompute(ctx context.Context, workspaceID, userID string, grantSource model.WorkspaceGrantSource, sourceRef string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if err := deleteWorkspaceMemberGrant(ctx, tx, workspaceID, userID, grantSource, sourceRef); err != nil {
			return err
		}
		return recomputeWorkspaceMemberAccess(ctx, tx, workspaceID, userID)
	})
}

func (s *Store) RecomputeWorkspaceMemberAccess(ctx context.Context, workspaceID, userID string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		return recomputeWorkspaceMemberAccess(ctx, tx, workspaceID, userID)
	})
}

func (s *Store) ListWorkspaceAccessPolicyRules(ctx context.Context, workspaceID string) ([]model.WorkspaceAccessPolicyRule, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+workspaceAccessPolicyRuleCols+`
		 FROM workspace_access_policy_rules
		 WHERE workspace_id = $1
		 ORDER BY created_at, id`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list workspace access policy rules: %w", err)
	}
	defer rows.Close()

	var rules []model.WorkspaceAccessPolicyRule
	for rows.Next() {
		rule := model.WorkspaceAccessPolicyRule{}
		if err := rows.Scan(
			&rule.ID,
			&rule.WorkspaceID,
			&rule.MatchKind,
			&rule.GroupID,
			&rule.Role,
			&rule.CreatedBy,
			&rule.CreatedAt,
			&rule.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list workspace access policy rules scan: %w", err)
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func (s *Store) ReplaceWorkspaceAccessPolicyRules(ctx context.Context, workspaceID, actorID string, rules []model.WorkspaceAccessPolicyRuleInput) ([]model.WorkspaceAccessPolicyRule, error) {
	var replaced []model.WorkspaceAccessPolicyRule
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`DELETE FROM workspace_access_policy_rules WHERE workspace_id = $1`,
			workspaceID,
		); err != nil {
			return fmt.Errorf("delete existing workspace access policy rules: %w", err)
		}

		for _, rule := range rules {
			createdBy := any(nil)
			if actorID != "" {
				createdBy = actorID
			}
			inserted, err := scanWorkspaceAccessPolicyRule(tx.QueryRow(ctx,
				`INSERT INTO workspace_access_policy_rules (workspace_id, match_kind, group_id, role, created_by)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING `+workspaceAccessPolicyRuleCols,
				workspaceID,
				rule.MatchKind,
				rule.GroupID,
				rule.Role,
				createdBy,
			))
			if err != nil {
				return fmt.Errorf("insert workspace access policy rule: %w", err)
			}
			replaced = append(replaced, *inserted)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return replaced, nil
}

func (s *Store) ReconcileProvisionedUserAccess(ctx context.Context, companyID, userID string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if err := lockCompany(ctx, tx, companyID); err != nil {
			return err
		}
		if err := ensureUserBelongsToCompany(ctx, tx, companyID, userID); err != nil {
			return err
		}
		if _, err := upsertCompanyRoleBinding(ctx, tx, companyID, "user", userID, "company_member"); err != nil {
			return err
		}
		hasCompanyAdmin, err := companyHasRole(ctx, tx, companyID, "company_admin")
		if err != nil {
			return err
		}
		if !hasCompanyAdmin {
			if _, err := upsertCompanyRoleBinding(ctx, tx, companyID, "user", userID, "company_admin"); err != nil {
				return err
			}
		}

		allEmployeesGroup, err := ensureCompanyAllEmployeesGroup(ctx, tx, companyID)
		if err != nil {
			return err
		}
		if err := addGroupMember(ctx, tx, allEmployeesGroup.ID, userID); err != nil {
			return err
		}

		workspaces, err := listCompanyWorkspaces(ctx, tx, companyID)
		if err != nil {
			return err
		}
		for _, workspace := range workspaces {
			if _, err := ensureWorkspaceSyncGroup(ctx, tx, workspace.ID); err != nil {
				return err
			}
			if err := syncPolicyWorkspaceMemberGrants(ctx, tx, workspace.ID, userID); err != nil {
				return err
			}
			if err := recomputeWorkspaceMemberAccess(ctx, tx, workspace.ID, userID); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) ReconcileWorkspacePoliciesForAllCompanyUsers(ctx context.Context, workspaceID string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		workspace, err := getWorkspaceByID(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		if _, err := ensureWorkspaceSyncGroup(ctx, tx, workspaceID); err != nil {
			return err
		}
		users, err := listCompanyUsers(ctx, tx, workspace.CompanyID)
		if err != nil {
			return err
		}
		for _, user := range users {
			if err := syncPolicyWorkspaceMemberGrants(ctx, tx, workspaceID, user.ID); err != nil {
				return err
			}
			if err := recomputeWorkspaceMemberAccess(ctx, tx, workspaceID, user.ID); err != nil {
				return err
			}
		}
		return nil
	})
}

func upsertWorkspaceMemberGrant(ctx context.Context, q dbtx, workspaceID, userID string, role model.WorkspaceRole, grantSource model.WorkspaceGrantSource, sourceRef string, createdBy *string) (*model.WorkspaceMemberGrant, error) {
	if err := validateWorkspaceUserCompanyMatch(ctx, q, workspaceID, userID); err != nil {
		return nil, err
	}
	row := q.QueryRow(ctx,
		`INSERT INTO workspace_member_grants (workspace_id, user_id, role, grant_source, source_ref, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (workspace_id, user_id, grant_source, source_ref) DO UPDATE
			 SET role = EXCLUDED.role,
			     updated_at = now()
			 RETURNING `+workspaceMemberGrantCols,
		workspaceID,
		userID,
		role,
		grantSource,
		sourceRef,
		createdBy,
	)
	grant, err := scanWorkspaceMemberGrant(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("upsert workspace member grant: %w", err)
	}
	return grant, nil
}

func deleteWorkspaceMemberGrant(ctx context.Context, q dbtx, workspaceID, userID string, grantSource model.WorkspaceGrantSource, sourceRef string) error {
	if err := validateWorkspaceUserCompanyMatch(ctx, q, workspaceID, userID); err != nil {
		return err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM workspace_member_grants
		 WHERE workspace_id = $1 AND user_id = $2 AND grant_source = $3 AND source_ref = $4`,
		workspaceID,
		userID,
		grantSource,
		sourceRef,
	); err != nil {
		return fmt.Errorf("delete workspace member grant: %w", err)
	}
	return nil
}

func recomputeWorkspaceMemberAccess(ctx context.Context, q dbtx, workspaceID, userID string) error {
	group, err := ensureWorkspaceSyncGroup(ctx, q, workspaceID)
	if err != nil {
		return err
	}

	roles, err := listWorkspaceMemberGrantRoles(ctx, q, workspaceID, userID)
	if err != nil {
		return err
	}
	role, ok := model.HighestWorkspaceRole(roles)
	if !ok {
		if _, err := q.Exec(ctx,
			`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
			workspaceID,
			userID,
		); err != nil {
			return fmt.Errorf("delete effective workspace member: %w", err)
		}
		return removeGroupMember(ctx, q, group.ID, userID)
	}

	if _, err := q.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (workspace_id, user_id) DO UPDATE
		 SET role = EXCLUDED.role,
		     updated_at = now()`,
		workspaceID,
		userID,
		role,
	); err != nil {
		return fmt.Errorf("upsert effective workspace member: %w", err)
	}
	return addGroupMember(ctx, q, group.ID, userID)
}

func listWorkspaceMemberGrantRoles(ctx context.Context, q dbtx, workspaceID, userID string) ([]model.WorkspaceRole, error) {
	rows, err := q.Query(ctx,
		`SELECT role
		 FROM workspace_member_grants
		 WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list workspace member grant roles: %w", err)
	}
	defer rows.Close()

	var roles []model.WorkspaceRole
	for rows.Next() {
		var role model.WorkspaceRole
		if err := rows.Scan(&role); err != nil {
			return nil, fmt.Errorf("list workspace member grant roles scan: %w", err)
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func syncPolicyWorkspaceMemberGrants(ctx context.Context, q dbtx, workspaceID, userID string) error {
	matchedRules, err := listMatchedWorkspacePolicyRules(ctx, q, workspaceID, userID)
	if err != nil {
		return err
	}

	allowed := make(map[string]matchedWorkspacePolicyRule, len(matchedRules))
	for _, rule := range matchedRules {
		ref := model.WorkspacePolicyGrantSourceRef(rule.Rule.MatchKind, rule.Rule.GroupID)
		allowed[ref] = rule
	}

	existingPolicyGrants, err := listPolicyWorkspaceMemberGrants(ctx, q, workspaceID, userID)
	if err != nil {
		return err
	}

	for sourceRef := range existingPolicyGrants {
		if _, ok := allowed[sourceRef]; ok {
			continue
		}
		if err := deleteWorkspaceMemberGrant(ctx, q, workspaceID, userID, model.WorkspaceGrantSourcePolicy, sourceRef); err != nil {
			return err
		}
	}

	for sourceRef, matchedRule := range allowed {
		var createdBy *string
		if matchedRule.Rule.CreatedBy != nil {
			createdBy = matchedRule.Rule.CreatedBy
		}
		if _, err := upsertWorkspaceMemberGrant(ctx, q, workspaceID, userID, matchedRule.Rule.Role, model.WorkspaceGrantSourcePolicy, sourceRef, createdBy); err != nil {
			return err
		}
	}
	return nil
}

func listPolicyWorkspaceMemberGrants(ctx context.Context, q dbtx, workspaceID, userID string) (map[string]model.WorkspaceMemberGrant, error) {
	rows, err := q.Query(ctx,
		`SELECT `+workspaceMemberGrantCols+`
		 FROM workspace_member_grants
		 WHERE workspace_id = $1 AND user_id = $2 AND grant_source = $3`,
		workspaceID,
		userID,
		model.WorkspaceGrantSourcePolicy,
	)
	if err != nil {
		return nil, fmt.Errorf("list policy workspace member grants: %w", err)
	}
	defer rows.Close()

	grants := make(map[string]model.WorkspaceMemberGrant)
	for rows.Next() {
		grant := model.WorkspaceMemberGrant{}
		if err := rows.Scan(
			&grant.ID,
			&grant.WorkspaceID,
			&grant.UserID,
			&grant.Role,
			&grant.GrantSource,
			&grant.SourceRef,
			&grant.CreatedBy,
			&grant.CreatedAt,
			&grant.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list policy workspace member grants scan: %w", err)
		}
		grants[grant.SourceRef] = grant
	}
	return grants, rows.Err()
}

func listMatchedWorkspacePolicyRules(ctx context.Context, q dbtx, workspaceID, userID string) ([]matchedWorkspacePolicyRule, error) {
	rows, err := q.Query(ctx,
		`SELECT r.id,
		        r.workspace_id,
		        r.match_kind,
		        r.group_id,
		        r.role,
		        r.created_by,
		        r.created_at,
		        r.updated_at,
		        cg.name
		 FROM workspace_access_policy_rules r
		 LEFT JOIN company_groups cg ON cg.id = r.group_id
		 LEFT JOIN group_memberships gm ON gm.group_id = r.group_id AND gm.user_id = $2
		 WHERE r.workspace_id = $1
		   AND (
				r.match_kind = $3
				OR (r.match_kind = $4 AND gm.user_id IS NOT NULL AND COALESCE(cg.source_type, '') NOT IN ($5, $6))
				OR (r.match_kind = $7 AND gm.user_id IS NOT NULL AND COALESCE(cg.source_type, '') IN ($5, $6))
		   )
		 ORDER BY r.created_at, r.id`,
		workspaceID,
		userID,
		model.WorkspaceAccessPolicyMatchAllCompanyMembers,
		model.WorkspaceAccessPolicyMatchCompanyGroup,
		model.CompanyGroupSourceIDP,
		model.CompanyGroupSourceLegacyExternal,
		model.WorkspaceAccessPolicyMatchIDPGroup,
	)
	if err != nil {
		return nil, fmt.Errorf("list matched workspace policy rules: %w", err)
	}
	defer rows.Close()

	var out []matchedWorkspacePolicyRule
	for rows.Next() {
		item := matchedWorkspacePolicyRule{}
		if err := rows.Scan(
			&item.Rule.ID,
			&item.Rule.WorkspaceID,
			&item.Rule.MatchKind,
			&item.Rule.GroupID,
			&item.Rule.Role,
			&item.Rule.CreatedBy,
			&item.Rule.CreatedAt,
			&item.Rule.UpdatedAt,
			&item.GroupName,
		); err != nil {
			return nil, fmt.Errorf("list matched workspace policy rules scan: %w", err)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func listWorkspaceMemberGrantSummaries(ctx context.Context, q dbtx, workspaceID string) ([]workspaceGrantSummary, error) {
	rows, err := q.Query(ctx,
		`SELECT g.user_id,
		        g.role,
		        g.grant_source,
		        g.source_ref,
		        r.match_kind,
		        r.group_id,
		        cg.name
		 FROM workspace_member_grants g
		 LEFT JOIN workspace_access_policy_rules r
		   ON g.workspace_id = r.workspace_id
		  AND g.grant_source = $2
		  AND (
				(r.match_kind = $3 AND g.source_ref = $3)
				OR (r.group_id IS NOT NULL AND g.source_ref = r.match_kind || ':' || r.group_id::text)
		  )
		 LEFT JOIN company_groups cg ON cg.id = r.group_id
		 WHERE g.workspace_id = $1
		 ORDER BY g.user_id, g.created_at, g.id`,
		workspaceID,
		model.WorkspaceGrantSourcePolicy,
		model.WorkspaceAccessPolicyMatchAllCompanyMembers,
	)
	if err != nil {
		return nil, fmt.Errorf("list workspace member grant summaries: %w", err)
	}
	defer rows.Close()

	var out []workspaceGrantSummary
	for rows.Next() {
		item := workspaceGrantSummary{}
		if err := rows.Scan(
			&item.UserID,
			&item.Role,
			&item.GrantSource,
			&item.SourceRef,
			&item.MatchKind,
			&item.GroupID,
			&item.GroupName,
		); err != nil {
			return nil, fmt.Errorf("list workspace member grant summaries scan: %w", err)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func describeWorkspaceMemberGrant(summary workspaceGrantSummary) model.MemberGrant {
	grant := model.MemberGrant{
		Role:        summary.Role,
		GrantSource: summary.GrantSource,
		SourceRef:   summary.SourceRef,
		MatchKind:   summary.MatchKind,
		GroupID:     summary.GroupID,
		GroupName:   summary.GroupName,
	}

	switch summary.GrantSource {
	case model.WorkspaceGrantSourceManual:
		grant.Explanation = "Granted by manual workspace membership"
	case model.WorkspaceGrantSourceSystemBootstrap:
		grant.Explanation = "Granted by bootstrap workspace creator rule"
	case model.WorkspaceGrantSourceIDP:
		grant.Explanation = "Granted by IdP-managed workspace membership"
	case model.WorkspaceGrantSourcePolicy:
		switch {
		case summary.MatchKind == nil:
			grant.Explanation = fmt.Sprintf("Granted by workspace policy -> %s", summary.Role)
		case *summary.MatchKind == model.WorkspaceAccessPolicyMatchAllCompanyMembers:
			grant.Explanation = fmt.Sprintf("Granted by workspace policy: all_company_members -> %s", summary.Role)
		case summary.GroupName != nil && *summary.GroupName != "":
			grant.Explanation = fmt.Sprintf("Granted by workspace policy: %s %s -> %s", *summary.MatchKind, *summary.GroupName, summary.Role)
		case summary.GroupID != nil:
			grant.Explanation = fmt.Sprintf("Granted by workspace policy: %s %s -> %s", *summary.MatchKind, *summary.GroupID, summary.Role)
		default:
			grant.Explanation = fmt.Sprintf("Granted by workspace policy: %s -> %s", *summary.MatchKind, summary.Role)
		}
	default:
		grant.Explanation = "Granted by workspace membership grant"
	}

	return grant
}

func getWorkspaceByID(ctx context.Context, q dbtx, workspaceID string) (*model.Workspace, error) {
	workspace := &model.Workspace{}
	err := q.QueryRow(ctx,
		`SELECT id, company_id, name, slug, created_at, updated_at
		 FROM workspaces
		 WHERE id = $1`,
		workspaceID,
	).Scan(&workspace.ID, &workspace.CompanyID, &workspace.Name, &workspace.Slug, &workspace.CreatedAt, &workspace.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by id: %w", err)
	}
	return workspace, nil
}

func listCompanyWorkspaces(ctx context.Context, q dbtx, companyID string) ([]model.Workspace, error) {
	rows, err := q.Query(ctx,
		`SELECT id, company_id, name, slug, created_at, updated_at
		 FROM workspaces
		 WHERE company_id = $1
		 ORDER BY created_at, id`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list company workspaces: %w", err)
	}
	defer rows.Close()

	var workspaces []model.Workspace
	for rows.Next() {
		workspace := model.Workspace{}
		if err := rows.Scan(&workspace.ID, &workspace.CompanyID, &workspace.Name, &workspace.Slug, &workspace.CreatedAt, &workspace.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list company workspaces scan: %w", err)
		}
		workspaces = append(workspaces, workspace)
	}
	return workspaces, rows.Err()
}

func listCompanyUsers(ctx context.Context, q dbtx, companyID string) ([]model.User, error) {
	rows, err := q.Query(ctx,
		`SELECT `+userCols+`
		 FROM users
		 WHERE company_id = $1
		 ORDER BY created_at, id`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list company users: %w", err)
	}
	users, err := scanUserRows(rows)
	if err != nil {
		return nil, fmt.Errorf("list company users scan: %w", err)
	}
	return users, nil
}

func lockCompany(ctx context.Context, q dbtx, companyID string) error {
	var lockedID string
	err := q.QueryRow(ctx,
		`SELECT id
		 FROM companies
		 WHERE id = $1
		 FOR UPDATE`,
		companyID,
	).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock company: %w", err)
	}
	return nil
}

func ensureUserBelongsToCompany(ctx context.Context, q dbtx, companyID, userID string) error {
	var exists bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM users
			WHERE id = $1 AND company_id = $2
		)`,
		userID,
		companyID,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("ensure user belongs to company: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func validateWorkspaceUserCompanyMatch(ctx context.Context, q dbtx, workspaceID, userID string) error {
	var matches bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM workspaces w
			JOIN users u ON u.company_id = w.company_id
			WHERE w.id = $1 AND u.id = $2
		)`,
		workspaceID,
		userID,
	).Scan(&matches)
	if err != nil {
		return fmt.Errorf("validate workspace and user company match: %w", err)
	}
	if !matches {
		return ErrNotFound
	}
	return nil
}
