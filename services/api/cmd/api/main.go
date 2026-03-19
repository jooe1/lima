package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/db"
	"github.com/lima/api/internal/maintenance"
	"github.com/lima/api/internal/observability"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/router"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

func main() {
	cfg := config.Load()

	log := newLogger(cfg.Env)
	defer func() {
		if syncErr := log.Sync(); syncErr != nil {
			_, _ = fmt.Fprintf(os.Stderr, "logger sync failed: %v\n", syncErr)
		}
	}()

	if err := run(cfg, log, os.Args[1:]); err != nil {
		log.Fatal("command failed", zap.Error(err))
	}
}

func run(cfg *config.Config, log *zap.Logger, args []string) error {
	if len(args) == 0 {
		return serve(cfg, log)
	}

	switch args[0] {
	case "serve":
		if len(args) > 1 {
			return fmt.Errorf("serve does not accept arguments")
		}
		return serve(cfg, log)
	case "maintenance":
		return runMaintenance(cfg, log, args[1:])
	case "help", "-h", "--help":
		fmt.Fprintln(os.Stdout, usageText())
		return nil
	default:
		return fmt.Errorf("unknown command %q\n%s", args[0], usageText())
	}
}

func serve(cfg *config.Config, log *zap.Logger) error {
	shutdown, err := observability.InitTracer(cfg.OTELEndpoint, cfg.ServiceName)
	if err != nil {
		return fmt.Errorf("tracer init failed: %w", err)
	}
	defer func() {
		if shutdownErr := shutdown(context.Background()); shutdownErr != nil {
			log.Error("tracer shutdown failed", zap.Error(shutdownErr))
		}
	}()

	pool, err := db.Connect(db.ConnConfig{
		URL:      cfg.DatabaseURL,
		MaxConns: cfg.DBMaxConns,
		MinConns: cfg.DBMinConns,
	})
	if err != nil {
		return fmt.Errorf("db connect failed: %w", err)
	}
	defer pool.Close()

	s := store.New(pool)

	// Enqueuer is optional only when Redis is not configured. If REDIS_URL is
	// set, fail startup after a few retries so queue-backed features do not
	// silently degrade into stuck pending runs.
	var enq *queue.Enqueuer
	if cfg.RedisURL != "" {
		for attempt := 1; attempt <= 5; attempt++ {
			enq, err = queue.NewEnqueuer(context.Background(), cfg.RedisURL)
			if err == nil {
				defer enq.Close()
				break
			}
			if attempt == 5 {
				return fmt.Errorf("redis enqueuer unavailable after retries: %w", err)
			}
			log.Warn("redis enqueuer unavailable, retrying", zap.Int("attempt", attempt), zap.Error(err))
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}

	r := router.New(cfg, pool, s, enq, log)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info("api server starting", zap.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal("server error", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(quit)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("graceful shutdown failed", zap.Error(err))
	}
	log.Info("server stopped")
	return nil
}

func runMaintenance(cfg *config.Config, log *zap.Logger, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("maintenance action is required\n%s", usageText())
	}
	if args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(os.Stdout, usageText())
		return nil
	}

	switch args[0] {
	case "reencrypt-connector-secrets":
		fs := flag.NewFlagSet("reencrypt-connector-secrets", flag.ContinueOnError)
		fs.SetOutput(os.Stdout)
		dryRun := fs.Bool("dry-run", false, "report connectors that would be re-encrypted without writing changes")
		if err := fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if fs.NArg() > 0 {
			return fmt.Errorf("unexpected arguments for reencrypt-connector-secrets: %v", fs.Args())
		}

		pool, err := db.Connect(db.ConnConfig{
			URL:      cfg.DatabaseURL,
			MaxConns: cfg.DBMaxConns,
			MinConns: cfg.DBMinConns,
		})
		if err != nil {
			return fmt.Errorf("db connect failed: %w", err)
		}
		defer pool.Close()

		svc := maintenance.NewService(store.New(pool), cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious)
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()

		result, err := svc.ReencryptConnectorSecrets(ctx, maintenance.ReencryptConnectorSecretsOptions{DryRun: *dryRun})
		for _, failure := range result.Failures {
			log.Error("connector secret re-encryption failed",
				zap.String("workspace_id", failure.WorkspaceID),
				zap.String("connector_id", failure.ConnectorID),
				zap.String("error", failure.Message),
			)
		}
		log.Info("connector secret re-encryption finished",
			zap.Bool("dry_run", *dryRun),
			zap.Int("processed", result.Processed),
			zap.Int("already_current", result.AlreadyCurrent),
			zap.Int("needs_rotation", result.NeedsRotation),
			zap.Int("rotated", result.Rotated),
			zap.Int("failed", result.Failed),
		)
		if err != nil {
			return err
		}
		return nil

	case "prune-audit-events":
		fs := flag.NewFlagSet("prune-audit-events", flag.ContinueOnError)
		fs.SetOutput(os.Stdout)
		if err := fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if fs.NArg() > 0 {
			return fmt.Errorf("unexpected arguments for prune-audit-events: %v", fs.Args())
		}

		pool, err := db.Connect(db.ConnConfig{
			URL:      cfg.DatabaseURL,
			MaxConns: cfg.DBMaxConns,
			MinConns: cfg.DBMinConns,
		})
		if err != nil {
			return fmt.Errorf("db connect failed: %w", err)
		}
		defer pool.Close()

		svc := maintenance.NewService(store.New(pool), cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious)
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()

		result, err := svc.PruneExpiredAuditEvents(ctx)
		if err != nil {
			return err
		}
		log.Info("expired audit events pruned", zap.Int64("deleted", result.Deleted))
		return nil

	default:
		return fmt.Errorf("unknown maintenance action %q\n%s", args[0], usageText())
	}
}

func newLogger(env string) *zap.Logger {
	log, _ := zap.NewProduction()
	if env == "development" {
		log, _ = zap.NewDevelopment()
	}
	return log
}

func usageText() string {
	return `usage:
  api
  api serve
  api maintenance reencrypt-connector-secrets [--dry-run]
  api maintenance prune-audit-events`
}
