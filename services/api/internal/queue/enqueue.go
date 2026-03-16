// Package queue provides a typed Redis enqueuer for the Lima API service.
// Generation and other async jobs are dispatched here and consumed by the
// lima-worker service.
package queue

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/lima/api/internal/model"
	"github.com/redis/go-redis/v9"
)

const (
	jobGeneration = "lima:jobs:generation"
	jobSchema     = "lima:jobs:schema"
	jobWorkflow   = "lima:jobs:workflow"
)

// Enqueuer pushes serialised job payloads onto Redis lists.
type Enqueuer struct {
	client *redis.Client
}

// NewEnqueuer parses redisURL and returns a connected Enqueuer.
// Connection health is verified with a Ping.
func NewEnqueuer(ctx context.Context, redisURL string) (*Enqueuer, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	c := redis.NewClient(opt)
	if err := c.Ping(ctx).Err(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &Enqueuer{client: c}, nil
}

// Close releases the Redis connection.
func (e *Enqueuer) Close() { _ = e.client.Close() }

// EnqueueGeneration pushes a generation job onto the worker queue.
func (e *Enqueuer) EnqueueGeneration(ctx context.Context, p model.GenerationJobPayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal generation payload: %w", err)
	}
	if err := e.client.RPush(ctx, jobGeneration, b).Err(); err != nil {
		return fmt.Errorf("rpush generation: %w", err)
	}
	return nil
}

// EnqueueSchema pushes a schema discovery job onto the worker queue.
func (e *Enqueuer) EnqueueSchema(ctx context.Context, p model.SchemaJobPayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal schema payload: %w", err)
	}
	if err := e.client.RPush(ctx, jobSchema, b).Err(); err != nil {
		return fmt.Errorf("rpush schema: %w", err)
	}
	return nil
}

// EnqueueWorkflow pushes a workflow execution job onto the worker queue.
// Called after a workflow run record is created by TriggerWorkflow.
func (e *Enqueuer) EnqueueWorkflow(ctx context.Context, p model.WorkflowJobPayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal workflow payload: %w", err)
	}
	if err := e.client.RPush(ctx, jobWorkflow, b).Err(); err != nil {
		return fmt.Errorf("rpush workflow: %w", err)
	}
	return nil
}

// EnqueueWorkflowResume pushes a workflow resume job after an approval decision.
// The worker uses this to continue or fail a run that was awaiting_approval.
func (e *Enqueuer) EnqueueWorkflowResume(ctx context.Context, p model.WorkflowResumePayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal workflow resume payload: %w", err)
	}
	if err := e.client.RPush(ctx, jobWorkflow, b).Err(); err != nil {
		return fmt.Errorf("rpush workflow resume: %w", err)
	}
	return nil
}
