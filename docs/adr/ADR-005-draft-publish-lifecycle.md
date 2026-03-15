# ADR-005: Draft/publish lifecycle and builder–runtime isolation

**Date:** 2026-03-15  
**Status:** Accepted

## Context

FR-20 requires that unpublished drafts are not accessible as end-user apps. FR-19 requires that only workspace admins can publish. The builder and runtime also have very different UX requirements (canvas vs. rendered app).

## Decision

- Each **App** entity has a `status` field: `draft | published`.
- A **Version** record is created on every publish action, storing the DSL snapshot and connector bindings at that moment.
- The **builder shell** (`/builder/[appId]`) always reads the latest draft state.
- The **runtime shell** (`/app/[appId]`) reads only the most recent `published` version. Requests to runs a draft URL return 404.
- **Rollback** creates a new draft pre-populated from an older version snapshot, which then requires a fresh publish.
- The two shells are separate Next.js route groups with separate layouts and no shared client state.

## Consequences

- Builders can break their draft without affecting end users running the published version.
- The version table grows over time; a retention policy (keep last N versions per app) should be defined before Phase 7.
- Collaborative editing (multiple builders on one draft) is explicitly out of scope for v1 — a single active editor per draft is assumed.
