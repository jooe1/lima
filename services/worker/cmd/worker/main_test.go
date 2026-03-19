package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/db"
	"go.uber.org/zap"
)

func TestOpenDBPoolWithRetriesSkipsConnectWhenDatabaseURLIsEmpty(t *testing.T) {
	cfg := &config.Config{}
	connectCalls := 0

	pool, err := openDBPoolWithRetries(cfg, zap.NewNop(), func(db.ConnConfig) (*pgxpool.Pool, error) {
		connectCalls++
		return nil, errors.New("should not be called")
	}, func(time.Duration) {})
	if err != nil {
		t.Fatalf("openDBPoolWithRetries() error = %v", err)
	}
	if pool != nil {
		t.Fatal("openDBPoolWithRetries() returned non-nil pool for empty DATABASE_URL")
	}
	if connectCalls != 0 {
		t.Fatalf("openDBPoolWithRetries() connect calls = %d, want 0", connectCalls)
	}
}

func TestOpenDBPoolWithRetriesRetriesUntilSuccess(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL: "postgres://worker:test@localhost:5432/lima",
		DBMaxConns:  7,
		DBMinConns:  2,
	}
	wantPool := &pgxpool.Pool{}
	connectCalls := 0
	var sleepDurations []time.Duration

	pool, err := openDBPoolWithRetries(cfg, zap.NewNop(), func(connCfg db.ConnConfig) (*pgxpool.Pool, error) {
		connectCalls++
		if connCfg.URL != cfg.DatabaseURL {
			t.Fatalf("connect URL = %q, want %q", connCfg.URL, cfg.DatabaseURL)
		}
		if connCfg.MaxConns != cfg.DBMaxConns {
			t.Fatalf("connect MaxConns = %d, want %d", connCfg.MaxConns, cfg.DBMaxConns)
		}
		if connCfg.MinConns != cfg.DBMinConns {
			t.Fatalf("connect MinConns = %d, want %d", connCfg.MinConns, cfg.DBMinConns)
		}
		if connectCalls < 3 {
			return nil, errors.New("db still starting")
		}
		return wantPool, nil
	}, func(d time.Duration) {
		sleepDurations = append(sleepDurations, d)
	})
	if err != nil {
		t.Fatalf("openDBPoolWithRetries() error = %v", err)
	}
	if pool != wantPool {
		t.Fatal("openDBPoolWithRetries() returned wrong pool")
	}
	if connectCalls != 3 {
		t.Fatalf("openDBPoolWithRetries() connect calls = %d, want 3", connectCalls)
	}
	wantSleeps := []time.Duration{time.Second, 2 * time.Second}
	if len(sleepDurations) != len(wantSleeps) {
		t.Fatalf("sleep count = %d, want %d", len(sleepDurations), len(wantSleeps))
	}
	for i, want := range wantSleeps {
		if sleepDurations[i] != want {
			t.Fatalf("sleep[%d] = %s, want %s", i, sleepDurations[i], want)
		}
	}
}

func TestOpenDBPoolWithRetriesFailsAfterMaxAttempts(t *testing.T) {
	cfg := &config.Config{DatabaseURL: "postgres://worker:test@localhost:5432/lima"}
	connectCalls := 0
	var sleepDurations []time.Duration

	pool, err := openDBPoolWithRetries(cfg, zap.NewNop(), func(db.ConnConfig) (*pgxpool.Pool, error) {
		connectCalls++
		return nil, errors.New("db unavailable")
	}, func(d time.Duration) {
		sleepDurations = append(sleepDurations, d)
	})
	if err == nil {
		t.Fatal("openDBPoolWithRetries() error = nil, want non-nil")
	}
	if !strings.Contains(err.Error(), "after 5 attempts") {
		t.Fatalf("openDBPoolWithRetries() error = %q, want attempts context", err.Error())
	}
	if pool != nil {
		t.Fatal("openDBPoolWithRetries() returned non-nil pool on failure")
	}
	if connectCalls != dbConnectMaxAttempts {
		t.Fatalf("openDBPoolWithRetries() connect calls = %d, want %d", connectCalls, dbConnectMaxAttempts)
	}
	wantSleeps := []time.Duration{time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second}
	if len(sleepDurations) != len(wantSleeps) {
		t.Fatalf("sleep count = %d, want %d", len(sleepDurations), len(wantSleeps))
	}
	for i, want := range wantSleeps {
		if sleepDurations[i] != want {
			t.Fatalf("sleep[%d] = %s, want %s", i, sleepDurations[i], want)
		}
	}
}
