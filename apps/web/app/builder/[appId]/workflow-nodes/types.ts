import type { Node, Edge } from '@xyflow/react'
import type { WorkflowStepType } from '../../../../lib/api'

export type WFNodeType = 'start' | 'query' | 'mutation' | 'condition' | 'approval_gate' | 'notification' | 'end'

export interface WFNodeData extends Record<string, unknown> {
  label: string
  stepType?: WorkflowStepType
  stepId?: string      // undefined for start/end pseudo-nodes
  config?: Record<string, unknown>
  aiGenerated?: boolean
  reviewed?: boolean
}

export type WFNode = Node<WFNodeData, WFNodeType>
export type WFEdge = Edge
