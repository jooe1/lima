// Package queue manages job types and dispatches them to typed worker pools.
// Job types:
//   - generation  — AI prompt processing, DSL emission, and canvas sync
//   - schema       — connector schema and metadata discovery
//   - import       — CSV/spreadsheet ingestion
//   - workflow     — approved workflow action execution
package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// JobType identifies each queue backed by a Redis list.
type JobType string

const (
	JobGeneration JobType = "lima:jobs:generation"
	JobSchema     JobType = "lima:jobs:schema"
	JobImport     JobType = "lima:jobs:import"
	JobWorkflow   JobType = "lima:jobs:workflow"
)

// Dispatcher starts per-type worker pools and routes jobs to them.
type Dispatcher struct {
	cfg    *config.Config
	pool   *pgxpool.Pool // may be nil; generation handler gracefully degrades
	log    *zap.Logger
	client *redis.Client
}

// NewDispatcher creates a Dispatcher. The Redis connection is established
// lazily on Run so that startup failures are loud.
func NewDispatcher(cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger) *Dispatcher {
	return &Dispatcher{cfg: cfg, pool: pool, log: log}
}

// Run starts all worker pools and blocks until ctx is cancelled.
func (d *Dispatcher) Run(ctx context.Context) error {
	opt, err := redis.ParseURL(d.cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse redis url: %w", err)
	}

	for attempt := 1; attempt <= 5; attempt++ {
		client := redis.NewClient(opt)
		if err = client.Ping(ctx).Err(); err == nil {
			d.client = client
			break
		}
		_ = client.Close()
		if attempt == 5 {
			return fmt.Errorf("redis ping: %w", err)
		}
		d.log.Warn("redis unavailable, retrying",
			zap.Int("attempt", attempt),
			zap.Error(err),
		)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt) * time.Second):
		}
	}
	defer d.client.Close()

	var wg sync.WaitGroup

	startPool := func(jobType JobType, concurrency int, handler jobHandler) {
		for range concurrency {
			wg.Add(1)
			go func() {
				defer wg.Done()
				d.runLoop(ctx, jobType, handler)
			}()
		}
	}

	startPool(JobGeneration, d.cfg.GenerationWorkers, handleGeneration(d.cfg, d.pool, d.log))
	startPool(JobSchema, d.cfg.SchemaWorkers, handleSchema(d.cfg, d.pool, d.log))
	startPool(JobImport, d.cfg.ImportWorkers, handleImport(d.cfg, d.pool, d.log))
	startPool(JobWorkflow, 1, handleWorkflow(d.cfg, d.pool, d.log)) // single-threaded for safety

	<-ctx.Done()
	d.log.Info("draining workers")
	wg.Wait()
	return nil
}

type jobHandler func(ctx context.Context, payload []byte) error

// runLoop pops jobs from a Redis BLPOP list and processes them sequentially.
func (d *Dispatcher) runLoop(ctx context.Context, jobType JobType, handler jobHandler) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		result, err := d.client.BLPop(ctx, 0, string(jobType)).Result()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			d.log.Warn("blpop error", zap.String("queue", string(jobType)), zap.Error(err))
			continue
		}

		payload := []byte(result[1])
		if err := handler(ctx, payload); err != nil {
			d.log.Error("job failed",
				zap.String("queue", string(jobType)),
				zap.Error(err),
			)
		}
	}
}

// handleImport returns a jobHandler that processes CSV import jobs.
// The payload follows the same shape as SchemaPayload. It fetches the
// connector's encrypted credentials, runs CSV schema discovery (which also
// parses the data rows from the base64-encoded CSV), and persists the result
// in schema_cache so the runtime query endpoint can serve the data.
func handleImport(cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger) jobHandler {
	return func(ctx context.Context, payload []byte) error {
		var p SchemaPayload
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("unmarshal import payload: %w", err)
		}
		if p.ConnectorID == "" {
			return fmt.Errorf("import payload missing connector_id")
		}
		log.Info("import job started",
			zap.String("connector_id", p.ConnectorID),
			zap.String("workspace_id", p.WorkspaceID),
		)

		if pool == nil {
			return fmt.Errorf("db pool unavailable — cannot run import for %s", p.ConnectorID)
		}

		rec, err := fetchConnectorRecord(ctx, pool, p.ConnectorID, p.WorkspaceID)
		if err != nil {
			return fmt.Errorf("fetch connector %s: %w", p.ConnectorID, err)
		}
		if rec.connectorType != "csv" {
			return fmt.Errorf("import job only supports csv connectors, got %q", rec.connectorType)
		}

		plainCreds, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, rec.encryptedCredentials)
		if err != nil {
			return fmt.Errorf("decrypt credentials: %w", err)
		}

		schemaJSON, err := discoverCSVSchema(plainCreds)
		if err != nil {
			return fmt.Errorf("csv import for %s: %w", p.ConnectorID, err)
		}

		if _, err := pool.Exec(ctx,
			`UPDATE connectors
			 SET schema_cache = $2, schema_cached_at = now(), updated_at = now()
			 WHERE id = $1`,
			p.ConnectorID, schemaJSON,
		); err != nil {
			return fmt.Errorf("persist csv schema cache: %w", err)
		}

		log.Info("import job complete",
			zap.String("connector_id", p.ConnectorID),
		)
		return nil
	}
}
