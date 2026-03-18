# Lima Implementation Status (Audited)

**Last Updated:** March 18, 2026  
**Audit Basis:** Direct repository inspection plus local build and test runs. This document replaces older status summaries that no longer match the codebase.

## Executive Summary

- Phase 0 is implemented.
- Phase 1 is implemented.
- Phase 2 is no longer a skeleton. The Aura DSL package is complete and tested, and the builder canvas is substantially implemented.
- Phase 3 is implemented, including real OpenAI-compatible and GitHub Copilot generation paths.
- Phase 4 is implemented for connector CRUD, schema discovery, connection tests, CSV import, and relational dashboard queries.
- Phase 5 is implemented for publish, rollback, published runtime rendering, draft preview, and approval decision handling.
- Phase 6 is partially implemented. Workflow CRUD, triggering, query execution, approval gating, and approval resume logic exist, but actual mutation execution remains stubbed.
- Phase 7 is partially implemented. Deployment packaging, upgrade guidance, backup and restore assets, observability hooks, audit retention, audit export, and backup CronJob support exist. Automated deployment drills and some hardening work remain open.

## Validation Run

- `pnpm --filter @lima/aura-dsl test` passed.
- `go test ./services/api/... ./services/worker/...` passed.
- `pnpm --filter @lima/web lint` passed.
- `pnpm --filter @lima/web build` passed.

## Phase Summary

| Phase | Status | Notes |
| --- | --- | --- |
| 0 | Done | Monorepo, migrations, CI, Compose, Helm, ADRs present. |
| 1 | Done | Auth, tenancy, RBAC, JWT claims, tenant checks implemented. |
| 2 | Partial | Aura DSL complete; builder UI substantially implemented rather than stubbed. |
| 3 | Done | Threads, queued generation, protected diff, real LLM calls implemented. |
| 4 | Done | Connector CRUD, schema discovery, tests, import, and relational query support implemented. |
| 5 | Done | Draft and published lifecycle, runtime renderer, preview route, approvals implemented. |
| 6 | Partial | Workflow engine and approval safety exist; connector mutation execution is still stubbed. |
| 7 | Partial | Upgrade docs, backup and restore, Helm packaging, audit retention and export exist; automated drills and some hardening are still open. |

## Detailed Status

### Phase 0 — Repo Structure

- `go.work`, `pnpm-workspace.yaml`, `turbo.json`, and workspace package structure are present.
- SQL migrations `001` through `008` exist under `services/api/migrations`.
- CI and release workflows exist under `.github/workflows`.
- Docker Compose assets exist under `deploy/docker-compose`.
- Helm chart, templates, secrets, HPA, PDB, ingress, migration job, and backup CronJob templates exist under `deploy/helm/lima`.

**Status:** Done.

### Phase 1 — Identity, Tenancy, RBAC

- Auth handlers exist for SSO login, SSO callback, dev login, and logout.
- Workspace role checks and company claim enforcement are wired in the router and middleware.
- Tenant isolation and RBAC tests exist in `services/api/internal/handler`.

**Status:** Done.

### Phase 2 — Aura DSL and Builder Canvas

#### Aura DSL

- Parser, serializer, validator, diff, and apply-diff logic exist in `packages/aura-dsl/src/index.ts`.
- Vitest coverage exists in `packages/aura-dsl/src/index.test.ts`, including multiline quoted values and protected diff behavior.

#### Builder UI

- The builder is no longer limited to app CRUD.
- `CanvasEditor.tsx` implements widget move, resize, delete, selection, and minimap support.
- `page.tsx` wires autosave, undo and redo history, draft preview, publish, chat, layers, inspector, version history, and workflow editor panels.
- `LayersPanel.tsx` provides layer search and quick add and delete controls.
- `useAutosave.ts` and `useDocumentHistory.ts` implement autosave and local document history.

**Status:** Partial, but far more complete than older status summaries implied.

### Phase 3 — AI Generation and Revision Loop

- Threads and messages are implemented in the API.
- Posting a message enqueues generation jobs.
- The worker implements DSL validation and protected diff application before persistence.
- Real OpenAI-compatible HTTP calls and GitHub Copilot SDK calls are implemented.

**Status:** Done.

### Phase 4 — Connectors and Secrets

- Connector CRUD is implemented.
- Connector credentials are encrypted at rest.
- Schema discovery jobs are executed by the worker for supported connector types.
- Connection tests exist for Postgres, MySQL, MSSQL, REST, GraphQL, and CSV.
- CSV import exists and populates schema cache.
- Dashboard read-only queries are implemented for Postgres, MySQL, and MSSQL.
- REST and GraphQL do not expose SQL-style dashboard queries, which is enforced in the API.

**Status:** Done.

### Phase 5 — Publish, Approvals, Runtime Isolation

- App publish, rollback, published-version fetch, and draft preview handlers are implemented.
- The web app uses a published-only runtime route and a separate builder-only draft preview route.
- Runtime rendering is implemented in `RuntimeRenderer.tsx`.
- Approval request creation, approval, rejection, audit logging, and workflow resume enqueueing are implemented.
- The approvals UI in the web app is wired to real approve and reject API calls.

**Status:** Done.

### Phase 6 — Workflows and Mutation Safety

- Workflow CRUD, activation, archive, trigger, run listing, and step review are implemented.
- The worker executes workflow runs, supports query steps, condition steps, notification steps, explicit approval gates, and resume-after-approval flow.
- Query steps support Postgres, MySQL, and MSSQL connectors.
- Mutation steps always create approval gates and fail closed if approval verification fails.
- `executeMutationStep` is still a stub and does not perform connector-side DML or API mutations.

**Status:** Partial.

### Phase 7 — Enterprise and Deployment

- Docker Compose assets exist for Postgres, Redis, migrations, OTEL, Prometheus, and Grafana.
- Helm templates exist for API, worker, web, ingress, HPA, PDB, secrets, migrations, and backups.
- `backup.sh` and `restore.sh` are functional scripts, not empty placeholders.
- `UPGRADING.md` includes Compose upgrades, Helm upgrades, rollback, key rotation guidance, audit retention guidance, HA guidance, and observability notes.
- Audit retention migration, audit export handler, export store query, and prune method all exist.
- CI includes TypeScript checks, Go tests, Aura DSL tests, and Docker image build smoke tests.

**Status:** Partial.

## Corrections To Earlier Status Notes

- The builder canvas is not a stub.
- The published runtime route is not a stub.
- Draft preview is implemented.
- Approval decision handlers are not stubs.
- AI settings handlers are not stubs.
- The worker dispatcher is not a stub.
- Schema discovery is executed by the worker rather than only enqueued.
- LLM calls are real rather than mocked.
- Backup and restore scripts are functional.

## Confirmed Remaining Gaps

- Connector mutation execution remains stubbed in the workflow worker.
- The repository does not contain automated Compose or Helm install, upgrade, restore, audit export, or tenant-leakage drills.
- The upgrade guide references a re-encryption admin endpoint or migration script, but no such implementation was found in the repository.
- Audit retention pruning is implemented as a store method, but no scheduled prune job was found in the deployment manifests.
- Worker runtime paths have no direct test files in `services/worker`.
- Database-enforced RBAC or row-level security policies were not found in the SQL migrations.

## Recommended Reference

- Use this file as the current-state implementation summary.
- Use `docs/phase7-and-mutation-gap-audit-2026-03-18.md` as the focused tracker for the remaining operational and workflow execution gaps.