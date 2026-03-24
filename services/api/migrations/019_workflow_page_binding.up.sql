-- Migration: 019_workflow_page_binding.up.sql
-- Adds page-binding support to workflows: a widget on a page can own a workflow
-- (source_widget_id / source_page_id), and the workflow can push results back
-- to widgets via output_bindings once complete.

ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS source_widget_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS source_page_id   TEXT NULL,
    ADD COLUMN IF NOT EXISTS output_bindings  JSONB NULL;

COMMENT ON COLUMN workflows.source_widget_id IS 'Widget ID that triggered creation of this page-bound workflow; immutable once set';
COMMENT ON COLUMN workflows.source_page_id   IS 'Page ID the source widget lives on; immutable once set';
COMMENT ON COLUMN workflows.output_bindings  IS 'Array of output binding objects: [{"trigger_step_id","widget_id","port","page_id"}]';

-- orphaned: source widget no longer exists on its page; workflow is inert
ALTER TYPE workflow_status ADD VALUE IF NOT EXISTS 'orphaned';
