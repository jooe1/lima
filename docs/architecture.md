## 0. System Overview

Lima is an AI-first internal tools platform. Users describe internal tools in natural language, and Lima generates editable canvas apps backed by databases and APIs. The repository is a monorepo containing the web UI, backend services, shared packages, and deployment configurations.

## 1. Tech Stack

| Layer         | Technology                                    | Rationale                                                      |
|-------------- |-----------------------------------------------|----------------------------------------------------------------|
| Frontend      | Next.js 15, React, TypeScript                 | Modern, composable UI, SSR/SSG, strong type safety             |
| Backend API   | Go 1.23+, chi, pgx, zap, OpenTelemetry        | High performance, strong concurrency, observability, logging   |
| Worker        | Go 1.23+, pgx, zap, OpenTelemetry, Copilot SDK| Async job processing, AI integration, observability            |
| Shared Libs   | TypeScript, tsup, Vitest                      | Code reuse, type safety, fast builds, unit testing             |
| DevOps        | Docker, Docker Compose, Helm, TurboRepo, pnpm | Containerization, orchestration, monorepo tooling              |

## 2. Folder Structure

| Folder/File                | Description                                                      |
|---------------------------|------------------------------------------------------------------|
| README.md                  | Project overview and quick start                                 |
| package.json               | Monorepo and package management (pnpm)                           |
| go.work                    | Go workspace configuration for backend services                  |
| turbo.json                 | TurboRepo build orchestration                                    |
| apps/web                   | Next.js frontend app (UI, builder, auth, dashboards)             |
| packages/aura-dsl          | Aura DSL parser, validator, serializer, diff/merge               |
| packages/sdk-connectors     | Connector interfaces, credential models, schema adapters         |
| packages/widget-catalog    | Widget type contracts, property schemas, registry                |
| services/api               | Go backend API service (HTTP, business logic, DB, tenancy)       |
| services/worker            | Go async worker (AI generation, schema, workflows)               |
| deploy/docker-compose      | Local dev environment (Postgres, Redis, OTEL, Jaeger)            |
| deploy/helm/lima           | Helm chart for production/on-prem deployment                     |

## 3. Key Files

| File/Filename                                 | Role                                                        |
|-----------------------------------------------|-------------------------------------------------------------|
| README.md                                     | Project purpose, structure, and setup                       |
| package.json                                  | Declares monorepo, scripts, dependencies                    |
| go.work                                       | Go workspace for backend modules                            |
| turbo.json                                    | TurboRepo pipeline config                                   |
| apps/web/package.json                         | Declares frontend dependencies, scripts                     |
| apps/web/next.config.ts                       | Next.js configuration, output, rewrites                     |
| apps/web/lib/api.ts                           | API request logic for frontend                              |
| apps/web/lib/auth.tsx                         | Authentication context for frontend                         |
| packages/aura-dsl/src/index.ts                | Aura DSL core logic                                         |
| packages/aura-dsl/src/index.test.ts           | Vitest test suite for DSL                                   |
| packages/sdk-connectors/src/index.ts          | Connector type definitions                                  |
| packages/widget-catalog/src/index.ts          | Widget type/prop schemas, registry                          |
| services/api/cmd/api/main.go                  | API service entrypoint                                      |
| services/api/internal/handler/                | HTTP handlers for business logic                            |
| services/api/internal/model/                  | Data models and business types                              |
| services/api/migrations/                      | SQL migrations for schema                                   |
| services/worker/cmd/worker/main.go            | Worker entrypoint                                           |
| services/worker/internal/queue/dispatcher.go   | Job dispatcher, worker pools                                |
| services/worker/internal/queue/generation.go   | AI-driven UI generation jobs                                |
| services/worker/internal/queue/workflow.go     | Workflow execution/resume logic                             |

## 4. Conventions

- Monorepo managed with pnpm and TurboRepo
- TypeScript for all frontend and shared packages
- Go modules for backend services
- Next.js app directory structure for frontend
- Internal packages are imported via monorepo aliases
- SQL migrations managed in services/api/migrations
- Tests colocated with implementation (e.g., `index.test.ts`, `*_test.go`)

## 5. Integration Points

| System         | Direction   | Connection Method/Details                                      |
|----------------|------------|---------------------------------------------------------------|
| Web frontend   | → API      | HTTP/JSON via BFF endpoints, Next.js API routes                |
| API service    | ↔ Database | PostgreSQL via pgx driver                                      |
| API service    | ↔ Redis    | Job queue, session/cache via go-redis                          |
| Worker         | ↔ API DB   | Reads/writes app/workflow/job data via PostgreSQL              |
| Worker         | ↔ Redis    | Job queue management                                           |
| Worker         | → OpenAI   | AI-driven UI generation (via Copilot SDK)                      |
| All services   | → OTEL     | Observability via OpenTelemetry                                |
| All services   | → Jaeger   | Tracing via OTEL exporter                                      |

## 6. Environment Variables

None found

## 7. Index Architecture

| Component         | File/Filename                        | Responsibility                                 |
|-------------------|--------------------------------------|-----------------------------------------------|
| Web entrypoint    | apps/web/app/layout.tsx              | Top-level layout, context providers            |
| Web API routes    | apps/web/app/api/                    | BFF endpoints for frontend                     |
| API entrypoint    | services/api/cmd/api/main.go         | Loads config, starts HTTP server, routes       |
| Worker entrypoint | services/worker/cmd/worker/main.go   | Loads config, starts dispatcher, job workers   |

## 8. Core Data Models

| Model         | Key Fields                | Purpose                                         |
|---------------|--------------------------|-------------------------------------------------|
| App           | id, name, dsl, owner_id  | Canonical representation of an internal tool     |
| User          | id, email, company_id    | Authentication, authorization, tenancy           |
| Company       | id, name                 | Multi-tenancy, workspace isolation               |
| Workflow      | id, steps, approvals     | Orchestration of multi-step business processes   |
| Widget        | type, props, bindings    | UI building blocks for apps                      |
| Connector     | type, config, schema     | External data source integration                 |
