package store

import (
	"context"
	"encoding/json"
	"fmt"

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
