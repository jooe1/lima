# Delivery Plan: Dual-Layer Graph Canvas — Phase 1 Foundation
_Last updated: 2026-04-11_
_Feature slug: dual-layer-graph-canvas-p1_
_Source: docs/requirements/dual-layer-graph-canvas.md_

## Goal
Lay the DSL, reactive-runtime, widget-port, and database foundations (P1-01 through P1-08) in strict dependency order so that no commit breaks an existing build and each commit is independently reviewable and testable before the next begins.

## Stack Decisions

| Decision | Value | Reason |
|----------|-------|--------|
| V2 API naming | New `parseV2` / `serializeV2` / `validateV2` / `diffV2` / `applyDiffV2` alongside existing V1 functions | Phase 1 must not break existing callers; V1 signatures stay unchanged until Phase 2 removes them |
| Reactive runtime location | `packages/aura-dsl/src/reactive.ts` (new file, re-exported from `index.ts`) | Keeps all DSL-related logic in one package; avoids a new package for Phase 1 |
| Step node port registry | New `StepNodeType` union + `STEP_NODE_REGISTRY` in `widget-catalog` | Step node element names contain `:` (e.g. `step:query`), making them invalid TypeScript union literals for `WidgetType`; separate registry avoids pollution |
| Port validation coupling | `validateV2` accepts a structural `PortRegistry` parameter; callers build it from the catalog | Prevents a circular dependency `aura-dsl → widget-catalog`; `PortDef` shape is re-declared structurally in `aura-dsl` |
| Transform sandbox | `new Function` with explicit scope args + prototype-pollution regex guard | Worker-based hard kill is over-engineered for Phase 1; 50 ms timeout is a post-execution check — documented limitation in code comment |
| DB migration number | `022_dsl_edges` | Latest existing migration is `021_user_language`; next slot is 022 |

---

## Commits

### Commit 1 — feat(aura-dsl): add AuraEdge and AuraDocumentV2 types
**Why:** Establishes the shared TypeScript types that commits 2, 3, 5, 6, and 7 all import; must land first.
**Parallelizable with:** Commits 4 and 8 (non-overlapping files)

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED: add `EdgeType`, `AuraEdge`, `AuraDocumentV2` exports
- `packages/aura-dsl/src/index.test.ts` — MODIFIED: add type-shape assertions

**Interface contracts** (names and shapes other commits depend on):
```ts
export type EdgeType = 'reactive' | 'async'

export interface AuraEdge {
  id: string
  fromNodeId: string   // widget ID or step node ID (e.g. "step_load_user")
  fromPort: string     // output port name (e.g. "selectedRow", "result")
  toNodeId: string
  toPort: string       // input port name (e.g. "content", "sql_param.user_id")
  edgeType: EdgeType
  transform?: string   // optional JS expression; $ is the source value
}

export interface AuraDocumentV2 {
  nodes: AuraNode[]
  edges: AuraEdge[]
}
```

**Implementation notes:**
- Place the three new exports directly after the existing `AuraDocument` type alias — no existing symbol is moved or altered.
- `AuraDocument` (= `AuraNode[]`) remains exported and unchanged; callers referencing it still compile.

**Tests** (written in this commit):
- `packages/aura-dsl/src/index.test.ts`: one test asserting that constructing an `AuraEdge` literal and an `AuraDocumentV2` literal type-checks and that both are exported (runtime `typeof` guard is sufficient for vitest).

**Done criteria:**
- `pnpm --filter @lima/aura-dsl build` exits 0
- `pnpm --filter @lima/aura-dsl test` exits 0
- `AuraEdge` and `AuraDocumentV2` are importable from the package root

---

### Commit 2 — feat(aura-dsl): extend parser with ---edges--- section and edge statements
**Why:** Adds `parseV2` so DSL source containing an `---edges---` block can be deserialized into an `AuraDocumentV2`; backward-compatible (no `---edges---` → `edges: []`).
**Parallelizable with:** Commits 4 and 8

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED: add `parseV2` function
- `packages/aura-dsl/src/index.test.ts` — MODIFIED: add parser tests for edge section

**Interface contracts:**
```ts
export function parseV2(source: string): AuraDocumentV2
// Throws ParseError on:
//   - malformed edge statement (wrong token count, wrong keywords)
//   - edge with missing id, fromNodeId, fromPort, toNodeId, toPort, or edgeType
```

**Implementation notes:**
- The existing tokenizer regex (`\S+` catch-all) already captures `---edges---` as a single token. In the main parse loop, detect this sentinel and switch to edge-parsing mode; everything before it is node statements, everything after is edge statements.
- No valid `AuraNode` element name begins with `-`, so the sentinel is unambiguous.
- Edge statement grammar: `edge <id> from <fromNodeId>.<fromPort> to <toNodeId>.<toPort> <edgeType> [transform <quotedExpr>] ;`
- `fromNodeId.fromPort` arrives as a single `\S+` token (e.g. `table1.selectedRow`). Split on the **first** dot only because `toPort` values such as `sql_param.user_id` can themselves contain dots.
- `parseV2` calls the same internal node-parsing path as `parse`; share the existing `parseNode` helper by extracting it (rename the inline loop body) rather than duplicating it. This is the **only** refactor permitted in this commit.
- Documents without `---edges---` return `{ nodes: [...existingNodes], edges: [] }`.

**Tests:**
- Document with `---edges---` section → `AuraDocumentV2.edges` matches expected shape
- Document without `---edges---` → `edges` is `[]`
- Edge with `transform` clause → `edge.transform` is populated
- Malformed edge (missing `from`/`to` keyword) → throws `ParseError`
- Round-trip: `parseV2(serialize(parseV2(source).nodes))` returns `edges: []` (i.e. `serialize` output is still valid input for `parseV2`)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `parseV2` is exported from the package root
- Existing `parse()`-based tests are all green (no regression)

---

### Commit 3 — feat(aura-dsl): extend serializer, validator, and diff/merge for edges
**Why:** Completes the V2 round-trip (`parseV2 ↔ serializeV2`), adds edge-ref and reactive-cycle validation, and widens the `DiffOp` union with edge operations.
**Parallelizable with:** Commits 4 and 8

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED: `serializeV2`, `validateV2`, `PortRegistryEntry`, `PortRegistry`, `diffV2`, `applyDiffV2`; extend `DiffOp` union
- `packages/aura-dsl/src/index.test.ts` — MODIFIED

**Interface contracts:**
```ts
// Extended DiffOp union (additive — existing variants unchanged):
export type DiffOp =
  | { op: 'add';         node: AuraNode }
  | { op: 'remove';      id: string }
  | { op: 'update';      id: string; patch: Partial<AuraNode> }
  | { op: 'add_edge';    edge: AuraEdge }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'update_edge'; edgeId: string; patch: Partial<AuraEdge> }

// Structural type — avoids importing from widget-catalog:
export interface PortRegistryEntry { name: string; direction: 'input' | 'output' }
export type PortRegistry = Map<string, readonly PortRegistryEntry[]>
// key = element type string, e.g. 'table', 'step:query'

export function serializeV2(doc: AuraDocumentV2): string
export function validateV2(doc: AuraDocumentV2, portRegistry?: PortRegistry): ValidationError[]
export function diffV2(
  from: AuraDocumentV2,
  to: AuraDocumentV2,
  opts?: { force?: boolean }
): DiffOp[]
export function applyDiffV2(doc: AuraDocumentV2, ops: DiffOp[]): AuraDocumentV2
```

**Implementation notes:**
- `serializeV2`: serialize nodes using the existing `serializeNode` helper; if `edges.length > 0` append `\n---edges---\n`; each edge line: `` edge <id> from <fromNodeId>.<fromPort> to <toNodeId>.<toPort> <edgeType>[ transform <JSON.stringify(transform)>] ; ``
- `validateV2`: run the full existing node-level validation, then for each edge check that `fromNodeId` and `toNodeId` exist in `doc.nodes` (by `id`). If `portRegistry` is provided, also verify `fromPort` ∈ registry for `fromNodeId`'s element type and `toPort` ∈ registry for `toNodeId`'s element type. Port errors use `edge.id` as the `nodeId` field of `ValidationError`.
- Reactive cycle detection: build an adjacency list from **only** `edgeType: 'reactive'` edges (async cycles are valid — approval gate loops). Run Kahn's algorithm; if any node retains non-zero in-degree after BFS, emit a `ValidationError` for each remaining edge.
- `diffV2`: run the existing `diff` logic on `from.nodes` vs `to.nodes` for node ops; run a parallel edge diff (by `id`) for edge ops. Compose into a single `DiffOp[]`.
- `applyDiffV2`: handle existing node ops with the existing `applyDiff` logic; additionally dispatch `add_edge`, `remove_edge`, `update_edge` against a cloned edge array.
- The extended `DiffOp` union is **additive** — callers with exhaustive `switch` statements on the existing three variants will get a TypeScript error on the new edge variants. Note this in the commit message as a minor breaking change within the package.

**Tests:**
- `parseV2(serializeV2(doc))` deep-equals `doc` for a document with edges (round-trip both directions)
- `validateV2`: reports unknown `fromNodeId` and `toNodeId`
- `validateV2`: detects a reactive cycle (A→B→C→A); does not fire on an async-only cycle
- `validateV2` with `portRegistry`: flags edge with `fromPort` absent from registry
- `diffV2`: detects added, removed, and property-patched edge
- `applyDiffV2`: applies `add_edge`, `remove_edge`, `update_edge` ops correctly

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `serializeV2`, `validateV2`, `diffV2`, `applyDiffV2`, `PortRegistry` exported from package root
- Round-trip test passes (parse → serialize → parse produces identical structure)

---

### Commit 4 — feat(widget-catalog): add PortDef type and populate static port registry
**Why:** Gives the DSL validator (commit 3) and the future Flow View a machine-readable port schema for every widget type and all five step-node types.
**Parallelizable with:** Commits 1, 2, 3, 5, 6, 7, 8

**Files:**
- `packages/widget-catalog/src/index.ts` — MODIFIED: add `PortDef`, `StepNodeType`, `StepNodeMeta`, `STEP_NODE_REGISTRY`; add `ports: PortDef[]` to `WidgetMeta`; populate `ports` on every `WIDGET_REGISTRY` entry
- `packages/widget-catalog/src/index.test.ts` — NEW

**Interface contracts:**
```ts
export interface PortDef {
  name: string
  direction: 'input' | 'output'
  dataType: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'trigger' | 'void'
  description: string
  dynamic?: boolean  // true → additional ports of this shape generated at runtime from widget config
}

// WidgetMeta gains one required field (all existing entries must declare it):
export interface WidgetMeta {
  // ...existing fields unchanged...
  ports: PortDef[]
}

export type StepNodeType =
  | 'step:query'
  | 'step:mutation'
  | 'step:condition'
  | 'step:approval_gate'
  | 'step:notification'

export interface StepNodeMeta {
  type: StepNodeType
  displayName: string
  description: string
  icon: string          // Lucide icon name
  ports: PortDef[]
}

export const STEP_NODE_REGISTRY: Record<StepNodeType, StepNodeMeta>
```

**Implementation notes:**
- Populate `ports` for all 11 entries in `WIDGET_REGISTRY` per the port table in requirements section 4.5. Key mappings: `table` → 3 outputs (`selectedRow`, `rows`, `selectedRowIndex`) + 3 inputs (`refresh`, `setRows`, `setFilter`); `form` → 2 static outputs (`values`, `submitted`) + 1 dynamic output sentinel (`dynamic: true`, `name: '*'`) + 3 inputs; `button` → 2 outputs + 2 inputs; `text` / `kpi` / `chart` / `filter` / `markdown` / `modal` / `tabs` / `container` per the table.
- `form` dynamic ports: list `values` and `submitted` as static; add a third entry `{ name: '*', direction: 'output', dataType: 'string', dynamic: true, description: 'One port per form field, keyed by field name' }`. The `*` name is a sentinel — callers that enumerate ports should skip names starting with `*` when displaying fixed ports.
- `step:query` / `step:mutation`: `params` input port has `dynamic: true` (one per SQL parameter). Static outputs are `result`, `rows`, `firstRow`, `rowCount` / `result`, `affectedRows`.
- Because `ports` is now a required field on `WidgetMeta`, TypeScript will error at build time if any `WIDGET_REGISTRY` entry is missing it — this is intentional self-validation.

**Tests** (`packages/widget-catalog/src/index.test.ts`, NEW):
- Every `WidgetType` key in `WIDGET_REGISTRY` has a non-empty `ports` array
- Every `StepNodeType` key in `STEP_NODE_REGISTRY` has a non-empty `ports` array
- All `direction` values across both registries are `'input'` or `'output'`
- No duplicate `name` within a single registry entry's port list

**Done criteria:**
- `pnpm --filter @lima/widget-catalog build` exits 0
- `pnpm --filter @lima/widget-catalog test` exits 0 (new test file runs)
- `StepNodeType` and `STEP_NODE_REGISTRY` are exported from the package root
- `WidgetMeta.ports` is required (TypeScript enforcement)

---

### Commit 5 — feat(aura-dsl): implement reactive store (signal/subscription)
**Why:** Creates the client-side observable state Map that widget components write to and the expression runtime reads from.
**Parallelizable with:** Commits 4 and 8

**Files:**
- `packages/aura-dsl/src/reactive.ts` — NEW: `ReactiveStore`, `Subscriber`, `createReactiveStore`
- `packages/aura-dsl/src/reactive.test.ts` — NEW
- `packages/aura-dsl/src/index.ts` — MODIFIED: add `export * from './reactive'`

**Interface contracts:**
```ts
// packages/aura-dsl/src/reactive.ts

export type Subscriber = (value: unknown) => void

export interface ReactiveStore {
  get(widgetId: string, portName: string): unknown
  set(widgetId: string, portName: string, value: unknown): void
  /** Returns a function that, when called, cancels the subscription. */
  subscribe(widgetId: string, portName: string, fn: Subscriber): () => void
  /** Returns a frozen two-level copy for debugging / snapshot assertions. */
  snapshot(): ReadonlyMap<string, ReadonlyMap<string, unknown>>
}

export function createReactiveStore(): ReactiveStore
```

**Implementation notes:**
- Internal storage: two-level `Map<string, Map<string, unknown>>` keyed by `widgetId` → `portName` → value. Do **not** collapse to a single `"widgetId:portName"` key — step node IDs already contain `:` (e.g. `step_load_user`), and the colon in the port path `sql_param.user_id` could create ambiguous keys.
- Subscriber storage: `Map<string, Map<string, Set<Subscriber>>>` mirroring the value map structure.
- `set()` notifies all subscribers for that `(widgetId, portName)` pair synchronously. Wrap each subscriber call in `try/catch` — a throwing subscriber must not prevent remaining subscribers from firing. Log the error to `console.error`.
- `snapshot()` returns a `new Map` of `new Map` copies (shallow per-entry) so callers see a stable structure between renders.

**Tests** (`packages/aura-dsl/src/reactive.test.ts`, NEW):
- `get` returns `undefined` for an unknown key
- `set` → `get` returns the new value
- `subscribe` → subscriber called synchronously on `set`
- Returned unsubscribe function → subscriber not called after invocation
- Two subscribers on the same key → both called
- Subscriber on different key → not called when unrelated key changes
- Throwing subscriber → other subscribers for the same key still fire
- `snapshot` reflects the current state and is not the live map (mutations after snapshot do not affect it)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `createReactiveStore` and `ReactiveStore` are importable from `@lima/aura-dsl`

---

### Commit 6 — feat(aura-dsl): implement expression runtime (topo-sort and edge propagation)
**Why:** Wires reactive edges from an `AuraDocumentV2` into the store so that a `publish` call automatically propagates values through the topologically-sorted dependency graph.
**Parallelizable with:** Commits 4 and 8

**Files:**
- `packages/aura-dsl/src/reactive.ts` — MODIFIED: add `buildDependencyGraph`, `topoSort`, `resolveExpression`, `createReactiveRuntime`, `CycleHandler`, `TransformTimeoutHandler`, `RuntimeOptions`, `ReactiveRuntime`
- `packages/aura-dsl/src/reactive.test.ts` — MODIFIED

**Interface contracts:**
```ts
export type CycleHandler = (cycleEdgeIds: string[]) => void
export type TransformTimeoutHandler = (edgeId: string, expr: string) => void

export interface RuntimeOptions {
  onCycleDetected?: CycleHandler
  onTransformTimeout?: TransformTimeoutHandler
}

export interface ReactiveRuntime {
  /** Notify that a widget output port value has changed. Propagates downstream. */
  publish(widgetId: string, portName: string, value: unknown): void
  destroy(): void
}

export function createReactiveRuntime(
  doc: AuraDocumentV2,
  store: ReactiveStore,
  opts?: RuntimeOptions
): ReactiveRuntime

// Exported for unit testing:
export function buildDependencyGraph(
  edges: AuraEdge[]
): Map<string, string[]>
// key format: "${widgetId}:${portName}" — colon chosen because widgetId
// is an arbitrary identifier that never contains ':', while portName uses '.'
// as a sub-path separator.  e.g. "table1:selectedRow"

export function topoSort(
  graph: Map<string, string[]>
): string[] | null  // null = cycle detected

export function resolveExpression(
  expr: string,
  store: ReactiveStore
): unknown
// Replaces {{widgetId.portName}} (and nested paths like {{t1.row.email}})
// by reading from the store. Returns the raw expr string if no pattern found.
```

**Implementation notes:**
- `buildDependencyGraph` includes **only** edges with `edgeType: 'reactive'` — async edges are not evaluated in the browser runtime.
- Node key format `"widgetId:portName"`: `widgetId` is always a plain identifier (letters, numbers, underscores, hyphens) and never contains `:`. Step node element names (`step:query`) describe the type, not the id — the id is something like `step_load_user`. No collision risk.
- `topoSort`: Kahn's algorithm (BFS in-degree). Returns `null` if any node has non-zero remaining in-degree after BFS completion. Does not throw.
- When `createReactiveRuntime` detects a cycle, collect the edge IDs whose `fromNodeId:fromPort` or `toNodeId:toPort` keys were not included in the topological order, call `opts?.onCycleDetected(edgeIds)`, and exclude those edges from the live propagation map. The runtime continues in degraded mode rather than refusing to function.
- `createReactiveRuntime.publish(widgetId, portName, value)`: (1) call `store.set(widgetId, portName, value)`; (2) look up all downstream edges in sorted order from that origin key; (3) for each edge, compute the target value — if `edge.transform` is set, call `evaluateTransform($, edge.transform)` (from commit 7, wired in at this call site); (4) call `store.set(toNodeId, toPort, targetValue)`.
- `evaluateTransform` is called via a late-bound import from the same module. In commit 6, stub it with a pass-through: `($ , _expr) => $`. Commit 7 replaces this stub.
- `resolveExpression` uses regex `/\{\{([^}]+)\}\}/g`. For each match, the capture group is split on `.` — first segment is `widgetId`, remaining segments are the nested property path. Read `store.get(widgetId, firstSegment)` then resolve the rest of the path using optional chaining (`?.`) so missing intermediates yield `undefined` rather than throwing.
- `destroy()` should clean up any store subscriptions the runtime registered (none in this commit, but the interface must be present for commitment 7 or Phase 2 to extend).

**Tests:**
- `buildDependencyGraph`: two edges A→B and B→C → correct adjacency map
- `topoSort`: linear chain `[A, B, C]` → `['A', 'B', 'C']` in order
- `topoSort`: cycle `A→B, B→A` → returns `null`
- `createReactiveRuntime.publish` with a two-hop chain: A.out → B.in → C.in; publish on A results in both B and C being updated in the store
- `createReactiveRuntime` with a cycled reactive edge: `onCycleDetected` is called once; subsequent `publish` does not loop infinitely
- `resolveExpression`: `'{{widget1.port1}}'` reads from store
- `resolveExpression`: `'{{table1.selectedRow.name}}'` reads `selectedRow` from store and accesses `.name`
- `resolveExpression`: unknown widget ID → returns `undefined` embedded in expression result (no throw)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `createReactiveRuntime`, `buildDependencyGraph`, `topoSort`, `resolveExpression` exported from `@lima/aura-dsl`

---

### Commit 7 — feat(aura-dsl): implement sandboxed transform evaluator
**Why:** Replaces the pass-through stub in commit 6 with a real inline evaluator that enforces a frozen scope and guards against prototype pollution.
**Parallelizable with:** Commits 4 and 8

**Files:**
- `packages/aura-dsl/src/reactive.ts` — MODIFIED: implement `evaluateTransform`, add `EvaluationError`
- `packages/aura-dsl/src/reactive.test.ts` — MODIFIED

**Interface contracts:**
```ts
export class EvaluationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'EvaluationError'
  }
}

export function evaluateTransform(
  $: unknown,
  expr: string,
  timeoutMs?: number  // default 50
): unknown
// Throws EvaluationError on:
//   - prototype pollution attempt (__proto__ / constructor / prototype in expr)
//   - JS syntax error in expr
//   - elapsed wall time exceeds timeoutMs (best-effort post-execution check)
// Returns transformed value on success.
```

**Implementation notes:**
- **Pollution guard first**: check `expr` against `/(__proto__|constructor\.constructor|\.prototype\b)/` and throw `EvaluationError('prototype pollution attempt blocked')` if matched. This runs synchronously before any `Function` construction.
- **Scope construction**: `new Function('$', 'Math', 'String', 'Number', 'Array', 'Object', 'JSON', 'Date', '"use strict"; return (' + expr + ')')`. Pass the globals explicitly as arguments — they shadow any closure or `window`-level reference inside the function. Do **not** pass `globalThis`, `window`, `document`, `fetch`, `process`, `eval`, or `Function`.
- **Timeout check**: record `const start = performance.now()` before calling the constructed function; after it returns, if `performance.now() - start > timeoutMs`, throw `EvaluationError('transform timeout')`. This is a post-execution check — a genuinely infinite loop cannot be interrupted synchronously. Add a code comment: `// NOTE: hard pre-emption of infinite loops requires a Worker (deferred to Phase 3 hardening)`.
- **Caller contract** (in `createReactiveRuntime`, commit 6 call site): wrap `evaluateTransform` in try/catch; on `EvaluationError` call `opts?.onTransformTimeout(edgeId, expr)` and fall back to passing the raw source value through to `store.set`.
- The expression form `return (expr)` supports both single expressions (`$.toUpperCase()`) and ternary expressions. Multi-statement blocks (`;` separated) are intentionally unsupported; the parser wraps the whole expression in parens which will cause a syntax error for blocks with `return` — this is the desired behaviour.

**Tests:**
- `$.toUpperCase()` on a string input returns uppercased string
- `$.filter(r => r.active)` on an array returns filtered array
- `__proto__` in expression → throws `EvaluationError` (pollution guard)
- `constructor.constructor('return process')()` → `EvaluationError` (pollution guard matches `constructor.constructor`)
- Reference to `window` → `ReferenceError` thrown inside the function → caught and re-thrown as `EvaluationError`
- Syntax error in expression → `EvaluationError`
- Timeout: expression that starts a tight loop exceeding 50 ms → `EvaluationError` (test uses a flag to verify `onTransformTimeout` callback is invoked in a `createReactiveRuntime` integration scenario — do not try to actually run an infinite loop in tests; mock `performance.now` to simulate elapsed time)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `evaluateTransform` and `EvaluationError` exported from `@lima/aura-dsl`
- The pass-through stub from commit 6 is replaced; existing commit-6 tests still pass

---

### Commit 8 — feat(api): add dsl_edges JSONB and dsl_version columns to apps table
**Why:** Persists edges and document format version to the database; required before any builder save path can store V2 documents.
**Parallelizable with:** Commits 1 through 7 (fully non-overlapping files)

**Files:**
- `services/api/migrations/022_dsl_edges.up.sql` — NEW
- `services/api/migrations/022_dsl_edges.down.sql` — NEW
- `services/api/internal/model/model.go` — MODIFIED: add `AuraEdge` struct; add `DslEdges` and `DslVersion` to `App`
- `services/api/internal/store/apps.go` — MODIFIED: update SELECT column lists and `Scan` call sites; update `UPDATE` query
- `services/api/internal/model/model_test.go` — NEW: JSON round-trip for `AuraEdge`

**Interface contracts:**

```sql
-- 022_dsl_edges.up.sql
ALTER TABLE apps ADD COLUMN dsl_edges   JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN dsl_version INTEGER NOT NULL DEFAULT 1;
```

```sql
-- 022_dsl_edges.down.sql
ALTER TABLE apps DROP COLUMN IF EXISTS dsl_version;
ALTER TABLE apps DROP COLUMN IF EXISTS dsl_edges;
```

```go
// model.go — new type:
type AuraEdge struct {
    ID         string `json:"id"`
    FromNodeID string `json:"from_node_id"`
    FromPort   string `json:"from_port"`
    ToNodeID   string `json:"to_node_id"`
    ToPort     string `json:"to_port"`
    EdgeType   string `json:"edge_type"`    // "reactive" | "async"
    Transform  string `json:"transform,omitempty"`
}

// model.go — App struct additions:
type App struct {
    // ...all existing fields unchanged...
    DslEdges  []AuraEdge `json:"dsl_edges"`
    DslVersion int       `json:"dsl_version"`
}
```

**Implementation notes:**
- `apps.go` has exactly **5 Scan call sites** that enumerate the full `App` column list (lines ~43, ~62, ~84, ~118, ~240). Each needs `dsl_edges` and `dsl_version` appended to the SELECT list and two additional Scan arguments, following the same `nodeMetaRaw []byte` + `json.Unmarshal` pattern already used for `node_metadata`:
  ```go
  var dslEdgesRaw []byte
  // ...Scan(..., &dslEdgesRaw, &a.DslVersion)
  if dslEdgesRaw != nil {
      _ = json.Unmarshal(dslEdgesRaw, &a.DslEdges)
  }
  ```
- The `UPDATE apps SET dsl_source = ... node_metadata = ...` query (for saving DSL) should also add `dsl_edges = $N, dsl_version = $M` so the write path is complete. Without this, saving a V2 document from the builder (Phase 2) would silently discard edges. Confirm parameter positions carefully — the existing scan-column ordering is positional and off-by-one errors will cause silent data corruption.
- The `appVersionCols` constant covers `app_versions`, not `apps` — leave it unchanged. Version snapshotting of edges is a Phase 3 concern.
- The worker SELECT in `services/worker/internal/queue/generation.go` (`SELECT id, dsl_source, node_metadata FROM apps`) does **not** need updating in this commit — the worker does not yet consume edges.
- `DslEdges` initialises to `nil` after scanning a row with `dsl_edges = '[]'`. Callers that range over `DslEdges` tolerate nil slices in Go, so no special handling is needed at the model layer. The JSON serialiser will emit `null` for a nil slice; if `[]` is required in API responses, add `omitempty` and handle the zero case in the handler layer (out of scope here).

**Tests:**
- `services/api/internal/model/model_test.go` (NEW): marshal an `AuraEdge` to JSON then unmarshal → deep equal; verify `transform` is omitted from JSON when empty.
- Existing integration tests in `services/worker/internal/queue/workflow_integration_test.go` use bare `INSERT INTO apps (..., dsl_source, ...)` which omits `dsl_edges` — this is valid because the column has a `DEFAULT '[]'`. Tests must pass unchanged.

**Done criteria:**
- Migration runs cleanly against a local Postgres instance: `up` adds both columns; `down` removes them idempotently
- `go build ./...` from `services/api` exits 0
- `go test ./internal/model/...` exits 0 (new test passes)
- Existing API integration tests pass unchanged

---

## Critical Files

| File | Why Critical |
|------|-------------|
| `packages/aura-dsl/src/index.ts` | Modified by commits 1, 2, 3, and 5; strict sequential dependency — merging any two of these out of order will produce conflicts |
| `packages/aura-dsl/src/reactive.ts` | Created in commit 5, modified by 6 and 7; commit 7 replaces a stub left by commit 6 |
| `packages/widget-catalog/src/index.ts` | `WidgetMeta.ports` becomes required — any missed `WIDGET_REGISTRY` entry breaks the TypeScript build |
| `services/api/internal/store/apps.go` | Five Scan call sites with positional column binding; one missed column addition will silently mismap scan targets |

---

## Open Questions

Minor unknowns the implementing agent should resolve at implementation time:

- **Write path for `dsl_edges` in Phase 1**: The builder save handler (`services/api/internal/handler/`) calls the store's SaveDSL function. Should it start sending `dsl_edges` in Phase 1? If yes, the handler and store `UPDATE` query must be wired in commit 8. If no, the column is read-only until the builder UI ships in Phase 2. Confirm with team — the plan assumes yes (write path added in commit 8).
- **`AppVersion` edge snapshotting**: Migration 022 intentionally does not add `dsl_edges` to `app_versions`. If published versions must capture edges, a follow-up migration is needed before the Phase 2 publish flow ships.
- **`DslEdges` nil vs empty in API responses**: A freshly migrated app will have `dsl_edges = '[]'` in DB. Go `json.Unmarshal` of `[]` into `[]AuraEdge` yields an empty (non-nil) slice. Serialised back to JSON this is `[]`. Confirm the frontend can handle both `[]` and `null` for backward compat.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `apps.go` positional scan changes introduce silent column mismapping | Enumerate each SELECT column list and Scan argument in a comment, assert column count == scan argument count in a unit test (`model_test.go`) |
| Extended `DiffOp` union breaks existing exhaustive `switch` statements in unscoped callers | Audit all `switch(op.op)` sites in the repo before landing commit 3; add `default: assertNever(op)` or equivalent to catch newly-unhandled variants at compile time |
| `new Function` sandbox bypass via non-obvious globals (`Reflect`, `Proxy`, `Symbol`) | Post-commit security review of `evaluateTransform`; add test cases for `Reflect.get`, `Proxy`, and `Symbol.for` — if any resolve, add them to the pollution-guard regex or the parameter shadow list |
| `---edges---` tokenizer ambiguity | Verified: the existing tokenizer's `\S+` path captures it as one token; no valid `AuraNode` element starts with `-`; no further action needed |
| Reactive cycle in Phase 1 visible only at validation time | `createReactiveRuntime` degrades gracefully (excludes cyclic edges, calls `onCycleDetected`) — the builder UI is responsible for surfacing the error badge (Phase 2) |
