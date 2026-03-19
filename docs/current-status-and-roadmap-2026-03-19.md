# Lima Current Status And Roadmap

**Last Updated:** March 19, 2026

## Purpose

This document is the current working summary after the March 19 implementation pass.

It complements, rather than replaces, the earlier audited documents:

- [implementation-status-audited-2026-03-18.md](implementation-status-audited-2026-03-18.md)
- [phase7-and-mutation-gap-audit-2026-03-18.md](phase7-and-mutation-gap-audit-2026-03-18.md)

Those two files remain the best record of the March 18 audit. This file captures what changed immediately after that audit, what is still missing, and the recommended roadmap from here.

## Executive Summary

- The product is materially closer to release readiness than it was on March 18.
- The largest functional gap from the audit, real approved mutation execution, is now implemented.
- Worker safety coverage now exists for the mutation path and related fail-closed behavior.
- Secret rotation is no longer documentation-only; there is now a supported operator maintenance command.
- Audit pruning is now schedulable in Helm through a dedicated CronJob template.
- The platform is not yet broadly production-ready. It is best described as pilot-ready or controlled-rollout-ready.

## What Is Implemented Now

### Core Product Surface

- Phase 0 is implemented.
- Phase 1 is implemented.
- Phase 2 is substantially implemented for Aura DSL and the builder canvas.
- Phase 3 is implemented for AI generation, threads, queued jobs, and protected diffs.
- Phase 4 is implemented for connector CRUD, schema discovery, import, connection tests, and relational query support.
- Phase 5 is implemented for draft, preview, publish, rollback, runtime rendering, and approvals.

### Workflow And Safety Improvements Completed On March 19

- Approved workflow mutation steps now execute real connector-side writes instead of returning a placeholder result.
- Relational mutation execution now exists for Postgres, MySQL, and SQL Server.
- REST and GraphQL mutation execution now exist with fail-closed validation.
- Worker tests now cover mutation SQL validation, REST and GraphQL mutation success paths, HTTP failure paths, GraphQL error payloads, and interpolation edge cases.

### Operational Improvements Completed On March 19

- The API binary now supports operator maintenance subcommands for:
  - connector secret re-encryption
  - expired audit-event pruning
- Secret rotation in [UPGRADING.md](../UPGRADING.md) now points to a supported command instead of a missing endpoint or script.
- Helm now contains an optional audit prune CronJob template.
- The maintenance CLI help flow was fixed so help and obvious argument validation happen before database bootstrap.

## Current Release Readiness Assessment

### Ready Or Nearly Ready

- AI-assisted internal app builder
- Multi-tenant auth and workspace model
- Draft, preview, publish, and rollback lifecycle
- Approval-gated runtime actions
- Workflow execution with real approved mutations
- Self-hosted packaging baseline through Docker Compose and Helm
- Backup and restore scripts
- Upgrade guidance and operational runbooks

### Not Yet Production-Ready

- Automated release-readiness drills are still missing.
- The mutation path has unit coverage, but not enough database-backed integration coverage.
- Helm chart changes have not been validated with local Helm commands in this environment.
- Database-enforced isolation is still not implemented.

## Remaining Gaps

### Release-Blocking Or Near Release-Blocking

#### 1. Deployment Drills Are Still Not Automated

What is still missing:

- fresh Docker Compose install validation
- fresh Helm install validation
- upgrade preservation checks
- backup and restore round-trip automation
- audit export verification
- tenant-leakage regression checks

Why it matters:

- The repo has packaging and documentation, but self-hosted readiness is still being inferred more than it is being exercised.

#### 2. Workflow Mutation And Approval Paths Need Deeper Integration Coverage

What is still missing:

- database-backed tests for approval resume plus real relational mutation execution
- direct coverage for connector lookup, decryption, and approval record verification paths

Why it matters:

- The highest-risk background execution path is now implemented, but the current confidence level is still more unit-test-heavy than integration-test-heavy.

#### 3. Helm Validation Still Needs A Real Environment

What is still missing:

- helm lint
- helm template
- disposable-cluster smoke test for install and upgrade

Why it matters:

- The new audit prune CronJob and other chart assets are syntactically consistent in code review, but they have not been validated with Helm tooling in this environment.

### Important Hardening Work

#### 4. Database-Enforced Isolation Is Still Open

What is still missing:

- row-level security, database roles, grants, or equivalent DB-layer enforcement

Why it matters:

- Current tenant isolation is enforced in application code and middleware. That may be enough for some deployments, but it is not the strongest posture for security-sensitive customers.

#### 5. Production Readiness SLOs And Runbooks Need To Be Closed Out

What is still missing:

- explicit release checklist
- formal install, upgrade, backup, and restore acceptance criteria
- chart-native validation in CI or release workflows

Why it matters:

- The system is close enough to demo and pilot, but broad release needs reproducible operational proof, not only working code.

### Product-Completeness Gaps That Are Not On The Main Release Path

These are real gaps, but they are better treated as the post-release or parallel product roadmap rather than the final release gate for the current platform hardening track.

- scheduled workflow triggers
- webhook workflow triggers
- external notification delivery for workflow notification steps
- richer admin UI for connectors, members, and audit
- full widget runtime parity for all registered widgets
- filter-driven reactive dashboard wiring across widgets
- REST and GraphQL dashboard querying if that remains a product requirement

## Recommended Roadmap

### Track 1: Finish Release Readiness

#### Step 1. Automate Compose And Helm Drills

Implement blocking CI or release jobs for:

- fresh Compose install
- fresh Helm install
- publish and approval mutation happy path
- backup and restore round-trip
- audit export
- tenant isolation regression checks

Primary files:

- `.github/workflows/ci.yaml`
- `.github/workflows/release.yaml`

#### Step 2. Add Database-Backed Integration Coverage

Add integration-style tests for:

- approval resume
- relational mutation execution
- failure and rollback behavior
- connector decryption and execution edge cases

Primary files:

- `services/worker/internal/queue/workflow.go`
- `services/worker/internal/queue/workflow_test.go`

#### Step 3. Validate Helm In A Real Tooling Environment

Run and then automate:

- `helm lint`
- `helm template`
- install smoke test in a disposable cluster

Primary files:

- `deploy/helm/lima/templates/`
- `deploy/helm/lima/values.yaml`

#### Step 4. Refresh The Audited Status Documents

Once the above is done, update the older audit docs so the repo no longer shows known-closed gaps as open.

Primary files:

- [implementation-status-audited-2026-03-18.md](implementation-status-audited-2026-03-18.md)
- [phase7-and-mutation-gap-audit-2026-03-18.md](phase7-and-mutation-gap-audit-2026-03-18.md)

### Track 2: Hardening After The Release Gate

#### Step 5. Decide On Database Hardening Scope

Choose whether the production posture requires:

- application-layer RBAC only
- row-level security
- DB roles and grants
- additional field-level encryption beyond secret blobs

This decision should be explicit because it materially changes the architecture and deployment posture.

### Track 3: Product Completeness Roadmap

#### Step 6. Complete Workflow Trigger Coverage

Add:

- schedule trigger execution
- webhook listener and authentication model

#### Step 7. Complete Notification Delivery

Add one or more real delivery channels:

- email
- webhook
- Slack or Teams

#### Step 8. Fill Admin-Surface Gaps

Add first-class web UI for:

- connectors
- members
- audit

#### Step 9. Close Runtime Widget Parity Gaps

Add missing or partial runtime support for:

- container
- modal
- tabs
- filter wiring across dashboard widgets

## Recommended Product Posture Today

### Reasonable To Claim

- Strong prototype
- Early production candidate for an internal team that can tolerate some operational work
- Good candidate for pilot, staging, and controlled customer rollout

### Not Yet Reasonable To Claim

- Fully production-ready for broad external rollout
- Fully complete internal-tools operating system with every planned surface finished
- Enterprise-grade release with hardened automated install, restore, and upgrade proof already in place

## Bottom Line

As of March 19, 2026, Lima now does more of what it was expected to do than it did during the March 18 audit. The system is no longer blocked by stubbed mutation execution, and the key-rotation and audit-pruning stories are now materially stronger.

The next step is not more speculative feature work. The next step is to close the release-readiness loop with automated deployment drills, deeper integration coverage, and a final hardening decision around database isolation.