package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// scanApproval reads a single approval row into an Approval struct.
func scanApproval(row pgx.Row, a *model.Approval) error {
	return row.Scan(
		&a.ID, &a.WorkspaceID, &a.AppID, &a.ConnectorID,
		&a.Description, &a.Status, &a.RequestedBy,
		&a.ReviewedBy, &a.ReviewedAt, &a.RejectionReason,
		&a.CreatedAt, &a.UpdatedAt,
	)
}

// ListApprovals returns approvals for a workspace, optionally filtered by status.
// Pending approvals sort first, then by created_at descending.
func (s *Store) ListApprovals(ctx context.Context, workspaceID string, status *model.ApprovalStatus) ([]model.Approval, error) {
	const baseQuery = `
		SELECT id, workspace_id, app_id, connector_id,
		       description, status, requested_by,
		       reviewed_by, reviewed_at, rejection_reason,
		       created_at, updated_at
		FROM approvals WHERE workspace_id = $1`

	var rows pgx.Rows
	var err error
	if status != nil {
		rows, err = s.pool.Query(ctx, baseQuery+` AND status = $2 ORDER BY created_at DESC`, workspaceID, *status)
	} else {
		rows, err = s.pool.Query(ctx, baseQuery+
			` ORDER BY (CASE status WHEN 'pending' THEN 0 ELSE 1 END), created_at DESC`, workspaceID)
	}
	if err != nil {
		return nil, fmt.Errorf("list approvals: %w", err)
	}
	defer rows.Close()

	var approvals []model.Approval
	for rows.Next() {
		var a model.Approval
		if err := scanApproval(rows, &a); err != nil {
			return nil, fmt.Errorf("list approvals scan: %w", err)
		}
		approvals = append(approvals, a)
	}
	return approvals, rows.Err()
}

// GetApprovalRecord fetches a single approval record including the encrypted payload.
func (s *Store) GetApprovalRecord(ctx context.Context, workspaceID, approvalID string) (*model.ApprovalRecord, error) {
	r := &model.ApprovalRecord{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, workspace_id, app_id, connector_id,
		        description, status, requested_by,
		        reviewed_by, reviewed_at, rejection_reason,
		        created_at, updated_at, encrypted_payload
		 FROM approvals WHERE id = $1 AND workspace_id = $2`,
		approvalID, workspaceID,
	).Scan(
		&r.ID, &r.WorkspaceID, &r.AppID, &r.ConnectorID,
		&r.Description, &r.Status, &r.RequestedBy,
		&r.ReviewedBy, &r.ReviewedAt, &r.RejectionReason,
		&r.CreatedAt, &r.UpdatedAt, &r.EncryptedPayload,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get approval: %w", err)
	}
	return r, nil
}

// CreateApproval inserts a new pending approval request.
func (s *Store) CreateApproval(
	ctx context.Context,
	workspaceID string,
	appID, connectorID *string,
	description string,
	encryptedPayload []byte,
	requestedBy string,
) (*model.Approval, error) {
	a := &model.Approval{}
	err := scanApproval(s.pool.QueryRow(ctx,
		`INSERT INTO approvals
		    (workspace_id, app_id, connector_id, description, encrypted_payload, requested_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, workspace_id, app_id, connector_id,
		           description, status, requested_by,
		           reviewed_by, reviewed_at, rejection_reason,
		           created_at, updated_at`,
		workspaceID, appID, connectorID, description, encryptedPayload, requestedBy,
	), a)
	if err != nil {
		return nil, fmt.Errorf("create approval: %w", err)
	}
	return a, nil
}

// UpdateApprovalStatus sets the status of an approval and records the reviewer.
// Only a pending approval may be transitioned; returns ErrNotFound for others.
func (s *Store) UpdateApprovalStatus(
	ctx context.Context,
	workspaceID, approvalID string,
	status model.ApprovalStatus,
	reviewerID string,
	rejectionReason *string,
) (*model.Approval, error) {
	a := &model.Approval{}
	err := scanApproval(s.pool.QueryRow(ctx,
		`UPDATE approvals
		 SET status = $3, reviewed_by = $4, reviewed_at = now(),
		     rejection_reason = $5, updated_at = now()
		 WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
		 RETURNING id, workspace_id, app_id, connector_id,
		           description, status, requested_by,
		           reviewed_by, reviewed_at, rejection_reason,
		           created_at, updated_at`,
		approvalID, workspaceID, status, reviewerID, rejectionReason,
	), a)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("update approval status: %w", err)
	}
	return a, nil
}
