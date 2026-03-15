# ADR-002: Technology stack

**Date:** 2026-03-15  
**Status:** Accepted

## Context

We need to choose languages and frameworks for the frontend, control-plane API, and async worker. The choices must support enterprise deployment targets (self-hosted, on-prem), a heavy async workload (AI generation, schema discovery, large imports), and a rich interactive canvas UI.

## Decision

| Layer | Choice | Rationale |
|---|---|---|
| Web UI | Next.js 15 (App Router) + React 19 | Strong ecosystem, RSC reduces client JS for runtime shell, easy BFF via Server Actions and rewrites |
| Control-plane API | Go + chi | Low memory footprint, easy containerisation, strong standard library for HTTP and crypto, fast startup for horizontal scaling |
| Async worker | Go + Redis BLPOP | Simple reliable job queue without a heavyweight broker; can be upgraded to NATS or BullMQ if throughput demands it |
| Database | PostgreSQL 16 | ACID guarantees, row-level security for tenant isolation, mature ecosystem, first-class support in golang-migrate |
| Cache / queue broker | Redis 7 | BLPOP-based job queues, session caching, future pub/sub for streaming generation events |
| Object storage | S3-compatible (MinIO for self-hosted) | Connector import artifacts, generated app snapshots, audit log exports |

## Consequences

- Two build systems must coexist in CI (Go toolchain + Node/pnpm).
- SSR and RSC in Next.js give the runtime shell a minimal JS footprint.
- The Redis BLPOP approach is simple but not durable across Redis restarts; if durability becomes a requirement, evaluate Redis Streams or NATS JetStream in Phase 3 or later.
