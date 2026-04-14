import type { AuraEdge, ReactiveStore } from '@lima/aura-dsl'
import type { AppSSEEvent } from './hooks/useAppSSE'

/**
 * Applies reactive store writes for a `workflow_run_update` SSE event.
 * Exported for unit testing without mounting the full page.
 */
export function processRunEvent(
  event: AppSSEEvent,
  edges: AuraEdge[],
  store: ReactiveStore,
): { triggerNodeId: string | null } {
  const d = event.data as { status?: string; step_id?: string; output?: Record<string, unknown> }

  if (d.status === 'step_completed' && d.step_id && d.output) {
    const outEdges = edges.filter(e => e.fromNodeId === d.step_id && e.edgeType === 'async')
    for (const edge of outEdges) {
      const value = d.output[edge.fromPort] ?? d.output
      store.set(edge.toNodeId, edge.toPort, value)
    }
  }

  if (d.status === 'failed' && d.step_id) {
    const triggerEdge = edges.find(e => e.toNodeId === d.step_id && e.edgeType === 'async')
    if (triggerEdge) return { triggerNodeId: triggerEdge.fromNodeId }
  }

  return { triggerNodeId: null }
}
