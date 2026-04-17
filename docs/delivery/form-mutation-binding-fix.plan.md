# Delivery Plan: Form-to-Mutation Binding Fix
_Last updated: 2026-04-17_
_Feature slug: form-mutation-binding-fix_
_Source: deep-trace of apps/web/app/builder/[appId]/FlowCanvas.tsx, apps/web/app/app/[appId]/RuntimeRenderer.tsx, packages/widget-catalog/src/index.ts, apps/web/app/builder/[appId]/ExpressionInput.tsx_

## Goal
Seven commits that fix the form-to-mutation binding path end-to-end: expose concrete form-field handles in the builder, guard against type-incompatible connections, separate data binding from mutation execution, replace fragile source-port SQL tokens with stable slot placeholders, execute mutations from an assembled slot bag, add backward-compatibility for existing saved apps, and add save-time validation.

## Root causes addressed
1. `WidgetNodeComponent` and `buildAvailableWidgets` use only static catalog ports — dynamic `*` form-field ports are never expanded into concrete handles (`name`, `email`, `status`, …).
2. The bind branch in `onConnect` accepts any source port, including `values` (an object) wired to a scalar mutation slot — producing a syntactically valid but semantically broken `{{form1.values}}` token.
3. `firePort` in the runtime executes a mutation step for every binding edge that fires. A form submit emits N per-field ports plus `values` plus `submitted` → the same mutation runs N+2 times.
4. `resolveSqlTemplate(sqlTemplate, value)` is called with only the single edge payload — multi-slot mutations can never satisfy all their tokens at once.
5. SQL tokens embed widget IDs (`{{form1.email}}`), making them brittle across node renames.
6. No save-time validation flags broken or ambiguous bindings.

## Stack Decisions

| Decision | Value | Reason |
|----------|-------|--------|
| Token format | `{{slot.set.0}}` / `{{slot.where.0}}` for new bindings | Decouples SQL from widget IDs; stable across renames |
| Binding edge execution | Binding edges never trigger step execution | Separates data-flow from control-flow |
| Mutation trigger | Explicit `run` input port on `step:mutation` | One trigger = one execution; deterministic |
| Slot accumulator | Per-node `Record<string, unknown>` ref in FlowEngineProvider | Accumulates all bound slot values before `run` fires |
| Backward compat | Load-time token migration in the V2 doc loader | Converts `{{widgetId.portName}}` to `{{slot.set.N}}` automatically |
| Port expansion | Runtime expand from `auraNode.with.fields` in WidgetNodeComponent | Builder surfaces exact same vocabulary as runtime |
| Commit ordering | 1→2→3→4→5→6→7; 1 and 2 are parallelizable | 3 depends on 1; 4 depends on 2; 5 depends on 3+4; 6 depends on 4; 7 depends on all |

---

## Commits

### Commit 1 — feat(flow-view): expand dynamic form-field ports in builder

**Why:** The runtime already emits one port per form field on submit (e.g. `name`, `email`, `status`). The builder shows only `values`, `submitted`, `*` from the static registry. Users cannot wire individual fields to mutation slots.

**Parallelizable with:** Commit 2

**Files:**
- `packages/widget-catalog/src/index.ts` — MODIFIED: export `expandWidgetPorts(node, ports)` helper
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: `WidgetNodeComponent` uses helper to expand form ports
- `apps/web/app/builder/[appId]/ExpressionInput.tsx` — MODIFIED: `buildAvailableWidgets` uses helper

**Interface contracts:**
```ts
// packages/widget-catalog/src/index.ts (new export)
/**
 * Expand dynamic ports for a widget node using its runtime config.
 * For form widgets, replaces the generic '*' port with one concrete port per field.
 * All other widgets are returned unchanged.
 */
export function expandWidgetPorts(nodeConfig: Record<string, unknown>, ports: PortDef[]): PortDef[]
```

**Implementation notes:**
- `expandWidgetPorts` takes `nodeConfig` (i.e. `auraNode.with ?? {}`) and the widget's catalog ports.
- For `form` widgets: filter out the `'*'` port, then parse `nodeConfig.fields as string` (comma-separated), and append one `PortDef` per field with `{ name: fieldName.trim(), direction: 'output', dataType: 'string', description: 'Form field: ${fieldName}' }`.
- Keep `values` and `submitted` and all input ports as-is.
- In `WidgetNodeComponent`: compute `const expandedPorts = expandWidgetPorts(wData.auraNode.with ?? {}, ports)` and use `expandedPorts` where `ports` was used.
- In `buildAvailableWidgets`: pass `n.with ?? {}` and the catalog ports through `expandWidgetPorts`.

**Tests:**
- `packages/widget-catalog/src/index.test.ts` — ADD: `expandWidgetPorts` with fields `'name,email,status'` → three concrete ports plus `values`/`submitted`/input ports, no `*`
- `packages/widget-catalog/src/index.test.ts` — ADD: `expandWidgetPorts` with non-form widget (e.g. `table`) → ports unchanged
- `packages/widget-catalog/src/index.test.ts` — ADD: `expandWidgetPorts` with form and no `fields` prop → returns catalog ports unchanged
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: `buildAvailableWidgets` returns concrete `name`/`email` ports for a form node with `fields: 'name,email'`

**Done criteria:**
- `pnpm --filter "@lima/widget-catalog" test` exits 0
- `pnpm --filter web tsc --noEmit` exits 0
- A form node with `fields: 'name,email,status'` renders three distinct output handles in the canvas (`name`, `email`, `status`) plus `values` and `submitted`

---

### Commit 2 — feat(flow-view): validate source-port type before accepting bind connections

**Why:** `onConnect` blindly writes `{{form1.values}}` when `form1.values` (an object port) is wired to a `bind:set:*` slot. The resulting token is never resolvable because the SQL slot expects a scalar.

**Parallelizable with:** Commit 1

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: `onConnect` bind branch adds type check

**Implementation notes:**
- In the bind branch (after `if (connection.targetHandle?.startsWith('bind:'))`), resolve the source widget's port definition: look up `WIDGET_REGISTRY[sourceNode.element]?.ports` and find the port matching `connection.sourceHandle`. Fall back to the expanded ports (after commit 1) for concrete field names.
- If the source port's `dataType` is `'object'` or `'array'`, return early without creating the binding (these are not scalar-compatible).
- Show a `console.warn` (and optionally a toast) explaining why the connection was rejected. Full toast UI is out of scope for this commit.
- Do **not** reject `trigger` → `bind:*` connections here; that is a separate concern (addressed in commit 3 by having triggers go to `run` instead).

**Tests:**
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: `onConnect` with `sourceHandle: 'values'` (dataType object) to `bind:set:0` → `onChange` is NOT called
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: `onConnect` with `sourceHandle: 'email'` (dataType string) to `bind:set:0` → `onChange` IS called

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Dragging `form1.values` onto a mutation `bind:set:0` slot silently rejects (no edge created, no SQL modified)
- Dragging a concrete field port `form1.email` onto a mutation `bind:set:0` slot creates the edge and writes the token

---

### Commit 3 — feat(runtime): add `run` trigger to step:mutation; binding edges skip execution

**Why:** Any edge firing into a mutation step currently executes it immediately. A form submit causes N+2 mutation executions (one per field + values + submitted). Binding edges should only supply data; control-flow must come through a dedicated trigger.

**Parallelizable with:** none (depends on commit 1 for expanded ports; must precede commit 5)

**Files:**
- `packages/widget-catalog/src/index.ts` — MODIFIED: add `run` input port to `step:mutation`
- `apps/web/app/app/[appId]/RuntimeRenderer.tsx` — MODIFIED: `FlowEngineProvider` — binding edges write to slot accumulator, `run` port triggers execution

**Interface contracts:**
New port in `step:mutation`:
```ts
{ name: 'run', direction: 'input', dataType: 'trigger', description: 'Trigger execution of this mutation step' }
```

New internal state in `FlowEngineProvider`:
```ts
// Per-node accumulator: nodeId -> portName -> value
// Used to collect bound slot values before the `run` trigger fires
const slotAccumulatorRef = useRef<Record<string, Record<string, unknown>>>({})
```

**Implementation notes:**
- Add `run` as the first input port in `step:mutation`'s ports array.
- In `firePort`, before executing a step, check `edge.edgeType`. If `edge.edgeType === 'binding'`, write the incoming value to `slotAccumulatorRef.current[edge.toNodeId][edge.toPort] = value` and return (do not execute the step).
- In the `step:mutation` execution branch, only execute when `edge.toPort === 'run'` (or when the target port is not a binding slot). If neither condition is met (i.e. the edge is a normal async edge to a non-run port), still fall through to execution for backward compatibility with existing docs that wire `submitted` directly to a mutation step without a `run` port.
- Specifically: for `step:mutation`, execute when `(edge.edgeType !== 'binding') && (edge.toPort === 'run' || edge.toPort === 'params')`. For backward compat, also execute when `edge.edgeType === 'async'` and target is the mutation step (any port other than `run` treated as a trigger).
- The slot accumulator is never cleared automatically (values persist across trigger firings). This is intentional: the latest bound values are always available.

**Tests:**
- `apps/web/app/app/[appId]/RuntimeRenderer.test.tsx` (or equivalent) — ADD:
  - Binding edge from `form1.email` to `bind:set:0` on mutation → `runConnectorMutation` is NOT called when `form1.email` fires
  - Async edge from `form1.submitted` to `run` on mutation → `runConnectorMutation` IS called once when `form1.submitted` fires
  - Form fires all per-field ports + values + submitted → `runConnectorMutation` is called exactly once

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- A form wired via binding edges to mutation slots + `submitted` → `run` triggers exactly one mutation call

---

### Commit 4 — refactor(flow-view): write stable `{{slot.set.N}}` placeholders in bind branch

**Why:** Tokens like `{{form1.email}}` embed widget IDs in SQL. If the node is renamed or the binding is rewired to a different source, the SQL text is stale. Stable slot placeholders decouple SQL from the binding graph.

**Parallelizable with:** none (depends on commit 2; precedes commit 5 and 6)

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: bind branch writes `{{slot.set.N}}` / `{{slot.where.N}}`
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: `onEdgesDelete` clears the slot placeholder from SQL (already clears, just verify the token matches)

**Implementation notes:**
- In the bind branch of `onConnect`, change line:
  ```ts
  const binding = `{{${connection.source}.${connection.sourceHandle}}}`
  ```
  to:
  ```ts
  const binding = `{{slot.${slotType}.${slotIdx}}}`
  ```
- The binding edge still records `fromPort: connection.sourceHandle` so the runtime knows which port to pull data from.
- No change to edge structure or AuraEdge types; only the SQL string written by the builder changes.
- `onEdgesDelete` already clears the slot value (sets `val: ''`) when a binding edge is deleted — no change needed there.

**Tests:**
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: `onConnect` binding → SQL contains `{{slot.set.0}}`, not `{{form1.email}}`
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: deleting a binding edge clears the `{{slot.set.0}}` token from SQL

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- New bindings write `{{slot.set.0}}` etc. in the SQL, not widget-ID-based tokens

---

### Commit 5 — feat(runtime): resolve mutations from assembled slot bag

**Why:** `resolveSqlTemplate(sqlTemplate, value)` receives the single value from the triggering edge. Slot placeholders like `{{slot.set.0}}` cannot be resolved from that payload. The resolver needs the full accumulated slot bag.

**Parallelizable with:** none (depends on commits 3 and 4)

**Files:**
- `apps/web/app/app/[appId]/RuntimeRenderer.tsx` — MODIFIED: mutation execution path passes slot bag to resolver
- `apps/web/app/app/[appId]/RuntimeRenderer.tsx` — MODIFIED: `resolveSqlTemplate` gains a second `slotBag` parameter

**Interface contracts:**
```ts
// Updated signature (backward compatible — slotBag defaults to {})
function resolveSqlTemplate(
  sql: string,
  data: unknown,
  slotBag?: Record<string, unknown>,
): string
```

**Implementation notes:**
- Extend `resolveSqlTemplate`: before the existing path-traversal resolution, check if the token matches `slot\.(set|where)\.\d+` (regex `/^slot\.(set|where)\.\d+$/`). If so, look up `slotBag[token]` directly and return `escapeSqlToken(value)`. Fall through to existing logic for non-slot tokens.
- In the `step:mutation` execution branch, build the slot bag from `slotAccumulatorRef.current[targetNode.id] ?? {}`.
- Pass the slot bag to `resolveSqlTemplate`: `resolveSqlTemplate(sqlTemplate, value, slotBag)`.
- The existing `{{widgetId.portName}}` fallback still works for legacy tokens (backward compat during transition).

**Tests:**
- Unit tests for `resolveSqlTemplate` with slot tokens:
  - `resolveSqlTemplate("INSERT INTO t (name) VALUES ('{{slot.set.0}}')", {}, { 'slot.set.0': 'Alice' })` → `"INSERT INTO t (name) VALUES ('Alice')"`
  - SQL injection: `resolveSqlTemplate("...'{{slot.set.0}}'", {}, { 'slot.set.0': "O'Brien" })` → `"...'O''Brien'"`
  - Mixed slot + legacy token → both resolve correctly
- Integration test: form with fields `name,email` bound to mutation, `submitted` → `run`, form submitted with `{name:'Alice',email:'a@x.com'}` → mutation called with `INSERT INTO … VALUES ('Alice','a@x.com')`

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- End-to-end: form submit writes correct values into mutation SQL

---

### Commit 6 — fix(compat): migrate legacy `{{widgetId.portName}}` binding tokens on doc load

**Why:** Existing saved documents use the old `{{form1.email}}` token format in their SQL. After commits 4 and 5, the slot-bag resolver would not find these tokens. A load-time migration converts them to `{{slot.set.N}}` automatically.

**Parallelizable with:** none (depends on commit 4 for new token format)

**Files:**
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: apply migration after loading V2 doc
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — POSSIBLY MODIFIED: export migration function for testing

**Interface contracts:**
```ts
/**
 * Migrate a V2 document's binding tokens from the old {{widgetId.portName}}
 * format to stable {{slot.set.N}} / {{slot.where.N}} placeholders.
 * Safe to call on already-migrated documents (idempotent).
 */
export function migrateLegacyBindingTokens(doc: AuraDocumentV2): AuraDocumentV2
```

**Implementation notes:**
- Iterate over all nodes with `element === 'step:mutation'` or `element === 'step:query'`.
- For each such node, find all binding edges targeting it (`doc.edges.filter(e => e.edgeType === 'binding' && e.toNodeId === node.id)`).
- For each binding edge, check the SQL: if `node.with?.sql` contains `{{fromNodeId.fromPort}}`, replace it with `{{slot.slotType.slotIdx}}` where `slotType` and `slotIdx` come from `edge.toPort` (e.g. `bind:set:0` → `slotType='set', slotIdx=0`).
- The function must be idempotent: if the SQL already contains `{{slot.set.0}}`, do not re-process.
- Apply this migration in the builder page after fetching the doc from the API, before passing it to FlowCanvas.
- Do NOT apply migration at runtime render time — RuntimeRenderer keeps its existing legacy-token fallback in `resolveSqlTemplate` for published apps that haven't been re-saved through the builder.

**Tests:**
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — ADD: `migrateLegacyBindingTokens` with a doc containing `{{form1.email}}` in a mutation SQL and a binding edge from `form1/email` to `bind:set:0` → SQL becomes `{{slot.set.0}}`
- ADD: idempotency test — already-migrated doc is unchanged

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Opening a previously saved doc with legacy tokens shows correct `{{slot.set.0}}` tokens on the canvas and does not corrupt the SQL

---

### Commit 7 — feat(builder): save-time validation for binding completeness

**Why:** Builders can save a doc with object-to-scalar bindings, unresolved slot placeholders, or mutation steps with bound slots but no `run` trigger. These are silent bugs that only surface at runtime. Surface them at save time.

**Parallelizable with:** none (depends on all preceding commits)

**Files:**
- `apps/web/app/builder/[appId]/StepConfigPanel.tsx` — MODIFIED: show inline warnings for unresolved slots and missing `run` trigger
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: validate before save/publish; show summary

**Implementation notes:**
- Add a `validateBindings(doc: AuraDocumentV2): ValidationIssue[]` function that checks:
  1. Any `step:mutation` node whose SQL contains `{{slot.set.N}}` or `{{slot.where.N}}` has a corresponding binding edge for each slot index.
  2. Any `step:mutation` node with at least one binding edge also has at least one non-binding edge targeting its `run` port (otherwise it will accumulate values but never execute).
  3. No binding edges from object-typed ports (already blocked at connection time by commit 2, but validate defensively).
- `ValidationIssue` shape: `{ nodeId: string; severity: 'error' | 'warning'; message: string }`.
- In `StepConfigPanel`, when the selected node is `step:mutation`, call `validateBindings` filtered to that node and render any issues inline below the SQL editor.
- On save/publish in `page.tsx`, run `validateBindings` on the full doc. If there are any errors, show a confirmation dialog listing the issues (allow saving with warnings, block publish with errors).

**Tests:**
- Unit tests for `validateBindings`:
  - Mutation with `{{slot.set.0}}` in SQL and a binding edge for slot 0 → no issues
  - Mutation with `{{slot.set.0}}` in SQL but no binding edge for slot 0 → error
  - Mutation with binding edges but no `run` edge → warning
  - Mutation with binding edges AND a `run` edge → no issues

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Saving a mutation step that has `{{slot.set.0}}` in SQL but no binding edge shows an error in `StepConfigPanel`
- Saving/publishing a fully configured mutation (binding + run trigger) shows no issues

---

## Overall validation

Run after each commit:
```bash
pnpm --filter "@lima/widget-catalog" test    # after commits 1, 3
pnpm --filter web tsc --noEmit               # every commit
pnpm --filter web test                       # every commit
```

Integration test path (manual, after commit 5):
1. Open builder, add a Form with `fields: name,email` and a Mutation step
2. Wire `form.name` → `mutation bind:set:0`, `form.email` → `mutation bind:set:1`
3. Wire `form.submitted` → `mutation run`
4. Verify SQL contains `INSERT INTO … VALUES ('{{slot.set.0}}', '{{slot.set.1}}')`
5. In runtime, submit form with `{name:'Alice',email:'alice@example.com'}`
6. Verify mutation was called exactly once with resolved values
