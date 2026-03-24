import type { Node, Edge } from '@xyflow/react'
import type { WorkflowStepType } from '../../../../lib/api'
import type { OutputPortDrag } from '../PortTray'

export type WFNodeType = 'start' | 'query' | 'mutation' | 'condition' | 'approval_gate' | 'notification' | 'end'

export interface WFNodeData extends Record<string, unknown> {
  label: string
  stepType?: WorkflowStepType
  stepId?: string      // undefined for start/end pseudo-nodes
  config?: Record<string, unknown>
  aiGenerated?: boolean
  reviewed?: boolean
  /** Active widget → port bindings for this step */
  inputBindings?: Record<string, { widgetId: string; portName: string; widgetLabel: string }>
  onBindingDropped?: (args: { portDrag: OutputPortDrag; stepId: string }) => void
  onBindingRemoved?: (args: { key: string; stepId: string }) => void
}

export type WFNode = Node<WFNodeData, WFNodeType>
export type WFEdge = Edge
