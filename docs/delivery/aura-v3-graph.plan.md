# Delivery Plan: Aura V3 — Single-Graph Authoring and Generation
_Last updated: 2026-04-24_
_Feature slug: aura-v3-graph_

## Goal

Replace the current split-generation architecture (separate layout pass + separate flow-wiring pass + late stitching of workflow JSON back into step nodes and edges) with a single coherent Aura graph:

- One model generation pass producing nodes with inline input/output links.
- A normalizer that compiles inline links into first-class `AuraEdge` entries.
- Full `validateV2` (graph-level) on every save, not just DSL syntax checks.
- No model-authored flow positions — Flow View positions are derived automatically.
- No `action` field or external workflow ID as the authored connection primitive.
- One canonical port registry used by runtime, builder, validator, and worker prompt.

`AuraDocumentV2 { nodes, edges }` already exists in `packages/aura-dsl`. This plan builds on top of it — it does NOT replace the existing type model; it extends the grammar and adds the compiler/normalization layer.

---

## Stack Decisions

| Decision | Value | Reason |
|---|---|---|
| Authoring syntax for connections | Inline clauses on nodes: `on`, `input`, `output` | Agent-friendly; no separate edges section to generate; normalizer converts to canonical edges |
| Canonical storage | Existing `AuraDocumentV2 { nodes, edges }` unchanged | All builder, runtime, validator, diff/merge already speaks V2 |
| Normalization | New `normalizeInlineLinks(doc)` function in `packages/aura-dsl` | Pure function; tested independently; called after parse, before validate |
| Port registry | `packages/widget-catalog` is the single source; Go worker reads via a generated JSON snapshot | Eliminates current drift between TypeScript registry and Go widgetcatalog.go |
| Flow positions | Not authored; `FlowCanvas` derives positions from graph topology (existing fallback already present) | Model no longer emits `flowX`/`flowY` |
| Layout intent | New `layout` clause on widget nodes: `layout area="main" span="6"` stored in `style` map | Backward compatible; runtime layout compiler reads these hints; falls back to current grid for old apps |
| Worker generation | Single LLM call producing nodes + inline links; replaces 3-stage pipeline | Reduces prompt surface area, eliminates late reconciliation |
| Validation gate | Worker calls `normalizeInlineLinks` then `validateV2` before persisting; save is rejected on graph errors | Prevents broken graphs from reaching production |

---

## Phase 1 — Shared Packages (foundational; all later phases depend on this)

### Commit 1 — fix(widget-catalog): add `submitted` port to form; add step:transform and step:http
**Why:** The `submitted` port is used by the runtime (`RuntimeRenderer.tsx:846`), the inspector (`Inspector.tsx:1558`), and the Go worker prompt manifest (`widgetcatalog.go:61`), but is missing from the canonical TypeScript registry. This drift causes graph validation failures. `step:transform` and `step:http` also exist in the worker but are missing from `STEP_ELEMENTS` in the DSL validator.
**Parallelizable with:** nothing — must be first.

**Files:**
- `packages/widget-catalog/src/index.ts` — MODIFIED

**Changes:**
1. In the `form` entry of `WIDGET_REGISTRY`, add `submitted` output port after `values`:
   ```ts
   { name: 'submitted', direction: 'output', dataType: 'trigger', description: 'Fires when the user submits the form' },
   ```
2. Add `step:transform` and `step:http` to the `StepNodeType` union (they already exist in `STEP_NODE_REGISTRY` but verify they're in the union type too).
3. In `packages/aura-dsl/src/index.ts`, add `'step:transform'` and `'step:http'` to `STEP_ELEMENTS` set.

**Interface contracts:**
```ts
// packages/widget-catalog/src/index.ts
// form ports array — submitted added after values:
ports: [
  { name: 'values',    direction: 'output', dataType: 'object',   description: '...' },
  { name: 'submitted', direction: 'output', dataType: 'trigger',  description: 'Fires when the user submits the form' },
  { name: '*',         direction: 'output', dataType: 'string',   description: '...', dynamic: true },
  { name: 'reset',     direction: 'input',  dataType: 'trigger',  description: '...' },
  { name: 'setValues', direction: 'input',  dataType: 'object',   description: '...', expandable: true, childKeySource: 'fields' },
  { name: 'setErrors', direction: 'input',  dataType: 'object',   description: '...', expandable: true, childKeySource: 'fields' },
],

// packages/aura-dsl/src/index.ts
export const STEP_ELEMENTS = new Set([
  'step:query', 'step:mutation', 'step:condition', 'step:approval_gate',
  'step:notification', 'step:transform', 'step:http',   // ← added
])
```

**Tests:**
- `packages/widget-catalog/src/index.test.ts` — add test: `form` widget has a port named `submitted` with `direction: 'output'` and `dataType: 'trigger'`.
- `packages/aura-dsl/src/index.test.ts` — add test: `validateV2` does not error on a node with `element: 'step:transform'` or `element: 'step:http'`.
- Existing `TestWidgetCatalogCoversAllTSTypes` in `services/worker/internal/queue/widgetcatalog_test.go` must still pass (verify coverage of new step types if added to TS union).

**Done criteria:**
- `pnpm --filter "@lima/widget-catalog" test` exits 0
- `pnpm --filter "@lima/aura-dsl" test` exits 0
- `go test ./... -timeout 120s` in `services/worker` exits 0 (widgetcatalog_test passes)

---

### Commit 2 — feat(aura-dsl): add inline link grammar — `on`, `input`, `output`, `layout` clauses
**Why:** Agents can write connections as clauses inside a node instead of generating a separate edges section. The normalization step (Commit 3) converts these to canonical `AuraEdge` entries.
**Parallelizable with:** nothing in Phase 1 (depends on Commit 1 for known step types).

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED

**New grammar clauses (parsed onto `AuraNode`):**

| Clause | Syntax | Meaning |
|---|---|---|
| `on` | `on <myPort> -> <targetId>.<targetPort>` | Trigger/async: when my `myPort` fires, run `targetId.targetPort`. Generates an `async` edge. |
| `input` | `input <myPort> <- <sourceId>.<sourcePort>` | Reactive input: bind `sourceId.sourcePort` to my `myPort`. Generates a `reactive` edge. |
| `output` | `output <myPort> -> <targetId>.<targetPort>` | Reactive or async output: route my `myPort` to `targetId.targetPort`. Type determined by whether target is a step (`async`) or widget (`reactive`). |
| `layout` | `layout area="main" span="6"` | Layout intent hint. Stored in `style` as `layoutArea`/`layoutSpan`/etc. No separate field. |

Multiple `on`, `input`, and `output` clauses are allowed per node (one per line, each parsed into `inlineLinks` array on the node).

**New fields on `AuraNode`:**
```ts
export interface InlineLink {
  direction: 'on' | 'input' | 'output'
  myPort: string
  targetNodeId: string
  targetPort: string
}

export interface AuraNode {
  // ... all existing fields unchanged ...
  /** Inline connection declarations authored by the AI. Compiled away by normalizeInlineLinks. */
  inlineLinks?: InlineLink[]
}
```

**Parser changes:**
- Add `'on'`, `'input'`, `'output'`, `'layout'` to `CLAUSES` set.
- In `parseNode`, handle each new clause after `formFields` and before `style`:
  - `on <myPort> -> <targetId>.<targetPort>` — push to `node.inlineLinks`
  - `input <myPort> <- <sourceId>.<sourcePort>` — push to `node.inlineLinks`
  - `output <myPort> -> <targetId>.<targetPort>` — push to `node.inlineLinks`
  - `layout <key>=<value> ...` — parse like `with`; merge into `node.style` with prefix `layout_` (e.g. `area` → `style.layout_area`, `span` → `style.layout_span`).
- Clause order: existing order ... `formFields` → `on/input/output` (any order, multiple allowed) → `layout` → `style`.

**Serializer changes:**
- `serializeNode` must emit `inlineLinks` back as `on`/`input`/`output` lines if present (round-trip).
- `layout_*` keys in `style` are emitted as a `layout` clause, not inside `style {}`.

**Implementation notes:**
- `->` and `<-` are two tokens in the tokeniser. The `<-` scan must check that `-` is the next token after `<`.
- `targetId.targetPort` is a single `IDENT.IDENT` token or two tokens — parse as one consume if the tokeniser produces `nodeId.portName` fused, otherwise consume three tokens: `nodeId`, `.`, `portName`.
- Do not attempt to resolve `targetNodeId` during parsing — that is the normalizer's job.

**Done criteria:**
- Round-trip: `serializeNode(parseNode(src))` produces identical output for any valid inline-link node.
- `pnpm --filter "@lima/aura-dsl" test` exits 0.

---

### Commit 3 — feat(aura-dsl): normalizeInlineLinks — compiler from inline syntax to AuraEdge
**Why:** Authoring sugar must be compiled to canonical `AuraEdge` entries before storage, validation, and runtime use.
**Parallelizable with:** nothing (depends on Commit 2).

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED
- `packages/aura-dsl/src/index.test.ts` — MODIFIED (significant tests)

**New exported function:**
```ts
/**
 * normalizeInlineLinks compiles inlineLinks on each node into AuraEdge entries,
 * merges them with any existing doc.edges (deduplicating by ID), and returns a
 * new document with inlineLinks cleared from all nodes.
 *
 * Edge ID scheme: `e_{fromNodeId}_{fromPort}_{toNodeId}_{toPort}`
 * Edge type rules:
 *   - `on <port> -> <targetId>.<targetPort>` → always async
 *   - `output <port> -> step:*` → async
 *   - `output <port> -> widget` → reactive
 *   - `input <port> <- <sourceId>.<sourcePort>` → reactive (edge is source→this)
 *
 * If a generated edge ID already exists in doc.edges it is NOT duplicated.
 * Nodes whose inlineLinks cannot be resolved (unknown targetNodeId) produce a
 * normalization warning but do not throw — the caller should run validateV2
 * afterward to surface dangling references as proper validation errors.
 */
export function normalizeInlineLinks(doc: AuraDocumentV2): {
  doc: AuraDocumentV2
  warnings: string[]
}
```

**Edge type determination:**
- `on` clause → always `async`.
- `output` clause → `async` if `targetNodeId` belongs to a step element (prefix `step:`), else `reactive`.
- `input` clause → `reactive`; the edge runs from `(sourceId, sourcePort)` to `(thisNodeId, myPort)`.

**parseV2 integration:**
- `parseV2` should call `normalizeInlineLinks` internally before returning, so callers always get a clean normalized document. `inlineLinks` should be absent on all nodes returned by `parseV2`.
- `serializeV2` must NOT emit inline links for a normalized document (they are already gone); it only emits them if nodes happen to have `inlineLinks` set (i.e., when called on an un-normalized intermediate doc).

**Tests — golden cases to cover:**
1. Button `on clicked -> mutation_step.run` → single async edge `button_id.clicked → mutation_step.run`.
2. Form `on submitted -> mutation_step.run` → async edge `form_id.submitted → mutation_step.run`.
3. Step `output result -> table.setRows` where table is a widget → reactive edge.
4. Step `output result -> next_step.run` where next_step is `step:query` → async edge.
5. Step `output trueBranch -> approve_step.run` and `output falseBranch -> reject_step.run` → two async edges.
6. Widget `input content <- step_query.firstRow.name` → reactive edge with composite port name.
7. Two nodes both linking to the same target → two distinct edges, no duplicate.
8. Inline link referencing unknown node ID → warning in `warnings[]`, doc still returned, dangling edge present with correct IDs.
9. Round-trip: `normalizeInlineLinks(parseV2(serializeV2(doc))).doc` deep-equals the pre-serialization doc.

**Done criteria:**
- `pnpm --filter "@lima/aura-dsl" test` exits 0 with all 9 golden cases passing.
- `normalizeInlineLinks` is exported from `packages/aura-dsl/src/index.ts`.

---

### Commit 4 — feat(widget-catalog): export port registry snapshot for Go worker
**Why:** The Go worker currently maintains a hand-written `widgetcatalog.go` that must be kept in sync manually. Generating a JSON snapshot from the TypeScript source eliminates the drift.
**Parallelizable with:** Commits 2–3 (independent).

**Files:**
- `packages/widget-catalog/src/generate-port-manifest.ts` — NEW: script that renders `WIDGET_REGISTRY` + `STEP_NODE_REGISTRY` to JSON
- `packages/widget-catalog/src/port-manifest.json` — NEW: generated output (checked in, regenerated in CI)
- `packages/widget-catalog/package.json` — MODIFIED: add `"generate": "tsx src/generate-port-manifest.ts"` script
- `services/worker/internal/queue/widgetcatalog.go` — MODIFIED: add a comment + `//go:embed` directive to load from the JSON snapshot instead of hard-coded Go literals; keep Go struct definitions but populate them from JSON on init
- `services/worker/internal/queue/widgetcatalog_test.go` — MODIFIED: `TestWidgetCatalogCoversAllTSTypes` becomes the gate that this is done

**generate-port-manifest.ts:**
```ts
import { WIDGET_REGISTRY, STEP_NODE_REGISTRY } from './index.js'
import { writeFileSync } from 'fs'
const manifest = {
  widgets: Object.values(WIDGET_REGISTRY).map(w => ({
    type: w.type,
    displayName: w.displayName,
    ports: w.ports,
  })),
  steps: Object.values(STEP_NODE_REGISTRY).map(s => ({
    type: s.type,
    displayName: s.displayName,
    ports: s.ports,
  })),
}
writeFileSync(new URL('./port-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2))
```

**widgetcatalog.go changes:**
- Add `//go:embed port-manifest.json` (copy the JSON into worker's embed path or symlink in the module).
- Parse on `init()` into the existing `widgetCatalog` slice.
- Remove all hard-coded Go struct literals for widget/step entries.
- Keep `BuildPortManifest()` function signature unchanged — it still returns a markdown string from the loaded data.

**Done criteria:**
- `pnpm --filter "@lima/widget-catalog" generate` exits 0 and produces `port-manifest.json`.
- `go test ./... -timeout 120s` in `services/worker` exits 0.
- The `submitted` port appears in `BuildPortManifest()` output (test via `TestBuildPortManifestContainsKeyPorts` — add `"submitted"` to the expected list).

---

## Phase 2 — Worker: Single-Pass Graph Generation

### Commit 5 — feat(worker): replace staged layout+flow generation with single graph generation pass
**Why:** The current `handleGeneration` function in `services/worker/internal/queue/generation.go` runs three sequential AI calls: plan → layout DSL → flow JSON. The layout and flow outputs are then stitched by `buildFlowNodesAndEdges`. This produces fragile results because the two generation stages can disagree. Replacing with a single call that emits nodes + inline links removes the stitching entirely.
**Parallelizable with:** nothing in Phase 2 (foundational).

**Files:**
- `services/worker/internal/queue/generation.go` — MODIFIED (large)
- `services/worker/internal/queue/dsl.go` — MODIFIED

**Changes:**

1. **Remove `generateFlow`, `buildFlowMessages`, `buildFlowCopilotPrompt`** — these are the Stage 2 flow-wiring generation functions. Their logic is subsumed by the new single-pass prompt.

2. **Remove `buildFlowNodesAndEdges`** — no longer needed; step nodes and edges come directly from the model output via the normalizer.

3. **Remove `reconcileGeneratedFlowTriggerRefs`, `deriveTriggerWidgets`, `extractFlows`, `extractEdges`, `persistGeneratedFlows`** — these exist solely to stitch the flow JSON representation back into Aura nodes and edges. All of this is replaced by the normalization step.

4. **Update `generateLayout`** (rename to `generateGraph`):
   - The function now asks the model to produce a single Aura V3 document with widget nodes, step nodes, and inline `on`/`input`/`output` links.
   - The system prompt now includes the inline link grammar documentation and the full port manifest from `BuildPortManifest()`.
   - The model does NOT produce `flowX`, `flowY`, `flowW`, `flowH` style keys.
   - The model does NOT produce `action` fields pointing to workflow IDs.
   - The model produces `layout` clauses instead of hardcoded grid positions where possible.

5. **Update `handleGeneration`** post-processing:
   - Parse model output with `parseV2` equivalent in Go (the existing `parseDSLStatements` + a new inline-link parser).
   - Call normalization (Go port of `normalizeInlineLinks`): extract inline links from node attributes into `dslEdge` structs.
   - Run full graph validation (port reference checks against the port manifest, async chain rules).
   - On validation errors: attempt a repair pass for common issues (missing step node IDs, bad port names → fallback to known good ports). If repair fails, return a generation error.
   - Persist `dsl_source` (normalized, no inline links in serialized form) and `dsl_edges` (all edges).

6. **Update `validateDSL`** in `dsl.go`:
   - After syntax validation, also check that every edge `fromNodeId`/`toNodeId` references a node ID present in the parsed document.
   - Check that `fromPort` and `toPort` exist in the port manifest for the referenced element type.
   - Return errors as before (non-fatal for soft issues, fatal for hard structural errors).

**New system prompt outline (for `buildGraphSystemPrompt`):**
```
You are generating a Lima app. Produce a single Aura document.

RULES:
- Every node ends with ;
- Widget nodes: table, form, button, text, kpi, chart, filter, modal, tabs, markdown, container
- Step nodes: step:query, step:mutation, step:condition, step:approval_gate, step:notification, step:transform, step:http
- To wire a trigger: use `on <myOutputPort> -> <targetNodeId>.<targetInputPort>` inside the source node
- To bind a reactive value: use `input <myInputPort> <- <sourceNodeId>.<sourceOutputPort>` inside the target node
- Do NOT produce flowX, flowY, flowW, flowH style keys
- Do NOT produce `action` fields
- Do NOT produce a separate ---edges--- section
- Use `layout area="<area>" span="<1-12>"` to express layout intent
- Available ports: <BuildPortManifest() output>
```

**Interface contracts (internal Go):**
```go
// New function replacing generateLayout + generateFlow:
func generateGraph(ctx context.Context, ...) (string, error)

// Updated handleGeneration pipeline:
// 1. generatePlan (optional, unchanged)
// 2. generateGraph → raw DSL string
// 3. parseDSLStatements → []dslStatement
// 4. normalizeInlineLinksGo → []dslEdge (new function)
// 5. validateDSL (extended) → []string errors
// 6. persistApp(dsl_source, dsl_edges)
```

**Done criteria:**
- `go test ./... -timeout 120s` in `services/worker` exits 0.
- A generation request produces a valid `dsl_source` with no `action` fields and no `flowX`/`flowY` style keys.
- `dsl_edges` is populated from normalized inline links.
- The existing `TestWidgetCatalogCoversAllTSTypes` still passes.

---

### Commit 6 — feat(worker): Go inline-link normalizer (`normalizeInlineLinksGo`)
**Why:** This is the Go-side equivalent of the TypeScript `normalizeInlineLinks`. It must run before `validateDSL` and before persistence. Extracted as a separate commit to keep each change reviewable.
**Parallelizable with:** Commit 5 development (can be written independently, integrated in Commit 5).

**Files:**
- `services/worker/internal/queue/normalize.go` — NEW
- `services/worker/internal/queue/normalize_test.go` — NEW

**normalize.go:**
```go
package queue

// InlineLink is a parsed on/input/output clause extracted from a DSL node.
type InlineLink struct {
    Direction    string // "on", "input", "output"
    MyPort       string
    TargetNodeID string
    TargetPort   string
}

// normalizeInlineLinksGo extracts InlineLink annotations from dslStatements
// (stored as style keys with prefix "on__", "input__", "output__" by the
// DSL parser, or as structured fields if the parser supports them directly)
// and converts them into dslEdge entries.
//
// Edge type rules (mirrors TypeScript normalizeInlineLinks):
//   on      → async
//   output  → async if target is a step:* node, else reactive
//   input   → reactive (edge runs from source → this node)
//
// Deduplicates by edge ID: e_{fromNodeId}_{fromPort}_{toNodeId}_{toPort}
func normalizeInlineLinksGo(statements []dslStatement, existingEdges []dslEdge) ([]dslEdge, []string)
```

**Test cases (mirror TypeScript golden cases):**
1. Button `on clicked -> mut.run` → async edge `button.clicked → mut.run`.
2. Form `on submitted -> mut.run` → async edge `form.submitted → mut.run`.
3. Step `output result -> table.setRows` (table is widget) → reactive edge.
4. Step `output result -> next.run` (next is step) → async edge.
5. Step `output trueBranch -> approveStep.run` and `output falseBranch -> rejectStep.run` → two async edges.
6. `input content <- q.firstRow.name` → reactive edge `q.firstRow.name → thisNode.content`.
7. Unknown target node ID → warning, edge still emitted (validateDSL catches it).

**Done criteria:**
- `go test ./... -timeout 120s` in `services/worker` exits 0 with all 7 test cases passing.

---

### Commit 7 — feat(worker): full graph validation gate before persistence
**Why:** The current save path only calls `validateDSL` (syntax only). After normalization, we can run full graph checks. This is the safety layer that ensures broken graphs never reach production.
**Parallelizable with:** nothing (depends on Commits 5 and 6).

**Files:**
- `services/worker/internal/queue/dsl.go` — MODIFIED
- `services/worker/internal/queue/generation.go` — MODIFIED (validation call site)

**Validation rules to add (in `validateDSL` or a new `validateGraph` function):**
1. Every `dslEdge.FromNodeID` and `ToNodeID` references a known node ID in the parsed document.
2. Every `dslEdge.FromPort` exists as an output port for the source node's element type (from port manifest).
3. Every `dslEdge.ToPort` exists as an input port for the target node's element type (from port manifest).
4. Every async edge that is not a trigger edge (widget→step) must have at least one endpoint that is a `step:*` element.
5. No `action` field on any node (deprecated; should have been replaced by `on` clause).

**Repair pass (best-effort, applied before hard-failing):**
- If a port name is wrong but the element type has exactly one input/output port of the required dataType, substitute it silently and log a warning.
- If a trigger edge is missing (button node exists with no outgoing async edge to a step), emit a generation warning but do not fail hard.

**Done criteria:**
- `go test ./... -timeout 120s` in `services/worker` exits 0.
- A document with a dangling edge (unknown node ID) is rejected before save.
- A document with an unknown port name that can be repaired is saved with a warning log.

---

## Phase 3 — Builder: AuraDocumentV2 State Adoption

### Commit 8 — feat(api): extend App type with dsl_edges; export API_BASE
_(Unchanged from current.plan.md Commit 1 — implement as described there)_
**Parallelizable with:** Commits 5–7 (independent of worker changes).

### Commit 9 — feat(builder): migrate document history and autosave to AuraDocumentV2
_(Unchanged from current.plan.md Commit 2 — implement as described there)_
**Parallelizable with:** nothing in Phase 3 (foundational for all builder commits).

### Commit 10 — feat(flow-view): Flow View canvas with widget nodes and reactive edge wiring
_(Follows current.plan.md Commit 3 structure — implement as described there)_
**Parallelizable with:** Commit 9.

### Commit 11 — feat(flow-view): step nodes and async edges
_(Follows current.plan.md Commit 4 structure)_
**Parallelizable with:** nothing (depends on Commit 10).

### Commit 12 — feat(flow-view): auto-layout — derive flow positions from graph topology
**Why:** The new Aura V3 model does not author flowX/flowY. The Flow View must position nodes automatically.
**Parallelizable with:** nothing (depends on Commit 11).

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED
- `apps/web/app/builder/[appId]/flow-layout.ts` — NEW

**flow-layout.ts:**
```ts
/**
 * computeFlowLayout derives React Flow node positions from graph topology.
 * Uses a simple layered DAG layout:
 *   - Layer 0: widget trigger nodes (nodes with outgoing async edges, no incoming async edges)
 *   - Layer 1..N: step nodes in topological order
 *   - Final layer: widget sink nodes (nodes with only incoming reactive edges from steps)
 *
 * Returns a Map<nodeId, { x: number, y: number }> for use in docV2ToFlowNodes.
 * Manual position overrides (style.flowX / style.flowY present on a node) are preserved.
 */
export function computeFlowLayout(doc: AuraDocumentV2): Map<string, { x: number; y: number }>
```

**FlowCanvas.tsx changes:**
- Call `computeFlowLayout(doc)` before building React Flow node array.
- In `docV2ToFlowNodes`, use computed position as default; override with manual `style.flowX/flowY` if present.
- Remove the fallback that used `gridX/gridY` — not needed when auto-layout is always available.

**Done criteria:**
- Flow View renders without NaN positions for any valid `AuraDocumentV2`.
- `pnpm --filter web test` exits 0.

### Commit 13 — feat(runtime): compile layout hints to grid coordinates
**Why:** The new Aura V3 model uses `layout area=... span=...` instead of explicit `gridX/gridY/gridW/gridH`. The runtime must compile these hints to grid coordinates for the existing absolute-position renderer.
**Parallelizable with:** Commits 10–12 (independent of Flow View work).

**Files:**
- `apps/web/app/app/[appId]/layout-compiler.ts` — NEW
- `apps/web/app/app/[appId]/RuntimeRenderer.tsx` — MODIFIED (use compiled layout)

**layout-compiler.ts:**
```ts
/**
 * compileLayout converts layout hints (style.layout_area, style.layout_span etc.)
 * on each node into explicit gridX / gridY / gridW / gridH values.
 *
 * Layout areas:
 *   "header"  → full-width row at top
 *   "main"    → primary content area; span controls column width (1-12 grid)
 *   "sidebar" → right sidebar (fixed 3-column width)
 *   "footer"  → full-width row at bottom
 *
 * Nodes without layout hints keep their existing gridX/gridY/gridW/gridH values
 * (backward compatible with V1 apps).
 *
 * Returns a new AuraDocument with grid coordinates populated on all nodes.
 */
export function compileLayout(nodes: AuraNode[]): AuraNode[]
```

**RuntimeRenderer.tsx changes:**
- Before rendering, call `compileLayout(doc.nodes)` and render from the result.
- Step nodes are still filtered out before rendering (no visual widget for step nodes).

**Done criteria:**
- An app with only `layout area="main" span="6"` clauses (no `gridX/Y/W/H`) renders correctly.
- An app with V1 `gridX/Y/W/H` values renders identically to before (backward compat).
- `pnpm --filter web test` exits 0.

---

## Phase 4 — Runtime: Graph-Driven Execution (post Phase 3)

### Commit 14 — feat(runtime): derive workflow execution order from graph topology
**Why:** Execution order currently comes from `step_order` integer on `workflow_steps` table. With step nodes and async edges in the graph, topological sort determines order — supporting branching and parallelism correctly.
**Parallelizable with:** nothing (depends on Phase 3 being complete).

**Scope:** `apps/web/app/app/[appId]/RuntimeRenderer.tsx` flow engine — replace `step_order`-based execution sequence with async-edge topological traversal. `services/api` workflow execution engine — use `dsl_edges` to determine next step(s) after each step completes.

_(Detailed spec to be written after Phase 3 is shipped and the graph model is validated in production.)_

---

## Exit Criteria

| # | Criterion |
|---|---|
| 1 | `form` widget has a `submitted` port in the canonical TypeScript registry |
| 2 | `step:transform` and `step:http` are valid step elements in the DSL validator |
| 3 | `normalizeInlineLinks` converts inline `on`/`input`/`output` clauses to `AuraEdge` entries |
| 4 | `parseV2` automatically normalizes inline links before returning |
| 5 | Go worker port manifest is generated from TypeScript source (no manual sync) |
| 6 | Worker emits a single graph payload per generation; no staged layout + flow passes |
| 7 | Full graph validation (`validateDSL` + graph checks) runs before every save |
| 8 | No `action` fields or external workflow IDs authored by the model |
| 9 | Flow View positions are auto-derived from graph topology; no model-authored flowX/Y |
| 10 | Runtime layout compiles from `layout` hints; old grid-coordinate apps still work |

---

## Commit Dependency Graph

```
C1 (fix port drift)
└── C2 (inline grammar)
    └── C3 (normalizer TS)
        └── C4* (port manifest JSON)  ← also feeds C5
            └── C6 (normalizer Go)
                └── C5 (single-pass generation)
                    └── C7 (validation gate)

C8 (api type) → C9 (history V2) → C10 (flow canvas) → C11 (step nodes) → C12 (auto-layout)
                                                                         └── C13 (layout compiler)  ← parallel with C10-C12

C14 (execution order) ← depends on C12 + C13
```

*C4 can be developed in parallel with C2/C3 but must integrate after C1.
