package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const resourceGrantCols = `id, company_id, resource_kind, resource_id, subject_type, subject_id,
       action, scope_json::text, effect, created_by, created_at`

func scanResourceGrant(row pgx.Row) (*model.ResourceGrant, error) {
	g := &model.ResourceGrant{}
	err := row.Scan(
		&g.ID, &g.CompanyID, &g.ResourceKind, &g.ResourceID,
		&g.SubjectType, &g.SubjectID, &g.Action,
		&g.ScopeJSON, &g.Effect, &g.CreatedBy, &g.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// ListResourceGrants returns all grants for a resource.
func (s *Store) ListResourceGrants(ctx context.Context, companyID, resourceKind, resourceID string) ([]model.ResourceGrant, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+resourceGrantCols+`
		 FROM resource_grants
		 WHERE company_id = $1 AND resource_kind = $2 AND resource_id = $3
		 ORDER BY created_at`,
		companyID, resourceKind, resourceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list resource grants: %w", err)
	}
	defer rows.Close()

	var out []model.ResourceGrant
	for rows.Next() {
		g := model.ResourceGrant{}
		if err := rows.Scan(
			&g.ID, &g.CompanyID, &g.ResourceKind, &g.ResourceID,
			&g.SubjectType, &g.SubjectID, &g.Action,
			&g.ScopeJSON, &g.Effect, &g.CreatedBy, &g.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("list resource grants scan: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ListSubjectGrants returns all grants for a subject (e.g. a workspace or user).
func (s *Store) ListSubjectGrants(ctx context.Context, companyID, subjectType, subjectID string) ([]model.ResourceGrant, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+resourceGrantCols+`
		 FROM resource_grants
		 WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3
		 ORDER BY created_at`,
		companyID, subjectType, subjectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list subject grants: %w", err)
	}
	defer rows.Close()

	var out []model.ResourceGrant
	for rows.Next() {
		g := model.ResourceGrant{}
		if err := rows.Scan(
			&g.ID, &g.CompanyID, &g.ResourceKind, &g.ResourceID,
			&g.SubjectType, &g.SubjectID, &g.Action,
			&g.ScopeJSON, &g.Effect, &g.CreatedBy, &g.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("list subject grants scan: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// CreateResourceGrant inserts a new resource grant. Returns the created grant.
func (s *Store) CreateResourceGrant(ctx context.Context, companyID, resourceKind, resourceID, subjectType, subjectID, action string, scopeJSON *string, effect, createdBy string) (*model.ResourceGrant, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO resource_grants
		     (company_id, resource_kind, resource_id, subject_type, subject_id, action, scope_json, effect, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
		 RETURNING `+resourceGrantCols,
		companyID, resourceKind, resourceID, subjectType, subjectID, action, scopeJSON, effect, createdBy,
	)
	g, err := scanResourceGrant(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("create resource grant: %w", err)
	}
	return g, nil
}

// DeleteResourceGrant deletes a grant by ID, enforcing company ownership.
func (s *Store) DeleteResourceGrant(ctx context.Context, companyID, grantID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM resource_grants WHERE id = $1 AND company_id = $2`,
		grantID, companyID,
	)
	if err != nil {
		return fmt.Errorf("delete resource grant: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// HasResourceGrant returns true if the subject has the given action grant on the resource (effect = 'allow').
func (s *Store) HasResourceGrant(ctx context.Context, companyID, resourceKind, resourceID, subjectType, subjectID, action string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (
		     SELECT 1 FROM resource_grants
		     WHERE company_id = $1 AND resource_kind = $2 AND resource_id = $3
		       AND subject_type = $4 AND subject_id = $5 AND action = $6 AND effect = 'allow'
		 )`,
		companyID, resourceKind, resourceID, subjectType, subjectID, action,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has resource grant: %w", err)
	}
	return exists, nil
}
