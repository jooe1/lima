-- Migration: 018_workflow_step_branching.up.sql
-- Adds explicit graph-traversal fields to workflow_steps.
-- next_step_id:         the step to execute after this one completes successfully
-- false_branch_step_id: the step to execute when this condition step evaluates to false
-- Both nullable; NULL means "fall through to the step with step_order + 1".

ALTER TABLE workflow_steps
    ADD COLUMN next_step_id         UUID REFERENCES workflow_steps(id) ON DELETE SET NULL,
    ADD COLUMN false_branch_step_id UUID REFERENCES workflow_steps(id) ON DELETE SET NULL;

COMMENT ON COLUMN workflow_steps.next_step_id         IS 'Explicit next step; NULL = linear fallback to step_order + 1';
COMMENT ON COLUMN workflow_steps.false_branch_step_id IS 'False branch for condition steps; NULL = stop on false';
