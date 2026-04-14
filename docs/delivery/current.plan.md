# Delivery Plan: Dual-Layer Graph Canvas — Frontend (P1-09, P1-10, P2-02 through P2-04, P2-08, P2-09)
_Last updated: 2026-04-14_
_Feature slug: dual-layer-graph-canvas-frontend_
_Source: docs/requirements/dual-layer-graph-canvas.md_

## Goal
Ship the builder Flow View and its associated runtime plumbing in dependency order: first upgrade the shared state layer to `AuraDocumentV2`, then render the Flow View canvas, then layer in step nodes, async edges, flow groups, and finally the SSE event pipeline that replaces the 3-second polling loop.

## Stack Decisions

| Decision | Value | Reason |
|----------|-------|--------|
| State shape | `AuraDocumentV2 { nodes: AuraNode[], edges: AuraEdge[] }` in `useDocumentHistory` | All history, autosave and page-level handlers operate on the same V2 shape from commit 2 onward; no parallel v1/v2 paths in the builder |
| V1→V2 load upgrade | Replace `parse(app.dsl_source)` with `parseV2(app.dsl_source)` in `hydrateLoadedApp` | `parseV2` handles no-edges documents (backward compatible); zero edge list = identical Layout View |
| Reactive store lifetime | `useMemo(() => createReactiveStore(), [])` in `page.tsx` | Created once for the builder session; shared by `FlowCanvas` and SSE event processor via prop drilling |
| SSE auth | `fetch` + `ReadableStream` + `Authorization: Bearer` header | `EventSource` does not support custom headers; passing the token as a query param would expose it in server access logs (OWASP A02) |
| Step node visuals | Re-use `QueryNode`, `MutationNode`, etc. from `./workflow-nodes/` | Already exist and styled for the dark builder theme; avoids duplication |
| Async edge style | `strokeDasharray: '6 3'`, `stroke: '#f97316'` (orange) | Matches DL-12; reactive edges use `stroke: '#3b82f6'` (blue), `animated: true` |
| Flow group storage | `AuraNode` with `element: 'flow:group'` added to `doc.nodes` | Keeps document model self-contained; no separate data structure needed |
| CanvasEditor step filtering | `history.doc.nodes.filter(n => !n.element.startsWith('step:') && n.element !== 'flow:group')` | Step/group nodes have no `gridX/Y/W/H`; explicit filter is clearer than skipping inside CanvasEditor |
| No new npm packages | `@xyflow/react`, `@lima/aura-dsl`, `@lima/widget-catalog` only | Already installed; constraint from feature brief |

---

## Commits

### Commit 1 — feat(api): extend App type with dsl_edges and export API base URL
**Why:** All later commits depend on the `App` type having `dsl_edges` and on the SSE hook being able to reach the API base URL. Must land first.
**Parallelizable with:** none

**Files:**
- `apps/web/lib/api.ts` — MODIFIED: add `dsl_edges?: AuraEdge[]` to `App`; extend `patchApp` patch shape; export `API_BASE`

**Interface contracts:**
```ts
// New import at top of api.ts:
import type { AuraEdge } from '@lima/aura-dsl'

// App interface — new field:
export interface App {
  // ... existing fields unchanged ...
  dsl_edges?: AuraEdge[]         // absent for apps with no edges
}

// patchApp — extended patch parameter:
export function patchApp(
  workspaceId: string,
  appId: string,
  patch: {
    name?: string
    description?: string
    dsl_source?: string
    dsl_edges?: AuraEdge[]       // NEW
    node_metadata?: Record<string, { manuallyEdited: boolean }>
  },
): Promise<App>

// Exported constant (was internal const):
export const API_BASE: string   // process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
```

**Implementation notes:**
- Change `const API_BASE` → `export const API_BASE`. Every existing call-site is in the same file; no churn elsewhere. External callers (SSE hook in commit 7) import it.
- No runtime behaviour changes; this is type-only.

**Tests:** No new behaviour — no tests required for this commit.

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0

---

### Commit 2 — feat(builder): migrate document history and autosave to AuraDocumentV2
**Why:** Upgrades the shared state foundation that all builder commits build on. After this commit, `history.doc` is `AuraDocumentV2`, autosave calls `serializeV2`, and the reactive store is instantiated. Layout View is visually unchanged.
**Parallelizable with:** none

**Files:**
- `apps/web/app/builder/[appId]/hooks/useDocumentHistory.ts` — MODIFIED: `AuraDocument` → `AuraDocumentV2` throughout
- `apps/web/app/builder/[appId]/hooks/useAutosave.ts` — MODIFIED: parameter type updated; `serialize` → `serializeV2`
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: `parseV2` on load; all `history.doc` array accesses → `history.doc.nodes`; `history.set` calls preserve edges; reactive store created; `handleAddEdge`/`handleDeleteEdge`/`handleUpdateEdges` added; `handlePublish` uses `serializeV2`
- `apps/web/app/builder/[appId]/Inspector.tsx` — MODIFIED: `doc: AuraDocument` → `doc: AuraDocumentV2` in Props; one internal usage updated; `onSwitchToFlowView?` prop added (used by commit 4)

**Interface contracts:**
```ts
// useDocumentHistory — new return shape:
export function useDocumentHistory(initial?: AuraDocumentV2): {
  doc: AuraDocumentV2
  canUndo: boolean
  canRedo: boolean
  set: (doc: AuraDocumentV2) => void
  reset: (doc: AuraDocumentV2) => void
  undo: () => void
  redo: () => void
}
// Default empty state: { nodes: [], edges: [] }

// useAutosave — updated first parameter:
export function useAutosave(
  doc: AuraDocumentV2,
  nodeMetadata: NodeMetadataMap,
  onSave: ((source: string, meta: NodeMetadataMap) => Promise<void>) | undefined,
  delay?: number,
): { saving: boolean; savedAt: Date | null }

// Inspector — updated Props interface:
interface Props {
  node: AuraNode | null
  doc: AuraDocumentV2            // CHANGED from AuraDocument
  onUpdate: (node: AuraNode) => void
  onDelete: (id: string) => void
  workspaceId: string
  appId: string
  pageId: string
  onOpenCanvas?: (workflowId: string) => void
  onOpenSplitView?: (workflowId: string) => void
  onSwitchToFlowView?: () => void   // NEW — called by Data flow badges (commit 4)
}

// page.tsx — new edge callbacks (wired to FlowCanvas in commit 3):
handleAddEdge: (edge: AuraEdge) => void          // history.set({ ...doc, edges: [...edges, edge] })
handleDeleteEdge: (edgeId: string) => void       // history.set({ ...doc, edges: edges.filter })
handleUpdateEdges: (edges: AuraEdge[]) => void   // history.set({ ...doc, edges })

// page.tsx — reactive store (stable ref):
const reactiveStore: ReactiveStore  // = useMemo(() => createReactiveStore(), [])
```

**Implementation notes:**
- `useDocumentHistory.ts`: Change `State.past/present/future` from `AuraDocument` to `AuraDocumentV2`. Update `RESET` initial value to `{ nodes: [], edges: [] }`. The reducer logic is unchanged; it operates on `AuraDocumentV2` as opaque values.
- `useAutosave.ts`: Change the first parameter type. Replace `serialize(doc)` → `serializeV2(doc)`. The debounce key: `serializeV2(doc) + '\x00' + JSON.stringify(nodeMetadata)`. Import `serializeV2` from `@lima/aura-dsl`.
- `page.tsx` — `hydrateLoadedApp`: replace `history.reset(parse(nextApp.dsl_source))` with `history.reset(parseV2(nextApp.dsl_source))`. Import `parseV2`, `serializeV2` (remove `parse`, `serialize`).
- `page.tsx` — `handlePublish`: change `serialize(history.doc)` → `serializeV2(history.doc)`.
- `page.tsx` — `handleDropWidget`, `handleAddWidget`: `history.set({ nodes: [...history.doc.nodes, newNode], edges: history.doc.edges })`.
- `page.tsx` — `handleDeleteWidget`: filter connected edges too: `history.set({ nodes: history.doc.nodes.filter(n => n.id !== id), edges: history.doc.edges.filter(e => e.fromNodeId !== id && e.toNodeId !== id) })`.
- `page.tsx` — `handleUpdateNode`: `history.set({ nodes: history.doc.nodes.map(n => n.id === updated.id ? updated : n), edges: history.doc.edges })`.
- `page.tsx` — `handleCanvasChange(newDoc: AuraDocument)`: CanvasEditor returns only widget nodes. Merge back the step/group nodes it never knew about: `history.set({ nodes: [...newDoc, ...history.doc.nodes.filter(n => n.element.startsWith('step:') || n.element === 'flow:group')], edges: history.doc.edges })`.
- `page.tsx` — `handleApplyTemplate`: `history.set({ nodes, edges: [] })`.
- `page.tsx` — `selectedNode`: `history.doc.nodes.find(n => n.id === selectedId) ?? null`.
- `page.tsx` — `workflowTriggerTargets`, `publishIssues`, `userFacingBlockers`: use `history.doc.nodes` where `history.doc` was used as an array.
- `page.tsx` — `CanvasEditor` `doc` prop: `history.doc.nodes.filter(n => !n.element.startsWith('step:') && n.element !== 'flow:group')`.
- `page.tsx` — `LayersPanel` `doc` prop: same filter as CanvasEditor.
- `page.tsx` — `Inspector` `doc` prop: `history.doc` (full V2 doc).
- `Inspector.tsx` — change `doc.filter(...)` → `doc.nodes.filter(...)` (the one place `doc` is iterated to find filter widgets).

**Tests:**
- `apps/web/app/builder/[appId]/hooks/useDocumentHistory.test.ts` — NEW:
  - Initial state is `{ nodes: [], edges: [] }`
  - `set({ nodes: [n1], edges: [e1] })` → `doc.nodes = [n1]`, `doc.edges = [e1]`
  - Undo/redo round-trip preserves V2 shape including edges
- `apps/web/app/builder/[appId]/hooks/useAutosave.test.ts` — NEW or MODIFIED:
  - `serializeV2` is called (spy) when `doc` changes; `serialize` is never called

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0 (vitest)
- Opening an existing V1 app (no `---edges---` in DSL) renders Layout View identically; no regression

---

### Commit 3 — feat(flow-view): Flow View canvas with widget nodes and reactive edge wiring (P1-09)
**Why:** Introduces the core Flow View surface: React Flow canvas, widget nodes with port handles, animated blue reactive edges, draw-by-drag, delete-by-key.
**Parallelizable with:** Commit 4

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — NEW: full React Flow canvas component
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: `canvasView` state, `Ctrl+Shift+F` shortcut, toolbar Layout/Flow toggle, conditional render

**Interface contracts:**
```ts
// FlowCanvas — exported component and helpers:
export interface FlowCanvasProps {
  doc: AuraDocumentV2
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (doc: AuraDocumentV2) => void
  workspaceId: string
  reactiveStore: ReactiveStore
}
export function FlowCanvas(props: FlowCanvasProps): React.JSX.Element

// Pure conversion helpers (exported for tests):
export function docV2ToFlowNodes(doc: AuraDocumentV2): Node[]  // @xyflow/react Node type
export function docV2ToFlowEdges(doc: AuraDocumentV2): Edge[]  // @xyflow/react Edge type

// page.tsx new state:
const [canvasView, setCanvasView] = useState<'layout' | 'flow'>('layout')
```

**Implementation notes:**
- Imports from `@xyflow/react`: `ReactFlow`, `ReactFlowProvider`, `Background`, `Controls`, `MiniMap`, `Handle`, `Position`, `useNodesState`, `useEdgesState`, `addEdge`, `type Connection`, `type Node`, `type Edge`, `type NodeTypes`.  Import `'@xyflow/react/dist/style.css'`.
- **Widget node type** (`'widgetNode'` key in `nodeTypes`): renders a 220×130 dark box. Top row: widget `displayName` + `icon` name as text label. Body: two columns of `<Handle>` elements — input ports on the left (`type="target"`), output ports on the right (`type="source"`). Handle `id` = port name. Ports read from `WIDGET_REGISTRY[node.element]?.ports ?? []`.
- **Coordinate mapping**: widget nodes without `style.flowX` → `x = parseInt(node.style.gridX ?? '0') * 60`, `y = parseInt(node.style.gridY ?? '0') * 60`. Step nodes (from commit 5) use `style.flowX`/`style.flowY` directly; fallback `y = index * 160, x = 900`. The multiplier `60` (not `CELL=40`) gives extra spread in the Flow View.
- **`docV2ToFlowEdges`**: reactive → `{ id, source: fromNodeId, sourceHandle: fromPort, target: toNodeId, targetHandle: toPort, type: 'smoothstep', animated: true, style: { stroke: '#3b82f6', strokeWidth: 1.5 } }`. Async → same but `animated: false, style: { stroke: '#f97316', strokeWidth: 1.5, strokeDasharray: '6 3' }`.
- **`onConnect`**: determine `edgeType` — if either endpoint's `AuraNode.element.startsWith('step:')` → `'async'`; else → `'reactive'`. Generate `id = 'e_' + crypto.randomUUID().slice(0, 8)`. `onChange({ ...doc, edges: [...doc.edges, newEdge] })`.
- **Edge delete**: React Flow calls `onEdgesDelete(deleted: Edge[])`. Map deleted RF edge IDs to AuraEdge IDs and call `onChange({ ...doc, edges: doc.edges.filter(e => !deletedIds.has(e.id)) })`.
- **Node position persistence**: `onNodeDragStop(event, node)` → update `style.flowX = String(node.position.x)`, `style.flowY = String(node.position.y)` on the matching AuraNode; call `onChange`.
- **`ReactFlowProvider`**: wrap `<ReactFlow>` in `<ReactFlowProvider>` inside `FlowCanvas`.
- `page.tsx` — keyboard shortcut: in the existing `handleKeyDown` `useEffect`, add `if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); setCanvasView(v => v === 'layout' ? 'flow' : 'layout') }`.
- `page.tsx` — toolbar: add a two-button toggle (styled inline, ~50px each) between the save indicator and the existing publications button. Active tab has `borderBottom: '2px solid #3b82f6'`.
- `page.tsx` — body: `canvasView === 'flow' ? <FlowCanvas doc={history.doc} selectedId={selectedId} onSelect={setSelectedId} onChange={d => history.set(d)} workspaceId={workspace?.id ?? ''} reactiveStore={reactiveStore} /> : <CanvasEditor doc={filteredNodes} ... />`. The `filteredNodes` variable is `history.doc.nodes.filter(n => !n.element.startsWith('step:') && n.element !== 'flow:group')`.
- `page.tsx` — Inspector: add `onSwitchToFlowView={() => setCanvasView('flow')}` prop.
- `SplitViewOverlay`, `WorkflowOverlay`, `FloatingWorkflowPanel` — unchanged; render above both canvas views.

**Tests:**
- `apps/web/app/builder/[appId]/FlowCanvas.test.tsx` — NEW:
  - `docV2ToFlowNodes`: widget node → `type: 'widgetNode'`; position derived from `style.flowX/Y` when present, from grid when absent
  - `docV2ToFlowEdges`: reactive edge → `animated: true`, blue stroke; async edge → `strokeDasharray` set, orange stroke
  - `onConnect` with two widget endpoints → `edgeType: 'reactive'` in the resulting AuraEdge fed to `onChange`

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Layout↔Flow toggle does not break CanvasEditor (either remount or `display:none` approach; chosen approach documented in code comment)
- In Flow View, existing widget nodes appear with visible port handles
- Drawing a reactive edge between two widget ports appears as a blue animated line; `doc.edges` contains the new `AuraEdge` after `onChange`

---

### Commit 4 — feat(inspector): data flow summary section (P1-10)
**Why:** Adds the read-only "Data flow" section at the bottom of the Inspector Properties tab, fulfilling DL-26.
**Parallelizable with:** Commit 3

**Files:**
- `apps/web/app/builder/[appId]/Inspector.tsx` — MODIFIED: add "Data flow" section; use `onSwitchToFlowView` prop from commit 2

**Interface contracts:**
```ts
// Internal helper added to Inspector.tsx (not exported):
function getDataFlowSummary(nodeId: string, edges: AuraEdge[]): {
  reactiveInputs:  Array<{ toPort: string; fromNodeId: string; fromPort: string; edgeId: string }>
  reactiveOutputs: Array<{ fromPort: string; toNodeId: string; toPort: string; edgeId: string }>
  asyncTriggers:   Array<{ fromPort: string; toNodeId: string; toPort: string; edgeId: string }>
}
// No new Props additions; onSwitchToFlowView? was already added in commit 2.
```

**Implementation notes:**
- Call `getDataFlowSummary(n.id, doc.edges)` at the top of the render body. If all three returned arrays are empty, render nothing.
- Place the section at the bottom of the `activeTab === 'properties'` block, inside a `<div>` with `padding: '0.75rem 1rem'` and `borderTop: '1px solid #1a1a1a'`.
- Section header: `style={{ fontSize: '0.6rem', color: '#555', marginBottom: 6 }}` → "Data flow".
- Reactive inputs sub-label "← Inputs" in `#3b82f6`. Each badge: `"{toPort} ← {fromNodeId}.{fromPort}"`.
- Reactive outputs sub-label "→ Outputs". Each badge: `"{fromPort} → {toNodeId}.{toPort}"`.
- Async triggers sub-label "⚡ Async" in `#f97316`. Each badge: `"{fromPort} → {toNodeId}.{toPort}"`.
- Each badge is a `<button>` that calls `onSwitchToFlowView?.()` on click. Style: `background: '#1a1a1a'`, `borderRadius: 4`, `fontSize: '0.6rem'`, `fontFamily: 'monospace'`, `cursor: onSwitchToFlowView ? 'pointer' : 'default'`.
- Only show edges where both `fromNodeId` and `toNodeId` exist in `doc.nodes` (prevents stale entries from deleted nodes): filter via `doc.nodes.some(n => n.id === edge.fromNodeId)`.

**Tests:**
- `apps/web/app/builder/[appId]/Inspector.test.tsx` — NEW:
  - `getDataFlowSummary('text1', [{ fromNodeId:'filter1', fromPort:'value', toNodeId:'text1', toPort:'setContent', edgeType:'reactive', id:'e1' }])` → `reactiveInputs.length === 1`
  - Node with no edges → all three arrays empty
  - Badge click calls `onSwitchToFlowView` when provided
  - Badge renders even when `onSwitchToFlowView` is undefined

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Inspector Properties tab for a widget with reactive edges shows "Data flow" section with correct badge text
- Clicking a badge calls `setCanvasView('flow')` in the page (verified via integration with `onSwitchToFlowView` callback)

---

### Commit 5 — feat(flow-view): step node palette and async edge creation (P2-02 + P2-03)
**Why:** P2-02 (palette) and P2-03 (async edges) are merged because both require step-node rendering inside `FlowCanvas` — splitting them would leave `FlowCanvas` in a broken in-between state.
**Parallelizable with:** none (depends on commit 3)

**Files:**
- `apps/web/app/builder/[appId]/StepPalette.tsx` — NEW: collapsible step-type drag palette
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: step node custom types; `onDrop` handler; async edge detection; unconnected-step warning
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: render `<StepPalette>` in left sidebar when `canvasView === 'flow'`

**Interface contracts:**
```ts
// StepPalette — no props; communicates via HTML5 drag API:
export function StepPalette(): React.JSX.Element
// Each item: draggable div with
//   onDragStart: e.dataTransfer.setData('application/reactflow/step', stepType)
// stepType is one of: 'step:query' | 'step:mutation' | 'step:condition' | 'step:approval_gate' | 'step:notification'

// FlowCanvas — new internal step node data shape:
// data: { label: string; stepType: StepNodeType; config: Record<string, string>; connected: boolean }
// nodeTypes entry: every StepNodeType maps to the matching workflow-node component:
//   'step:query'         → QueryNode
//   'step:mutation'      → MutationNode
//   'step:condition'     → ConditionNode
//   'step:approval_gate' → ApprovalGateNode
//   'step:notification'  → NotificationNode

// FlowCanvas — drop creates a new AuraNode:
// { element: stepType, id: `${stepType.replace(':','-')}-${crypto.randomUUID().slice(0,6)}`,
//   parentId: 'root', style: { flowX: String(pos.x), flowY: String(pos.y) } }

// page.tsx — left sidebar ternary:
canvasView === 'flow'
  ? <StepPalette />
  : <LayersPanel doc={filteredNodes} ... />
```

**Implementation notes:**
- `StepPalette.tsx`: `import { STEP_NODE_REGISTRY } from '@lima/widget-catalog'`. Iterate `Object.values(STEP_NODE_REGISTRY)`. Render a `<details open>` wrapping `<summary>Steps</summary>` and the list of tiles. Each tile: 180px wide dark box with `meta.displayName` in bold and `meta.description` in small muted text. `draggable` attribute on the div.
- `FlowCanvas.tsx` — drop zone: wrap `<ReactFlow>` in a `<div>` with `onDrop={handleDrop}` and `onDragOver={e => e.preventDefault()}`. In `handleDrop`, read `e.dataTransfer.getData('application/reactflow/step')`; if non-empty, call `reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY })` (requires `useReactFlow()` hook, which needs `ReactFlowProvider` outer wrapper — already in place from commit 3).
- `FlowCanvas.tsx` — step-node custom type map: import `{ QueryNode, MutationNode, ConditionNode, ApprovalGateNode, NotificationNode }` from `'./workflow-nodes'`. Add them to `nodeTypes` with keys matching the `element` values.
- `FlowCanvas.tsx` — async edge: commit 3 already contains the logic (`element.startsWith('step:')` → `'async'`); this commit does not change it but verifies it covers step→step and step→widget cases.
- `FlowCanvas.tsx` — unconnected step warning: compute `connectedNodeIds = new Set([...doc.edges.map(e => e.fromNodeId), ...doc.edges.map(e => e.toNodeId)])`. Pass `connected: connectedNodeIds.has(node.id)` in the RF node `data`. The workflow-node components already accept a `data` prop; add a yellow border style when `data.connected === false` by wrapping in a `<div>` with `border: data.connected ? 'none' : '1px solid #fbbf24'`.
- `page.tsx` — sidebar: In the body `<div style={{ flex:1, display:'flex', overflow:'hidden' }}>`, change `<LayersPanel .../>` to `canvasView === 'flow' ? <StepPalette /> : <LayersPanel doc={filteredNodes} ... />`.

**Tests:**
- `StepPalette.test.tsx` — NEW:
  - Renders exactly `Object.keys(STEP_NODE_REGISTRY).length` tiles
  - `onDragStart` sets correct `dataTransfer` value for `'step:query'` tile
- `FlowCanvas.test.tsx` — EXTENDED:
  - `docV2ToFlowNodes` with a `step:query` node → RF node `type === 'step:query'`, position from `style.flowX/Y`
  - Widget→step `onConnect` call → resulting AuraEdge has `edgeType: 'async'`

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Dragging a "Query" tile from the palette onto the Flow View canvas creates a step node at the drop position
- Step node with no edges shows a yellow border
- Connecting a widget output port to a step node input port creates an orange dashed edge

---

### Commit 6 — feat(flow-view): flow group creation with Ctrl+G (P2-04)
**Why:** Allows builders to group step nodes visually; named group maps to a Workflow at the API level (DL-20/DL-21).
**Parallelizable with:** Commit 7

**Files:**
- `apps/web/app/builder/[appId]/FlowCanvas.tsx` — MODIFIED: multi-select detection, `Ctrl+G` handler, group node render and delete

**Interface contracts:**
```ts
// Group AuraNode shape stored in doc.nodes:
// { element: 'flow:group', id: 'group-<6 chars>', parentId: 'root',
//   text: 'New Flow Group',
//   style: { flowX: string, flowY: string, flowW: string, flowH: string } }

// Step AuraNode — new style field added when grouped:
// style.parentGroupId: string   // ID of the containing flow:group node

// Exported pure helper (for tests):
export function buildGroupFromStepSelection(
  selectedStepNodes: AuraNode[],
  padding?: number,       // default 40
): { groupNode: AuraNode; updatedStepNodes: AuraNode[] }
// Computes bounding box, creates group AuraNode, relativizes step flowX/flowY
```

**Implementation notes:**
- `onSelectionChange`: maintain `selectedStepNodeIds` in React state — IDs of selected RF nodes whose corresponding AuraNode has `element.startsWith('step:')`.
- `Ctrl+G` keydown: guard with `selectedStepNodeIds.length >= 2`. Call `buildGroupFromStepSelection`. Call `onChange({ nodes: [...nonSelectedStepNodes, ...updatedStepNodes, groupNode], edges: doc.edges })`. `.preventDefault()` must be called only inside the Flow View div — use a `onKeyDown` handler on the `<div>` wrapping `<ReactFlow>` with `tabIndex={0}`, not on `window`, to avoid conflicting with browser `Ctrl+G`.
- `buildGroupFromStepSelection`: compute `minX`, `minY`, `maxX`, `maxY` from each step node's `style.flowX`/`style.flowY` (treat missing as 0). Use `200` for estimated node width, `80` for estimated node height. Group bounding box: `{ x: minX - padding, y: minY - padding, w: maxX - minX + 2*padding + 200, h: maxY - minY + 2*padding + 80 }`. Relativize each step node's `flowX` → `String(parseFloat(node.style.flowX) - (minX - padding))` and same for `flowY`.
- `docV2ToFlowNodes` extended: flow:group AuraNodes → RF node with `type: 'group'`, `style: { width, height, border: '2px dashed #3b82f6', borderRadius: 8, background: 'rgba(29,78,216,0.05)' }`. Step nodes with `style.parentGroupId` set → RF node with `parentNode = parentGroupId`, `extent = 'parent'`.
- Group label: inline `<input>` inside the RF group node's label area; `onChange` on blur updates the group AuraNode's `text` field.
- Group deletion: `onNodesDelete` handler — when a `flow:group` node is deleted, also filter out all step nodes whose `style.parentGroupId` matches, and all edges touching those nodes.
- DL-21 badge: compute `hasTriggerEdge = doc.edges.some(e => e.toNodeId === groupNode.id || groupStepIds.has(e.toNodeId) && (e.fromPort === 'clicked' || e.fromPort === 'submitted'))`. If true, render a small "⚡ Workflow" badge in the group header. API record creation is deferred.

**Tests:**
- `FlowCanvas.test.tsx` — EXTENDED:
  - `buildGroupFromStepSelection([stepA, stepB])`: group bounding box encompasses both nodes with padding; `stepA.style.flowX` is relativized correctly; `groupNode.element === 'flow:group'`
  - Group deletion → child step nodes removed from returned `doc.nodes` in `onChange` call
  - Single step selected → `Ctrl+G` is a no-op (guard condition)

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- Select two step nodes in Flow View + `Ctrl+G` → bounding box appears with label "New Flow Group"
- Step nodes inside the group move as a unit when the group is dragged
- Double-clicking the group label enables renaming

---

### Commit 7 — feat(runtime): useAppSSE hook with exponential backoff (P2-08)
**Why:** Provides the shared `useAppSSE` hook consumed by both `WorkflowEditor` (polling replacement) and `page.tsx` (commit 8). Uses `fetch`+`ReadableStream` to support Bearer auth.
**Parallelizable with:** Commit 6

**Files:**
- `apps/web/app/builder/[appId]/hooks/useAppSSE.ts` — NEW
- `apps/web/app/builder/[appId]/WorkflowEditor.tsx` — MODIFIED: replace 3-second `setInterval` with `useAppSSE`; 5-second polling fallback when disconnected

**Interface contracts:**
```ts
// useAppSSE hook:
export interface AppSSEEvent {
  type: string                        // 'workflow_run_update' | 'variable_update' | unknown string
  data: Record<string, unknown>
}

export function useAppSSE(
  workspaceId: string,
  appId: string,
  enabled: boolean,
): {
  connected: boolean       // true once first data line received; false on error/disconnect
  lastEvent: AppSSEEvent | null
}
// When enabled=false: hook is dormant, no fetch initiated.
// Reconnect backoff: 100ms * 2^attempt, capped at 30_000ms.
// While connected=false and consumer has active runs, consumer manages its own poll.
```

**Implementation notes:**
- Read token: `const token = typeof window !== 'undefined' ? localStorage.getItem('lima_token') : null`. If null, do not initiate fetch.
- Build URL: `` `${API_BASE}/v1/workspaces/${workspaceId}/apps/${appId}/events` ``. Guard: if `workspaceId` or `appId` is empty string, return without fetching.
- `fetch` call: `{ headers: { 'Authorization': `Bearer ${token}` }, signal: ac.signal }`.
- Parse SSE stream: read `res.body!.getReader()`. Buffer partial chunks with a `TextDecoder`. Split buffer on `'\n\n'`. For each complete event block, extract `event:` line → `type`; `data:` line → `JSON.parse` → `data`. Set `lastEvent` via `useState`.
- On HTTP 401/403: do not retry; set `connected = false` and log a warning. Cap retry on auth errors at 3 attempts max.
- On read error or stream end: set `connected = false`; schedule reconnect via `setTimeout(retry, backoffMs)`. Double `backoffMs` for next attempt (start 100, cap 30_000). Reset backoff to 100 on first successful event.
- `useEffect` cleanup: `ac.abort()` + `clearTimeout` on any pending reconnect.
- **`WorkflowEditor.tsx`**: import `useAppSSE`. Replace the `window.setInterval` block (lines ~357–359) with:
  ```ts
  const { connected, lastEvent } = useAppSSE(workspace?.id ?? '', appId, !!selected?.id)
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== 'workflow_run_update' || !selected?.id) return
    void refreshRuns(selected.id, true)
  }, [lastEvent, selected?.id, refreshRuns])
  ```
  Keep the existing `refreshRuns` function (used for initial load). Add polling fallback: when `!connected && runs.some(r => ACTIVE_RUN_STATUSES.includes(r.status))` → `window.setInterval(pollFn, 5000)`.

**Tests:**
- `apps/web/app/builder/[appId]/hooks/useAppSSE.test.ts` — NEW (Vitest + `vi.useFakeTimers()`):
  - Initial state: `{ connected: false, lastEvent: null }`
  - `enabled = false`: `fetch` never called (spy on `globalThis.fetch`)
  - Mock fetch returns stream `"event: workflow_run_update\ndata: {\"run_id\":\"r1\"}\n\n"` → `lastEvent = { type: 'workflow_run_update', data: { run_id: 'r1' } }` and `connected = true`
  - Stream ends → `connected = false`; `setTimeout` called with delay `>= 100`
  - Three consecutive failures → backoff delays are `100`, `200`, `400` ms
  - `enabled` toggled to false while connected → `AbortController.abort()` called

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- In the builder's Workflows tab, triggering a workflow → run status updates without observing a 3-second `setInterval` firing (verify in devtools Network tab)

---

### Commit 8 — feat(runtime): apply SSE events to reactive store (P2-09)
**Why:** Closes the async edge loop: when a step completes, its output is written to the reactive store, causing subscribed widgets to update immediately.
**Parallelizable with:** none (depends on commits 2, 5, and 7)

**Files:**
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: consume `useAppSSE`; `workflow_run_update` events written to `reactiveStore`; error badge on trigger widget on run failure

**Interface contracts:**
```ts
// No new exports. Interactions:
//   useAppSSE(workspaceId, appId, enabled) — from commit 7
//   reactiveStore.set(widgetId, portName, value) — store from commit 2
//   history.doc.edges — AuraEdge[] from commit 2 state

// Extractable pure helper for testing:
export function processRunEvent(
  event: AppSSEEvent,
  edges: AuraEdge[],
  store: ReactiveStore,
): { triggerNodeId: string | null }
// Applies store writes for step_completed events.
// Returns triggerNodeId when status === 'failed', null otherwise.
```

**Implementation notes:**
- Add near the reactive store declaration in `page.tsx`:
  ```ts
  const { lastEvent } = useAppSSE(workspace?.id ?? '', appId, !loading && !loadError)
  const docRef = useRef(history.doc)
  docRef.current = history.doc
  const [runErrorWidgetId, setRunErrorWidgetId] = useState<string | null>(null)
  const errorClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  ```
- Add `useEffect` that watches only `lastEvent` (stable ref for doc avoids re-subscribing on every edit):
  ```ts
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== 'workflow_run_update') return
    const d = lastEvent.data as { status?: string; step_id?: string; output?: Record<string, unknown> }

    if (d.status === 'step_completed' && d.step_id && d.output) {
      const outEdges = docRef.current.edges.filter(
        e => e.fromNodeId === d.step_id && e.edgeType === 'async',
      )
      for (const edge of outEdges) {
        const value = d.output[edge.fromPort] ?? d.output
        reactiveStore.set(edge.toNodeId, edge.toPort, value)
      }
    }

    if (d.status === 'failed' && d.step_id) {
      const triggerEdge = docRef.current.edges.find(
        e => e.toNodeId === d.step_id && e.edgeType === 'async',
      )
      if (triggerEdge) {
        setRunErrorWidgetId(triggerEdge.fromNodeId)
        if (errorClearRef.current) clearTimeout(errorClearRef.current)
        errorClearRef.current = setTimeout(() => setRunErrorWidgetId(null), 5000)
      }
    }
  }, [lastEvent]) // eslint-disable-line react-hooks/exhaustive-deps
  // docRef.current and reactiveStore are stable refs — not listed as deps intentionally.
  ```
- Pass `runErrorWidgetId` to `CanvasEditor`: `highlightedWidgetIds={[...(highlightedWidgetIds), ...(runErrorWidgetId ? [runErrorWidgetId] : [])]}`. The existing `highlightedWidgetIds` prop already adds a highlight ring — reuse it. Use amber color by adding a second color code, or accept that the existing blue highlight is close enough for this phase (implementation decision).
- `processRunEvent` helper: extract the core logic (store writes + triggerNodeId detection) into a top-level exportable function so commit 8's test can exercise it without mounting the full page.

**Tests:**
- `apps/web/app/builder/[appId]/processRunEvent.test.ts` — NEW:
  - `step_completed` event, edge `step1.rows → table1.setRows` → `store.get('table1', 'setRows')` equals the output `rows` value
  - `step_completed` event, no outgoing edges from step → store unchanged
  - `failed` event with edge `form1.submitted → step1.params` → returns `{ triggerNodeId: 'form1' }`
  - `failed` event with no incoming async edges to the failed step → returns `{ triggerNodeId: null }`

**Done criteria:**
- `pnpm --filter web tsc --noEmit` exits 0
- `pnpm --filter web test` exits 0
- Injecting a mock `workflow_run_update / step_completed` event (via `useAppSSE` mock) causes the widget subscribed to the output port to update without a page refresh

---

## Critical Files

| File | Why Critical |
|------|-------------|
| `apps/web/app/builder/[appId]/page.tsx` | Modified by commits 2, 3, 5, and 8; strict sequence; no parallelism within this file |
| `apps/web/app/builder/[appId]/hooks/useDocumentHistory.ts` | Foundation changed in commit 2; its V2 shape is assumed by every subsequent commit |
| `apps/web/app/builder/[appId]/FlowCanvas.tsx` | Created commit 3, extended commits 5 and 6; must not be worked on concurrently |
| `apps/web/app/builder/[appId]/Inspector.tsx` | Modified commits 2 and 4; commit 4 requires `doc: AuraDocumentV2` from commit 2 |
| `apps/web/lib/api.ts` | Modified commit 1 only; type-level only, but all other files derive from it |

---

## Open Questions

- **Flow View / Layout View toggle — unmount vs hide**: Use `display: none` to avoid losing React Flow viewport state across toggles, OR accept remount with viewport stored in a `useRef`. Decide before starting commit 3 — affects the JSX structure.
- **Step node config Inspector panel**: Clicking a step node opens the Inspector, which shows a blank Properties tab for unknown elements. A dedicated step-node config panel (using `STEP_NODE_REGISTRY` port definitions) is outside this slice. The implementer should add a clear "Step configuration UI coming soon" placeholder rather than leaving a blank panel.
- **`nanoid` availability**: Commits 5 and 6 generate short IDs. Check `apps/web/package.json` for `nanoid`. If absent, use `crypto.randomUUID().slice(0,8)` — no new package required.
- **Triggered flow group → Workflow API write**: DL-21 requires a triggered flow group to create/update a `Workflow` DB record on save. Commit 6 shows only a badge. Confirm whether the API write belongs in this frontend slice or a follow-up backend commit.
- **`CanvasEditor` highlight color for run errors**: `highlightedWidgetIds` currently renders a blue outline. Commit 8 reuses this for error state. Either change the highlight color to amber when the source is `runErrorWidgetId`, or accept blue for the initial cut and file a follow-up.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `handleCanvasChange` silently drops step and group nodes | Commit 2 merge logic `[...newDoc, ...fallback]` is the only protection; must be present and covered by the `useDocumentHistory` test that verifies step nodes survive a canvas change round-trip |
| React Flow re-renders on every intermediate drag position cause performance issues | Use `onNodeDragStop` (not `onNodeDrag`) for writing back to `doc`; let RF's internal `useNodesState` handle intermediate positions |
| SSE fetch retry storms after server restart (100ms base → hundreds of connections per second) | Backoff cap at 30s and per-client nature of SSE prevent server overload; also guard with `enabled` flag so WorkflowEditor only connects when a workflow is selected |
| `fetch`-based SSE returns HTTP 401 after token expiry mid-stream | guard code caps retries at 3 for 4xx responses; after 3 failures the hook sets `connected = false` permanently until re-mount — acceptable since builders typically re-auth via page reload |
| `Ctrl+G` captures keypress during text input (e.g. group label rename) | Attach handler to the Flow View `<div>` with `tabIndex={0}` (not `window`), and skip when the active element is an `<input>` or `<textarea>` |

// New errors emitted:
//   nodeId = node.id,  message = "unknown step node element 'step:foo'"
//   nodeId = edge.id,  message = "async edge '<id>' must connect to at least one step node"
```

**Implementation notes:**
- Add a `Set` of valid step element names at the top of `validateV2`:
  `const STEP_ELEMENTS = new Set(['step:query','step:mutation','step:condition','step:approval_gate','step:notification'])`
- In the node-checking loop: if `node.element.startsWith('step:')` and the element is not in `STEP_ELEMENTS`, push a `ValidationError`.
- Build `nodeElementMap: Map<string, string>` (id → element) from `doc.nodes` — it's already constructed inside `validateV2` for port checks; reuse it.
- In the edge-checking loop (after the existing `fromNodeId`/`toNodeId` existence checks): for each `async` edge, look up `nodeElementMap.get(edge.fromNodeId)` and `nodeElementMap.get(edge.toNodeId)`. If neither starts with `'step:'`, push a `ValidationError` on `edge.id`.
- Do not error when one or both node IDs are absent (that error is already emitted by the existing unknown-node check above). Only run the async-chain check when both endpoints resolve.
- `transform` syntax validation (DL-55 bullet 5) is deferred; see Open Questions.

**Tests:**
- `validateV2` with a node `{element:'step:query', ...}` → no error
- `validateV2` with a node `{element:'step:unknown', ...}` → error containing `"unknown step node element"`
- Async edge between two widget nodes (no step node) → error containing `"must connect to at least one step node"`
- Async edge from widget to `step:mutation` → no async-chain error
- Async edge from `step:query` to `step:mutation` → no async-chain error (step→step is valid)
- Existing `validateV2` tests remain green (no regressions)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `pnpm --filter @lima/aura-dsl build` exits 0

---

### Commit 2 — feat(aura-dsl): add migrateV1ToV2 to convert existing app documents
**Why:** Provides the pure conversion function (DL-57) that the API and one-time migration scripts call; depends on Commit 1 because step node elements must be valid DSL post-migration.
**Parallelizable with:** Commits 3, 4, 5, 6 (non-overlapping files after Commit 1 lands)

**Files:**
- `packages/aura-dsl/src/index.ts` — MODIFIED: add `V1WorkflowStep`, `V1WorkflowOutputBinding`, `V1Workflow`, `migrateV1ToV2`
- `packages/aura-dsl/src/index.test.ts` — MODIFIED: add migration tests

**Interface contracts:**
```ts
export interface V1WorkflowStep {
  id: string
  stepType: 'query' | 'mutation' | 'condition' | 'approval_gate' | 'notification'
  name: string
  config: Record<string, unknown>
  stepOrder: number
  nextStepId?: string
  falseBranchStepId?: string
}

export interface V1WorkflowOutputBinding {
  triggerStepId: string   // "__workflow_complete__" | stepId
  widgetId: string
  port: string
}

export interface V1Workflow {
  id: string
  steps: V1WorkflowStep[]
  outputBindings: V1WorkflowOutputBinding[]
}

export function migrateV1ToV2(
  doc: AuraDocument,
  workflows: V1Workflow[]
): AuraDocumentV2
// Pure function; does not throw. Returns a valid AuraDocumentV2.
// Edge IDs are deterministic: "e_{fromNodeId}_{fromPort}_{toNodeId}_{toPort}".
```

**Implementation notes:**
- Build a map `workflowById: Map<string, V1Workflow>` from `workflows`.
- For each `AuraNode` with `action` set (workflow trigger):
  1. Look up the workflow in `workflowById`. If not found, skip (no step nodes created).
  2. Sort the workflow's steps by `stepOrder`. Create one `AuraNode` per step with `element: 'step:' + stepType`, `id: step.id`, `parentId: 'root'`.
  3. Create an async `AuraEdge` from `{node.id}.submitted` → `{firstStep.id}.params`.
  4. For each step (in order): create an async `AuraEdge` from `{step.id}.result` → `{step.nextStepId}.params` (if `nextStepId` is set). For condition steps additionally create `{step.id}.result` → `{step.falseBranchStepId}.params` (if set).
  5. For each `outputBinding`: create an async `AuraEdge` from `{ob.triggerStepId === '__workflow_complete__' ? lastStep.id : ob.triggerStepId}.result` → `{ob.widgetId}.{ob.port}`.
- For each `AuraNode` with `widget_bindings`:
  - For each `[configKey, binding]` in `widget_bindings`: create a reactive `AuraEdge` from `{binding.widget_id}.{binding.port}` → `{node.id}.{configKey}`.
- Return a new `AuraDocumentV2` with `nodes` = original nodes (shallow copy each, clearing `action`, `widget_bindings`, `output_bindings` on migrated ones) + new step nodes; `edges` = all created edges.
- The function is pure: no original node is mutated; the returned doc may be immediately validated with `validateV2`.
- Edge ID collision: use a counter suffix if the deterministic key duplicates within a single migration pass.

**Tests:**
- Single-step workflow: doc with one `button` node with `action` set → returns one `step:mutation` node + two edges (button→step, step→target widget)
- Two-step linear workflow: → two step nodes + three edges (trigger, step1→step2, step2→output)
- Condition step: `falseBranchStepId` set → `falseBranch` edge created
- `widget_bindings`: one binding entry → one reactive edge
- `action` and `widget_bindings` cleared on converted nodes in returned doc
- Orphan workflow (workflow ID in `action` not in `workflows` input) → node silently skipped, no error thrown
- Round-trip: `validateV2(migrateV1ToV2(v1Doc, workflows))` returns no errors (requires a doc where all widget IDs match the target nodes)

**Done criteria:**
- `pnpm --filter @lima/aura-dsl test` exits 0
- `migrateV1ToV2`, `V1Workflow`, `V1WorkflowStep`, `V1WorkflowOutputBinding` exported from package root

---

### Commit 3 — feat(worker): add DSL helpers to extract step graph from apps table
**Why:** Introduces all new data-reading plumbing (P2-05) without touching the live execution path; gives Commit 4 a clean API to call.
**Parallelizable with:** Commit 2 (non-overlapping packages)

**Files:**
- `services/worker/internal/queue/workflow_store.go` — MODIFIED: add `dslEdge` struct, `getAppDSLForWorkflow`, `buildStepsFromDSL`
- `services/worker/internal/queue/dsl.go` — MODIFIED: add `parseWithFromStatement`
- `services/worker/internal/queue/workflow_test.go` — MODIFIED: add unit tests for new helpers

**Interface contracts:**
```go
// Local mirror of model.AuraEdge — avoids cross-module import.
type dslEdge struct {
    ID         string `json:"id"`
    FromNodeID string `json:"from_node_id"`
    FromPort   string `json:"from_port"`
    ToNodeID   string `json:"to_node_id"`
    ToPort     string `json:"to_port"`
    EdgeType   string `json:"edge_type"` // "reactive" | "async"
    Transform  string `json:"transform,omitempty"`
}

// getAppDSLForWorkflow fetches dsl_source, dsl_edges, dsl_version, and app_id
// for the app linked to the given workflowID (via workflows.app_id FK).
// Returns (dslSource, edges, version, appID, err).
func getAppDSLForWorkflow(
    ctx context.Context,
    pool *pgxpool.Pool,
    workflowID string,
) (dslSource string, edges []dslEdge, dslVersion int, appID string, err error)

// parseWithFromStatement extracts the `with` key=value map from a single
// DSL statement text (output of parseDSLStatements). Returns an empty map if
// no `with` clause is present.
func parseWithFromStatement(stmt string) (map[string]string, error)

// buildStepsFromDSL derives a []wfStep from the app's DSL source and edges.
// Step execution order is determined by topological sort of async edges
// between step nodes. nextStepID and falseBranchStepID are populated from
// edges whose fromPort is "result"/"trueBranch" and "falseBranch" respectively.
func buildStepsFromDSL(
    workflowID string,
    dslSource string,
    dslEdges []dslEdge,
) ([]wfStep, error)
```

**Implementation notes:**
- `getAppDSLForWorkflow` query:
  ```sql
  SELECT a.dsl_source, a.dsl_edges, a.dsl_version, a.id
  FROM apps a
  JOIN workflows w ON w.app_id = a.id
  WHERE w.id = $1
  ```
  Scan `dsl_edges` JSONB into `[]byte`, then `json.Unmarshal` into `[]dslEdge`.
- `parseWithFromStatement`: tokenise the statement by splitting on whitespace while respecting double-quoted strings (a minimal re-use of the brace/string-aware logic already in `parseDSLStatements`). Find the token `"with"`. Consume subsequent `key="value"` pairs until the next non-`key="value"` token (i.e. a token that does not contain `=` or is `;`). Return the map. Values are JSON-unquoted strings — use `json.Unmarshal([]byte(rawVal), &dest)` to strip the outer quotes.
- `buildStepsFromDSL`:
  1. Call `parseDSLStatements(dslSource)` → `stmts` map.
  2. Filter: keep statements whose first token starts with `"step:"`.
  3. For each step statement: extract `element` (token 0), `id` (token 1), call `parseWithFromStatement` to get `config`.
  4. `stepType`: slice `element` after the colon prefix — e.g., `"step:query"` → `"query"`. Cast to `workflowStepType`.
  5. Build two adjacency sets from `dslEdges` where `edgeType == "async"` and both `fromNodeId` and `toNodeId` are step node IDs (i.e. exist in the step ID set from step 3).
  6. Topological sort (Kahn's) of step IDs using the step-to-step async edges. Return error on cycle.
  7. Assign `stepOrder` = position in topo-sort result (0-based).
  8. For each step: scan outgoing async edges — `fromPort == "falseBranch"` → `falseBranchStepID`; any other async output port → `nextStepID`. If a step has multiple non-false-branch outgoing edges, use the one with the smallest topo-sort index as `nextStepID` (deterministic).
  9. Return `[]wfStep` in topo-sort order.

**Tests:**
- `parseWithFromStatement("step:mutation s @ root\n  with connector=\"pg\" sql=\"INSERT INTO t (a) VALUES (1)\"\n;")` → `{"connector":"pg","sql":"INSERT INTO t (a) VALUES (1)"}` 
- `parseWithFromStatement` on a statement with no `with` clause → empty map, no error
- `buildStepsFromDSL` with two step nodes connected by a single async edge → returns two `wfStep` entries in topo-sorted order, `nextStepID` on the first pointing to the second
- `buildStepsFromDSL` with a condition step and two outgoing edges (`trueBranch`→stepA, `falseBranch`→stepB) → `nextStepID = stepA.id`, `falseBranchStepID = stepB.id`
- `buildStepsFromDSL` with a cycle in async step edges → returns an error

**Done criteria:**
- `go test ./services/worker/internal/queue/...` (unit subset) exits 0
- `getAppDSLForWorkflow`, `buildStepsFromDSL`, `parseWithFromStatement` are unexported (package-private within `queue`)

---

### Commit 4 — feat(worker): route executeWorkflowRun to DSL step graph when dsl_version ≥ 2
**Why:** Makes the worker actually use the DSL-derived step definitions (DL-44 through DL-47) while keeping the V1 `workflow_steps` path intact.
**Parallelizable with:** Commit 2

**Files:**
- `services/worker/internal/queue/workflow.go` — MODIFIED: `executeWorkflowRun`, `resumeWorkflowRun`, `resolveInputRef`, add `hydrateDSLSteps`
- `services/worker/internal/queue/workflow_test.go` — MODIFIED

**Interface contracts:**
```go
// hydrateDSLSteps replaces def.steps with the DSL-derived step graph when
// dsl_version >= 2. It is a no-op for V1 workflows.
// Callers: executeWorkflowRun, resumeWorkflowRun.
func hydrateDSLSteps(
    ctx context.Context,
    pool *pgxpool.Pool,
    def *wfDefinition,
) error

// resolveInputRef — extended signature (unchanged; new behaviour added):
// Now also handles "{{widgetId.portName}}" by doing a flat key lookup in
// inputData with key "widgetId.portName" (DL-47). Existing {{input.FIELD}}
// and {{step.ID.PATH}} patterns are untouched.
func resolveInputRef(expr string, inputData map[string]any, stepResults map[string]any) any
```

**Implementation notes:**
- `wfDefinition` needs a `dslVersion int` and `appID string` field. Add them to the struct. Update `getWorkflowDefinition` to also query `SELECT ..., a.dsl_version, a.id FROM workflows w JOIN apps a ON a.id = w.app_id WHERE w.id = $1`.
- `hydrateDSLSteps(ctx, pool, def)`:
  - If `def.dslVersion < 2`, return nil immediately (V1 path unchanged).
  - Call `getAppDSLForWorkflow(ctx, pool, def.id)` to get `dslSource`, `dslEdges`, `dslVersion`, `appID`.
  - Call `buildStepsFromDSL(def.id, dslSource, dslEdges)`.
  - Replace `def.steps` with the result. Set `def.appID`.
  - Return error on any DB or parse failure.
- In `executeWorkflowRun`, after `getWorkflowDefinition`, call `hydrateDSLSteps(ctx, pool, def)` before the `setRunStatus(running)` call. If it returns an error, mark the run as `failed` and return nil (same pattern as existing error handling).
- In `resumeWorkflowRun`, apply the same `hydrateDSLSteps` call after `getWorkflowDefinition` on the resume branch.
- **DL-47 input ref extension**: add a new compiled regex at the top of the `var` block:
  `workflowWidgetRefRe = regexp.MustCompile(`\{\{([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.([a-zA-Z0-9_.]+)\}\}`)`
  In `resolveInputRef`, before the existing exact-match checks, add: if the expression matches `workflowWidgetRefRe` and the key `"widgetId.portName"` exists verbatim in `inputData`, return that value. This lookup must run before the `{{input.FIELD}}` regex so that `{{form1.first_name}}` is not interpreted as `{{input.*}}` (`workflowInputRefRe` requires `input.` prefix so there is no overlap as long as no widget is named `input`).
- The V1 `runStepGraph` code path is unchanged. Topological ordering is encoded into `wfStep.stepOrder` by `buildStepsFromDSL` (commit 3), so the existing `nextStep()` step-order fallback and `nextStepID`/`falseBranchStepID` branching already works without modification.

**Tests:**
- `resolveInputRef("{{form1.first_name}}", map[string]any{"form1.first_name": "Alice"}, nil)` → `"Alice"`
- `resolveInputRef("{{input.first_name}}", map[string]any{"first_name": "Alice"}, nil)` → `"Alice"` (existing behaviour preserved)
- `resolveInputRef("{{form1.email}}", map[string]any{"form1.first_name": "Alice"}, nil)` → returns the original expression string (key not found)
- `hydrateDSLSteps` with `def.dslVersion = 1` → returns nil; `def.steps` unchanged (verify with a stub that `getAppDSLForWorkflow` is not called — achieved by passing a nil pool and asserting no panic)
- Integration: existing `workflow_integration_test.go` suite passes unchanged (V1 path regression guard)

**Done criteria:**
- `go build ./services/worker/...` exits 0
- `go test ./services/worker/internal/queue/...` (unit tests) exits 0
- DB integration suite (gated on `LIMA_RUN_DB_INTEGRATION_TESTS=1`) remains green

---

### Commit 5 — feat(worker): publish step completion and run terminal events to Redis pub/sub
**Why:** Implements DL-49 — once the worker completes a step or finishes a run, clients subscribed via SSE need a push notification.
**Parallelizable with:** none (depends on Commit 4 for `def.appID` and run identity)

**Files:**
- `services/worker/internal/queue/workflow.go` — MODIFIED: add `workflowRunEvent`, `publishStepEvent`; update `handleWorkflow`, `executeWorkflowRun`, `resumeWorkflowRun`, `runStepGraph` signatures to accept `*redis.Client`
- `services/worker/internal/queue/dispatcher.go` — MODIFIED: pass `d.client` to `handleWorkflow`

**Interface contracts:**
```go
// workflowRunEvent is the JSON body of each Redis pub/sub message.
type workflowRunEvent struct {
    RunID   string         `json:"run_id"`
    AppID   string         `json:"app_id"`
    Status  string         `json:"status"`   // "step_completed" | "completed" | "failed" | "awaiting_approval"
    StepID  string         `json:"step_id,omitempty"`
    Output  map[string]any `json:"output,omitempty"`
}

// publishStepEvent marshals event to JSON and calls
// rdb.Publish(ctx, "app:"+event.AppID+":events", payload).
// Logs but does not return the error — a publish failure must never
// fail the workflow execution itself.
func publishStepEvent(ctx context.Context, rdb *redis.Client, event workflowRunEvent)

// Updated signatures (internal; not exported):
func handleWorkflow(cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger) jobHandler
func executeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger, runID, workflowID string) error
func resumeWorkflowRun(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger, runID, approvalID string, approved bool) error
func runStepGraph(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger, run *wfRun, def *wfDefinition, stepResults map[string]any) error
```

**Implementation notes:**
- `publishStepEvent` wraps `json.Marshal` + `rdb.Publish`. If `rdb == nil` (can happen when the worker runs without Redis in tests), return immediately without panicking.
- Publish points:
  1. **After each step completion** in `runStepGraph`, immediately after the `executeStep(...)` call returns `(paused=false, err=nil)`: publish `{status:"step_completed", stepID: current.id, output: stepResults[current.id]}`.
  2. **On run completion** in `executeWorkflowRun`: after the final `setRunStatus(completed)` call, publish `{status:"completed"}`.
  3. **On run failure** in `executeWorkflowRun`: after `setRunStatus(failed)`, publish `{status:"failed"}`.
  4. **On awaiting_approval** in `executeWorkflowRun`: after `setRunStatus(awaiting_approval)`, publish `{status:"awaiting_approval", stepID: <last paused step>}`.
  5. Mirror the same points in `resumeWorkflowRun`.
- `appID` is available on `def.appID` (set by `hydrateDSLSteps` in V2 path; set by the updated `getWorkflowDefinition` for V1 — confirm `getWorkflowDefinition` now returns `def.appID` per Commit 4).
- Do NOT pass `rdb` into `executeStep` or `resolveApprovedStep` — publish happens at the outer graph-loop level only.
- `dispatcher.go` change: `startPool(JobWorkflow, 1, handleWorkflow(d.cfg, d.pool, d.client, d.log))`. The `d.client` field is already set on the `Dispatcher` struct by `Run()`.

**Tests:**
- `publishStepEvent` with `rdb == nil` → no panic, no error logged
- `publishStepEvent` with a mock Redis that captures messages → message is valid JSON matching `workflowRunEvent` shape with `"app:{appID}:events"` as channel
- `handleWorkflow` called with `rdb = nil` → executes without panicking (verifiable via existing unit test suite)
- Existing `workflow_test.go` and `workflow_integration_test.go` tests pass (nil `rdb` is acceptable because `publishStepEvent` is a no-op when `rdb == nil`)

**Done criteria:**
- `go build ./services/worker/...` exits 0
- `go test ./services/worker/...` exits 0
- Redis channel name used in publish calls is exactly `"app:" + appID + ":events"`

---

### Commit 6 — feat(api): stream app events via SSE from Redis pub/sub
**Why:** Implements DL-48 — authenticated clients subscribe once; the API fan-fouts Redis pub/sub messages as `text/event-stream` events.
**Parallelizable with:** Commit 5 (channel name and event JSON shape specified above; handler can be written against those contracts before Commit 5 merges)

**Files:**
- `services/api/internal/handler/events.go` — NEW: `AppEvents` handler
- `services/api/internal/router/router.go` — MODIFIED: register `GET /{appID}/events` route

**Interface contracts:**
```go
// AppEvents serves an SSE stream for a single app.
// Required auth: Authenticate middleware already applied by the router group.
// Required role: end_user (already applied by the outer workspaces/{workspaceID} group).
func AppEvents(s *store.Store, rdb *goredis.Client, log *zap.Logger) http.HandlerFunc
```

**SSE message format** (matches DL-48):
```
event: workflow_run_update
data: {"run_id":"...","app_id":"...","status":"step_completed","step_id":"...","output":{...}}

```
(Two trailing newlines end each event frame.)

**Implementation notes:**
- Extract `workspaceID` and `appID` from chi URL params. Call `s.GetApp(r.Context(), workspaceID, appID)` to verify the app exists and belongs to the workspace. On `store.ErrNotFound` respond 404; on any other error respond 500. Do not proceed to the SSE loop on error.
- Set response headers before writing any body:
  ```go
  w.Header().Set("Content-Type", "text/event-stream")
  w.Header().Set("Cache-Control", "no-cache")
  w.Header().Set("Connection", "keep-alive")
  w.Header().Set("X-Accel-Buffering", "no")  // disable nginx buffering
  ```
- Subscribe: `pubsub := rdb.Subscribe(r.Context(), "app:"+appID+":events")`. Defer `pubsub.Close()`.
- Loop:
  ```go
  msgCh := pubsub.Channel()
  flusher, ok := w.(http.Flusher)
  // ...
  for {
      select {
      case msg, open := <-msgCh:
          if !open { return }
          fmt.Fprintf(w, "event: workflow_run_update\ndata: %s\n\n", msg.Payload)
          if ok { flusher.Flush() }
      case <-r.Context().Done():
          return
      }
  }
  ```
- If `w` does not implement `http.Flusher`, log a warning and continue (the stream will still work; intermediate proxies may buffer). Do not reject the connection.
- Route location in `router.go`: inside the existing `r.Route("/{appID}", ...)` block, after publish/rollback routes:
  ```go
  r.Get("/events", handler.AppEvents(s, rdb, log))
  ```
  The `rdb` parameter is already available in `router.New()`.
- **Security**: `AppEvents` must not forward raw Redis messages that originate from channels other than `app:{appID}:events`. The subscription is keyed to a single channel, so no cross-app leakage is possible in this design.

**Tests:**
- `services/api/internal/handler/events_test.go` — NEW, using `httptest.NewRecorder` and a mock Redis pub/sub:
  - Workspace/app mismatch (app belongs to different workspace) → `GetApp` returns `ErrNotFound` → handler responds 404 before writing SSE headers
  - Valid subscription: inject one Redis message → response body contains `event: workflow_run_update\ndata: ...`
  - Client disconnect (`r.Context()` cancelled) → handler returns cleanly; no goroutine leak (assert with `goleak` or by verifying the mock subscription is closed)

**Done criteria:**
- `go build ./services/api/...` exits 0
- `go test ./services/api/internal/handler/...` exits 0
- `curl -N -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/workspaces/{id}/apps/{id}/events` returns a streaming `200 OK` with `Content-Type: text/event-stream`

---

## Critical Files

| File | Why Critical |
|------|-------------|
| `packages/aura-dsl/src/index.ts` | Modified by both Commits 1 and 2; must land sequentially — both commits touch `validateV2` area |
| `services/worker/internal/queue/workflow.go` | Modified by Commits 4 and 5; function signatures change in each; strict sequence required |
| `services/worker/internal/queue/workflow_store.go` | Modified by Commits 3 and 4 (`wfDefinition` struct gains new fields in 4 that 3 does not add); must land in order |
| `services/worker/internal/queue/dispatcher.go` | Modified only by Commit 5; low risk but blocks the Redis publish wiring |
| `services/api/internal/router/router.go` | Commit 6 adds one route; no other Phase 2 commit touches this file |

---

## Open Questions

Minor unknowns the implementing agent should resolve at implementation time:

- **transform syntax validation (DL-55 bullet 5)**: Adding AST-level JS parse checks inside `validateV2` requires a parser dependency (e.g. `acorn` or `@babel/parser`). Including one adds ~100 KB to the DSL bundle. Decide whether to add the dependency or defer to Phase 3 hardening. Current plan defers it.
- **`migrateV1ToV2` caller wiring**: The plan delivers the pure function but not the API endpoint or migration script that calls it. That wiring (DL-59: "V1 documents are silently upgraded on read") is an open backend task outside these 6 commits. Confirm before Phase 2 ships whether that wiring belongs in this slice or the next.
- **`AppVersion` edge snapshotting**: The `app_versions` table does not have a `dsl_edges` column. Published versions currently snapshot only `dsl_source`. Confirm whether published versions must also snapshot `dsl_edges` for replay. If yes, a migration is needed before the builder ships the Flow View publish button.
- **`resumeWorkflowRun` DSL consistency**: `hydrateDSLSteps` is called on resume with the app's *current* `dsl_edges`. If the document was edited while a run was awaiting approval, the resume may execute against a different graph than the initial run. Decide whether to snapshot `dsl_edges` onto the `workflow_runs` record at run-start or accept this eventual-consistency risk.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Positional column mismatch when `getWorkflowDefinition` gains new JOIN fields | Write a unit test that verifies the SELECT column count equals the `Scan` argument count; use named struct tags rather than raw positional ordering where pgx allows |
| `buildStepsFromDSL` parse of `with` clause breaks on embedded quotes in SQL | `parseWithFromStatement` must use a proper string-aware tokeniser, not `strings.Fields`; covered by tests for multi-word SQL values |
| SSE handler goroutine leak on abnormal client disconnect | Rely on `r.Context().Done()` — chi/stdlib cancels context on TCP close; verify with a test using a cancelled context |
| Worker `rdb` nil in unit tests → `publishStepEvent` silently swallowed | All unit tests that call `executeWorkflowRun` pass `nil` for `rdb` and assert step results through `workflow_runs.output_data` as before; publish is best-effort |
| Step node `id` field collision between DSL step IDs and `workflow_steps` IDs | V2 path uses DSL IDs exclusively; V1 path uses `workflow_steps` IDs exclusively; the two sets never mix because `hydrateDSLSteps` replaces `def.steps` entirely |


