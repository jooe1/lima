package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lima/api/internal/model"
)

// WriteAuditEvent appends an audit record. Errors are non-fatal by convention;
// callers should log them but not fail the user-facing request.
func (s *Store) WriteAuditEvent(ctx context.Context, e *model.AuditEvent) error {
	var metaRaw []byte
	if e.Metadata != nil {
		var err error
		metaRaw, err = json.Marshal(e.Metadata)
		if err != nil {
			return fmt.Errorf("audit marshal metadata: %w", err)
		}
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO audit_events (workspace_id, actor_id, event_type, resource_type, resource_id, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		e.WorkspaceID, e.ActorID, e.EventType, e.ResourceType, e.ResourceID, metaRaw,
	)
	if err != nil {
		return fmt.Errorf("write audit event: %w", err)
	}
	return nil
}

// ListAuditEvents returns audit events for a workspace, most recent first.
func (s *Store) ListAuditEvents(ctx context.Context, workspaceID string, limit int) ([]model.AuditEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, workspace_id, actor_id, event_type, resource_type, resource_id, metadata, created_at
		 FROM audit_events WHERE workspace_id = $1
		 ORDER BY created_at DESC LIMIT $2`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()
	var events []model.AuditEvent
	for rows.Next() {
		var e model.AuditEvent
		var metaRaw []byte
		if err := rows.Scan(&e.ID, &e.WorkspaceID, &e.ActorID, &e.EventType, &e.ResourceType, &e.ResourceID, &metaRaw, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("list audit events scan: %w", err)
		}
		if metaRaw != nil {
			_ = json.Unmarshal(metaRaw, &e.Metadata)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// AuditExportFilter controls the range and volume of an audit export query.
type AuditExportFilter struct {
	Since  time.Time // inclusive lower bound (required)
	Until  time.Time // exclusive upper bound; zero means now
	Cursor time.Time // keyset cursor for pagination (created_at of last row from previous page)
	Limit  int       // rows per page, capped at 5000
}

// ExportAuditEvents returns a page of audit events within the requested window,
// ordered oldest-first for streaming export. Use the CreatedAt of the last
// returned row as Cursor to fetch the next page.
func (s *Store) ExportAuditEvents(ctx context.Context, workspaceID string, f AuditExportFilter) ([]model.AuditEvent, error) {
	if f.Limit <= 0 || f.Limit > 5000 {
		f.Limit = 1000
	}
	if f.Until.IsZero() {
		f.Until = time.Now()
	}

	const baseQuery = `
		SELECT id, workspace_id, actor_id, event_type, resource_type, resource_id, metadata, created_at
		FROM audit_events
		WHERE workspace_id = $1
		  AND created_at >= $2
		  AND created_at <  $3`

	var (
		query string
		args  []any
	)
	if f.Cursor.IsZero() {
		query = baseQuery + ` ORDER BY created_at ASC LIMIT $4`
		args = []any{workspaceID, f.Since, f.Until, f.Limit}
	} else {
		query = baseQuery + ` AND created_at > $4 ORDER BY created_at ASC LIMIT $5`
		args = []any{workspaceID, f.Since, f.Until, f.Cursor, f.Limit}
	}

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("export audit events query: %w", err)
	}
	defer rows.Close()

	var events []model.AuditEvent
	for rows.Next() {
		var e model.AuditEvent
		var metaRaw []byte
		if scanErr := rows.Scan(&e.ID, &e.WorkspaceID, &e.ActorID, &e.EventType, &e.ResourceType, &e.ResourceID, &metaRaw, &e.CreatedAt); scanErr != nil {
			return nil, fmt.Errorf("export audit events scan: %w", scanErr)
		}
		if metaRaw != nil {
			_ = json.Unmarshal(metaRaw, &e.Metadata)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// PruneExpiredAuditEvents deletes audit events whose expires_at has passed.
// This is called by a background job or cron; returns the count of deleted rows.
func (s *Store) PruneExpiredAuditEvents(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM audit_events WHERE expires_at IS NOT NULL AND expires_at < now()`,
	)
	if err != nil {
		return 0, fmt.Errorf("prune audit events: %w", err)
	}
	return tag.RowsAffected(), nil
}
