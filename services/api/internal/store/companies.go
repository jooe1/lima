package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// GetCompany returns the company with the given ID.
func (s *Store) GetCompany(ctx context.Context, companyID string) (*model.Company, error) {
	c := &model.Company{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, slug, created_at, updated_at FROM companies WHERE id = $1`,
		companyID,
	).Scan(&c.ID, &c.Name, &c.Slug, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get company: %w", err)
	}
	return c, nil
}
