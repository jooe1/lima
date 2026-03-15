## Plan: AI Internal Tools Platform Release 1

This plan assumes a greenfield build. Recommended architecture: Next.js/React builder and runtime shell, Go control-plane and worker services, PostgreSQL for system data and app state, Redis or NATS for async jobs, S3-compatible storage for imports and artifacts, and Aura flat DSL as the canonical app source. The execution order is designed to keep all listed requirements in scope for the first release while validating the highest-risk loop early: prompt to generated CRUD app to manual edit to preview to admin publish to approved runtime action.

**Steps**
1. Phase 0: Architecture baseline and repo bootstrap. Create the monorepo structure, ADRs, environment model, CI/CD, database migration flow, observability baseline, and local plus self-hosted developer environments. Define ownership of the web app, API service, worker service, DSL package, connector package, and deployment artifacts. This blocks all implementation.
2. Phase 1: Identity, tenancy, and lifecycle core. Implement company, workspace, user, and role models; SSO and session handling; RBAC; tenant routing; the draft versus published app model; version records; and the audit event schema. This is the foundational control plane and blocks all end-to-end flows.
3. Phase 2: Aura DSL and builder canvas. Implement the flat Aura DSL parser, validator, serializer, and diff model; the widget registry; the render engine; the infinite canvas; the inspector; move, resize, and delete interactions; layers, search, and minimap; undo and redo; autosave; and manual edit tracking. Preserve manual edits as first-class metadata so later AI revisions can avoid overwriting protected areas. Depends on Phase 1 for persistence and permissions. Widget catalog work and version snapshotting can run in parallel after the DSL schema is stable.
4. Phase 3: AI generation and revision loop. Implement conversation threads, prompt orchestration, schema and context summarization, streaming generation jobs, DSL repair and validation, chat-to-canvas synchronization, targeted revisions, and change-application logic. First milestone inside this phase is single-table CRUD app generation; second is multi-widget CRUD pages; third is dashboard and workflow revisions. Depends on Phase 2 because the agent must emit stable Aura DSL rather than direct UI code.
5. Phase 4: Connectors, metadata, and query or action execution. Implement the connector framework, encrypted secrets, schema and metadata discovery, safe query builder, read-only previews, relational drivers for Postgres, MySQL, and SQL Server, API connectors for REST and GraphQL, CSV and spreadsheet import, and mutation policy enforcement. Start with Postgres plus REST for first internal validation, then add the remaining connector types behind the same contract. Relational drivers, API drivers, and file import can run in parallel after the connector SDK and credential model are defined. Depends on Phases 1 and 3.
6. Phase 5: CRUD runtime, preview, publish, and safety controls. Build the runtime app shell separate from the builder shell, preview environments, the admin publish flow, version history and rollback, the approval queue for write operations, reviewer UI, and hard enforcement that unpublished drafts are not accessible as end-user apps. Depends on Phases 1, 3, and 4.
7. Phase 6: Analytics dashboards, workflows, and custom business logic. Add chart, KPI, and filter widgets; dashboard-oriented query patterns; the workflow model; triggers; action orchestration; AI-generated business-logic review and editing; and explicit human approval before any mutating external action executes. Can begin in parallel with late Phase 5 once query and action abstractions plus approval primitives are stable.
8. Phase 7: Enterprise hardening and self-hosted or on-prem delivery. Deliver Docker Compose and Helm packaging, backup and restore, HA guidance, audit retention and export, secret rotation, observability, performance tuning, tenant-isolation testing, and upgrade strategy. This is the release-readiness phase for FR-24 and the unresolved NFRs. Depends on all prior phases.
9. Continuous verification track: start in Phase 0 and gate every promotion. Build golden prompt suites, DSL round-trip tests, canvas interaction tests, RBAC matrix tests, connector contract tests, approval-flow tests, publish and rollback tests, performance benchmarks, and SaaS plus self-hosted smoke tests. This track runs in parallel with all implementation phases and blocks milestone signoff.

**Relevant files**
- c:\Users\Jamil\prog\lima\docs\requirements\ai-internal-tools-platform.md — source of truth for scope, roles, connectors, and safety constraints.
- c:\Users\Jamil\prog\lima\.github\agents\clarity.md — existing requirements workflow and document structure to keep future discovery and planning artifacts aligned.

**Initial modules to create**
- apps/web — Next.js builder UI, runtime shell, SSO entrypoints, and BFF endpoints.
- services/api — Go control-plane for tenancy, apps, publish, connectors, approvals, and audit.
- services/worker — Go async job runner for generation, schema discovery, imports, and workflow execution.
- packages/aura-dsl — parser, validator, serializer, and diff or merge logic.
- packages/widget-catalog — shared widget model and renderer contracts.
- packages/sdk-connectors — connector interfaces, auth helpers, and schema adapters.
- deploy/docker-compose and deploy/helm — self-hosted and on-prem delivery artifacts.

**Verification**
1. Builder flow acceptance: given 30 golden CRUD prompts, the system creates editable draft apps with chat-to-canvas sync, manual edit preservation, preview, and admin publish. Measure first-pass correctness against a scoring rubric before claiming the 75 percent goal.
2. Safety acceptance: no generated mutation executes without explicit approval, schema-only access is the default, and audit events exist for connector creation, prompt revisions, publish, rollback, and approved writes.
3. Connector acceptance: Postgres, MySQL, SQL Server, REST, GraphQL, and CSV or spreadsheet imports each pass contract tests for discovery, read previews, credential validation, and policy enforcement.
4. Runtime acceptance: drafts and published apps are isolated, RBAC is enforced for admin, builder, and end-user roles, and published apps remain usable when builder artifacts change.
5. Performance acceptance: p95 time to first rendered widget stays under 10 seconds on golden prompts, canvas interaction remains smooth at 150 widgets with minimap and search enabled, and publish plus preview actions finish under 60 seconds for reference apps.
6. Deployment acceptance: fresh self-hosted installation via Compose and Helm completes from docs, upgrades preserve apps and connectors, and restore drills recover from backup without tenant data leakage.

**Decisions**
- Use Next.js for the React web application and Go for backend control-plane and worker services. This splits UI velocity from the long-running, connector-heavy, enterprise backend concerns.
- Keep Aura flat DSL as the canonical app source format. AI outputs DSL changes, not JSX or direct database mutations.
- Optimize early internal milestones around CRUD and admin apps, but keep dashboards, workflows, enterprise auth, and on-prem delivery inside the release program rather than treating them as post-GA stretch scope.
- Default to schema and metadata access plus sample or preview data paths. Production writes require approval, and unrestricted live data access is out of scope for autonomous AI behavior.
- Assume a single active editor per app draft for the first release unless collaborative editing becomes an explicit requirement. This keeps the release focused and avoids an unnecessary CRDT or OT program.

**Further Considerations**
1. Formalize missing NFR targets before Phase 7 begins: max widget count, latency budget, audit retention, HA tier, backup RPO and RTO, and the first-pass correctness scoring rubric.
2. Decide whether custom business logic is emitted as Aura action DSL plus vetted templates, or as sandboxed code snippets attached to action nodes. The first option is safer; the second is more flexible.
3. Decide whether on-prem deployments must support air-gapped model inference in the first release. If yes, add model-hosting and prompt-eval infrastructure to Phase 7 rather than treating external LLM APIs as the only path.
