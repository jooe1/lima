package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/handler"
	"github.com/lima/api/internal/middleware"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

func New(cfg *config.Config, pool *pgxpool.Pool, s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.Handler {
	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.Logger(log))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Request-ID"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check — unauthenticated
	r.Get("/healthz", handler.Healthz(pool))

	// Versioned API
	r.Route("/v1", func(r chi.Router) {
		// Auth — no JWT required
		r.Route("/auth", func(r chi.Router) {
			r.Get("/sso/login", handler.SSOLogin(cfg, log))
			r.Get("/sso/callback", handler.SSOCallback(cfg, s, log))
			r.Post("/logout", handler.Logout)
			if cfg.Env == "development" {
				r.Post("/dev/login", handler.DevLogin(cfg, s, log))
			}
		})

		// All routes below require a valid session JWT
		r.Group(func(r chi.Router) {
			r.Use(handler.Authenticate(cfg.JWTSecret))

			r.Route("/me", func(r chi.Router) {
				r.Get("/ai-settings", handler.GetMyAISettings(s, log))
				r.Put("/ai-settings", handler.PutMyAISettings(cfg, s, log))
			})

			// Identity & tenancy — company claim is verified per-route
			r.Route("/companies/{companyID}", func(r chi.Router) {
				r.Use(handler.RequireCompanyClaim)
				r.Get("/", handler.GetCompany(s, log))
				r.Route("/workspaces", func(r chi.Router) {
					r.Get("/", handler.ListWorkspaces(s, log))
					r.Post("/", handler.CreateWorkspace(s, log))
					r.Route("/{workspaceID}", func(r chi.Router) {
						r.Get("/", handler.GetWorkspace(s, log))
						r.Get("/members", handler.ListMembers(s, log))
					})
				})
			})

			// Workspace-scoped routes — require at least end_user membership
			r.Route("/workspaces/{workspaceID}", func(r chi.Router) {
				r.Use(handler.RequireWorkspaceRole(s, log, model.RoleEndUser))

				// Apps (draft/publish lifecycle)
				r.Route("/apps", func(r chi.Router) {
					r.Get("/", handler.ListApps(s, log))
					// Builders and admins can create apps
					r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
						Post("/", handler.CreateApp(s, log))
					r.Route("/{appID}", func(r chi.Router) {
						r.Get("/", handler.GetApp(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
							Patch("/", handler.PatchApp(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
							Delete("/", handler.DeleteApp(s, log))
						// Publish and rollback require admin approval
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/publish", handler.PublishApp(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/rollback", handler.RollbackApp(s, log))
						r.Get("/versions", handler.ListAppVersions(s, log))

						// Conversation threads (Phase 3)
						r.Route("/threads", func(r chi.Router) {
							r.Get("/", handler.ListThreads(s, log))
							r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
								Post("/", handler.CreateThread(s, log))
							r.Route("/{threadID}", func(r chi.Router) {
								r.Get("/", handler.GetThread(s, log))
								r.Get("/messages", handler.ListMessages(s, log))
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Post("/messages", handler.PostMessage(s, enq, log))
							})
						})
					})
				})

				// Connectors
				r.Route("/connectors", func(r chi.Router) {
					r.Get("/", handler.ListConnectors(s, log))
					r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
						Post("/", handler.CreateConnector(cfg, s, enq, log))
					r.Route("/{connectorID}", func(r chi.Router) {
						r.Get("/", handler.GetConnector(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Patch("/", handler.PatchConnector(cfg, s, enq, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Delete("/", handler.DeleteConnector(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/test", handler.TestConnector(cfg, s, log))
						r.Get("/schema", handler.GetConnectorSchema(s, enq, log))
					})
				})

				// Write-approval queue (FR-15)
				r.Route("/approvals", func(r chi.Router) {
					r.Get("/", handler.ListApprovals(s, log))
					r.Route("/{approvalID}", func(r chi.Router) {
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/approve", handler.ApproveAction(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/reject", handler.RejectAction(s, log))
					})
				})

				// Audit log
				r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
					Get("/audit", handler.ListAuditEvents(s, log))
			})
		})
	})

	return r
}
