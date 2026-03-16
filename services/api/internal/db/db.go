package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ConnConfig holds pool tuning knobs alongside the connection URL.
type ConnConfig struct {
	URL      string
	MaxConns int32 // maximum pool size per process (0 = pgxpool default)
	MinConns int32 // minimum idle connections kept alive (0 = pgxpool default)
}

func Connect(c ConnConfig) (*pgxpool.Pool, error) {
	if c.URL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	cfg, err := pgxpool.ParseConfig(c.URL)
	if err != nil {
		return nil, fmt.Errorf("parse db config: %w", err)
	}

	if c.MaxConns > 0 {
		cfg.MaxConns = c.MaxConns
	}
	if c.MinConns > 0 {
		cfg.MinConns = c.MinConns
	}

	// Keep idle connections warm with a health check interval.
	cfg.HealthCheckPeriod = 30 * time.Second
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	if err := pool.Ping(context.Background()); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}

	return pool, nil
}
