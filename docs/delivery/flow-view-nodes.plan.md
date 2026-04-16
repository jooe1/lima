# Delivery Plan: Flow View Node Improvements
_Last updated: 2026-04-16_
_Feature slug: flow-view-node-improvements_
_Source: analysis of apps/web/app/builder/[appId]/FlowCanvas.tsx and packages/widget-catalog/src/index.ts_

## Goal
Five targeted commits that fix broken config summaries, add semantic handle colors, improve port legibility, surface data-type information, indicate dynamic ports, and add a missing failure output port to the notification step — all without touching the document model or API.

## Stack Decisions

| Decision | Value | Reason |
|----------|-------|--------|
| Scope | `FlowCanvas.tsx` + `widget-catalog/index.ts` only | All changes are purely visual or registry metadata; no DSL, API, or routing changes required |
| No new packages | Existing `@xyflow/react`, `@lima/widget-catalog` only | Style/registry changes need no new dependencies |
| Commit ordering | Bug fixes first, then visual enhancements | Commit 1 is a regression fix; later commits build on readable nodes |
| Parallelism | Commits 3 and 4 are parallelizable; all others are sequential | 3 and 4 touch separate code paths in the same file with no shared state |

---

## Commits

### Commit 1 — fix(flow-view): correct config summaries for query, mutation, condition, and approval-gate nodes
**Why:** Config summaries for three of the seven step types are always "Not configured" or always hardcoded, even when the step is fully wired. This is a correctness regression — builders cannot see their step's configuration on the canvas.
**Parallelizable with:** none (baseline fix; all later commits depend on correct summaries)

**Root causes:**
- `step:query` and `step:mutation` are handled in the same branch; the mutation branch checks `w.sql` (never set) and `w.connector` (key is actually `w.connector_id`). Also `step:query` checks `w.connector` instead of `w.connector_id`.
- `step:condition`: reads `w.expression` but the config shape (from `STEP_DEFAULT_CONFIGS` in `WorkflowCanvas.tsx`) stores `{ left, op, right }`.
- `step:approval_gate`: hardcoded to the string `'Awaits admin approval'`; never reads `w.description` or `w.approver_role`.

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: config summary block in `StepNodeComponent`

**Implementation notes — exact diff to `configSummary` block:**

Replace the current combined `step:query || step:mutation` branch and the `step:condition` and `step:approval_gate` branches with:

```tsx
// step:query
if (sData.stepType === 'step:query') {
  const sql  = w.sql           as string | undefined
  const conn = w.connector_id  as string | undefined   // was w.connector — wrong key
  if (sql)  configSummary = sql.slice(0, 40) + (sql.length > 40 ? '\u2026' : '')
  else if (conn) configSummary = `connector: ${conn.slice(0, 20)}`

// step:mutation
} else if (sData.stepType === 'step:mutation') {
  const op    = (w.operation   as string | undefined) ?? 'insert'
  const table =  w.table       as string | undefined
  const conn  =  w.connector_id as string | undefined
  const OP_LABEL: Record<string, string> = { insert: 'INSERT INTO', update: 'UPDATE', delete: 'DELETE FROM' }
  const opLabel = OP_LABEL[op] ?? op.toUpperCase()
  if (table)      configSummary = `${opLabel} ${table}`
  else if (conn)  configSummary = `${opLabel} (connector: ${conn.slice(0, 20)})`
  else            configSummary = `${opLabel} — not configured`

// step:condition
} else if (sData.stepType === 'step:condition') {
  const left  = w.left  as string | undefined   // was w.expression — wrong key
  const op    = w.op    as string | undefined
  const right = w.right as string | undefined
  if (left !== undefined || op !== undefined || right !== undefined) {
    const raw = `${left ?? '?'} ${op ?? '=='} ${right ?? '?'}`
    configSummary = raw.length > 40 ? raw.slice(0, 40) + '\u2026' : raw
  }

// step:approval_gate
} else if (sData.stepType === 'step:approval_gate') {
  const role = w.approver_role as string | undefined
  const desc = w.description   as string | undefined
  if (role)      configSummary = `Requires: ${role}`
  else if (desc) configSummary = desc.slice(0, 40) + (desc.length > 40 ? '\u2026' : '')
  else           configSummary = 'Awaits admin approval'
```

The `step:notification`, `step:transform`, and `step:http` branches are already correct and must not be changed.

**Tests:**
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — EXTENDED (or NEW if not yet present):
  - `docV2ToFlowNodes` with a `step:mutation` AuraNode whose `with = { operation: 'update', table: 'orders', connector_id: 'pg1' }` → the node's `data.auraNode.with` is passed through unchanged (node rendering is not tested here; config summary is an internal render detail)
  - Write a direct unit test of `StepNodeComponent` rendered with `@testing-library/react`:
    - mutation node with `with = { operation: 'update', table: 'orders' }` → renders text `UPDATE orders`
    - mutation node with `with = { operation: 'insert' }` (no table, no connector_id) → renders `INSERT INTO — not configured`
    - condition node with `with = { left: 'status', op: 'eq', right: 'active' }` → renders `status eq active`
    - condition node with `with = {}` → renders `Not configured`
    - approval_gate node with `with = { approver_role: 'Admin' }` → renders `Requires: Admin`
    - approval_gate node with `with = {}` → renders `Awaits admin approval`
    - query node with `with = { connector_id: 'pg1' }` → renders `connector: pg1`

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- A mutation step configured with `operation: 'delete'` and `table: 'sessions'` shows `DELETE FROM sessions` in the italic config summary line, not `Not configured`
- A condition step configured with `left: 'amount', op: 'gt', right: '100'` shows `amount gt 100`

---

### Commit 2 — feat(flow-view): semantic handle colors for branching and outcome output ports
**Why:** `trueBranch`/`falseBranch`, `approved`/`rejected`, and `ok`/`error` ports all share the same flat accent color, making it impossible to see at a glance which edge carries the success path vs. the failure path. Coloring by semantic meaning is a standard node-graph convention.
**Parallelizable with:** Commits 3 and 4

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: add `SEMANTIC_HANDLE_COLORS` constant; use it in `StepNodeComponent` handle style; use it in `WidgetNodeComponent` for the `submitted`/`clicked` trigger outputs

**Interface contracts — new constant (module-level, not exported):**
```ts
// Keyed by port name. Takes precedence over the per-step accent color.
const SEMANTIC_HANDLE_COLORS: Record<string, string> = {
  // Positive outcomes — green
  trueBranch: '#4ade80',
  approved:   '#4ade80',
  ok:         '#4ade80',
  sent:       '#4ade80',
  // Negative outcomes — red
  falseBranch: '#f87171',
  rejected:    '#f87171',
  error:       '#f87171',
  failed:      '#f87171',   // pre-registered for the port added in Commit 5
}
```

**Implementation notes:**

In `StepNodeComponent`, change the Handle `style.background` in the output port column from the flat `accent` to:
```ts
background: SEMANTIC_HANDLE_COLORS[port.name] ?? accent
```

The input port column keeps `accent` with `opacity: 0.8` unchanged — semantic coloring only applies to outputs since inputs are data slots, not branching outcomes.

In `WidgetNodeComponent`, the widget output handles currently use a flat `#f97316`. `trigger`-typed widget outputs (`submitted`, `clicked`, `closed`) convey an event rather than data; color them amber `#f59e0b` to visually distinguish them from data outputs. Apply this by checking `port.dataType === 'trigger'` on the output side and using `#f59e0b` instead of `#f97316`. No `SEMANTIC_HANDLE_COLORS` lookup needed for widget nodes.

**Tests:**
- `FlowCanvas.test.tsx` — EXTENDED:
  - Render `StepNodeComponent` with `stepType: 'step:condition'` and a full `meta` stub containing `trueBranch` and `falseBranch` output ports → `Handle` for `trueBranch` has `background: '#4ade80'`; `Handle` for `falseBranch` has `background: '#f87171'`
  - Render with `stepType: 'step:approval_gate'` → `approved` handle is green, `rejected` handle is red
  - Render with `stepType: 'step:http'` → `ok` handle is green, `error` handle is red
  - Render with an unlisted port name (e.g. `result`) → falls back to the step accent color

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- In the Flow View, `step:condition` node's bottom-right output handles are visually green (true) and red (false) — not both yellow
- `step:approval_gate` outputs are green and red — not both purple
- `step:http` `ok` is green, `error` is red

---

### Commit 3 — feat(flow-view): port label readability, data-type badges, and description tooltips
**Why:** Port labels are `0.55rem` at `#666` on a `#111` background — contrast ratio ~2.5:1, well below WCAG AA (4.5:1 for small text). Port descriptions in `PortDef` are never surfaced. There is no visual distinction between an `array` port and a `string` port.
**Parallelizable with:** Commits 2 and 4

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: port label styles and port row markup in both `WidgetNodeComponent` and `StepNodeComponent`

**Interface contracts — new module-level helper (not exported):**
```ts
function dataTypeBadge(dataType: string): string {
  const MAP: Record<string, string> = {
    trigger: '⚡',
    array:   '[]',
    object:  '{}',
    number:  '#',
    string:  '"',
    boolean: 'T/F',
    date:    '📅',
  }
  return MAP[dataType] ?? dataType.slice(0, 3)
}
```

**Implementation notes:**

In **both** `WidgetNodeComponent` and `StepNodeComponent`, for each port row:

1. Change port label span:
   - `fontSize: '0.55rem'` → `'0.65rem'`
   - `color: '#666'` → `'#888'`

2. Add `title={port.description}` on the port row `<div>` (the one with `position: 'relative'`).

3. Add a data-type badge immediately after the port name span (inside the same row div):
   ```tsx
   <span style={{
     fontSize: '0.5rem',
     color: '#444',
     fontFamily: 'monospace',
     marginLeft: 3,      // input side
     // marginRight: 3  // output side (badge precedes the port name span)
   }}>
     {dataTypeBadge(port.dataType)}
   </span>
   ```
   For input ports: badge is to the right of the name (after the name span).
   For output ports: badge is to the left of the name (before the name span), so it remains visually closest to the handle.

No width changes — the badge is narrow (1–3 characters).

**Tests:**
- `FlowCanvas.test.tsx` — EXTENDED:
  - Render `WidgetNodeComponent` with a form widget → port label spans have computed `fontSize` of `0.65rem`
  - Port row div for the `rows` output port (dataType `array`) has `title` matching the registry `description` string
  - The `⚡` badge character appears adjacent to the `submitted` (trigger) port
  - The `[]` badge appears adjacent to the `rows` (array) output

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- Port names are visibly legible without zooming in on the canvas
- Hovering any port row shows the description tooltip
- `step:query`'s `rows` output shows `[]` badge; `rowCount` shows `#`; `result` shows `{}`
- Widget form node's `submitted` output shows `⚡`

---

### Commit 4 — feat(flow-view): dynamic port visual indicator
**Why:** The `dynamic: true` flag in `PortDef` means the port fans out to N named ports at runtime (one per SQL parameter, one per form field). Builders who wire a static `params` handle are implicitly binding the whole parameter object, not a single named value — and they have no visual cue that this port behaves differently.
**Parallelizable with:** Commits 2 and 3

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: handle style and label suffix for dynamic ports in both node components

**Implementation notes:**

In `StepNodeComponent` and `WidgetNodeComponent`, in the port row render:

1. Detect dynamic: `const isDynamic = !!port.dynamic`

2. Handle style — add a dashed outline when dynamic:
   ```ts
   style={{
     // ...existing style...
     outline: isDynamic ? `1.5px dashed ${accent}` : 'none',
     outlineOffset: '2px',
   }}
   ```
   For `WidgetNodeComponent` use the port direction accent (`#3b82f6` for input, `#f97316` for output).

3. Port label suffix:
   ```tsx
   <span style={{ fontSize: '0.65rem', color: '#888', ... }}>
     {port.name}{isDynamic ? ' +' : ''}
   </span>
   ```
   The `' +'` suffix signals "more ports will appear here". The tooltip (from commit 3) will carry the full explanation from `port.description`.

Dynamic ports in the registries that this affects:
- `form` widget: the `*` port (wildcard dynamic output — one per form field)
- `step:query` and `step:mutation`: the `params` input (one per SQL parameter)

**Tests:**
- `FlowCanvas.test.tsx` — EXTENDED:
  - Render `StepNodeComponent` for `step:query` → `params` handle element has CSS `outline` containing `dashed`; label text is `params +`
  - Render `WidgetNodeComponent` for form → the `*` output port handle has dashed outline; label text is `* +`
  - Non-dynamic ports (e.g. `rows`) → no dashed outline; no ` +` suffix

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- Query and mutation step nodes' `params` input handle renders with a dashed border ring
- Form widget's `*` output port renders with dashed border ring and `* +` label

---

### Commit 5 — feat(widget-catalog): add failed output port to step:notification
**Why:** Notification delivery can fail (bad channel config, network error, invalid recipient). The registry currently only has a `sent` output; there is no path to branch on failure. `failed` is pre-registered in `SEMANTIC_HANDLE_COLORS` from Commit 2 so it will automatically render red.
**Parallelizable with:** none (depends on Commit 2 having registered `failed` in `SEMANTIC_HANDLE_COLORS`)

**Files:**
- `packages/widget-catalog/src/index.ts` — MODIFIED: `step:notification` ports array

**Implementation notes:**

In `STEP_NODE_REGISTRY['step:notification'].ports`, add one entry after the existing `sent` port:

```ts
{ name: 'failed', direction: 'output', dataType: 'trigger', description: 'Triggered when notification delivery fails or the channel is unreachable' },
```

No other files need changing. `StepNodeComponent` reads ports from the registry dynamically; the new port will appear automatically. `SEMANTIC_HANDLE_COLORS` already maps `'failed'` → `'#f87171'` from Commit 2.

**Tests:**
- `packages/widget-catalog/src/index.test.ts` — EXTENDED:
  - `STEP_NODE_REGISTRY['step:notification'].ports` contains an entry with `name: 'failed'` and `direction: 'output'`
  - The `failed` port has `dataType: 'trigger'`
- `FlowCanvas.test.tsx` — EXTENDED:
  - Render `StepNodeComponent` for `step:notification` → a `Handle` element with `id="failed"` exists; its `background` style is `#f87171`

**Done criteria:**
- `pnpm --filter "@lima/widget-catalog" test` exits 0
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- `step:notification` node in Flow View renders a red `failed` output handle alongside the green `sent` handle
