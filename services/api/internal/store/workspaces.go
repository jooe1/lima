package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// ListWorkspaces returns all workspaces belonging to a company.
func (s *Store) ListWorkspaces(ctx context.Context, companyID string) ([]model.Workspace, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, company_id, name, slug, created_at, updated_at
		 FROM workspaces WHERE company_id = $1 ORDER BY created_at`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer rows.Close()
	var wss []model.Workspace
	for rows.Next() {
		var ws model.Workspace
		if err := rows.Scan(&ws.ID, &ws.CompanyID, &ws.Name, &ws.Slug, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list workspaces scan: %w", err)
		}
		wss = append(wss, ws)
	}
	return wss, rows.Err()
}

// GetWorkspace returns the workspace with the given ID, scoped to a company.
func (s *Store) GetWorkspace(ctx context.Context, companyID, workspaceID string) (*model.Workspace, error) {
	ws := &model.Workspace{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, company_id, name, slug, created_at, updated_at
		 FROM workspaces WHERE id = $1 AND company_id = $2`,
		workspaceID, companyID,
	).Scan(&ws.ID, &ws.CompanyID, &ws.Name, &ws.Slug, &ws.CreatedAt, &ws.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace: %w", err)
	}
	return ws, nil
}

// GetWorkspaceByID returns a workspace by its ID without company scoping.
// Used internally when the company context is not available from the URL.
func (s *Store) GetWorkspaceByID(ctx context.Context, workspaceID string) (*model.Workspace, error) {
	ws := &model.Workspace{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, company_id, name, slug, created_at, updated_at
		 FROM workspaces WHERE id = $1`,
		workspaceID,
	).Scan(&ws.ID, &ws.CompanyID, &ws.Name, &ws.Slug, &ws.CreatedAt, &ws.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by id: %w", err)
	}
	return ws, nil
}

// CreateWorkspace inserts a new workspace and returns it.
func (s *Store) CreateWorkspace(ctx context.Context, companyID, name, slug string) (*model.Workspace, error) {
	ws := &model.Workspace{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO workspaces (company_id, name, slug)
		 VALUES ($1, $2, $3)
		 RETURNING id, company_id, name, slug, created_at, updated_at`,
		companyID, name, slug,
	).Scan(&ws.ID, &ws.CompanyID, &ws.Name, &ws.Slug, &ws.CreatedAt, &ws.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("create workspace: %w", err)
	}
	return ws, nil
}

// ListMembers returns all members of a workspace with their user details.
func (s *Store) ListMembers(ctx context.Context, workspaceID string) ([]model.MemberDetail, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT wm.user_id, wm.workspace_id, u.email, u.name, wm.role, wm.created_at
		 FROM workspace_members wm
		 JOIN users u ON u.id = wm.user_id
		 WHERE wm.workspace_id = $1
		 ORDER BY wm.created_at`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	defer rows.Close()
	var members []model.MemberDetail
	for rows.Next() {
		var m model.MemberDetail
		if err := rows.Scan(&m.UserID, &m.WorkspaceID, &m.Email, &m.Name, &m.Role, &m.JoinedAt); err != nil {
			return nil, fmt.Errorf("list members scan: %w", err)
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// GetMemberRole returns the role of userID in workspaceID.
// Returns ErrNotFound if the user is not a member.
func (s *Store) GetMemberRole(ctx context.Context, workspaceID, userID string) (model.WorkspaceRole, error) {
	var role model.WorkspaceRole
	err := s.pool.QueryRow(ctx,
		`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get member role: %w", err)
	}
	return role, nil
}

// EnsureMember adds the user to the workspace with the given role if they are
// not already a member; if they are, updates their role.
func (s *Store) EnsureMember(ctx context.Context, workspaceID, userID string, role model.WorkspaceRole) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
		workspaceID, userID, role,
	)
	if err != nil {
		return fmt.Errorf("ensure member: %w", err)
	}
	return nil
}
