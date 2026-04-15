# Lima

AI-first internal tools platform. Describe an internal tool in natural language; Lima generates an editable canvas app backed by your databases and APIs.

## Repository structure

```
apps/
  web/                  Next.js 15 — builder UI, runtime shell, BFF endpoints
packages/
  aura-dsl/             Aura flat DSL: parser, validator, serializer, diff/merge
  widget-catalog/       Shared widget type contracts and prop schemas
  sdk-connectors/       Connector interfaces, auth helpers, schema adapters
services/
  api/                  Go control-plane (tenancy, apps, connectors, approvals, audit)
  worker/               Go async worker (generation, schema discovery, imports, workflows)
deploy/
  docker-compose/       Local and self-hosted dev environment
  helm/lima/            Kubernetes Helm chart for production / on-prem deployment
docs/
  adr/                  Architecture Decision Records
  requirements/         Source-of-truth requirements document
```

## Prerequisites

| Tool | Version |
|------|---------|
| Node | ≥ 20 |
| pnpm | ≥ 9 |
| Go | 1.23 |
| Docker + Compose | recent stable |

## Quick start (local dev)

```bash
# 0. Install workspace dependencies
pnpm install

# 1. Start Postgres, Redis, OTEL collector, and Jaeger
cd deploy/docker-compose
docker compose up postgres redis otel-collector jaeger -d

# 2. Run DB migrations
docker compose run --rm migrate

# 3. Start the API service
cd services/api
go run ./cmd/api

cp .env.example .env

# 4. Start the worker
cd services/worker
go run ./cmd/worker

cp .env.example .env

# 5. Start the web app
cd apps/web
pnpm dev

cp .env.example .env
```

Local dev note: the Docker Compose stack exposes Postgres on `localhost:5444` and Redis on `localhost:6380`. If you already copied the `.env.example` files before this change, update the existing `.env` files to use those host ports.

Then open http://localhost:3000.

Traces are visible at http://localhost:16686 (Jaeger UI).

## Running tests

> **Note:** The primary development and CI environment is **Linux/macOS** (CI runs
> on `ubuntu-latest`). The `-race` detector requires CGO and is only supported on
> Linux/macOS. Local development on Windows works but omit the `-race` flag.

```bash
# TypeScript tests (aura-dsl)
pnpm --filter "@lima/aura-dsl" test

# Go tests (Linux/macOS — matches CI)
cd services/api && go test ./... -race -timeout 120s
cd services/worker && go test ./... -race -timeout 120s

# Go tests (Windows — omit -race)
# cd services/api && go test ./... -timeout 120s
# cd services/worker && go test ./... -timeout 120s
```

## Build all

```bash
pnpm build          # builds all JS packages and the Next.js app
```

## Architecture decisions

See [docs/adr/](docs/adr/) for the full set of ADRs covering monorepo tooling, tech stack, the Aura DSL, the safety model, and the draft/publish lifecycle.

## What's new — March 23, 2026

### Mutation support: forms and buttons can now write data

Apps can now INSERT, UPDATE, and DELETE records in SQL connectors (Postgres, MySQL, MSSQL), not just read them. Mutations are driven by the existing workflow engine so every write goes through the same approval and audit path.

**For workspace admins**

- New **Permissions tab** on every connector (in the builder's Connectors panel). Grant or revoke per-user/group/workspace `mutate` access without touching workspace-level roles.
- Supported grant actions: `query`, `mutate`, `bind`, `read_schema`, `manage`.

**For app builders**

- Selecting a **Form** or **Button** widget in the Inspector now shows a **Workflow** dropdown instead of a plain text field for the *On submit* / *On click* property. The dropdown lists only workflows whose trigger type matches the widget (`form_submit` or `button_click`). Workflows that require human approval are labelled *(needs approval)*.
- Wire a workflow with one or more `mutation` steps to the widget and publish — no other changes needed.

**For end users**

- Submitting a form or clicking a button bound to a mutation workflow creates a workflow run.
- **End users are always approval-gated**: the run goes to `awaiting_approval` status and a workspace admin must approve it before the SQL write executes. The widget shows "Submitted for approval" immediately.
- **App builders and workspace admins** bypass the per-user grant check. If the workflow's *Requires approval* flag is off, the mutation runs immediately and data widgets on the page refresh automatically.
- If an end user does not have a `mutate` grant on the connector, the submit is rejected with a clear error message — no approval record is created.

**Scope for this release**

- SQL connectors only (Postgres, MySQL, MSSQL). REST and GraphQL mutation support is planned for a future release.
- Tables remain read-only — inline row-delete actions are not included in this release.
- Workflows must be created in the Workflow Editor before being bound to a widget. The builder does not auto-generate workflows from widget configuration.

---

## Implementation status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Monorepo, repo bootstrap, CI/CD, migrations, observability | ✅ Done |
| 1 | Identity, tenancy, SSO, RBAC, audit schema | 🔜 Next |
| 2 | Aura DSL, builder canvas, inspector, undo/redo | 🔜 |
| 3 | AI generation loop, prompt orchestration, chat-to-canvas sync | 🔜 |
| 4 | Connectors: relational, REST, GraphQL, CSV | 🔜 |
| 5 | Runtime shell, preview, publish, approval queue UI | 🔜 |
| 6 | Analytics dashboards, workflows, custom business logic | 🔜 |
| 7 | Enterprise hardening, Helm, backup/restore, HA | 🔜 |
