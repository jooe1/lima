-- Allow managed_table_rows to be inserted without a triggering user (e.g.
-- system-generated rows or rows inserted by workflows whose run has no
-- authenticated user attached).
ALTER TABLE managed_table_rows ALTER COLUMN created_by DROP NOT NULL;
