package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/db"
	"github.com/lima/api/internal/observability"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/router"
	"github.com/lima/api/internal/store"
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

	pool, err := db.Connect(db.ConnConfig{
		URL:      cfg.DatabaseURL,
		MaxConns: cfg.DBMaxConns,
		MinConns: cfg.DBMinConns,
	})
	if err != nil {
		log.Fatal("db connect failed", zap.Error(err))
	}
	defer pool.Close()

	s := store.New(pool)

	// Enqueuer is optional — if Redis is not configured the API still serves
	// HTTP but generation jobs are not dispatched.
	var enq *queue.Enqueuer
	if cfg.RedisURL != "" {
		enq, err = queue.NewEnqueuer(context.Background(), cfg.RedisURL)
		if err != nil {
			log.Warn("redis enqueuer unavailable — generation jobs disabled", zap.Error(err))
		} else {
			defer enq.Close()
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
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("graceful shutdown failed", zap.Error(err))
	}
	log.Info("server stopped")
}
