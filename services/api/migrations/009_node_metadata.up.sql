-- Migration: 009_node_metadata.up.sql
-- Adds a JSONB column to persist per-node metadata (e.g. manuallyEdited flag)
-- separately from the DSL source text.

ALTER TABLE apps ADD COLUMN IF NOT EXISTS node_metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE app_versions ADD COLUMN IF NOT EXISTS node_metadata JSONB NOT NULL DEFAULT '{}';
