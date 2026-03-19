package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/db"
	"github.com/lima/worker/internal/observability"
	"github.com/lima/worker/internal/queue"
	"go.uber.org/zap"
)

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

	// DB is optional: worker starts without it but LLM generation is disabled.
	pool, dbErr := db.Connect(db.ConnConfig{
		URL:      cfg.DatabaseURL,
		MaxConns: cfg.DBMaxConns,
		MinConns: cfg.DBMinConns,
	})
	if dbErr != nil {
		log.Warn("db connect failed — generation jobs will be skipped", zap.Error(dbErr))
	} else {
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
