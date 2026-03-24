-- Migration: 019_workflow_page_binding.down.sql
-- Reverses 019_workflow_page_binding.up.sql.

ALTER TABLE workflows
    DROP COLUMN IF EXISTS output_bindings,
    DROP COLUMN IF EXISTS source_page_id,
    DROP COLUMN IF EXISTS source_widget_id;

-- Postgres does not support ALTER TYPE ... DROP VALUE directly.
-- Recreate workflow_status without 'orphaned', demoting any orphaned rows first.
UPDATE workflows SET status = 'archived' WHERE status = 'orphaned';

ALTER TYPE workflow_status RENAME TO workflow_status_old;
CREATE TYPE workflow_status AS ENUM ('draft', 'active', 'archived');

ALTER TABLE workflows
    ALTER COLUMN status TYPE workflow_status USING status::text::workflow_status;

DROP TYPE workflow_status_old;
