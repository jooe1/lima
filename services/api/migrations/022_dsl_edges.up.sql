-- Migration 022: add dsl_edges and dsl_version to the apps table
-- dsl_edges stores AuraEdge[] JSON for the dual-layer graph canvas (Phase 1)
-- dsl_version tracks document format: 1 = legacy (no edges), 2 = V2 with edges
ALTER TABLE apps ADD COLUMN dsl_edges   JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN dsl_version INTEGER NOT NULL DEFAULT 1;
