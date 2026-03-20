package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/db"
	"github.com/lima/worker/internal/observability"
	"github.com/lima/worker/internal/queue"
	"go.uber.org/zap"
)

const dbConnectMaxAttempts = 10

type dbConnectFunc func(db.ConnConfig) (*pgxpool.Pool, error)

func main() {
	cfg := config.Load()

	log, _ := zap.NewProduction()
	if cfg.Env == "development" {
		log, _ = zap.NewDevelopment()
	}
	defer func() {
		if syncErr := log.Sync(); syncErr != nil {
			_, _ = fmt.Fprintf(os.Stderr, "logger sync failed: %v\n", syncErr)
		}
	}()

	shutdown, err := observability.InitTracer(cfg.OTELEndpoint, cfg.ServiceName)
	if err != nil {
		log.Fatal("tracer init failed", zap.Error(err))
	}
	defer func() {
		if shutdownErr := shutdown(context.Background()); shutdownErr != nil {
			log.Error("tracer shutdown failed", zap.Error(shutdownErr))
		}
	}()

	pool, err := openDBPool(cfg, log)
	if err != nil {
		log.Fatal("db connect failed", zap.Error(err))
	}
	if pool != nil {
		defer pool.Close()
	}

	dispatcher := queue.NewDispatcher(cfg, pool, log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Info("worker starting")
	if err := dispatcher.Run(ctx); err != nil {
		log.Error("worker stopped with error", zap.Error(err))
	}
	log.Info("worker stopped")
}

func openDBPool(cfg *config.Config, log *zap.Logger) (*pgxpool.Pool, error) {
	return openDBPoolWithRetries(cfg, log, db.Connect, time.Sleep)
}

func openDBPoolWithRetries(cfg *config.Config, log *zap.Logger, connect dbConnectFunc, sleep func(time.Duration)) (*pgxpool.Pool, error) {
	if cfg.DatabaseURL == "" {
		log.Warn("DATABASE_URL is empty; starting worker without DB-backed job support")
		return nil, nil
	}

	connCfg := db.ConnConfig{
		URL:      cfg.DatabaseURL,
		MaxConns: cfg.DBMaxConns,
		MinConns: cfg.DBMinConns,
	}

	var err error
	for attempt := 1; attempt <= dbConnectMaxAttempts; attempt++ {
		pool, connectErr := connect(connCfg)
		if connectErr == nil {
			return pool, nil
		}
		err = connectErr
		if attempt == dbConnectMaxAttempts {
			return nil, fmt.Errorf("after %d attempts: %w", dbConnectMaxAttempts, err)
		}

		log.Warn("db unavailable, retrying",
			zap.Int("attempt", attempt),
			zap.Int("max_attempts", dbConnectMaxAttempts),
			zap.Error(err),
		)
		sleep(time.Duration(attempt) * time.Second)
	}

	return nil, fmt.Errorf("after %d attempts: db connect retries exhausted", dbConnectMaxAttempts)
}
