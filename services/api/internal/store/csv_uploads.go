package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

const csvUploadCols = `id, connector_id, filename, columns, rows, total_rows, uploaded_by, uploaded_at`

func scanCSVUploadRow(row pgx.Row) (*model.CSVUpload, error) {
	u := &model.CSVUpload{}
	var colsRaw, rowsRaw []byte
	err := row.Scan(
		&u.ID, &u.ConnectorID, &u.Filename,
		&colsRaw, &rowsRaw, &u.TotalRows,
		&u.UploadedBy, &u.UploadedAt,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(colsRaw, &u.Columns)
	_ = json.Unmarshal(rowsRaw, &u.Rows)
	return u, nil
}

// CreateCSVUpload persists a new CSV import and returns the saved record.
// All rows are stored without any row-count cap.
func (s *Store) CreateCSVUpload(
	ctx context.Context,
	connectorID, uploadedBy string,
	filename *string,
	columns, rows []map[string]any,
	totalRows int,
) (*model.CSVUpload, error) {
	colsJSON, err := json.Marshal(columns)
	if err != nil {
		return nil, fmt.Errorf("marshal csv columns: %w", err)
	}
	rowsJSON, err := json.Marshal(rows)
	if err != nil {
		return nil, fmt.Errorf("marshal csv rows: %w", err)
	}
	row := s.pool.QueryRow(ctx,
		`INSERT INTO csv_uploads (connector_id, filename, columns, rows, total_rows, uploaded_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+csvUploadCols,
		connectorID, filename, colsJSON, rowsJSON, totalRows, uploadedBy,
	)
	u, err := scanCSVUploadRow(row)
	if err != nil {
		return nil, fmt.Errorf("create csv upload: %w", err)
	}
	return u, nil
}

// GetLatestCSVUpload returns the most recently uploaded CSV file for the given
// connector, or ErrNotFound if no upload exists yet.
func (s *Store) GetLatestCSVUpload(ctx context.Context, connectorID string) (*model.CSVUpload, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+csvUploadCols+`
		 FROM csv_uploads
		 WHERE connector_id = $1
		 ORDER BY uploaded_at DESC
		 LIMIT 1`,
		connectorID,
	)
	u, err := scanCSVUploadRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get latest csv upload: %w", err)
	}
	return u, nil
}

// GetCSVUploadByID returns a specific upload by ID regardless of connector.
func (s *Store) GetCSVUploadByID(ctx context.Context, uploadID string) (*model.CSVUpload, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+csvUploadCols+` FROM csv_uploads WHERE id = $1`,
		uploadID,
	)
	u, err := scanCSVUploadRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get csv upload by id: %w", err)
	}
	return u, nil
}

// ListLatestCSVUploadsByWorkspace returns one snapshot entry per CSV connector
// in the workspace, keyed to the most recent upload for that connector.
// Used to build publish-time snapshots.
func (s *Store) ListLatestCSVUploadsByWorkspace(ctx context.Context, workspaceID string) ([]model.AppVersionCSVSnapshot, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT ON (c.id) c.name, cu.id
		 FROM connectors c
		 JOIN csv_uploads cu ON cu.connector_id = c.id
		 WHERE c.workspace_id = $1 AND c.type = 'csv'
		 ORDER BY c.id, cu.uploaded_at DESC`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list latest csv uploads by workspace: %w", err)
	}
	defer rows.Close()

	var out []model.AppVersionCSVSnapshot
	for rows.Next() {
		var snap model.AppVersionCSVSnapshot
		if err := rows.Scan(&snap.ConnectorName, &snap.CSVUploadID); err != nil {
			return nil, fmt.Errorf("scan csv upload row: %w", err)
		}
		out = append(out, snap)
	}
	return out, rows.Err()
}

// CreateAppVersionCSVSnapshots records the CSV upload state for each connector
// at publish time. Idempotent via ON CONFLICT DO NOTHING.
func (s *Store) CreateAppVersionCSVSnapshots(ctx context.Context, appVersionID string, snapshots []model.AppVersionCSVSnapshot) error {
	for _, snap := range snapshots {
		_, err := s.pool.Exec(ctx,
			`INSERT INTO app_version_csv_snapshots (app_version_id, connector_name, csv_upload_id)
			 VALUES ($1, $2, $3)
			 ON CONFLICT DO NOTHING`,
			appVersionID, snap.ConnectorName, snap.CSVUploadID,
		)
		if err != nil {
			return fmt.Errorf("create csv snapshot for connector %q: %w", snap.ConnectorName, err)
		}
	}
	return nil
}

// GetCSVSnapshotForVersion returns the upload ID frozen at publish time for the
// given connector name and app version. Returns ErrNotFound when no snapshot
// exists (e.g., connector had no upload at publish time).
func (s *Store) GetCSVSnapshotForVersion(ctx context.Context, appVersionID, connectorName string) (string, error) {
	var uploadID string
	err := s.pool.QueryRow(ctx,
		`SELECT csv_upload_id
		 FROM app_version_csv_snapshots
		 WHERE app_version_id = $1 AND connector_name = $2`,
		appVersionID, connectorName,
	).Scan(&uploadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get csv snapshot for version: %w", err)
	}
	return uploadID, nil
}
