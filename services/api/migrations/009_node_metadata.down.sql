-- Migration: 009_node_metadata.down.sql
ALTER TABLE apps DROP COLUMN IF EXISTS node_metadata;
ALTER TABLE app_versions DROP COLUMN IF EXISTS node_metadata;
