-- Migration: 007_create_workflows.down.sql

DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflow_steps;
DROP TABLE IF EXISTS workflows;
DROP TYPE IF EXISTS workflow_run_status;
DROP TYPE IF EXISTS workflow_step_type;
DROP TYPE IF EXISTS workflow_status;
DROP TYPE IF EXISTS workflow_trigger;
