package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// ---- Column definitions -----------------------------------------------------

// SetManagedTableColumns replaces all column definitions for a managed connector
// inside a single transaction, then returns the saved columns.
func (s *Store) SetManagedTableColumns(ctx context.Context, connectorID string, cols []model.ManagedTableColumn) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx,
		`DELETE FROM managed_table_columns WHERE connector_id = $1`, connectorID,
	); err != nil {
		return fmt.Errorf("delete managed columns: %w", err)
	}

	for i, col := range cols {
		if _, err := tx.Exec(ctx,
			`INSERT INTO managed_table_columns (connector_id, name, col_type, nullable, col_order)
			 VALUES ($1, $2, $3, $4, $5)`,
			connectorID, col.Name, col.ColType, col.Nullable, i,
		); err != nil {
			return fmt.Errorf("insert managed column %q: %w", col.Name, err)
		}
	}
	return tx.Commit(ctx)
}

// GetManagedTableColumns returns all column definitions ordered by col_order.
func (s *Store) GetManagedTableColumns(ctx context.Context, connectorID string) ([]model.ManagedTableColumn, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, connector_id, name, col_type, nullable, col_order
		 FROM managed_table_columns
		 WHERE connector_id = $1
		 ORDER BY col_order`,
		connectorID,
	)
	if err != nil {
		return nil, fmt.Errorf("get managed columns: %w", err)
	}
	defer rows.Close()

	var cols []model.ManagedTableColumn
	for rows.Next() {
		var c model.ManagedTableColumn
		if err := rows.Scan(&c.ID, &c.ConnectorID, &c.Name, &c.ColType, &c.Nullable, &c.ColOrder); err != nil {
			return nil, fmt.Errorf("scan managed column: %w", err)
		}
		cols = append(cols, c)
	}
	return cols, rows.Err()
}

// ---- Row CRUD ---------------------------------------------------------------

func scanManagedRow(row pgx.Row) (*model.ManagedTableRow, error) {
	var r model.ManagedTableRow
	var dataRaw []byte
	if err := row.Scan(&r.ID, &r.ConnectorID, &dataRaw, &r.CreatedBy, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(dataRaw, &r.Data)
	return &r, nil
}

// ListManagedTableRows returns all non-deleted rows for a connector, ordered by creation time.
func (s *Store) ListManagedTableRows(ctx context.Context, connectorID string) ([]model.ManagedTableRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, connector_id, data, created_by, created_at, updated_at
		 FROM managed_table_rows
		 WHERE connector_id = $1 AND deleted_at IS NULL
		 ORDER BY created_at`,
		connectorID,
	)
	if err != nil {
		return nil, fmt.Errorf("list managed rows: %w", err)
	}
	defer rows.Close()

	var out []model.ManagedTableRow
	for rows.Next() {
		var r model.ManagedTableRow
		var dataRaw []byte
		if err := rows.Scan(&r.ID, &r.ConnectorID, &dataRaw, &r.CreatedBy, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan managed row: %w", err)
		}
		_ = json.Unmarshal(dataRaw, &r.Data)
		out = append(out, r)
	}
	return out, rows.Err()
}

// InsertManagedTableRow adds a new data row and returns the saved record.
func (s *Store) InsertManagedTableRow(ctx context.Context, connectorID, createdBy string, data map[string]any) (*model.ManagedTableRow, error) {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal row data: %w", err)
	}
	row := s.pool.QueryRow(ctx,
		`INSERT INTO managed_table_rows (connector_id, data, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id, connector_id, data, created_by, created_at, updated_at`,
		connectorID, dataJSON, createdBy,
	)
	r, err := scanManagedRow(row)
	if err != nil {
		return nil, fmt.Errorf("insert managed row: %w", err)
	}
	return r, nil
}

// UpdateManagedTableRow replaces the data for an existing row.
func (s *Store) UpdateManagedTableRow(ctx context.Context, connectorID, rowID string, data map[string]any) (*model.ManagedTableRow, error) {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal row data: %w", err)
	}
	row := s.pool.QueryRow(ctx,
		`UPDATE managed_table_rows
		 SET data = $1, updated_at = now()
		 WHERE id = $2 AND connector_id = $3 AND deleted_at IS NULL
		 RETURNING id, connector_id, data, created_by, created_at, updated_at`,
		dataJSON, rowID, connectorID,
	)
	r, err := scanManagedRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("update managed row: %w", err)
	}
	return r, nil
}

// DeleteManagedTableRow soft-deletes a single row by ID.
func (s *Store) DeleteManagedTableRow(ctx context.Context, connectorID, rowID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE managed_table_rows
		 SET deleted_at = now(), updated_at = now()
		 WHERE id = $1 AND connector_id = $2 AND deleted_at IS NULL`,
		rowID, connectorID,
	)
	if err != nil {
		return fmt.Errorf("delete managed row: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAllManagedTableRows soft-deletes every row for a connector.
// Used when seeding with replace=true.
func (s *Store) DeleteAllManagedTableRows(ctx context.Context, connectorID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE managed_table_rows
		 SET deleted_at = now(), updated_at = now()
		 WHERE connector_id = $1 AND deleted_at IS NULL`,
		connectorID,
	)
	if err != nil {
		return fmt.Errorf("delete all managed rows: %w", err)
	}
	return nil
}

// ---- Publish-time snapshots -------------------------------------------------

// ListManagedSnapshotsByWorkspace collects the current column definitions and
// row data for every managed connector in the workspace. Used to freeze state
// at publish time.
func (s *Store) ListManagedSnapshotsByWorkspace(ctx context.Context, workspaceID string) ([]model.AppVersionManagedSnapshot, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name FROM connectors WHERE workspace_id = $1 AND type = 'managed'`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list managed connectors: %w", err)
	}
	defer rows.Close()

	type entry struct{ id, name string }
	var conns []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.name); err != nil {
			return nil, fmt.Errorf("scan connector entry: %w", err)
		}
		conns = append(conns, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var snaps []model.AppVersionManagedSnapshot
	for _, c := range conns {
		cols, err := s.GetManagedTableColumns(ctx, c.id)
		if err != nil {
			return nil, fmt.Errorf("get columns for %s: %w", c.name, err)
		}
		tableRows, err := s.ListManagedTableRows(ctx, c.id)
		if err != nil {
			return nil, fmt.Errorf("get rows for %s: %w", c.name, err)
		}

		colMaps := make([]map[string]any, len(cols))
		for i, col := range cols {
			colMaps[i] = map[string]any{
				"name":     col.Name,
				"col_type": col.ColType,
				"nullable": col.Nullable,
			}
		}
		rowMaps := make([]map[string]any, len(tableRows))
		for i, r := range tableRows {
			rowMaps[i] = r.Data
		}
		snaps = append(snaps, model.AppVersionManagedSnapshot{
			ConnectorName: c.name,
			Columns:       colMaps,
			Rows:          rowMaps,
			TotalRows:     len(tableRows),
		})
	}
	return snaps, nil
}

// CreateAppVersionManagedSnapshots records the managed table state at publish time.
// Idempotent via ON CONFLICT DO NOTHING.
func (s *Store) CreateAppVersionManagedSnapshots(ctx context.Context, appVersionID string, snaps []model.AppVersionManagedSnapshot) error {
	for _, snap := range snaps {
		colsJSON, _ := json.Marshal(snap.Columns)
		rowsJSON, _ := json.Marshal(snap.Rows)
		if _, err := s.pool.Exec(ctx,
			`INSERT INTO app_version_managed_snapshots (app_version_id, connector_name, columns, rows, total_rows)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT DO NOTHING`,
			appVersionID, snap.ConnectorName, colsJSON, rowsJSON, snap.TotalRows,
		); err != nil {
			return fmt.Errorf("create managed snapshot for connector %q: %w", snap.ConnectorName, err)
		}
	}
	return nil
}

// GetManagedSnapshotForVersion returns the snapshot frozen at publish time.
// Returns ErrNotFound when no snapshot was recorded for this connector.
func (s *Store) GetManagedSnapshotForVersion(ctx context.Context, appVersionID, connectorName string) (*model.AppVersionManagedSnapshot, error) {
	var snap model.AppVersionManagedSnapshot
	var colsRaw, rowsRaw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT connector_name, columns, rows, total_rows
		 FROM app_version_managed_snapshots
		 WHERE app_version_id = $1 AND connector_name = $2`,
		appVersionID, connectorName,
	).Scan(&snap.ConnectorName, &colsRaw, &rowsRaw, &snap.TotalRows)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get managed snapshot: %w", err)
	}
	snap.AppVersionID = appVersionID
	_ = json.Unmarshal(colsRaw, &snap.Columns)
	_ = json.Unmarshal(rowsRaw, &snap.Rows)
	return &snap, nil
}
