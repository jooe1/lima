package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const companyRoleBindingCols = `company_id, subject_type, subject_id, role, created_at`

func scanCompanyRoleBinding(row pgx.Row) (*model.CompanyRoleBinding, error) {
	b := &model.CompanyRoleBinding{}
	err := row.Scan(&b.CompanyID, &b.SubjectType, &b.SubjectID, &b.Role, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func scanCompanyRoleBindingRows(rows pgx.Rows) ([]model.CompanyRoleBinding, error) {
	defer rows.Close()

	var out []model.CompanyRoleBinding
	for rows.Next() {
		b := model.CompanyRoleBinding{}
		if err := rows.Scan(&b.CompanyID, &b.SubjectType, &b.SubjectID, &b.Role, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ListCompanyRoleBindings returns all role bindings for a company.
func (s *Store) ListCompanyRoleBindings(ctx context.Context, companyID string) ([]model.CompanyRoleBinding, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+companyRoleBindingCols+` FROM company_role_bindings WHERE company_id = $1 ORDER BY created_at`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list company role bindings: %w", err)
	}
	out, err := scanCompanyRoleBindingRows(rows)
	if err != nil {
		return nil, fmt.Errorf("list company role bindings scan: %w", err)
	}
	return out, nil
}

// GetCompanyRole returns the role binding for a specific subject in a company, or nil if none.
func (s *Store) GetCompanyRole(ctx context.Context, companyID, subjectType, subjectID string) (*model.CompanyRoleBinding, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+companyRoleBindingCols+`
		 FROM company_role_bindings
		 WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3
		 LIMIT 1`,
		companyID, subjectType, subjectID,
	)
	b, err := scanCompanyRoleBinding(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get company role: %w", err)
	}
	return b, nil
}

// UpsertCompanyRoleBinding creates or updates a company role binding.
func (s *Store) UpsertCompanyRoleBinding(ctx context.Context, companyID, subjectType, subjectID, role string) (*model.CompanyRoleBinding, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO company_role_bindings (company_id, subject_type, subject_id, role)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (company_id, subject_type, subject_id, role) DO UPDATE SET role = EXCLUDED.role
		 RETURNING `+companyRoleBindingCols,
		companyID, subjectType, subjectID, role,
	)
	b, err := scanCompanyRoleBinding(row)
	if err != nil {
		return nil, fmt.Errorf("upsert company role binding: %w", err)
	}
	return b, nil
}

// DeleteCompanyRoleBinding removes a role binding.
func (s *Store) DeleteCompanyRoleBinding(ctx context.Context, companyID, subjectType, subjectID, role string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM company_role_bindings
		 WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3 AND role = $4`,
		companyID, subjectType, subjectID, role,
	)
	if err != nil {
		return fmt.Errorf("delete company role binding: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SubjectHasCompanyRole(ctx context.Context, companyID, subjectType, subjectID, role string) (bool, error) {
	return subjectHasCompanyRole(ctx, s.pool, companyID, subjectType, subjectID, role)
}

func (s *Store) SubjectHasAnyCompanyRole(ctx context.Context, companyID, subjectType, subjectID string, roles ...string) (bool, error) {
	return subjectHasAnyCompanyRole(ctx, s.pool, companyID, subjectType, subjectID, roles...)
}

func (s *Store) CompanyHasRole(ctx context.Context, companyID, role string) (bool, error) {
	return companyHasRole(ctx, s.pool, companyID, role)
}

func subjectHasCompanyRole(ctx context.Context, q dbtx, companyID, subjectType, subjectID, role string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM company_role_bindings
			WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3 AND role = $4
		)`,
		companyID, subjectType, subjectID, role,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("subject has company role: %w", err)
	}
	return exists, nil
}

func subjectHasAnyCompanyRole(ctx context.Context, q dbtx, companyID, subjectType, subjectID string, roles ...string) (bool, error) {
	if len(roles) == 0 {
		return false, nil
	}
	var exists bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM company_role_bindings
			WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3 AND role = ANY($4)
		)`,
		companyID, subjectType, subjectID, roles,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("subject has any company role: %w", err)
	}
	return exists, nil
}

func companyHasRole(ctx context.Context, q dbtx, companyID, role string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM company_role_bindings
			WHERE company_id = $1 AND role = $2
		)`,
		companyID, role,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("company has role: %w", err)
	}
	return exists, nil
}

func upsertCompanyRoleBinding(ctx context.Context, q dbtx, companyID, subjectType, subjectID, role string) (*model.CompanyRoleBinding, error) {
	row := q.QueryRow(ctx,
		`INSERT INTO company_role_bindings (company_id, subject_type, subject_id, role)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (company_id, subject_type, subject_id, role) DO NOTHING
		 RETURNING `+companyRoleBindingCols,
		companyID, subjectType, subjectID, role,
	)
	b, err := scanCompanyRoleBinding(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return scanCompanyRoleBinding(q.QueryRow(ctx,
			`SELECT `+companyRoleBindingCols+`
			 FROM company_role_bindings
			 WHERE company_id = $1 AND subject_type = $2 AND subject_id = $3 AND role = $4`,
			companyID, subjectType, subjectID, role,
		))
	}
	if err != nil {
		return nil, fmt.Errorf("upsert company role binding: %w", err)
	}
	return b, nil
}
