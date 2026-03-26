package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// ListConnectorActions returns all action definitions for a connector,
// ordered by resource_name then action_key.
func (s *Store) ListConnectorActions(ctx context.Context, workspaceID, connectorID string) ([]model.ActionDefinition, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ca.id, ca.connector_id, ca.resource_name, ca.action_key, ca.action_label,
		       ca.description, ca.http_method, ca.path_template, ca.input_fields,
		       ca.created_at, ca.updated_at
		FROM connector_actions ca
		JOIN connectors c ON c.id = ca.connector_id
		WHERE ca.connector_id = $1
		  AND c.workspace_id  = $2
		ORDER BY ca.resource_name, ca.action_key
	`, connectorID, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list connector actions: %w", err)
	}
	defer rows.Close()

	var out []model.ActionDefinition
	for rows.Next() {
		a, err := scanActionDef(rows)
		if err != nil {
			return nil, fmt.Errorf("list connector actions scan: %w", err)
		}
		out = append(out, *a)
	}
	if out == nil {
		out = []model.ActionDefinition{}
	}
	return out, rows.Err()
}

// GetConnectorAction returns a single action definition, verifying workspace ownership.
func (s *Store) GetConnectorAction(ctx context.Context, workspaceID, connectorID, actionID string) (*model.ActionDefinition, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT ca.id, ca.connector_id, ca.resource_name, ca.action_key, ca.action_label,
		       ca.description, ca.http_method, ca.path_template, ca.input_fields,
		       ca.created_at, ca.updated_at
		FROM connector_actions ca
		JOIN connectors c ON c.id = ca.connector_id
		WHERE ca.id = $1 AND ca.connector_id = $2 AND c.workspace_id = $3
	`, actionID, connectorID, workspaceID)
	a, err := scanActionDef(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// UpsertConnectorAction inserts or updates a single action (matched by
// connector_id + resource_name + action_key). Returns the persisted record.
func (s *Store) UpsertConnectorAction(ctx context.Context, workspaceID, connectorID string, in model.ActionDefinitionInput) (*model.ActionDefinition, error) {
	if err := s.requireConnectorOwnership(ctx, workspaceID, connectorID); err != nil {
		return nil, err
	}

	fieldsJSON, err := json.Marshal(in.InputFields)
	if err != nil {
		return nil, fmt.Errorf("marshal input_fields: %w", err)
	}

	row := s.pool.QueryRow(ctx, `
		INSERT INTO connector_actions
			(connector_id, resource_name, action_key, action_label,
			 description, http_method, path_template, input_fields)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (connector_id, resource_name, action_key) DO UPDATE SET
			action_label  = EXCLUDED.action_label,
			description   = EXCLUDED.description,
			http_method   = EXCLUDED.http_method,
			path_template = EXCLUDED.path_template,
			input_fields  = EXCLUDED.input_fields,
			updated_at    = now()
		RETURNING id, connector_id, resource_name, action_key, action_label,
		          description, http_method, path_template, input_fields,
		          created_at, updated_at
	`, connectorID, in.ResourceName, in.ActionKey, in.ActionLabel,
		in.Description, in.HTTPMethod, in.PathTemplate, fieldsJSON)
	a, err := scanActionDef(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// DeleteConnectorAction removes a single action, verifying workspace ownership.
func (s *Store) DeleteConnectorAction(ctx context.Context, workspaceID, connectorID, actionID string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM connector_actions
		WHERE id = $1 AND connector_id = $2
		  AND EXISTS (SELECT 1 FROM connectors WHERE id=$2 AND workspace_id=$3)
	`, actionID, connectorID, workspaceID)
	if err != nil {
		return fmt.Errorf("delete connector action: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// BulkReplaceConnectorActions replaces the full action catalog for a connector
// in a single transaction: deletes all existing actions then inserts the new set.
func (s *Store) BulkReplaceConnectorActions(ctx context.Context, workspaceID, connectorID string, actions []model.ActionDefinitionInput) ([]model.ActionDefinition, error) {
	if err := s.requireConnectorOwnership(ctx, workspaceID, connectorID); err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `DELETE FROM connector_actions WHERE connector_id = $1`, connectorID); err != nil {
		return nil, fmt.Errorf("delete existing actions: %w", err)
	}

	var out []model.ActionDefinition
	for _, in := range actions {
		fieldsJSON, err := json.Marshal(in.InputFields)
		if err != nil {
			return nil, fmt.Errorf("marshal input_fields: %w", err)
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO connector_actions
				(connector_id, resource_name, action_key, action_label,
				 description, http_method, path_template, input_fields)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, connector_id, resource_name, action_key, action_label,
			          description, http_method, path_template, input_fields,
			          created_at, updated_at
		`, connectorID, in.ResourceName, in.ActionKey, in.ActionLabel,
			in.Description, in.HTTPMethod, in.PathTemplate, fieldsJSON)
		a, err := scanActionDef(row)
		if err != nil {
			return nil, fmt.Errorf("insert action %q: %w", in.ActionKey, err)
		}
		out = append(out, *a)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	if out == nil {
		out = []model.ActionDefinition{}
	}
	return out, nil
}

// requireConnectorOwnership returns ErrNotFound when the connector does not
// exist in the given workspace.
func (s *Store) requireConnectorOwnership(ctx context.Context, workspaceID, connectorID string) error {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM connectors WHERE id = $1 AND workspace_id = $2)`,
		connectorID, workspaceID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("check connector ownership: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

// scanActionDef reads one row of connector_actions columns into an ActionDefinition.
func scanActionDef(row pgx.Row) (*model.ActionDefinition, error) {
	var a model.ActionDefinition
	var fieldsRaw []byte
	err := row.Scan(
		&a.ID, &a.ConnectorID, &a.ResourceName, &a.ActionKey, &a.ActionLabel,
		&a.Description, &a.HTTPMethod, &a.PathTemplate, &fieldsRaw,
		&a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if fieldsRaw != nil {
		if err := json.Unmarshal(fieldsRaw, &a.InputFields); err != nil {
			return nil, fmt.Errorf("unmarshal input_fields: %w", err)
		}
	}
	if a.InputFields == nil {
		a.InputFields = []model.ActionFieldDef{}
	}
	return &a, nil
}
