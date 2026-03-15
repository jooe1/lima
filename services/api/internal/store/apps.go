package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// ListApps returns all apps in a workspace, ordered by update time descending.
func (s *Store) ListApps(ctx context.Context, workspaceID string) ([]model.App, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, workspace_id, name, description, status, dsl_source, created_by, created_at, updated_at
		 FROM apps WHERE workspace_id = $1 ORDER BY updated_at DESC`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list apps: %w", err)
	}
	defer rows.Close()
	var apps []model.App
	for rows.Next() {
		var a model.App
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Description, &a.Status, &a.DSLSource, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list apps scan: %w", err)
		}
		apps = append(apps, a)
	}
	return apps, rows.Err()
}

// GetApp fetches a single app by ID, scoped to a workspace.
func (s *Store) GetApp(ctx context.Context, workspaceID, appID string) (*model.App, error) {
	a := &model.App{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, workspace_id, name, description, status, dsl_source, created_by, created_at, updated_at
		 FROM apps WHERE id = $1 AND workspace_id = $2`,
		appID, workspaceID,
	).Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Description, &a.Status, &a.DSLSource, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get app: %w", err)
	}
	return a, nil
}

// CreateApp inserts a new draft app and returns it.
func (s *Store) CreateApp(ctx context.Context, workspaceID, name string, description *string, createdBy string) (*model.App, error) {
	a := &model.App{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO apps (workspace_id, name, description, created_by)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, workspace_id, name, description, status, dsl_source, created_by, created_at, updated_at`,
		workspaceID, name, description, createdBy,
	).Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Description, &a.Status, &a.DSLSource, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create app: %w", err)
	}
	return a, nil
}

// PatchApp applies partial updates to name, description, and/or dsl_source.
func (s *Store) PatchApp(ctx context.Context, workspaceID, appID string, name *string, description *string, dslSource *string) (*model.App, error) {
	a := &model.App{}
	err := s.pool.QueryRow(ctx,
		`UPDATE apps SET
		    name        = COALESCE($3, name),
		    description = COALESCE($4, description),
		    dsl_source  = COALESCE($5, dsl_source),
		    updated_at  = now()
		 WHERE id = $1 AND workspace_id = $2
		 RETURNING id, workspace_id, name, description, status, dsl_source, created_by, created_at, updated_at`,
		appID, workspaceID, name, description, dslSource,
	).Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Description, &a.Status, &a.DSLSource, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("patch app: %w", err)
	}
	return a, nil
}

// DeleteApp soft-archives an app by setting its status to archived.
func (s *Store) DeleteApp(ctx context.Context, workspaceID, appID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE apps SET status = 'archived', updated_at = now()
		 WHERE id = $1 AND workspace_id = $2 AND status != 'archived'`,
		appID, workspaceID,
	)
	if err != nil {
		return fmt.Errorf("delete app: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PublishApp creates a version snapshot and sets the app status to published.
// Returns the new AppVersion record.
func (s *Store) PublishApp(ctx context.Context, workspaceID, appID, publisherID string) (*model.AppVersion, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("publish app begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock the app row.
	var dslSource string
	err = tx.QueryRow(ctx,
		`SELECT dsl_source FROM apps WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
		appID, workspaceID,
	).Scan(&dslSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("publish app lock: %w", err)
	}

	// Determine next version number.
	var maxVer int
	_ = tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(version_num), 0) FROM app_versions WHERE app_id = $1`,
		appID,
	).Scan(&maxVer)

	// Insert the version snapshot.
	v := &model.AppVersion{}
	err = tx.QueryRow(ctx,
		`INSERT INTO app_versions (app_id, version_num, dsl_source, published_by)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, app_id, version_num, dsl_source, published_by, published_at`,
		appID, maxVer+1, dslSource, publisherID,
	).Scan(&v.ID, &v.AppID, &v.VersionNum, &v.DSLSource, &v.PublishedBy, &v.PublishedAt)
	if err != nil {
		return nil, fmt.Errorf("publish app insert version: %w", err)
	}

	// Update app status.
	_, err = tx.Exec(ctx,
		`UPDATE apps SET status = 'published', updated_at = now() WHERE id = $1`,
		appID,
	)
	if err != nil {
		return nil, fmt.Errorf("publish app update status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("publish app commit: %w", err)
	}
	return v, nil
}

// RollbackApp restores the app's dsl_source from the given version.
func (s *Store) RollbackApp(ctx context.Context, workspaceID, appID string, versionNum int) (*model.App, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("rollback app begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var dslSource string
	err = tx.QueryRow(ctx,
		`SELECT dsl_source FROM app_versions
		 WHERE app_id = $1 AND version_num = $2`,
		appID, versionNum,
	).Scan(&dslSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rollback app find version: %w", err)
	}

	a := &model.App{}
	err = tx.QueryRow(ctx,
		`UPDATE apps SET dsl_source = $3, status = 'draft', updated_at = now()
		 WHERE id = $1 AND workspace_id = $2
		 RETURNING id, workspace_id, name, description, status, dsl_source, created_by, created_at, updated_at`,
		appID, workspaceID, dslSource,
	).Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Description, &a.Status, &a.DSLSource, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rollback app update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("rollback app commit: %w", err)
	}
	return a, nil
}

// ListAppVersions returns all published versions for an app, newest first.
func (s *Store) ListAppVersions(ctx context.Context, appID string) ([]model.AppVersion, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, app_id, version_num, dsl_source, published_by, published_at
		 FROM app_versions WHERE app_id = $1 ORDER BY version_num DESC`,
		appID,
	)
	if err != nil {
		return nil, fmt.Errorf("list app versions: %w", err)
	}
	defer rows.Close()
	var versions []model.AppVersion
	for rows.Next() {
		var v model.AppVersion
		if err := rows.Scan(&v.ID, &v.AppID, &v.VersionNum, &v.DSLSource, &v.PublishedBy, &v.PublishedAt); err != nil {
			return nil, fmt.Errorf("list app versions scan: %w", err)
		}
		versions = append(versions, v)
	}
	return versions, rows.Err()
}

// GetLatestPublishedVersion returns the most recent AppVersion for an app that is
// currently in 'published' status. Returns ErrNotFound if the app is not published
// or does not belong to the workspace — enforcing the runtime isolation requirement.
func (s *Store) GetLatestPublishedVersion(ctx context.Context, workspaceID, appID string) (*model.AppVersion, error) {
	// Verify the app belongs to the workspace and is currently published.
	var status string
	err := s.pool.QueryRow(ctx,
		`SELECT status FROM apps WHERE id = $1 AND workspace_id = $2`,
		appID, workspaceID,
	).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get published app check: %w", err)
	}
	if status != string(model.StatusPublished) {
		return nil, ErrNotFound
	}

	v := &model.AppVersion{}
	err = s.pool.QueryRow(ctx,
		`SELECT id, app_id, version_num, dsl_source, published_by, published_at
		 FROM app_versions WHERE app_id = $1
		 ORDER BY version_num DESC LIMIT 1`,
		appID,
	).Scan(&v.ID, &v.AppID, &v.VersionNum, &v.DSLSource, &v.PublishedBy, &v.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get published version: %w", err)
	}
	return v, nil
}
