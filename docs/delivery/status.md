# Orchestration Status: Aura V3 — Single-Graph Authoring and Generation
_Last updated: 2026-04-24_
_Plan: docs/delivery/aura-v3-graph.plan.md_
_Depth: 0_
_Commit mode: no-commit_

## Phase 1 — Shared Packages

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 1 | fix(widget-catalog): add `submitted` port to form; add step:transform and step:http | complete | |
| 2 | feat(aura-dsl): add inline link grammar — on/input/output/layout clauses | complete | |
| 3 | feat(aura-dsl): normalizeInlineLinks compiler | complete | |
| 4 | feat(widget-catalog): export port registry snapshot for Go worker | in-progress | depends on C1, parallel with C2-C3 |

## Phase 2 — Worker Single-Pass Generation

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 5 | feat(worker): replace staged layout+flow generation with single graph generation pass | not-started | depends on C4 |
| 6 | feat(worker): Go inline-link normalizer (normalizeInlineLinksGo) | not-started | parallel with C5 dev |
| 7 | feat(worker): full graph validation gate before persistence | not-started | depends on C5, C6 |

## Phase 3 — Builder AuraDocumentV2 State Adoption

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 8  | feat(api): extend App type with dsl_edges; export API_BASE | not-started | parallel with C5-C7 |
| 9  | feat(builder): migrate document history and autosave to AuraDocumentV2 | not-started | depends on C8 |
| 10 | feat(flow-view): Flow View canvas with widget nodes and reactive edge wiring | not-started | depends on C9 |
| 11 | feat(flow-view): step nodes and async edges | not-started | depends on C10 |
| 12 | feat(flow-view): auto-layout — derive flow positions from graph topology | not-started | depends on C11 |
| 13 | feat(runtime): compile layout hints to grid coordinates | not-started | depends on C9, parallel with C10-C12 |

## Phase 4 — Runtime Graph-Driven Execution

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 14 | feat(runtime): derive workflow execution order from graph topology | not-started | depends on Phase 3 complete |
