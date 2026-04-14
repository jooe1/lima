// Package queue manages job types and dispatches them to typed worker pools.
// Job types:
//   - generation  — AI prompt processing, DSL emission, and canvas sync
//   - schema       — connector schema and metadata discovery
//   - workflow     — approved workflow action execution
package queue

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// JobType identifies each queue backed by a Redis list.
type JobType string

const (
	JobGeneration           JobType = "lima:jobs:generation"
	JobSchema               JobType = "lima:jobs:schema"
	JobWorkflow             JobType = "lima:jobs:workflow"
	redisConnectMaxAttempts         = 10
)

// Dispatcher starts per-type worker pools and routes jobs to them.
type Dispatcher struct {
	cfg    *config.Config
	pool   *pgxpool.Pool // may be nil only when DATABASE_URL is unset at startup
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

	for attempt := 1; attempt <= redisConnectMaxAttempts; attempt++ {
		client := redis.NewClient(opt)
		if err = client.Ping(ctx).Err(); err == nil {
			d.client = client
			break
		}
		_ = client.Close()
		if attempt == redisConnectMaxAttempts {
			return fmt.Errorf("redis ping: %w", err)
		}
		d.log.Warn("redis unavailable, retrying",
			zap.Int("attempt", attempt),
			zap.Int("max_attempts", redisConnectMaxAttempts),
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
	startPool(JobWorkflow, 1, handleWorkflow(d.cfg, d.pool, d.client, d.log)) // single-threaded for safety

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
