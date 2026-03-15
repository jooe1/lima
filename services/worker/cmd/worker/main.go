package main

import (
	"context"
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
	defer log.Sync()

	shutdown, err := observability.InitTracer(cfg.OTELEndpoint, cfg.ServiceName)
	if err != nil {
		log.Fatal("tracer init failed", zap.Error(err))
	}
	defer shutdown(context.Background())

	// DB is optional: worker starts without it but LLM generation is disabled.
	pool, dbErr := db.Connect(cfg.DatabaseURL)
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
