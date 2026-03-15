// Package store provides typed database query functions for the Lima API.
package store

import (
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store holds the database connection pool and exposes all query methods.
type Store struct {
	pool *pgxpool.Pool
}

// New creates a Store backed by the given connection pool.
func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}
