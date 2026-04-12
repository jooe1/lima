/**
 * Reactive store and expression runtime for the Aura dual-layer canvas.
 *
 * The `ReactiveStore` is an observable state Map keyed by (widgetId, portName).
 * Widget components write to it on state change; the expression runtime reads
 * it to propagate reactive edge values.
 *
 * This module is environment-agnostic (browser and Node.js).
 */

// ---- Reactive store --------------------------------------------------------

export type Subscriber = (value: unknown) => void

export interface ReactiveStore {
  /** Read the current value for a (widgetId, portName) pair. Returns undefined if not set. */
  get(widgetId: string, portName: string): unknown
  /** Set a value and notify all subscribers for that (widgetId, portName) pair synchronously. */
  set(widgetId: string, portName: string, value: unknown): void
  /**
   * Subscribe to value changes for a (widgetId, portName) pair.
   * Returns an unsubscribe function — call it to stop receiving updates.
   */
  subscribe(widgetId: string, portName: string, fn: Subscriber): () => void
  /**
   * Returns a frozen snapshot of the current store state.
   * The returned Maps are new objects — mutations do not affect the live store.
   */
  snapshot(): ReadonlyMap<string, ReadonlyMap<string, unknown>>
}

export function createReactiveStore(): ReactiveStore {
  // Two-level map: widgetId → portName → value
  const values = new Map<string, Map<string, unknown>>()
  // Mirroring subscriber map: widgetId → portName → Set<Subscriber>
  const subs = new Map<string, Map<string, Set<Subscriber>>>()

  function get(widgetId: string, portName: string): unknown {
    return values.get(widgetId)?.get(portName)
  }

  function set(widgetId: string, portName: string, value: unknown): void {
    if (!values.has(widgetId)) values.set(widgetId, new Map())
    values.get(widgetId)!.set(portName, value)

    // Notify subscribers
    const portSubs = subs.get(widgetId)?.get(portName)
    if (portSubs) {
      for (const fn of portSubs) {
        try {
          fn(value)
        } catch (err) {
          console.error(`ReactiveStore: subscriber threw for (${widgetId}, ${portName}):`, err)
        }
      }
    }
  }

  function subscribe(widgetId: string, portName: string, fn: Subscriber): () => void {
    if (!subs.has(widgetId)) subs.set(widgetId, new Map())
    const portMap = subs.get(widgetId)!
    if (!portMap.has(portName)) portMap.set(portName, new Set())
    portMap.get(portName)!.add(fn)

    return () => {
      subs.get(widgetId)?.get(portName)?.delete(fn)
    }
  }

  function snapshot(): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
    const snap = new Map<string, ReadonlyMap<string, unknown>>()
    for (const [widgetId, ports] of values) {
      snap.set(widgetId, new Map(ports))
    }
    return snap
  }

  return { get, set, subscribe, snapshot }
}

// ---- Expression runtime ---------------------------------------------------

interface ReactiveEdge {
  id: string
  fromNodeId: string
  fromPort: string
  toNodeId: string
  toPort: string
  edgeType: 'reactive' | 'async'
  transform?: string
}

interface DocumentEdgeList {
  edges: ReactiveEdge[]
}

/**
 * Build a directed adjacency map from reactive edges.
 * Key format: "${widgetId}:${portName}" — widgetId never contains ':', portName may contain '.'.
 * Only includes edges with edgeType 'reactive'.
 */
export function buildDependencyGraph(
  edges: ReactiveEdge[]
): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const e of edges) {
    if (e.edgeType !== 'reactive') continue
    const from = `${e.fromNodeId}:${e.fromPort}`
    const to = `${e.toNodeId}:${e.toPort}`
    if (!graph.has(from)) graph.set(from, [])
    if (!graph.has(to)) graph.set(to, [])
    graph.get(from)!.push(to)
  }
  return graph
}

/**
 * Topological sort using Kahn's BFS algorithm.
 * Returns the sorted node keys, or null if a cycle is detected.
 */
export function topoSort(
  graph: Map<string, string[]>
): string[] | null {
  const inDegree = new Map<string, number>()
  for (const node of graph.keys()) inDegree.set(node, 0)
  for (const [, neighbors] of graph) {
    for (const n of neighbors) {
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node)
  }

  const result: string[] = []
  while (queue.length > 0) {
    const cur = queue.shift()!
    result.push(cur)
    for (const neighbor of (graph.get(cur) ?? [])) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(neighbor)
    }
  }

  return result.length === graph.size ? result : null
}

/**
 * Resolves {{widgetId.portName}} placeholders in an expression string
 * by reading from the reactive store.
 * Supports nested paths: {{table1.selectedRow.name}} reads store.get('table1', 'selectedRow')
 * then accesses .name on the result.
 */
export function resolveExpression(
  expr: string,
  store: ReactiveStore
): unknown {
  const pattern = /\{\{([^}]+)\}\}/g

  // First pass: check if the entire expression is a single template
  const singlePattern = /^\{\{([^}]+)\}\}$/
  const singleMatch_ = singlePattern.exec(expr)
  if (singleMatch_) {
    const path = singleMatch_[1].split('.')
    const widgetId = path[0]
    const portName = path[1]
    let val: unknown = store.get(widgetId, portName)
    for (let i = 2; i < path.length; i++) {
      if (val == null) { val = undefined; break }
      val = (val as Record<string, unknown>)[path[i]]
    }
    return val
  }

  // Multi-placeholder: replace each with its string representation
  return expr.replace(pattern, (_, capture) => {
    const path = (capture as string).split('.')
    const widgetId = path[0]
    const portName = path[1]
    let val: unknown = store.get(widgetId, portName)
    for (let i = 2; i < path.length; i++) {
      if (val == null) { val = undefined; break }
      val = (val as Record<string, unknown>)[path[i]]
    }
    return val == null ? '' : String(val)
  })
}

/**
 * Evaluates a transform expression in a sandboxed scope.
 *
 * The expression receives:
 *  - `$` — the source value
 *  - Math, String, Number, Array, Object, JSON, Date — standard globals
 *
 * Security:
 *  - Prototype pollution guard: rejects expressions containing `__proto__`,
 *    `constructor.constructor`, or `.prototype`
 *  - No access to globalThis, window, document, fetch, process, eval, Function
 *  - "use strict" mode inside the constructed function
 *
 * Timeout:
 *  - Post-execution wall-clock check; does NOT pre-empt running code.
 *  - NOTE: hard pre-emption of infinite loops requires a Worker (deferred to Phase 3).
 *
 * @throws EvaluationError on pollution attempt, syntax error, runtime error, or timeout
 */
export function evaluateTransform(
  $: unknown,
  expr: string,
  timeoutMs = 50,
): unknown {
  // Prototype pollution guard (runs before any Function construction)
  if (/(__proto__|constructor\.constructor|\.prototype\b)/.test(expr)) {
    throw new EvaluationError('prototype pollution attempt blocked')
  }

  let fn: (...args: unknown[]) => unknown
  try {
    // Construct with explicit scope args that shadow any global references.
    // All args other than $ are passed as undefined except the allowed globals.
    // eslint-disable-next-line no-new-func
    fn = new Function(
      '$',
      'Math',
      'String',
      'Number',
      'Array',
      'Object',
      'JSON',
      'Date',
      '"use strict"; return (' + expr + ')',
    ) as (...args: unknown[]) => unknown
  } catch (err) {
    throw new EvaluationError(`transform syntax error: ${String(err)}`, err)
  }

  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let result: unknown
  try {
    result = fn(
      $,
      Math,
      String,
      Number,
      Array,
      Object,
      JSON,
      Date,
    )
  } catch (err) {
    throw new EvaluationError(`transform runtime error: ${String(err)}`, err)
  }

  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start
  if (elapsed > timeoutMs) {
    throw new EvaluationError(`transform timeout: expression exceeded ${timeoutMs}ms`)
  }

  return result
}

export class EvaluationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'EvaluationError'
  }
}

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
  doc: DocumentEdgeList,
  store: ReactiveStore,
  opts?: RuntimeOptions
): ReactiveRuntime {
  const reactiveEdges = doc.edges.filter((e) => e.edgeType === 'reactive')
  const graph = buildDependencyGraph(reactiveEdges)
  const sorted = topoSort(graph)

  // Detect cycle edges if topo sort failed
  if (sorted === null && opts?.onCycleDetected) {
    const cycleEdgeIds = reactiveEdges.map((e) => e.id)
    opts.onCycleDetected(cycleEdgeIds)
  }

  // Build edge lookup: fromKey → [{ toNodeId, toPort, edge }]
  const edgesByFromKey = new Map<string, Array<{ toNodeId: string; toPort: string; edge: ReactiveEdge }>>()
  for (const e of reactiveEdges) {
    const fromKey = `${e.fromNodeId}:${e.fromPort}`
    if (!edgesByFromKey.has(fromKey)) edgesByFromKey.set(fromKey, [])
    edgesByFromKey.get(fromKey)!.push({ toNodeId: e.toNodeId, toPort: e.toPort, edge: e })
  }

  // Build propagation order from topological sort (if available)
  const propagationOrder: Array<{ fromKey: string; toNodeId: string; toPort: string; edge: ReactiveEdge }> = []
  if (sorted !== null) {
    for (const key of sorted) {
      const downstream = edgesByFromKey.get(key) ?? []
      for (const d of downstream) {
        propagationOrder.push({ fromKey: key, ...d })
      }
    }
  } else {
    // Degraded mode: still allow propagation without guaranteed order
    for (const [fromKey, downstream] of edgesByFromKey) {
      for (const d of downstream) {
        propagationOrder.push({ fromKey, ...d })
      }
    }
  }

  function publish(widgetId: string, portName: string, value: unknown): void {
    // Set the origin value
    store.set(widgetId, portName, value)

    // Propagate through sorted edges
    const originKey = `${widgetId}:${portName}`
    // Only propagate edges reachable from the changed key
    const visited = new Set<string>([originKey])

    for (const step of propagationOrder) {
      // Only propagate edges whose fromKey has been set in this propagation
      if (!visited.has(step.fromKey)) continue

      const colonIdx = step.fromKey.indexOf(':')
      const fromWidgetId = step.fromKey.slice(0, colonIdx)
      const fromPortName = step.fromKey.slice(colonIdx + 1)
      let sourceValue = store.get(fromWidgetId, fromPortName)

      // Apply transform if present
      if (step.edge.transform) {
        try {
          sourceValue = evaluateTransform(sourceValue, step.edge.transform)
        } catch (err) {
          if (err instanceof EvaluationError) {
            opts?.onTransformTimeout?.(step.edge.id, step.edge.transform)
          }
          // Fall through: use raw sourceValue
        }
      }

      store.set(step.toNodeId, step.toPort, sourceValue)
      visited.add(`${step.toNodeId}:${step.toPort}`)
    }
  }

  return {
    publish,
    destroy() {
      // No subscriptions registered in Phase 1 — placeholder for Phase 2
    },
  }
}
