package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// GetUser returns the user with the given ID.
func (s *Store) GetUser(ctx context.Context, userID string) (*model.User, error) {
	u := &model.User{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, company_id, email, name, sso_subject, created_at, updated_at
		 FROM users WHERE id = $1`,
		userID,
	).Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	return u, nil
}

// FindUserByEmail looks up a user by company + email.
func (s *Store) FindUserByEmail(ctx context.Context, companyID, email string) (*model.User, error) {
	u := &model.User{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, company_id, email, name, sso_subject, created_at, updated_at
		 FROM users WHERE company_id = $1 AND email = $2`,
		companyID, email,
	).Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find user by email: %w", err)
	}
	return u, nil
}

// FindUserBySSO looks up a user by the IdP subject identifier.
func (s *Store) FindUserBySSO(ctx context.Context, ssoSubject string) (*model.User, error) {
	u := &model.User{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, company_id, email, name, sso_subject, created_at, updated_at
		 FROM users WHERE sso_subject = $1`,
		ssoSubject,
	).Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find user by sso: %w", err)
	}
	return u, nil
}

// UpsertUserSSO creates or updates a user identified by their SSO subject.
// If the user exists (matched by company + email), the sso_subject is stored.
// If the user does not exist, it is created.
func (s *Store) UpsertUserSSO(ctx context.Context, companyID, email, name, ssoSubject string) (*model.User, error) {
	u := &model.User{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users (company_id, email, name, sso_subject)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (company_id, email) DO UPDATE
		   SET name = EXCLUDED.name,
		       sso_subject = EXCLUDED.sso_subject,
		       updated_at = now()
		 RETURNING id, company_id, email, name, sso_subject, created_at, updated_at`,
		companyID, email, name, ssoSubject,
	).Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("upsert user sso: %w", err)
	}
	return u, nil
}

// CreateUser inserts a new user (used in dev-login path).
func (s *Store) CreateUser(ctx context.Context, companyID, email, name string) (*model.User, error) {
	u := &model.User{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users (company_id, email, name)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (company_id, email) DO UPDATE
		   SET name = EXCLUDED.name, updated_at = now()
		 RETURNING id, company_id, email, name, sso_subject, created_at, updated_at`,
		companyID, email, name,
	).Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// FindOrCreateCompany looks up a company by slug, creating it if absent.
func (s *Store) FindOrCreateCompany(ctx context.Context, name, slug string) (*model.Company, error) {
	c := &model.Company{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO companies (name, slug)
		 VALUES ($1, $2)
		 ON CONFLICT (slug) DO UPDATE SET updated_at = now()
		 RETURNING id, name, slug, created_at, updated_at`,
		name, slug,
	).Scan(&c.ID, &c.Name, &c.Slug, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("find or create company: %w", err)
	}
	return c, nil
}
