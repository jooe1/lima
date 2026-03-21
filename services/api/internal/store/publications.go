package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const pubCols = `id, app_id, app_version_id, workspace_id, company_id, status, published_by, policy_profile_id, runtime_identity_id, created_at, updated_at`

func scanPublication(row pgx.Row) (*model.AppPublication, error) {
	p := &model.AppPublication{}
	err := row.Scan(
		&p.ID, &p.AppID, &p.AppVersionID, &p.WorkspaceID, &p.CompanyID,
		&p.Status, &p.PublishedBy, &p.PolicyProfileID, &p.RuntimeIdentityID,
		&p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// CreatePublication creates a new app publication record with audience groups.
// The insert and audience rows are wrapped in a single transaction.
func (s *Store) CreatePublication(ctx context.Context, appID, appVersionID, workspaceID, companyID, publishedBy string, audiences []model.AppPublicationAudience) (*model.AppPublication, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("create publication begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	p := &model.AppPublication{}
	err = tx.QueryRow(ctx,
		`INSERT INTO app_publications (app_id, app_version_id, workspace_id, company_id, published_by)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING `+pubCols,
		appID, appVersionID, workspaceID, companyID, publishedBy,
	).Scan(
		&p.ID, &p.AppID, &p.AppVersionID, &p.WorkspaceID, &p.CompanyID,
		&p.Status, &p.PublishedBy, &p.PolicyProfileID, &p.RuntimeIdentityID,
		&p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create publication insert: %w", err)
	}

	for _, a := range audiences {
		_, err = tx.Exec(ctx,
			`INSERT INTO app_publication_audiences (publication_id, group_id, capability)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			p.ID, a.GroupID, a.Capability,
		)
		if err != nil {
			return nil, fmt.Errorf("create publication audience: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("create publication commit: %w", err)
	}
	return p, nil
}

// ListPublications returns all active publications for an app, newest first.
func (s *Store) ListPublications(ctx context.Context, appID string) ([]model.AppPublication, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+pubCols+` FROM app_publications
		 WHERE app_id = $1 AND status = 'active'
		 ORDER BY created_at DESC`,
		appID,
	)
	if err != nil {
		return nil, fmt.Errorf("list publications: %w", err)
	}
	defer rows.Close()

	var out []model.AppPublication
	for rows.Next() {
		p := model.AppPublication{}
		if err := rows.Scan(
			&p.ID, &p.AppID, &p.AppVersionID, &p.WorkspaceID, &p.CompanyID,
			&p.Status, &p.PublishedBy, &p.PolicyProfileID, &p.RuntimeIdentityID,
			&p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list publications scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetPublication returns a publication by ID with company enforcement.
func (s *Store) GetPublication(ctx context.Context, companyID, publicationID string) (*model.AppPublication, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+pubCols+` FROM app_publications
		 WHERE id = $1 AND company_id = $2`,
		publicationID, companyID,
	)
	p, err := scanPublication(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get publication: %w", err)
	}
	return p, nil
}

// ArchivePublication sets a publication status to archived.
func (s *Store) ArchivePublication(ctx context.Context, companyID, publicationID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE app_publications SET status = 'archived', updated_at = now()
		 WHERE id = $1 AND company_id = $2 AND status != 'archived'`,
		publicationID, companyID,
	)
	if err != nil {
		return fmt.Errorf("archive publication: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListPublicationAudiences returns the audiences for a publication.
func (s *Store) ListPublicationAudiences(ctx context.Context, publicationID string) ([]model.AppPublicationAudience, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT publication_id, group_id, capability
		 FROM app_publication_audiences
		 WHERE publication_id = $1`,
		publicationID,
	)
	if err != nil {
		return nil, fmt.Errorf("list publication audiences: %w", err)
	}
	defer rows.Close()

	var out []model.AppPublicationAudience
	for rows.Next() {
		a := model.AppPublicationAudience{}
		if err := rows.Scan(&a.PublicationID, &a.GroupID, &a.Capability); err != nil {
			return nil, fmt.Errorf("list publication audiences scan: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListCompanyPublishedTools returns all active publications visible to a user
// through their group memberships. Used for company-scoped tool discovery.
func (s *Store) ListCompanyPublishedTools(ctx context.Context, companyID, userID string) ([]model.AppPublication, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+pubCols+`
		 FROM app_publications
		 WHERE company_id = $1
		   AND status = 'active'
		   AND id IN (
		       SELECT DISTINCT apa.publication_id
		       FROM app_publication_audiences apa
		       JOIN group_memberships gm ON gm.group_id = apa.group_id AND gm.user_id = $2
		       WHERE apa.capability = 'use'
		   )
		 ORDER BY created_at DESC`,
		companyID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list company published tools: %w", err)
	}
	defer rows.Close()

	var out []model.AppPublication
	for rows.Next() {
		p := model.AppPublication{}
		if err := rows.Scan(
			&p.ID, &p.AppID, &p.AppVersionID, &p.WorkspaceID, &p.CompanyID,
			&p.Status, &p.PublishedBy, &p.PolicyProfileID, &p.RuntimeIdentityID,
			&p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list company published tools scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
