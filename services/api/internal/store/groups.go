package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const companyGroupCols = `id, company_id, name, slug, source_type, external_ref, managed_by, created_at, updated_at`

func scanCompanyGroup(row pgx.Row) (*model.CompanyGroup, error) {
	g := &model.CompanyGroup{}
	err := row.Scan(
		&g.ID, &g.CompanyID, &g.Name, &g.Slug, &g.SourceType,
		&g.ExternalRef, &g.ManagedBy, &g.CreatedAt, &g.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// ListCompanyGroups returns all groups for a company.
func (s *Store) ListCompanyGroups(ctx context.Context, companyID string) ([]model.CompanyGroup, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+companyGroupCols+` FROM company_groups WHERE company_id = $1 ORDER BY name`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list company groups: %w", err)
	}
	defer rows.Close()

	var out []model.CompanyGroup
	for rows.Next() {
		g := model.CompanyGroup{}
		if err := rows.Scan(
			&g.ID, &g.CompanyID, &g.Name, &g.Slug, &g.SourceType,
			&g.ExternalRef, &g.ManagedBy, &g.CreatedAt, &g.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list company groups scan: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetCompanyGroup returns a single group by ID with company enforcement.
func (s *Store) GetCompanyGroup(ctx context.Context, companyID, groupID string) (*model.CompanyGroup, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+companyGroupCols+` FROM company_groups WHERE id = $1 AND company_id = $2`,
		groupID, companyID,
	)
	g, err := scanCompanyGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get company group: %w", err)
	}
	return g, nil
}

// CreateCompanyGroup inserts a new group. Returns the created group.
func (s *Store) CreateCompanyGroup(ctx context.Context, companyID, name, slug, sourceType string, externalRef, managedBy *string) (*model.CompanyGroup, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO company_groups (company_id, name, slug, source_type, external_ref, managed_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+companyGroupCols,
		companyID, name, slug, sourceType, externalRef, managedBy,
	)
	g, err := scanCompanyGroup(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("create company group: %w", err)
	}
	return g, nil
}

func (s *Store) FindCompanyAllEmployeesGroup(ctx context.Context, companyID string) (*model.CompanyGroup, error) {
	return findCompanyAllEmployeesGroup(ctx, s.pool, companyID)
}

func (s *Store) EnsureCompanyAllEmployeesGroup(ctx context.Context, companyID string) (*model.CompanyGroup, error) {
	return ensureCompanyAllEmployeesGroup(ctx, s.pool, companyID)
}

func (s *Store) FindWorkspaceSyncGroup(ctx context.Context, workspaceID string) (*model.CompanyGroup, error) {
	return findWorkspaceSyncGroup(ctx, s.pool, workspaceID)
}

func (s *Store) EnsureWorkspaceSyncGroup(ctx context.Context, workspaceID string) (*model.CompanyGroup, error) {
	return ensureWorkspaceSyncGroup(ctx, s.pool, workspaceID)
}

// DeleteCompanyGroup deletes a group by ID, enforcing company ownership.
func (s *Store) DeleteCompanyGroup(ctx context.Context, companyID, groupID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM company_groups WHERE id = $1 AND company_id = $2`,
		groupID, companyID,
	)
	if err != nil {
		return fmt.Errorf("delete company group: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListGroupMembers returns user IDs in a group.
func (s *Store) ListGroupMembers(ctx context.Context, groupID string) ([]model.GroupMembership, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT group_id, user_id, joined_at FROM group_memberships WHERE group_id = $1 ORDER BY joined_at`,
		groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("list group members: %w", err)
	}
	defer rows.Close()

	var out []model.GroupMembership
	for rows.Next() {
		var m model.GroupMembership
		if err := rows.Scan(&m.GroupID, &m.UserID, &m.JoinedAt); err != nil {
			return nil, fmt.Errorf("list group members scan: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddGroupMember adds a user to a group. Ignores if already a member.
func (s *Store) AddGroupMember(ctx context.Context, groupID, userID string) error {
	return addGroupMember(ctx, s.pool, groupID, userID)
}

// RemoveGroupMember removes a user from a group.
func (s *Store) RemoveGroupMember(ctx context.Context, groupID, userID string) error {
	return removeGroupMember(ctx, s.pool, groupID, userID)
}

func findCompanyAllEmployeesGroup(ctx context.Context, q dbtx, companyID string) (*model.CompanyGroup, error) {
	row := q.QueryRow(ctx,
		`SELECT `+companyGroupCols+`
		 FROM company_groups
		 WHERE company_id = $1 AND source_type = $2 AND slug = $3`,
		companyID, model.CompanyGroupSourceCompanySynthetic, model.CompanyAllEmployeesGroupSlug,
	)
	g, err := scanCompanyGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find company all employees group: %w", err)
	}
	return g, nil
}

func ensureCompanyAllEmployeesGroup(ctx context.Context, q dbtx, companyID string) (*model.CompanyGroup, error) {
	row := q.QueryRow(ctx,
		`INSERT INTO company_groups (company_id, name, slug, source_type, external_ref)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (company_id, slug) DO UPDATE
		 SET name = EXCLUDED.name,
		     source_type = EXCLUDED.source_type,
		     external_ref = EXCLUDED.external_ref,
		     updated_at = now()
		 RETURNING `+companyGroupCols,
		companyID,
		model.CompanyAllEmployeesGroupName,
		model.CompanyAllEmployeesGroupSlug,
		model.CompanyGroupSourceCompanySynthetic,
		"all-employees",
	)
	g, err := scanCompanyGroup(row)
	if err != nil {
		return nil, fmt.Errorf("ensure company all employees group: %w", err)
	}
	return g, nil
}

func findWorkspaceSyncGroup(ctx context.Context, q dbtx, workspaceID string) (*model.CompanyGroup, error) {
	row := q.QueryRow(ctx,
		`SELECT `+companyGroupCols+`
		 FROM company_groups
		 WHERE source_type = $1 AND external_ref = $2
		 LIMIT 1`,
		model.CompanyGroupSourceWorkspaceSync,
		workspaceID,
	)
	g, err := scanCompanyGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find workspace sync group: %w", err)
	}
	return g, nil
}

func ensureWorkspaceSyncGroup(ctx context.Context, q dbtx, workspaceID string) (*model.CompanyGroup, error) {
	row := q.QueryRow(ctx,
		`INSERT INTO company_groups (company_id, name, slug, source_type, external_ref)
		 SELECT w.company_id,
		        'Workspace: ' || w.name,
		        'ws-' || REPLACE(w.id::text, '-', ''),
		        $2,
		        w.id::text
		 FROM workspaces w
		 WHERE w.id = $1
		 ON CONFLICT (company_id, slug) DO UPDATE
		 SET name = EXCLUDED.name,
		     source_type = EXCLUDED.source_type,
		     external_ref = EXCLUDED.external_ref,
		     updated_at = now()
		 RETURNING `+companyGroupCols,
		workspaceID,
		model.CompanyGroupSourceWorkspaceSync,
	)
	g, err := scanCompanyGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("ensure workspace sync group: %w", err)
	}
	return g, nil
}

func addGroupMember(ctx context.Context, q dbtx, groupID, userID string) error {
	valid, err := groupUserCompanyMatch(ctx, q, groupID, userID)
	if err != nil {
		return err
	}
	if !valid {
		return ErrNotFound
	}
	_, err = q.Exec(ctx,
		`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		groupID, userID,
	)
	if err != nil {
		return fmt.Errorf("add group member: %w", err)
	}
	return nil
}

func removeGroupMember(ctx context.Context, q dbtx, groupID, userID string) error {
	valid, err := groupUserCompanyMatch(ctx, q, groupID, userID)
	if err != nil {
		return err
	}
	if !valid {
		return ErrNotFound
	}
	_, err = q.Exec(ctx,
		`DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	)
	if err != nil {
		return fmt.Errorf("remove group member: %w", err)
	}
	return nil
}

func groupUserCompanyMatch(ctx context.Context, q dbtx, groupID, userID string) (bool, error) {
	var valid bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM company_groups cg
			JOIN users u ON u.company_id = cg.company_id
			WHERE cg.id = $1 AND u.id = $2
		)`,
		groupID, userID,
	).Scan(&valid)
	if err != nil {
		return false, fmt.Errorf("validate group membership company scope: %w", err)
	}
	return valid, nil
}
