package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// companyConnectorSafeCols omits encrypted_credentials for list responses.
const companyConnectorSafeCols = `id, workspace_id, name, type,
       schema_cache, schema_cached_at, created_by, created_at, updated_at,
       company_id, owner_scope`

// companyConnectorAllCols includes encrypted_credentials for single-row ops.
const companyConnectorAllCols = `id, workspace_id, name, type, encrypted_credentials,
       schema_cache, schema_cached_at, created_by, created_at, updated_at,
       company_id, owner_scope`

func scanCompanyConnectorRecord(row pgx.Row) (*model.ConnectorRecord, error) {
	rec := &model.ConnectorRecord{}
	var schemaCacheRaw []byte
	err := row.Scan(
		&rec.ID, &rec.WorkspaceID, &rec.Name, &rec.Type,
		&rec.EncryptedCredentials, &schemaCacheRaw, &rec.SchemaCachedAt,
		&rec.CreatedBy, &rec.CreatedAt, &rec.UpdatedAt,
		&rec.CompanyID, &rec.OwnerScope,
	)
	if err != nil {
		return nil, err
	}
	if schemaCacheRaw != nil {
		_ = json.Unmarshal(schemaCacheRaw, &rec.SchemaCache)
	}
	return rec, nil
}

// ListConnectorsByCompany returns all company-scoped connectors for a company.
func (s *Store) ListConnectorsByCompany(ctx context.Context, companyID string) ([]model.Connector, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+companyConnectorSafeCols+`
		 FROM connectors
		 WHERE company_id = $1 AND owner_scope = 'company'
		 ORDER BY name`,
		companyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list connectors by company: %w", err)
	}
	defer rows.Close()

	var out []model.Connector
	for rows.Next() {
		var (
			c   model.Connector
			raw []byte
		)
		if err := rows.Scan(
			&c.ID, &c.WorkspaceID, &c.Name, &c.Type,
			&raw, &c.SchemaCachedAt,
			&c.CreatedBy, &c.CreatedAt, &c.UpdatedAt,
			&c.CompanyID, &c.OwnerScope,
		); err != nil {
			return nil, fmt.Errorf("list connectors by company scan: %w", err)
		}
		if raw != nil {
			_ = json.Unmarshal(raw, &c.SchemaCache)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetConnectorByCompany fetches the safe public view of a company-scoped connector.
func (s *Store) GetConnectorByCompany(ctx context.Context, companyID, connectorID string) (*model.Connector, error) {
	rec, err := s.GetConnectorRecordByCompany(ctx, companyID, connectorID)
	if err != nil {
		return nil, err
	}
	return &rec.Connector, nil
}

// GetConnectorRecordByCompany fetches a company-scoped connector including credentials.
func (s *Store) GetConnectorRecordByCompany(ctx context.Context, companyID, connectorID string) (*model.ConnectorRecord, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+companyConnectorAllCols+`
		 FROM connectors
		 WHERE id = $1 AND company_id = $2 AND owner_scope = 'company'`,
		connectorID, companyID,
	)
	rec, err := scanCompanyConnectorRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get connector by company: %w", err)
	}
	return rec, nil
}

// CreateCompanyConnector inserts a company-scoped connector and returns the safe view.
func (s *Store) CreateCompanyConnector(ctx context.Context, companyID, workspaceID, name string, connType model.ConnectorType, encCreds []byte, createdBy string) (*model.Connector, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO connectors
		     (workspace_id, company_id, name, type, encrypted_credentials, created_by, owner_scope)
		 VALUES ($1, $2, $3, $4, $5, $6, 'company')
		 RETURNING `+companyConnectorAllCols,
		workspaceID, companyID, name, connType, encCreds, createdBy,
	)
	rec, err := scanCompanyConnectorRecord(row)
	if err != nil {
		return nil, fmt.Errorf("create company connector: %w", err)
	}
	return &rec.Connector, nil
}

// PatchCompanyConnector applies partial updates to name and/or credentials,
// enforcing that the connector belongs to the given company.
func (s *Store) PatchCompanyConnector(ctx context.Context, companyID, connectorID string, name *string, encCreds []byte) (*model.Connector, error) {
	row := s.pool.QueryRow(ctx,
		`UPDATE connectors SET
		     name                  = COALESCE($3, name),
		     encrypted_credentials = COALESCE($4, encrypted_credentials),
		     updated_at            = now()
		 WHERE id = $1 AND company_id = $2 AND owner_scope = 'company'
		 RETURNING `+companyConnectorAllCols,
		connectorID, companyID, name, encCreds,
	)
	rec, err := scanCompanyConnectorRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("patch company connector: %w", err)
	}
	return &rec.Connector, nil
}

// DeleteCompanyConnector removes a company-scoped connector.
func (s *Store) DeleteCompanyConnector(ctx context.Context, companyID, connectorID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM connectors WHERE id = $1 AND company_id = $2 AND owner_scope = 'company'`,
		connectorID, companyID,
	)
	if err != nil {
		return fmt.Errorf("delete company connector: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
