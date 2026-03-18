package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const connectorCols = `id, workspace_id, name, type, encrypted_credentials,
       schema_cache, schema_cached_at, created_by, created_at, updated_at`

// scanConnectorRow reads a connector row and populates a ConnectorRecord.
// schema_cache is scanned as raw bytes and decoded only when non-null.
func scanConnectorRow(row pgx.Row) (*model.ConnectorRecord, error) {
	rec := &model.ConnectorRecord{}
	var schemaCacheRaw []byte
	err := row.Scan(
		&rec.ID, &rec.WorkspaceID, &rec.Name, &rec.Type,
		&rec.EncryptedCredentials, &schemaCacheRaw, &rec.SchemaCachedAt,
		&rec.CreatedBy, &rec.CreatedAt, &rec.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if schemaCacheRaw != nil {
		_ = json.Unmarshal(schemaCacheRaw, &rec.SchemaCache)
	}
	return rec, nil
}

// ListConnectors returns all connectors in a workspace ordered by name.
func (s *Store) ListConnectors(ctx context.Context, workspaceID string) ([]model.Connector, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+connectorCols+` FROM connectors WHERE workspace_id = $1 ORDER BY name`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list connectors: %w", err)
	}
	defer rows.Close()

	var out []model.Connector
	for rows.Next() {
		var schemaCacheRaw []byte
		rec := model.ConnectorRecord{}
		if err := rows.Scan(
			&rec.ID, &rec.WorkspaceID, &rec.Name, &rec.Type,
			&rec.EncryptedCredentials, &schemaCacheRaw, &rec.SchemaCachedAt,
			&rec.CreatedBy, &rec.CreatedAt, &rec.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("list connectors scan: %w", err)
		}
		if schemaCacheRaw != nil {
			_ = json.Unmarshal(schemaCacheRaw, &rec.SchemaCache)
		}
		out = append(out, rec.Connector)
	}
	return out, rows.Err()
}

// ListConnectorRecordsForMaintenance returns all connector records including
// encrypted credentials for operator maintenance workflows.
func (s *Store) ListConnectorRecordsForMaintenance(ctx context.Context) ([]model.ConnectorRecord, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+connectorCols+` FROM connectors ORDER BY workspace_id, id`,
	)
	if err != nil {
		return nil, fmt.Errorf("list connector records for maintenance: %w", err)
	}
	defer rows.Close()

	var out []model.ConnectorRecord
	for rows.Next() {
		rec, err := scanConnectorRow(rows)
		if err != nil {
			return nil, fmt.Errorf("list connector records for maintenance scan: %w", err)
		}
		out = append(out, *rec)
	}
	return out, rows.Err()
}

// GetConnectorRecord fetches a connector including its encrypted credentials.
// Used internally for test-connection and schema-discovery flows.
func (s *Store) GetConnectorRecord(ctx context.Context, workspaceID, connectorID string) (*model.ConnectorRecord, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+connectorCols+` FROM connectors WHERE id = $1 AND workspace_id = $2`,
		connectorID, workspaceID,
	)
	rec, err := scanConnectorRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get connector: %w", err)
	}
	return rec, nil
}

// GetConnector fetches the safe public view of a connector (no credentials).
func (s *Store) GetConnector(ctx context.Context, workspaceID, connectorID string) (*model.Connector, error) {
	rec, err := s.GetConnectorRecord(ctx, workspaceID, connectorID)
	if err != nil {
		return nil, err
	}
	return &rec.Connector, nil
}

// CreateConnector inserts a new connector and returns the safe public view.
func (s *Store) CreateConnector(ctx context.Context, workspaceID, name string, connType model.ConnectorType, encCreds []byte, createdBy string) (*model.Connector, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO connectors (workspace_id, name, type, encrypted_credentials, created_by)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING `+connectorCols,
		workspaceID, name, connType, encCreds, createdBy,
	)
	rec, err := scanConnectorRow(row)
	if err != nil {
		return nil, fmt.Errorf("create connector: %w", err)
	}
	return &rec.Connector, nil
}

// PatchConnector applies partial updates to name and/or encrypted credentials.
// Pass nil for fields that should not change.
func (s *Store) PatchConnector(ctx context.Context, workspaceID, connectorID string, name *string, encCreds []byte) (*model.Connector, error) {
	row := s.pool.QueryRow(ctx,
		`UPDATE connectors SET
		    name                  = COALESCE($3, name),
		    encrypted_credentials = COALESCE($4, encrypted_credentials),
		    updated_at            = now()
		 WHERE id = $1 AND workspace_id = $2
		 RETURNING `+connectorCols,
		connectorID, workspaceID, name, encCreds,
	)
	rec, err := scanConnectorRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("patch connector: %w", err)
	}
	return &rec.Connector, nil
}

// ReplaceConnectorEncryptedCredentials swaps encrypted credentials only when
// the stored ciphertext still matches the scanned value.
func (s *Store) ReplaceConnectorEncryptedCredentials(ctx context.Context, workspaceID, connectorID string, currentEncCreds, nextEncCreds []byte) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE connectors
		 SET encrypted_credentials = $4, updated_at = now()
		 WHERE id = $1 AND workspace_id = $2 AND encrypted_credentials = $3`,
		connectorID, workspaceID, currentEncCreds, nextEncCreds,
	)
	if err != nil {
		return false, fmt.Errorf("replace connector encrypted credentials: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// DeleteConnector permanently removes a connector.
func (s *Store) DeleteConnector(ctx context.Context, workspaceID, connectorID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM connectors WHERE id = $1 AND workspace_id = $2`,
		connectorID, workspaceID,
	)
	if err != nil {
		return fmt.Errorf("delete connector: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateConnectorSchema stores a freshly discovered schema in the cache column.
func (s *Store) UpdateConnectorSchema(ctx context.Context, connectorID string, schemaJSON []byte) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE connectors
		 SET schema_cache = $2, schema_cached_at = now(), updated_at = now()
		 WHERE id = $1`,
		connectorID, schemaJSON,
	)
	if err != nil {
		return fmt.Errorf("update connector schema: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
