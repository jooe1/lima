# Phase 7 And Mutation Gap Audit

**Last Updated:** March 18, 2026  
**Scope:** Remaining gaps only. This audit intentionally excludes items that are already implemented in code, even if older status notes still call them stubbed.

## Non-Gaps Confirmed During Audit

- The builder canvas is implemented with move, resize, delete, autosave, undo and redo, layers, search, and minimap.
- Published runtime rendering is implemented.
- Builder-only draft preview is implemented.
- Approval creation, approve and reject handlers, and workflow resume enqueueing are implemented.
- Worker generation, worker schema discovery, and worker dispatch loops are implemented.
- Backup and restore scripts exist and contain real shell logic.
- Upgrade, rollback, HA, and observability guidance exist in `UPGRADING.md`.
- Audit export and audit pruning code exist.

## Confirmed Remaining Gaps

### 1. Connector Mutation Execution Is Still Stubbed

**Severity:** Critical

`services/worker/internal/queue/workflow.go` still leaves `executeMutationStep` as a documented stub.

- Mutation approval gating exists.
- Approval payload verification exists.
- Resume-after-approval exists.
- Actual write execution does not exist.

What is missing:

- Postgres, MySQL, and MSSQL mutation dispatch in a write-capable transaction.
- REST and GraphQL mutation dispatch using connector credentials and request config.
- Clear step-level success and failure outputs based on real side effects.
- Tests that prove a mutation step only reports success after the external write actually happens.

Operational consequence:

- Workflow history can move through approval and resume paths, but approved mutations currently end in a placeholder result rather than a real external change.

Completion criteria:

- Implement connector-specific mutation executors.
- Ensure every mutation path returns concrete execution output or a concrete error.
- Add worker tests that prove fail-closed behavior and successful post-approval execution.

### 2. Secret Rotation Cannot Be Completed End To End From Repository Code Alone

**Severity:** High

`UPGRADING.md` describes a safe key-rotation process using `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` and then instructs operators to re-encrypt all stored connector ciphertexts with an admin endpoint or migration script.

What exists:

- Current and previous key configuration exists in API and worker config.
- Decrypt-with-rotation support exists.
- Compose and Helm templates expose the previous-key setting.

What is missing:

- No re-encryption admin endpoint was found.
- No repository migration script or CLI for bulk re-encryption was found.

Operational consequence:

- The documented rotation flow is only partially implemented. Operators can stage old and new keys, but the repository does not provide the final bulk re-encryption mechanism needed to retire the previous key safely.

Completion criteria:

- Add an authenticated admin endpoint, CLI, or maintenance job that rewrites existing encrypted connector and related secret blobs with the new key.
- Add an operational check proving old ciphertexts were fully re-encrypted before the previous key is removed.

### 3. Phase 7 Deployment Drills Are Not Automated

**Severity:** High

The repository contains packaging and documentation, but it does not yet automate the deeper release-readiness drills described in `docs/plan-new`.

What exists:

- CI runs TypeScript build and lint, Go tests, Aura DSL tests, and Docker build smoke.
- Release workflow builds and publishes container images.
- Compose and Helm assets exist.

What is missing:

- No CI or release job was found for fresh Compose installation validation.
- No CI or release job was found for fresh Helm installation validation.
- No automated upgrade-preservation drill was found.
- No automated backup and restore drill was found.
- No automated audit export check was found.
- No automated tenant-leakage validation was found.

Operational consequence:

- Self-hosted readiness is still being inferred from manifests and documentation rather than exercised automatically.

Completion criteria:

- Add scripted install, migrate, publish, upgrade, backup, restore, and audit-export checks for both Compose and Helm paths.
- Make those checks blocking for release promotion.

### 4. Audit Retention Pruning Is Implemented But Not Scheduled

**Severity:** Medium

The repository includes the retention column, append-only protections, export path, and prune method.

What exists:

- Migration `008_audit_retention.up.sql` adds `expires_at` and append-only behavior.
- `ExportAuditEventsCSV` exists.
- `Store.ExportAuditEvents` exists.
- `Store.PruneExpiredAuditEvents` exists.

What is missing:

- No deployment manifest or scheduled job dedicated to audit pruning was found.
- The Helm templates include a backup CronJob, but no audit prune CronJob was found.

Operational consequence:

- Expired audit rows can accumulate indefinitely unless an operator wires pruning outside the repository.

Completion criteria:

- Add an audit prune CronJob or worker task with safe scheduling and observability.
- Add an operational check proving pruning only removes expired rows.

### 5. Worker Runtime Paths Have No Direct Tests

**Severity:** Medium

`go test ./services/worker/...` passes, but the worker package has no `_test.go` files.

What exists:

- The worker builds and compiles successfully.
- The API has a small handler test suite.

What is missing:

- No worker tests for generation flow.
- No worker tests for schema discovery flow.
- No worker tests for workflow execution or approval resume.
- No worker tests for mutation fail-closed behavior.

Operational consequence:

- The highest-risk background execution paths are only compile-validated.

Completion criteria:

- Add focused unit and integration tests around generation, schema, workflow query, approval resume, and mutation execution paths.

### 6. Database Hardening Stops Short Of Database-Enforced Isolation

**Severity:** Medium

Tenant isolation and RBAC are enforced in application code and middleware, but the SQL migrations do not currently show database roles, grants, or row-level policies for tenant isolation.

What exists:

- Middleware-enforced tenancy and workspace role checks.
- Audit append-only DB protections.
- Encryption for connector credentials, AI secrets, and approval payloads.

What is missing:

- No `CREATE ROLE`, `GRANT`, or row-level security policy definitions were found in the migrations.
- No general field-level encryption scheme was found for app data beyond secret blobs and approval payloads.

Operational consequence:

- The database still trusts the application tier for most access control boundaries.

Completion criteria:

- Decide whether production posture requires DB roles, row-level security, or both.
- Implement the corresponding migrations and connection strategy.
- Document which data classes require encryption beyond credentials and approval payloads.

## Suggested Execution Order

1. Implement real connector mutation execution.
2. Add worker tests around approval resume and mutation safety.
3. Add a supported re-encryption path for key rotation.
4. Automate Compose and Helm install, upgrade, backup, restore, and audit-export drills.
5. Add scheduled audit pruning.
6. Decide whether database-enforced isolation and broader field-level encryption are required for production.