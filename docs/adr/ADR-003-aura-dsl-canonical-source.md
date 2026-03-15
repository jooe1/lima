# ADR-003: Aura flat DSL as canonical app source

**Date:** 2026-03-15  
**Status:** Accepted

## Context

The AI agent must emit structured output that the canvas renderer can consume deterministically. Three options were considered: (1) direct JSX/React component trees, (2) YAML component config, (3) a bespoke flat DSL.

## Decision

Use the **Aura flat DSL** format as the canonical source of truth for every app. The AI agent emits DSL statements; the builder canvas renders from them; manual edits are reflected back into the DSL; the control-plane stores and versions the DSL string.

Key constraints:
- Statements are flat (`<element> <id> @ <parentId> clauses ;`) — no nested child blocks.
- Clause order is fixed: `text → value → forEach → key → if → with → transform → style`.
- `@root` is the reserved root parent.
- The `manuallyEdited` flag on a node prevents AI rewrites unless `force: true` is passed to `diff()`.

## Consequences

- The AI must be prompted with the DSL grammar and widget catalog so it emits valid DSL.
- Round-trip correctness (`parse → serialize → parse`) is enforced by the test suite in `packages/aura-dsl`.
- JSX is never generated directly by the AI, which reduces the injection and arbitrary-code-execution surface.
- Nested layouts are expressed via `parentId` references, which is more verbose but streaming-friendly.
