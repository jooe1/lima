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
	r.Get("/livez", handler.Livez())
	r.Get("/healthz", handler.Healthz(pool))
	r.Handle("/metrics", handler.Metrics())

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
						r.Post("/members", handler.UpsertMember(s, log))
						r.Delete("/members/{userID}", handler.DeleteMember(s, log))
						r.Get("/access-policy", handler.GetAccessPolicy(s, log))
						r.Put("/access-policy", handler.PutAccessPolicy(s, log))
					})
				})

				// Company-scoped resources (connectors with owner_scope='company')
				r.Route("/resources", func(r chi.Router) {
					r.Get("/", handler.ListCompanyResources(s, log))
					r.Post("/", handler.CreateCompanyResource(cfg, s, enq, log))
					r.Route("/{resourceID}", func(r chi.Router) {
						r.Get("/", handler.GetCompanyResource(s, log))
						r.Patch("/", handler.UpdateCompanyResource(cfg, s, enq, log))
						r.Delete("/", handler.DeleteCompanyResource(s, log))
						r.Get("/grants", handler.ListResourceGrants(s, log))
						r.Post("/grants", handler.CreateResourceGrant(s, log))
						r.Delete("/grants/{grantID}", handler.DeleteResourceGrant(s, log))
					})
				})

				// Company groups and memberships
				r.Route("/groups", func(r chi.Router) {
					r.Get("/", handler.ListGroups(s, log))
					r.Post("/", handler.CreateGroup(s, log))
					r.Route("/{groupID}", func(r chi.Router) {
						r.Delete("/", handler.DeleteGroup(s, log))
						r.Get("/members", handler.ListGroupMembers(s, log))
						r.Post("/members", handler.AddGroupMember(s, log))
						r.Delete("/members/{userID}", handler.RemoveGroupMember(s, log))
					})
				})

				// Company-scoped tool discovery
				r.Get("/tools", handler.ListCompanyTools(s, log))
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
						// Runtime: published DSL — only returns data for published apps (enforces isolation)
						r.Get("/published", handler.GetPublishedApp(s, log))
						// Builder draft preview — requires app_builder or admin; end_user is blocked
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
							Get("/preview", handler.PreviewDraftApp(s, log))

						// Publications (Phase 7)
						r.Route("/publications", func(r chi.Router) {
							r.Get("/", handler.ListPublications(s, log))
							r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
								Post("/", handler.CreatePublication(s, log))
							r.Route("/{publicationID}", func(r chi.Router) {
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Delete("/", handler.ArchivePublication(s, log))
								r.Get("/audiences", handler.GetPublicationAudiences(s, log))
							})
						})

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

						// Workflows (Phase 6)
						r.Route("/workflows", func(r chi.Router) {
							r.Get("/", handler.ListWorkflows(s, log))
							r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
								Post("/", handler.CreateWorkflow(s, log))
							r.Route("/{workflowID}", func(r chi.Router) {
								r.Get("/", handler.GetWorkflow(s, log))
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Patch("/", handler.PatchWorkflow(s, log))
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Delete("/", handler.DeleteWorkflow(s, log))
								// Only admins may activate a workflow (FR-15 / FR-19)
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
									Post("/activate", handler.ActivateWorkflow(s, log))
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Post("/archive", handler.ArchiveWorkflow(s, log))
									// Manual trigger creates a run record and enqueues an execution job
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleEndUser)).
									Post("/trigger", handler.TriggerWorkflow(cfg, s, enq, log))
								r.Get("/runs", handler.ListWorkflowRuns(s, log))
								// Step management
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Put("/steps", handler.PutWorkflowSteps(s, log))
								r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
									Post("/steps/{stepID}/review", handler.ReviewStep(s, log))
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
						r.Get("/schema", handler.GetConnectorSchema(cfg, s, enq, log))
						// Dashboard read-only query (Phase 6) — any workspace member may query
						r.Post("/query", handler.RunQuery(cfg, s, log))
						// CSV file import — builders and admins may upload data
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleAppBuilder)).
							Post("/import", handler.ImportCSV(s, log))
						// Connector resource grants — workspace_admin only (Phase 2)
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Get("/grants", handler.ListConnectorGrants(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/grants", handler.CreateConnectorGrant(s, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Delete("/grants/{grantID}", handler.DeleteConnectorGrant(s, log))
					})
				})

				// Write-approval queue (FR-15)
				r.Route("/approvals", func(r chi.Router) {
					r.Get("/", handler.ListApprovals(s, log))
					r.Post("/", handler.CreateApproval(cfg, s, log))
					r.Route("/{approvalID}", func(r chi.Router) {
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/approve", handler.ApproveAction(s, enq, log))
						r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
							Post("/reject", handler.RejectAction(s, enq, log))
					})
				})

				// Audit log
				r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
					Get("/audit", handler.ListAuditEvents(s, log))
				r.With(handler.RequireWorkspaceRole(s, log, model.RoleWorkspaceAdmin)).
					Get("/audit/export", handler.ExportAuditEventsCSV(s, log))
			})
		})
	})

	return r
}
