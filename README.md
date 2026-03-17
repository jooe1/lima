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
# 1. Start Postgres, Redis, OTEL collector, and Jaeger
cd deploy/docker-compose
docker compose up postgres redis otel-collector jaeger -d

# 2. Run DB migrations
docker compose run --rm migrate

# 3. Start the API service
cd services/api
cp .env.example .env
go run ./cmd/api

# 4. Start the worker
cd services/worker
cp .env.example .env
go run ./cmd/worker

# 5. Start the web app
cd apps/web
cp .env.example .env
pnpm dev
```

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
