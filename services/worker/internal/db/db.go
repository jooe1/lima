// Package db provides a PostgreSQL connection pool for the Lima worker.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ConnConfig holds pool tuning parameters alongside the connection URL.
type ConnConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

// Connect opens a pgxpool connection and verifies it with a Ping.
func Connect(c ConnConfig) (*pgxpool.Pool, error) {
	if c.URL == "" {
		return nil, fmt.Errorf("DATABASE_URL is not set")
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
	cfg.HealthCheckPeriod = 30 * time.Second
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db ping: %w", err)
	}
	return pool, nil
}
