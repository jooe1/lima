ALTER TABLE workflow_steps
    DROP COLUMN IF EXISTS false_branch_step_id,
    DROP COLUMN IF EXISTS next_step_id;
