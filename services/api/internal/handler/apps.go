package handler

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListApps returns all apps in a workspace.
func ListApps(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		apps, err := s.ListApps(r.Context(), workspaceID)
		if err != nil {
			log.Error("list apps", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list apps")
			return
		}
		if apps == nil {
			apps = []model.App{}
		}
		respond(w, http.StatusOK, map[string]any{"apps": apps})
	}
}

// CreateApp creates a new draft app.
func CreateApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Name == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "name is required")
			return
		}

		app, err := s.CreateApp(r.Context(), workspaceID, req.Name, req.Description, claims.UserID)
		if err != nil {
			log.Error("create app", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create app")
			return
		}

		auditAppEvent(r.Context(), s, log, claims, workspaceID, "app.created", &app.ID)
		respond(w, http.StatusCreated, app)
	}
}

// GetApp returns a single app.
func GetApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		app, err := s.GetApp(r.Context(), workspaceID, appID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, app)
	}
}

// PatchApp applies partial updates to an app.
func PatchApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")

		var req struct {
			Name         *string                   `json:"name"`
			Description  *string                   `json:"description"`
			DSLSource    *string                   `json:"dsl_source"`
			NodeMetadata map[string]model.NodeMeta `json:"node_metadata"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		app, err := s.PatchApp(r.Context(), workspaceID, appID, req.Name, req.Description, req.DSLSource, req.NodeMetadata)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, app)
	}
}

// DeleteApp archives an app (soft delete).
func DeleteApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")

		if err := s.DeleteApp(r.Context(), workspaceID, appID); err != nil {
			handleStoreErr(w, err)
			return
		}
		claims, _ := ClaimsFromContext(r.Context())
		auditAppEvent(r.Context(), s, log, claims, workspaceID, "app.archived", &appID)
		respond(w, http.StatusOK, map[string]string{"status": "archived"})
	}
}

// PublishApp creates a version snapshot and marks the app as published.
// Requires workspace_admin role (enforced via RBAC middleware on the router).
func PublishApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		claims, _ := ClaimsFromContext(r.Context())

		version, err := s.PublishApp(r.Context(), workspaceID, appID, claims.UserID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		// Snapshot the current state of every Lima Table (managed) connector in
		// the workspace so that published apps serve deterministic, immutable data
		// even if the live table is edited or deleted later.
		snapshots, serr := s.ListManagedSnapshotsByWorkspace(r.Context(), workspaceID)
		if serr != nil {
			log.Warn("failed to list managed table snapshots for publish",
				zap.String("app_version_id", version.ID), zap.Error(serr))
		} else if len(snapshots) > 0 {
			for i := range snapshots {
				snapshots[i].AppVersionID = version.ID
			}
			if serr := s.CreateAppVersionManagedSnapshots(r.Context(), version.ID, snapshots); serr != nil {
				log.Warn("failed to create managed table snapshots for published version",
					zap.String("app_version_id", version.ID), zap.Error(serr))
			}
		}

		auditAppEvent(r.Context(), s, log, claims, workspaceID, "app.published", &appID)
		respond(w, http.StatusOK, version)
	}
}

// RollbackApp restores the app to a previous version.
// Requires workspace_admin role (enforced via RBAC middleware on the router).
func RollbackApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")

		var req struct {
			VersionNum int `json:"version_num"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.VersionNum < 1 {
			respondErr(w, http.StatusBadRequest, "bad_request", "version_num must be >= 1")
			return
		}

		app, err := s.RollbackApp(r.Context(), workspaceID, appID, req.VersionNum)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		claims, _ := ClaimsFromContext(r.Context())
		auditAppEvent(r.Context(), s, log, claims, workspaceID, "app.rolled_back", &appID)
		respond(w, http.StatusOK, app)
	}
}

// ListAppVersions returns the publish history for an app.
func ListAppVersions(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "appID")
		versions, err := s.ListAppVersions(r.Context(), appID)
		if err != nil {
			log.Error("list app versions", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list versions")
			return
		}
		if versions == nil {
			versions = []model.AppVersion{}
		}
		respond(w, http.StatusOK, map[string]any{"versions": versions})
	}
}

// ListAuditEvents returns recent audit events for a workspace.
func ListAuditEvents(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		limit := 100
		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		events, err := s.ListAuditEvents(r.Context(), workspaceID, limit)
		if err != nil {
			log.Error("list audit events", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list audit events")
			return
		}
		if events == nil {
			events = []model.AuditEvent{}
		}
		respond(w, http.StatusOK, map[string]any{"events": events})
	}
}

// GetPublishedApp returns the latest published AppVersion for an app.
// Returns 404 if the app is not published and 403 if publication audiences
// restrict the app to discovery-only access for the caller.
func GetPublishedApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
			return
		}

		publicationID := r.URL.Query().Get("publication_id")
		if publicationID != "" {
			version, err := s.GetPublishedVersionForPublication(r.Context(), workspaceID, appID, publicationID)
			if err != nil {
				handleStoreErr(w, err)
				return
			}

			allowed, err := s.CanUsePublication(r.Context(), publicationID, claims.UserID)
			if err != nil {
				log.Error("check publication access", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "db_error", "failed to verify publication access")
				return
			}
			if !allowed {
				respondErr(w, http.StatusForbidden, "publication_access_denied", "this app is published for discovery only")
				return
			}

			respond(w, http.StatusOK, version)
			return
		}

		access, err := s.GetPublishedAppAccess(r.Context(), workspaceID, appID, claims.UserID)
		if err != nil {
			log.Error("get published app access", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to verify publication access")
			return
		}

		if access.HasActivePublications {
			if !access.HasUseAccess {
				respondErr(w, http.StatusForbidden, "publication_access_denied", "this app is published for discovery only")
				return
			}

			version, err := s.GetLatestUsablePublicationVersion(r.Context(), workspaceID, appID, claims.UserID)
			if err != nil {
				handleStoreErr(w, err)
				return
			}
			respond(w, http.StatusOK, version)
			return
		}

		version, err := s.GetLatestPublishedVersion(r.Context(), workspaceID, appID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, version)
	}
}

// PreviewDraftApp returns the current draft App (DSL + node_metadata) for preview in the builder.
// End-user access is blocked at the router level by the RoleAppBuilder gate on this route.
func PreviewDraftApp(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		app, err := s.GetApp(r.Context(), workspaceID, appID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, app)
	}
}

// auditAppEvent writes a non-fatal audit event for app operations.
func auditAppEvent(ctx context.Context, s *store.Store, log *zap.Logger, claims *Claims, workspaceID, eventType string, resourceID *string) {
	resType := "app"
	event := &model.AuditEvent{
		WorkspaceID:  workspaceID,
		EventType:    eventType,
		ResourceType: &resType,
		ResourceID:   resourceID,
	}
	if claims != nil {
		event.ActorID = &claims.UserID
	}
	if err := s.WriteAuditEvent(ctx, event); err != nil {
		log.Warn("audit write failed", zap.String("event", eventType), zap.Error(err))
	}
}
