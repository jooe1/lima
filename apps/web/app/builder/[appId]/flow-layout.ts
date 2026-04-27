import { type AuraDocumentV2 } from '@lima/aura-dsl'

const START_X = 50
const START_Y = 80
const LAYER_GAP = 300
const NODE_GAP = 160

/**
 * computeFlowLayout derives React Flow node positions from graph topology.
 *
 * Algorithm (layered DAG):
 *   Layer 0: widget trigger nodes — widgets with at least one outgoing async edge
 *            and no incoming async edges. If none found, use all non-step widgets.
 *   Layer 1..N: step nodes in topological order following async edges.
 *   Final layer: widget sink nodes — widgets with only incoming reactive edges from steps,
 *               or widgets with no edges at all.
 *
 * Layout:
 *   - Each layer is a column.
 *   - Within a layer, nodes are stacked vertically with 160px spacing.
 *   - Layers are separated by 300px horizontally.
 *   - Total layout starts at x=50, y=80.
 *
 * Manual position overrides: if a node already has style.flowX / style.flowY set,
 * its position is preserved exactly (not overridden by auto-layout).
 *
 * Returns a Map<nodeId, { x: number, y: number }>.
 */
export function computeFlowLayout(doc: AuraDocumentV2): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()

  const asyncEdges = doc.edges.filter(e => e.edgeType === 'async')
  const reactiveEdges = doc.edges.filter(e => e.edgeType === 'reactive')

  // Build async adjacency maps
  const outgoingAsyncTargets = new Map<string, Set<string>>()
  const incomingAsyncSources = new Map<string, Set<string>>()
  for (const node of doc.nodes) {
    outgoingAsyncTargets.set(node.id, new Set())
    incomingAsyncSources.set(node.id, new Set())
  }
  for (const edge of asyncEdges) {
    outgoingAsyncTargets.get(edge.fromNodeId)?.add(edge.toNodeId)
    incomingAsyncSources.get(edge.toNodeId)?.add(edge.fromNodeId)
  }

  // Build reactive adjacency (incoming only, for sink detection)
  const incomingReactiveSources = new Map<string, Set<string>>()
  for (const node of doc.nodes) {
    incomingReactiveSources.set(node.id, new Set())
  }
  for (const edge of reactiveEdges) {
    incomingReactiveSources.get(edge.toNodeId)?.add(edge.fromNodeId)
  }

  const outgoingAsync = (id: string): Set<string> => outgoingAsyncTargets.get(id) ?? new Set()
  const incomingAsync = (id: string): Set<string> => incomingAsyncSources.get(id) ?? new Set()
  const incomingReactive = (id: string): Set<string> => incomingReactiveSources.get(id) ?? new Set()
  const hasAnyEdge = (id: string): boolean =>
    doc.edges.some(e => e.fromNodeId === id || e.toNodeId === id)

  const stepNodes = doc.nodes.filter(n => n.element.startsWith('step:'))
  const nonStepNodes = doc.nodes.filter(n => !n.element.startsWith('step:'))

  const triggerWidgets = nonStepNodes.filter(
    n => outgoingAsync(n.id).size > 0 && incomingAsync(n.id).size === 0,
  )
  const triggerWidgetIds = new Set(triggerWidgets.map(n => n.id))

  const sinkWidgets = nonStepNodes.filter(
    n =>
      !triggerWidgetIds.has(n.id) &&
      incomingAsync(n.id).size === 0 &&
      outgoingAsync(n.id).size === 0 &&
      (incomingReactive(n.id).size > 0 || !hasAnyEdge(n.id)),
  )
  const sinkWidgetIds = new Set(sinkWidgets.map(n => n.id))

  const intermediateWidgets = nonStepNodes.filter(
    n => !triggerWidgetIds.has(n.id) && !sinkWidgetIds.has(n.id),
  )

  // BFS to assign topological distances to step nodes reachable from triggers
  const stepDistances = new Map<string, number>()
  if (triggerWidgets.length > 0) {
    const queue: Array<{ id: string; distance: number }> = []

    for (const trigger of triggerWidgets) {
      for (const targetId of outgoingAsync(trigger.id)) {
        const target = doc.nodes.find(n => n.id === targetId)
        if (target?.element.startsWith('step:') && !stepDistances.has(targetId)) {
          stepDistances.set(targetId, 1)
          queue.push({ id: targetId, distance: 1 })
        }
      }
    }

    while (queue.length > 0) {
      const { id, distance } = queue.shift()!
      for (const targetId of outgoingAsync(id)) {
        const target = doc.nodes.find(n => n.id === targetId)
        if (target?.element.startsWith('step:') && !stepDistances.has(targetId)) {
          stepDistances.set(targetId, distance + 1)
          queue.push({ id: targetId, distance: distance + 1 })
        }
      }
    }
  }

  const unreachedSteps = stepNodes.filter(n => !stepDistances.has(n.id))

  // Assemble layers
  const layers: string[][] = []

  if (triggerWidgets.length > 0) {
    // Layer 0: trigger widgets
    layers.push(triggerWidgets.map(n => n.id))

    // Layers 1..N: step nodes grouped by BFS distance
    const maxDist = stepDistances.size > 0 ? Math.max(...stepDistances.values()) : 0
    for (let d = 1; d <= maxDist; d++) {
      const group = stepNodes.filter(n => stepDistances.get(n.id) === d).map(n => n.id)
      if (group.length > 0) layers.push(group)
    }

    // Unreached step nodes go after reached steps
    if (unreachedSteps.length > 0) {
      layers.push(unreachedSteps.map(n => n.id))
    }

    // Final layer: sink + intermediate widgets
    const finalLayer = [...sinkWidgets, ...intermediateWidgets].map(n => n.id)
    if (finalLayer.length > 0) layers.push(finalLayer)
  } else {
    // No trigger widgets: all non-step nodes in layer 0
    layers.push(nonStepNodes.map(n => n.id))

    // Step nodes go to a subsequent layer
    if (stepNodes.length > 0) {
      layers.push(stepNodes.map(n => n.id))
    }
  }

  // Assign positions from layers
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx]
    const x = START_X + layerIdx * LAYER_GAP
    for (let posIdx = 0; posIdx < layer.length; posIdx++) {
      const nodeId = layer[posIdx]
      const node = doc.nodes.find(n => n.id === nodeId)
      // Preserve manual overrides
      if (node?.style?.flowX !== undefined && node?.style?.flowY !== undefined) {
        positions.set(nodeId, {
          x: parseFloat(node.style.flowX),
          y: parseFloat(node.style.flowY),
        })
      } else {
        positions.set(nodeId, { x, y: START_Y + posIdx * NODE_GAP })
      }
    }
  }

  return positions
}
