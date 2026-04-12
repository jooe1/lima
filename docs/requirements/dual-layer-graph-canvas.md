# Dual-Layer Graph Canvas

**Status:** Draft

**Last Updated:** April 10, 2026

**Supersedes:** [visual-workflow-system.md](visual-workflow-system.md) (WF-01 through WF-37 remain valid as a subset; this document extends them with a unified graph model)

---

## 1. Purpose

Define the architecture for a unified dual-layer builder canvas that collapses the current separation between widget layout and workflow editing into a single surface. In **Layout View** the builder sees the app as end-users will — a grid of widgets. In **Flow View** every widget becomes a graph node with typed I/O ports, workflow step nodes live on the same canvas, and edges between them define all data flow. One graph is the app definition.

The goal is to give Lima the compositional power of a node-based automation tool (n8n, Pipedream) with the visual polish and drag-and-drop simplicity of a low-code app builder (Retool, Appsmith).

---

## 2. Background and Motivation

### 2.1 Current state

The builder has three disconnected surfaces:

1. **Canvas grid** — widget layout (`CanvasEditor`), driven by `AuraDocument` (a flat array of `AuraNode`).
2. **Workflow overlay / floating panel** — a separate React Flow graph (`WorkflowCanvas`) opened from the Inspector or the Workflows tab. Step nodes and edges are separate from the canvas grid.
3. **Inspector** — property panel where `workflow_trigger` props (`form.onSubmit`, `button.onClick`) wire a widget to a workflow ID.

Data flows through four binding structures that are not formally connected:

| Binding structure | Stored on | Used by |
|---|---|---|
| `step.config.input_bindings` | `WorkflowStep.Config` (JSONB) | Worker — resolves `{{input.*}}` from `run.input_data` |
| `AuraNode.widget_bindings` | DSL document | AI generation layer only |
| `AuraNode.output_bindings` | DSL document | AI generation layer only |
| `Workflow.output_bindings[]` | Workflow record | Worker writes to `output_data.__output_bindings__` |

### 2.2 Problems

1. **Context loss** — editing a workflow removes the builder from the page. Even the split-view overlay (WF-06) only shows a ghosted read-only canvas; you cannot resize widgets or add new ones while wiring data flow.
2. **Two mental models** — the builder must understand "layout" as one concept and "data wiring" as a separate activity, even though the two are tightly coupled.
3. **No widget-to-widget reactivity** — selecting a table row and having a form pre-fill requires a full workflow trigger → run → poll cycle. Simple reactive data references (filter → table, table row → detail panel) cannot be expressed without a workflow.
4. **No real-time push** — workflow output bindings are written to DB and polled every 3 seconds. End-users never see live results.
5. **Binding proliferation** — four separate binding representations lead to bugs when one is updated and the others aren't.

### 2.3 Desired model

- **One document** — the `AuraDocument` is extended with `AuraEdge[]`, a typed edge list that replaces all four current binding structures.
- **Two views, one data model** — the builder toggles between Layout View and Flow View. Both views read and write the same `AuraDocument + AuraEdge[]`.
- **Reactive edges evaluate client-side** — widget → widget references resolve instantly in the browser with no network round-trip.
- **Async edges create workflow runs** — any path through a step node (query, mutation, condition, approval gate) triggers server-side execution with SSE push on completion.

---

## 3. Definitions

| Term | Meaning |
|---|---|
| **Layout View** | The current canvas grid. Widgets are positioned by `gridX/Y/W/H`. No step nodes or edges are visible. |
| **Flow View** | A React Flow canvas where every widget is a large node with port handles and workflow step nodes float between them. Edges are visible and editable. |
| **AuraEdge** | A typed, directional edge in the document. Defines data flow from one node's output port to another node's input port. |
| **Reactive edge** | An `AuraEdge` with `edgeType: 'reactive'`. Evaluated synchronously in the browser. Example: `table1.selectedRow.name` → `text1.content`. |
| **Async edge** | An `AuraEdge` with `edgeType: 'async'`. Any path that passes through at least one step node. Creates a workflow run on the server. |
| **Step node** | A node on the Flow View canvas representing a workflow step (query, mutation, condition, approval\_gate, notification). Not visible in Layout View. |
| **Flow group** | A visual grouping of connected step nodes in Flow View. A flow group with a trigger edge from a widget becomes a named "workflow" at the API level. |
| **Widget node** | A widget (table, form, button, etc.) rendered as a graph node in Flow View, with typed input/output port handles. |
| **Expression runtime** | A browser-side evaluator that resolves `{{widgetId.port}}` expressions by reading live widget state from the reactive store. |
| **Reactive store** | A client-side observable state map keyed by `(widgetId, portName)`. Populated by widget state changes. Read by the expression runtime. |

---

## 4. Data Model Changes

### 4.1 AuraEdge type (new — `packages/aura-dsl`)

```ts
export type EdgeType = 'reactive' | 'async'

export interface AuraEdge {
  id: string
  fromNodeId: string          // widget ID or step node ID
  fromPort: string            // output port name (e.g. "selectedRow", "result")
  toNodeId: string            // widget ID or step node ID
  toPort: string              // input port name (e.g. "content", "sql_param.user_id")
  edgeType: EdgeType
  transform?: string          // optional JS expression to reshape data between ports
}
```

### 4.2 AuraDocument extension

```ts
export interface AuraDocumentV2 {
  nodes: AuraNode[]
  edges: AuraEdge[]
}

// Backward compatibility: AuraDocument (AuraNode[]) is promoted to
// AuraDocumentV2 by setting edges = []. Existing apps with no edges
// continue to work unchanged.
```

### 4.3 Step nodes in the DSL

Step nodes are represented as `AuraNode` entries with a reserved `element` namespace:

```ts
// element values for step nodes:
// "step:query", "step:mutation", "step:condition",
// "step:approval_gate", "step:notification"

// Step-specific config lives in node.with:
{
  element: "step:query",
  id: "step_load_user",
  parentId: "root",
  with: {
    connector: "postgres_main",
    sql: "SELECT * FROM users WHERE id = {{table1.selectedRow.id}}"
  },
  style: {
    // Flow View position (not used in Layout View):
    flowX: "400", flowY: "200"
  }
}
```

### 4.4 Deprecation of old binding structures

| Current structure | Replaced by | Migration |
|---|---|---|
| `step.config.input_bindings` | Incoming `AuraEdge` to the step node's input port | Auto-generate edges from existing `input_bindings` map |
| `AuraNode.widget_bindings` | Incoming `AuraEdge` to the widget node's input port | Auto-generate edges from existing `widget_bindings` |
| `AuraNode.output_bindings` | Outgoing `AuraEdge` from step node to widget node | Auto-generate edges from existing `output_bindings` |
| `Workflow.output_bindings[]` | `AuraEdge` entries from step nodes to widget nodes | Auto-generate; remove column after migration |
| `AuraNode.action` | `AuraEdge` from widget's trigger port to first step node | Auto-generate edge; deprecate `action` field |

### 4.5 Widget port registry (new — `packages/widget-catalog`)

Extend `WidgetMeta` with a formal port schema:

```ts
export interface PortDef {
  name: string
  direction: 'input' | 'output'
  dataType: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'trigger' | 'void'
  description: string
  dynamic?: boolean   // true for ports derived from runtime config (form fields, table columns)
}

export interface WidgetMeta {
  // ... existing fields ...
  ports: PortDef[]
}
```

Static port definitions per widget type:

| Widget | Output ports | Input ports |
|---|---|---|
| `table` | `selectedRow` (object), `rows` (array), `selectedRowIndex` (number) | `refresh` (trigger), `setRows` (array), `setFilter` (object) |
| `form` | `values` (object), `submitted` (trigger) — plus one dynamic port per field | `reset` (trigger), `setValues` (object), `setErrors` (object) |
| `button` | `clicked` (trigger), `clickedAt` (date) | `setDisabled` (boolean), `setLabel` (string) |
| `text` | `content` (string) | `setContent` (string) |
| `kpi` | `value` (number) | `setValue` (number), `setTrend` (string) |
| `chart` | `selectedPoint` (object) | `setData` (array), `refresh` (trigger) |
| `filter` | `value` (string), `selectedValue` (string) | `setOptions` (array), `setValue` (string) |
| `markdown` | — | `setContent` (string) |
| `modal` | `closed` (trigger) | `open` (trigger), `close` (trigger) |
| `tabs` | `activeTab` (string), `activeTabIndex` (number) | `setActiveTab` (string) |
| Step: `query` | `result` (object), `rows` (array), `firstRow` (object), `rowCount` (number) | `params` (object) per SQL parameter |
| Step: `mutation` | `result` (object), `affectedRows` (number) | `params` (object) per SQL parameter |
| Step: `condition` | `trueBranch` (trigger), `falseBranch` (trigger) | `value` (any), `compareTo` (any) |
| Step: `approval_gate` | `approved` (trigger), `rejected` (trigger) | — |
| Step: `notification` | `sent` (trigger) | `message` (string), `channel` (string) |

### 4.6 Go model changes (`services/api/internal/model`)

```go
// AuraEdge stored in app.dsl_edges (new JSONB column on apps table)
type AuraEdge struct {
    ID         string `json:"id"`
    FromNodeID string `json:"from_node_id"`
    FromPort   string `json:"from_port"`
    ToNodeID   string `json:"to_node_id"`
    ToPort     string `json:"to_port"`
    EdgeType   string `json:"edge_type"` // "reactive" or "async"
    Transform  string `json:"transform,omitempty"`
}

// Workflow struct changes:
// - OutputBindings []OutputBinding → removed (edges replace this)
// - SourceWidgetID, SourcePageID → derived from the trigger edge's fromNodeId
// - Steps are stored as AuraNode entries with element prefix "step:"
```

### 4.7 Database migration

```sql
-- New column on apps table
ALTER TABLE apps ADD COLUMN dsl_edges JSONB NOT NULL DEFAULT '[]';

-- Workflow.output_bindings is kept temporarily for backward compat,
-- marked deprecated, and dropped after migration validation.
```

---

## 5. Builder UI

### 5.1 View toggle

**DL-01** The builder canvas SHALL have a toggle in the top toolbar: **Layout** | **Flow**. The shortcut `Ctrl+Shift+F` / `Cmd+Shift+F` switches between them.

**DL-02** In **Layout View**:
- The canvas renders widgets in their grid positions (current behaviour, unchanged).
- Step nodes are hidden.
- Edges are hidden (but active — reactive bindings still evaluate).
- The Inspector shows widget props as today.

**DL-03** In **Flow View**:
- The canvas switches to a React Flow surface.
- Each widget is rendered as a large node showing its display name, type icon, and a miniature preview of its layout content.
- Port handles appear on the node: outputs on the right edge, inputs on the left edge.
- Step nodes (query, mutation, condition, etc.) appear as smaller nodes with their own port handles, positioned by `style.flowX/flowY`.
- Edges are visible as animated lines colored by type: blue for reactive, orange for async.

**DL-04** Switching from Flow View to Layout View SHALL preserve all edge and step node changes. Switching back SHALL restore the Flow View graph positions.

**DL-05** In Flow View, the builder SHALL be able to:
- Draw an edge from any output port to any compatible input port by clicking and dragging.
- Delete an edge by selecting it and pressing `Delete`/`Backspace`.
- Add step nodes from a step palette (sidebar or context menu) by dragging onto the canvas.
- Configure a step node by clicking it (opens a config panel — same UI as current `NodeConfigPanel`).
- Group step nodes into a named flow group by selecting multiple nodes and pressing `Ctrl+G`.

### 5.2 Reactive edges (widget-to-widget)

**DL-06** Drawing an edge directly from one widget's output port to another widget's input port SHALL create a reactive edge (no step node in between). The edge `edgeType` is `'reactive'`.

**DL-07** Reactive edges SHALL be evaluated immediately in the browser. When the source widget's output value changes, the target widget's input port updates within the same render frame.

**DL-08** The expression runtime SHALL build a dependency graph from all reactive edges. If a cycle is detected (A → B → A), the builder SHALL show an error badge on the cycle edges and refuse to save until the cycle is broken.

**DL-09** Reactive edges SHALL support an optional `transform` expression. When present, the expression receives the source value as `$` and must return the transformed value. Example: `$.toUpperCase()` or `$.filter(r => r.active)`.

**DL-10** Transform expressions SHALL be executed in a sandboxed evaluator (no access to `window`, `document`, `fetch`, or any global state). Only pure data transformations are permitted.

### 5.3 Async edges (widget → step → widget)

**DL-11** When a widget's output port is connected to a step node's input port, and the step node's output port is connected to another widget's input port, the full path is an **async edge chain**. The `edgeType` on each segment is `'async'`.

**DL-12** The builder SHALL visually distinguish async edges from reactive edges: async edges use a dashed orange line with an animated flow indicator showing directionality.

**DL-13** Async edge chains that include at least one `mutation` or `approval_gate` step SHALL display an *(approval may be required)* badge on the trigger widget in Layout View.

**DL-14** The builder SHALL allow mixing reactive and async edges on the same widget. Example: a form's `values` port can reactively feed a text widget preview AND the form's `submitted` port can trigger an async mutation step.

### 5.4 Step node management

**DL-15** Step nodes SHALL be addable only in Flow View. They appear in a collapsible "Steps" palette on the left sidebar with icons for each step type.

**DL-16** Step nodes SHALL carry `style.flowX` and `style.flowY` for their position on the Flow View canvas. These are independent of the Layout View grid positions.

**DL-17** Step nodes SHALL NOT appear in the Layers Panel (which exclusively lists layout widgets).

**DL-18** Step nodes with no incoming or outgoing edges SHALL be flagged with a warning icon ("unconnected step — will never execute").

**DL-19** Deleting a step node SHALL delete all edges connected to it. The builder SHALL confirm if the step has more than 2 connected edges.

### 5.5 Flow groups (named workflows)

**DL-20** The builder SHALL be able to select multiple step nodes and group them via `Ctrl+G`. This creates a visual bounding box (React Flow group node) with an editable name.

**DL-21** A flow group with an incoming edge from a widget's trigger port (`clicked`, `submitted`) is a **triggered flow group** — it maps to a `Workflow` record in the API. The group's name becomes the workflow name.

**DL-22** A flow group with no trigger edge is a **reusable flow group** — a subroutine that can be invoked from other flow groups. (Implementation deferred to Phase 3.)

**DL-23** The Workflows tab (⚡) SHALL continue to list all triggered flow groups and standalone workflows. Clicking a triggered flow group in the list SHALL switch to Flow View and center the canvas on that group.

### 5.6 Inspector integration

**DL-24** In Flow View, clicking a widget node SHALL open the Inspector showing both widget props (Layout tab) and connected edges (Flow tab). The Flow tab lists all incoming and outgoing edges with their source/target and type.

**DL-25** In Flow View, clicking a step node SHALL open a Step Config panel (same as current `NodeConfigPanel`). Input fields that have an incoming edge SHALL show the edge source as a read-only badge instead of a text input.

**DL-26** In Layout View, the Inspector SHALL show a "Data flow" summary section at the bottom of each widget's properties. It lists reactive inputs (e.g. "content ← table1.selectedRow.name") and async triggers (e.g. "onSubmit → Create Contact workflow") as read-only badges. Clicking any badge switches to Flow View and highlights that edge.

### 5.7 Backward compatibility with split-view and floating panel

**DL-27** The existing split-view overlay (WF-06) and floating panel (WF-33–37) SHALL remain functional as alternative entry points. Opening a page-bound workflow from the Inspector SHALL offer two options: "Edit in Flow View" (switches the main canvas to Flow View centered on the flow group) or "Edit in overlay" (opens the current split-view).

**DL-28** Over time, the overlay and floating panel are expected to be deprecated in favor of the unified Flow View. They will not receive new feature development after this phase.

---

## 6. Expression Runtime (client-side)

### 6.1 Reactive store

**DL-30** The runtime SHALL maintain a reactive store: an observable `Map<string, Map<string, any>>` keyed by `(widgetId, portName)`. Every widget publishes its current output port values to this store on state change.

**DL-31** The reactive store SHALL be implemented as a lightweight signal/subscription system. When a value changes, only the widgets that subscribe to that specific `(widgetId, port)` key re-render.

**DL-32** The reactive store SHALL exist in both the builder (for live preview) and the published app runtime.

### 6.2 Dependency graph

**DL-33** On document load, the runtime SHALL build a directed dependency graph from all reactive edges. Each node in the graph is a `(widgetId, portName)` pair.

**DL-34** The runtime SHALL perform a topological sort of the dependency graph. If the sort fails (cycle detected), the runtime SHALL log an error and skip evaluation of the cyclic subgraph, leaving affected widgets in their default state.

**DL-35** When a source value changes, the runtime SHALL propagate the change through the topologically sorted graph, evaluating `transform` expressions at each edge in order.

### 6.3 Expression syntax

**DL-36** Reactive expressions use the existing `{{widgetId.portName}}` syntax. The expression runtime resolves these by reading from the reactive store.

**DL-37** Nested property access is supported: `{{table1.selectedRow.email}}`. The runtime accesses `store.get("table1", "selectedRow")` and then reads `.email` from the result object.

**DL-38** Expressions in `AuraNode.value`, `AuraNode.if`, `AuraNode.with.*` (e.g. SQL parameters), and `AuraNode.transform` SHALL all be evaluated against the reactive store. This replaces the current unvalidated string interpolation.

### 6.4 Sandbox

**DL-39** `transform` expressions on edges and nodes SHALL be evaluated in a frozen scope where only the input value (`$`), `Math`, `String`, `Number`, `Array`, `Object`, `JSON`, and `Date` constructors are available. No DOM, network, or storage access.

**DL-40** Transform evaluation SHALL have a 50ms timeout. If exceeded, the transform is skipped and the raw source value is passed through unchanged. A warning is logged to the builder console.

---

## 7. Server-Side Execution (async edges)

### 7.1 Trigger resolution

**DL-41** When a widget fires a trigger event (button click, form submit), the runtime SHALL:
1. Identify all async edge chains originating from that widget's trigger port.
2. Collect the connected step nodes into a flow group (the "workflow" to execute).
3. Resolve all incoming reactive values for the step nodes' input ports using the reactive store (snapshot at trigger time).
4. Call `POST /workspaces/:id/apps/:id/workflows/:id/trigger` with `input_data` populated from the resolved port values.

**DL-42** The `input_data` keys SHALL use the format `{fromNodeId}.{fromPort}` to avoid collisions. Example: `{ "form1.first_name": "Alice", "form1.email": "alice@co.com" }`.

**DL-43** The existing approval flow (end-user → always approval-gated) SHALL remain unchanged. The trigger resolution adds a reactive value snapshot but does not bypass the safety model.

### 7.2 Worker execution changes

**DL-44** The worker SHALL read step definitions from the app's `AuraNode[]` entries with `element` prefix `"step:"` rather than from the `workflow_steps` table. The `workflow_steps` table becomes a derived/cached projection.

**DL-45** Step execution order SHALL be determined by the `AuraEdge` graph topology (topological sort of async edges between step nodes), not by `step_order` integer. This naturally handles branching and parallelism.

**DL-46** Condition steps (`step:condition`) SHALL evaluate their `trueBranch` / `falseBranch` output ports. Only the edges connected to the triggered port's downstream nodes are followed.

**DL-47** Step `{{input.*}}` reference resolution SHALL be extended to support the new key format: `{{form1.first_name}}` resolves from `input_data["form1.first_name"]`. The existing `{{input.fieldname}}` format SHALL continue to work for backward compatibility.

### 7.3 SSE push for async results

**DL-48** The API SHALL expose a new SSE endpoint: `GET /workspaces/:id/apps/:id/events`. Authenticated clients subscribe and receive events:

```
event: workflow_run_update
data: {"run_id":"...","status":"completed","step_id":"step_load_user","output":{"rows":[...]}}

event: variable_update
data: {"widget_id":"contacts_table","port":"refresh","value":null}
```

**DL-49** When the worker completes a step, it SHALL publish the step result to a Redis pub/sub channel `app:{app_id}:events`. The API SSE handler subscribes to this channel and forwards events to connected clients.

**DL-50** The runtime SHALL process incoming SSE events by:
1. For `workflow_run_update` with a completed step: reading the `AuraEdge[]` to find outgoing async edges from that step's output port and applying the step result to the target widget's input port in the reactive store.
2. For `workflow_run_update` with `status: completed` (whole run): triggering `__workflow_complete__` output edges.
3. For `workflow_run_update` with `status: failed`: showing the error on the trigger widget.

**DL-51** The 3-second polling loop in the builder SHALL be replaced by the SSE subscription. Polling SHALL remain as a fallback if the SSE connection drops (reconnect with exponential backoff, poll every 5 s while disconnected).

---

## 8. DSL Parser/Serializer Changes

### 8.1 Document format

**DL-52** The `AuraDocument` serialization format SHALL be extended with an `---edges---` separator:

```
table contacts_table @ root value "{{query.rows}}" with connector "pg" sql "SELECT * FROM contacts" style gridX "0" gridY "0" gridW "6" gridH "4" ;
form new_contact @ root style gridX "6" gridY "0" gridW "6" gridH "4" fields "first_name,last_name,email" ;
step:mutation create_contact @ root with connector "pg" sql "INSERT INTO contacts (first_name, last_name, email) VALUES ({{form1.first_name}}, {{form1.last_name}}, {{form1.email}})" style flowX "400" flowY "100" ;
---edges---
edge e1 from new_contact.submitted to create_contact.params async ;
edge e2 from create_contact.result to contacts_table.refresh async ;
edge e3 from contacts_table.selectedRow to detail_text.content reactive transform "$.first_name + ' ' + $.last_name" ;
```

**DL-53** The parser SHALL handle documents with no `---edges---` section (backward compatible — treated as `edges: []`).

**DL-54** The serializer SHALL emit the `---edges---` section only when `edges.length > 0`.

### 8.2 Validation additions

**DL-55** The validator SHALL check:
- All `AuraEdge.fromNodeId` and `toNodeId` reference existing node IDs in the document.
- All `fromPort` names exist in the source node's port schema (from `WidgetMeta.ports` for widgets, or the step type's port schema for step nodes).
- All `toPort` names exist in the target node's port schema.
- No reactive edge cycles exist (topological sort check).
- Async edge chains have at least one step node (a direct async edge between two widgets is invalid — that should be reactive).
- `transform` expressions parse without syntax errors (AST-level check, not execution).

### 8.3 Diff/merge

**DL-56** `DiffOp` type SHALL be extended with edge operations:

```ts
export type DiffOp =
  | { op: 'add'; node: AuraNode }
  | { op: 'remove'; id: string }
  | { op: 'update'; id: string; patch: Partial<AuraNode> }
  | { op: 'add_edge'; edge: AuraEdge }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'update_edge'; edgeId: string; patch: Partial<AuraEdge> }
```

---

## 9. Migration

### 9.1 Existing apps

**DL-57** A migration function SHALL convert existing app documents to the V2 format:

1. For each `AuraNode` with `action` set (form/button → workflow):
   - Look up the workflow's steps and output bindings.
   - Create `AuraNode` entries with `element: "step:*"` for each step.
   - Create `AuraEdge` entries from the widget's trigger port to the first step.
   - Create `AuraEdge` entries from each step to the next step (from `next_step_id` and `false_branch_step_id`).
   - Create `AuraEdge` entries from steps to target widgets for each `OutputBinding`.
2. For each `AuraNode.widget_bindings` entry:
   - Create a reactive `AuraEdge` from the source widget/port to this node.
3. Clear deprecated fields: `action`, `widget_bindings`, `output_bindings`.

**DL-58** The migration SHALL be idempotent and reversible. A `dsl_version` field on the `apps` table tracks format version (1 = current, 2 = V2 with edges).

**DL-59** The API SHALL accept both V1 and V2 documents during the migration period. V1 documents are silently upgraded on read. V2 documents are stored as-is.

### 9.2 Workflow records

**DL-60** Existing `Workflow` records are preserved. A triggered flow group in V2 creates/updates the corresponding `Workflow` record on save (the API derives `trigger_type`, `source_widget_id`, `source_page_id` from the flow group's trigger edge).

**DL-61** The `workflow_steps` table becomes secondary storage. The worker reads step definitions from the app's DSL (node entries with `element: "step:*"`). The `workflow_steps` table is kept in sync for debugging and audit logging.

---

## 10. Phasing

### Phase 1: Foundation (DSL + reactive edges)

| ID | Scope |
|---|---|
| P1-01 | Add `AuraEdge` type and `edges` field to `AuraDocumentV2` |
| P1-02 | Extend parser with `---edges---` section and `edge` statement syntax |
| P1-03 | Extend serializer, validator, and diff/merge for edges |
| P1-04 | Add `PortDef` to `WidgetMeta` in the widget catalog |
| P1-05 | Implement reactive store (signal-based, browser-only) |
| P1-06 | Implement expression runtime with `{{widgetId.port}}` resolution |
| P1-07 | Implement sandboxed `transform` evaluator |
| P1-08 | Add `dsl_edges` JSONB column to `apps` table (migration) |
| P1-09 | Builder: add Flow View toggle (Layout / Flow) — render widgets as React Flow nodes with port handles, render reactive edges, allow drawing/deleting reactive edges |
| P1-10 | Inspector: show "Data flow" summary in Layout View |

**Outcome:** builders can wire widget-to-widget reactive data flow visually. No server changes. Existing workflows still work via the overlay/floating panel.

### Phase 2: Async edges + SSE

| ID | Scope |
|---|---|
| P2-01 | Add step node elements (`step:query`, `step:mutation`, etc.) to DSL and validator |
| P2-02 | Builder: add Steps palette in Flow View; allow adding/configuring step nodes |
| P2-03 | Builder: async edge drawing (widget → step → widget) |
| P2-04 | Flow groups: visual grouping, naming, auto-mapping to Workflow records |
| P2-05 | Worker: read step graph from DSL edges instead of `step_order` |
| P2-06 | API: SSE endpoint for `workflow_run_update` events |
| P2-07 | Worker: publish step completion to Redis pub/sub |
| P2-08 | Runtime: SSE subscription, replace 3 s polling |
| P2-09 | Runtime: process async edge results into reactive store |
| P2-10 | Migration function for existing apps (DL-57) |

**Outcome:** the full dual-layer experience. Workflows are defined and wired visually on the same canvas as widgets. Real-time push replaces polling.

### Phase 3: Advanced features (post-launch)

| ID | Scope |
|---|---|
| P3-01 | Reusable flow groups (subroutine steps that invoke another flow group) |
| P3-02 | Parallel step execution (fan-out from a step with multiple async output edges) |
| P3-03 | Cross-page reactive references (with page-load resolution) |
| P3-04 | Flow View minimap for large apps |
| P3-05 | Deprecate and remove split-view overlay and floating panel |
| P3-06 | Visual debugging: step-through mode in Flow View showing live data at each edge |
| P3-07 | `schedule` and `webhook` triggers as headless trigger nodes (no source widget) in Flow View |

---

## 11. Validation and Integrity

**DL-62** All validation rules from the existing workflow system (WF-26 through WF-29) are preserved and generalized:
- Renaming a widget updates all `AuraEdge` references to that widget's ID.
- Deleting a widget deletes all connected edges and flags affected step nodes as unconnected.
- Deleting a step node deletes all connected edges.

**DL-63** `appValidation.ts` SHALL be extended to validate edges:
- All edge `fromNodeId` / `toNodeId` exist in the document.
- All port names match the widget/step port schema.
- No orphaned step nodes (step nodes with no edges).
- No reactive cycles.
- At least one async edge in every flow group connects back to a widget input port (otherwise the workflow's output is discarded).

**DL-64** The Publish button SHALL be disabled if any edge validation error exists, with a message listing the issue.

---

## 12. Non-Functional Requirements

**DL-NFR-01** The Flow View toggle SHALL animate the transition in under 300ms. Widget nodes SHALL fade from grid layout to graph layout positions with a spring animation.

**DL-NFR-02** The Flow View SHALL support at least 100 nodes (widgets + steps combined) without visible frame-rate degradation. React Flow viewport culling and node virtualization SHALL be enabled.

**DL-NFR-03** Reactive edge evaluation SHALL complete within 5ms for chains of up to 20 edges. The dependency graph topological sort is performed once on document load and cached.

**DL-NFR-04** SSE reconnection SHALL happen within 2 seconds of connection drop. During disconnect, the runtime falls back to polling at 5-second intervals.

**DL-NFR-05** The sandboxed `transform` evaluator SHALL prevent prototype pollution and shall not expose `__proto__`, `constructor`, or `Function`.

**DL-NFR-06** The `dsl_edges` column SHALL be included in app version snapshots (`app_versions` table) so that edges are versioned alongside nodes.

---

## 13. Security Considerations

**SC-01** Transform expressions execute in a frozen sandbox with no access to globals, DOM, network, or storage APIs. The sandbox SHALL use a restricted `Function` constructor with an explicit allowlist of available names.

**SC-02** SSE endpoints SHALL require the same authentication and workspace membership as existing API endpoints. Events are scoped to `(workspace_id, app_id)` — a client only receives events for apps it has access to.

**SC-03** Reactive edges are client-side only. They do not transmit data to the server. The server never evaluates reactive expressions — it only stores them.

**SC-04** The existing safety model is unchanged: end-user workflow triggers are always approval-gated, mutation grants are checked per-connector, and DML/DDL regex guards remain active on query steps.

**SC-05** `input_data` sent to `/trigger` SHALL continue to be validated and size-limited (existing 1MB payload limit). The new `{fromNodeId}.{fromPort}` key format does not change the validation boundary.

---

## 14. Out of Scope

- **Cross-app reactive references** — reactive edges only work within a single app.
- **Collaborative editing** — two builders editing the same app's Flow View simultaneously is not addressed (existing optimistic-lock behavior applies).
- **Custom step types** — builders cannot define new step types; only the built-in set is available.
- **Non-SQL connector mutations** — REST/GraphQL mutations remain out of scope per existing limitations.
- **Mobile builder** — Flow View targets desktop browsers only.

---

## 15. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | Should flow groups be nestable (a flow group containing another flow group as a subroutine)? Deferred to Phase 3 but the DSL representation should not preclude it. | Architecture | Open |
| 2 | Should reactive edges support debouncing (e.g. a filter input that only triggers a table reload after 300ms of inactivity)? | Product | Open |
| 3 | How should dynamic ports (form fields, table columns) be handled when the source schema changes? Auto-delete broken edges or show a repair dialog? | Product | Open |
| 4 | Should the worker support parallel step execution (fan-out) in Phase 2 or defer to Phase 3? The edge topology naturally supports it but the worker `runStepGraph` is currently linear. | Engineering | Open |
| 5 | What is the maximum number of edges per document before performance degrades? Need benchmarking with React Flow at 200+ edges. | Engineering | Open |
| 6 | Should standalone workflows (schedule, webhook, manual) appear in Flow View as headless trigger nodes, or remain exclusively in the Workflows tab? | Product | Open |
