package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const userCols = `id, company_id, email, name, sso_subject, created_at, updated_at`

func scanUser(row pgx.Row) (*model.User, error) {
	u := &model.User{}
	err := row.Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func scanUserRows(rows pgx.Rows) ([]model.User, error) {
	defer rows.Close()

	var out []model.User
	for rows.Next() {
		u := model.User{}
		if err := rows.Scan(&u.ID, &u.CompanyID, &u.Email, &u.Name, &u.SSOSubject, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// GetUser returns the user with the given ID.
func (s *Store) GetUser(ctx context.Context, userID string) (*model.User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE id = $1`,
		userID,
	))
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
	u, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE company_id = $1 AND email = $2`,
		companyID, email,
	))
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
	u, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE sso_subject = $1`,
		ssoSubject,
	))
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
	u, err := scanUser(s.pool.QueryRow(ctx,
		`INSERT INTO users (company_id, email, name, sso_subject)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (company_id, email) DO UPDATE
		   SET name = EXCLUDED.name,
		       sso_subject = EXCLUDED.sso_subject,
		       updated_at = now()
		 RETURNING `+userCols,
		companyID, email, name, ssoSubject,
	))
	if err != nil {
		return nil, fmt.Errorf("upsert user sso: %w", err)
	}
	return u, nil
}

// CreateUser inserts a new user (used in dev-login path).
func (s *Store) CreateUser(ctx context.Context, companyID, email, name string) (*model.User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`INSERT INTO users (company_id, email, name)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (company_id, email) DO UPDATE
		   SET name = EXCLUDED.name, updated_at = now()
		 RETURNING `+userCols,
		companyID, email, name,
	))
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// ListCompanyUsers returns all users provisioned in a company.
func (s *Store) ListCompanyUsers(ctx context.Context, companyID string) ([]model.User, error) {
	rows, err := s.pool.Query(ctx,
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
