# ADR-004: Safety model — schema-only default and approval-gated mutations

**Date:** 2026-03-15  
**Status:** Accepted

## Context

The AI agent can generate queries and workflow actions that touch external databases and APIs. Without guardrails, a generated app could silently corrupt production data. FR-14 requires schema-only access by default; FR-15 requires explicit human approval for any write/mutating operation.

## Decision

1. **Schema and metadata discovery** — always allowed from any connector. No approval required.
2. **Read-only queries and preview data** — allowed in builder context. A row-count limit (`limit` param on `QueryRequest`) is enforced in the worker.
3. **Mutations (INSERT, UPDATE, DELETE, POST, PUT, PATCH, DELETE on APIs)** — routed through the `approvals` table. The API creates a pending `WorkflowAction` record; the worker only executes the mutation after a workspace admin (or delegated approver) POST to `/approvals/{id}/approve`. Approved records are immutable.
4. **Unrestricted live data access** — out of scope for autonomous AI behaviour.

Enforcement points:
- `IConnector.mutate()` requires an `approvalId` that must match a `status=approved` record in the database. The worker rejects any call without a verified approvalId.
- API handler `ApproveAction` checks that the calling user holds `workspace_admin` role (from JWT claims).
- Audit events are written for: connector created/updated/deleted, approval requested, approval approved/rejected, app published, app rolled back.

## Consequences

- Builders see a pending-approval badge when a generated workflow includes mutations.
- The approval queue must be polled or pushed to the reviewer UI (Phase 5/6).
- This adds latency to any generated mutating workflow but is non-negotiable for internal enterprise trust.
