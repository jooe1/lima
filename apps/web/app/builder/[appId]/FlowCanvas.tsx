'use client'

import React, { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  type OnNodesDelete,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WIDGET_REGISTRY, STEP_NODE_REGISTRY, type WidgetType, type StepNodeType } from '@lima/widget-catalog'
import { type AuraDocumentV2, type AuraNode, type ReactiveStore } from '@lima/aura-dsl'

// ---- Types -----------------------------------------------------------------

export interface FlowCanvasProps {
  doc: AuraDocumentV2
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (doc: AuraDocumentV2) => void
  workspaceId: string
  reactiveStore: ReactiveStore
  onAddWidget?: (element: string) => void
}

interface WidgetNodeData extends Record<string, unknown> {
  auraNode: AuraNode
  displayName: string
  element: string
}

// ---- Pure conversion helpers (exported for tests) --------------------------

/**
 * Convert a V2 document into React Flow nodes.
 * Widget nodes → type 'widgetNode', positioned from flowX/Y or derived from grid coords.
 * Step nodes (element starts with 'step:') → type matching element, positioned from flowX/Y.
 * Flow:group nodes → type 'group', positioned from flowX/Y with explicit size.
 */
export function docV2ToFlowNodes(doc: AuraDocumentV2): Node[] {
  return doc.nodes.map((node, index) => {
    const hasFlowPos = node.style?.flowX !== undefined && node.style?.flowY !== undefined

    if (node.element === 'flow:group') {
      return {
        id: node.id,
        type: 'group',
        position: {
          x: hasFlowPos ? parseFloat(node.style!.flowX!) : 0,
          y: hasFlowPos ? parseFloat(node.style!.flowY!) : index * 200,
        },
        style: {
          width: node.style?.flowW ? parseFloat(node.style.flowW) : 400,
          height: node.style?.flowH ? parseFloat(node.style.flowH) : 300,
          border: '2px dashed #3b82f6',
          borderRadius: 8,
          background: 'rgba(29,78,216,0.05)',
        },
        data: { label: node.text ?? 'Flow Group' },
      } satisfies Node
    }

    if (node.element.startsWith('step:')) {
      const x = hasFlowPos ? parseFloat(node.style!.flowX!) : 900
      const y = hasFlowPos ? parseFloat(node.style!.flowY!) : index * 160
      return {
        id: node.id,
        type: node.element,
        position: { x, y },
        parentId: node.style?.parentGroupId,
        extent: node.style?.parentGroupId ? 'parent' : undefined,
        data: {
          label: node.id,
          auraNode: node,
          stepType: node.element,
          connected: true, // will be overridden in FlowCanvas render
        },
      } satisfies Node
    }

    // Widget node
    const gx = parseInt(node.style?.gridX ?? '0', 10) || 0
    const gy = parseInt(node.style?.gridY ?? '0', 10) || 0
    const x = hasFlowPos ? parseFloat(node.style!.flowX!) : gx * 60
    const y = hasFlowPos ? parseFloat(node.style!.flowY!) : gy * 60

    const meta = WIDGET_REGISTRY[node.element as WidgetType]
    return {
      id: node.id,
      type: 'widgetNode',
      position: { x, y },
      data: {
        auraNode: node,
        displayName: meta?.displayName ?? node.element,
        element: node.element,
      } satisfies WidgetNodeData,
    } satisfies Node
  })
}

/**
 * Convert V2 document edges into React Flow edges.
 * Reactive → blue animated smoothstep.
 * Async → orange dashed smoothstep.
 */
export function docV2ToFlowEdges(doc: AuraDocumentV2): Edge[] {
  return doc.edges.map(edge => {
    const isReactive = edge.edgeType === 'reactive'
    return {
      id: edge.id,
      source: edge.fromNodeId,
      sourceHandle: edge.fromPort,
      target: edge.toNodeId,
      targetHandle: edge.toPort,
      type: 'smoothstep',
      animated: isReactive,
      style: {
        stroke: isReactive ? '#3b82f6' : '#f97316',
        strokeWidth: 1.5,
        ...(isReactive ? {} : { strokeDasharray: '6 3' }),
      },
    } satisfies Edge
  })
}

// ---- Widget node custom component ------------------------------------------

function WidgetNodeComponent({ data, selected }: NodeProps) {
  const wData = data as WidgetNodeData
  const meta = WIDGET_REGISTRY[wData.element as WidgetType]
  const ports = meta?.ports ?? []
  const inputPorts = ports.filter(p => p.direction === 'input')
  const outputPorts = ports.filter(p => p.direction === 'output')

  return (
    <div style={{
      width: 220,
      minHeight: 130,
      background: '#111',
      border: selected ? '2px solid #3b82f6' : '1px solid #2a2a2a',
      borderRadius: 6,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={{ fontSize: '0.55rem', color: '#3b82f6', fontFamily: 'monospace' }}>
          {wData.element}
        </span>
        <span style={{ fontSize: '0.7rem', color: '#e5e5e5', fontWeight: 600, flex: 1 }}>
          {wData.displayName}
        </span>
      </div>

      {/* ID */}
      <div style={{ padding: '4px 10px', fontSize: '0.65rem', color: '#555', borderBottom: '1px solid #111' }}>
        {wData.auraNode.id}
      </div>

      {/* Port columns */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '4px 0' }}>
        {/* Input ports on the left */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
          {inputPorts.map(port => (
            <div key={port.name} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
              <Handle
                type="target"
                position={Position.Left}
                id={port.name}
                style={{ width: 8, height: 8, background: '#3b82f6', border: '1px solid #2a2a2a', left: -4 }}
              />
              <span style={{ fontSize: '0.55rem', color: '#666', marginLeft: 6 }}>{port.name}</span>
            </div>
          ))}
        </div>

        {/* Output ports on the right */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0', alignItems: 'flex-end' }}>
          {outputPorts.map(port => (
            <div key={port.name} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
              <span style={{ fontSize: '0.55rem', color: '#666', marginRight: 6 }}>{port.name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.name}
                style={{ width: 8, height: 8, background: '#f97316', border: '1px solid #2a2a2a', right: -4 }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---- Accent colors per step type -------------------------------------------

const STEP_ACCENT: Record<string, string> = {
  'step:query':         '#3b82f6',
  'step:mutation':      '#fb923c',
  'step:condition':     '#facc15',
  'step:approval_gate': '#a78bfa',
  'step:notification':  '#34d399',
  'step:transform':     '#e879f9',
  'step:http':          '#38bdf8',
}

// ---- Unified step node component -------------------------------------------

interface StepNodeData extends Record<string, unknown> {
  auraNode: AuraNode
  stepType: string
  connected: boolean
}

function StepNodeComponent({ data, selected }: NodeProps) {
  const sData = data as StepNodeData
  const meta = STEP_NODE_REGISTRY[sData.stepType as StepNodeType]
  const accent = STEP_ACCENT[sData.stepType] ?? '#555'
  const ports = meta?.ports ?? []
  const inputPorts = ports.filter(p => p.direction === 'input')
  const outputPorts = ports.filter(p => p.direction === 'output')

  // Config summary
  const w = sData.auraNode?.with ?? {}
  let configSummary = 'Not configured'
  if (sData.stepType === 'step:query' || sData.stepType === 'step:mutation') {
    const sql = w.sql as string | undefined
    const conn = w.connector as string | undefined
    if (sql) configSummary = sql.slice(0, 40) + (sql.length > 40 ? '\u2026' : '')
    else if (conn) configSummary = `connector: ${conn}`
  } else if (sData.stepType === 'step:condition') {
    const expr = w.expression as string | undefined
    if (expr) configSummary = expr.slice(0, 40) + (expr.length > 40 ? '\u2026' : '')
  } else if (sData.stepType === 'step:notification') {
    const msg = w.message as string | undefined
    if (msg) configSummary = msg.slice(0, 40) + (msg.length > 40 ? '\u2026' : '')
  } else if (sData.stepType === 'step:transform') {
    const expr = w.expression as string | undefined
    if (expr) configSummary = expr.slice(0, 40) + (expr.length > 40 ? '\u2026' : '')
  } else if (sData.stepType === 'step:http') {
    const url = w.url as string | undefined
    const method = (w.method as string | undefined) ?? 'GET'
    if (url) configSummary = `${method} ${url.slice(0, 28)}`
  } else if (sData.stepType === 'step:approval_gate') {
    configSummary = 'Awaits admin approval'
  }

  const sideW = selected ? '2px' : '1px'
  const topRightBottomColor = selected ? accent : !sData.connected ? '#fbbf24' : '#2a2a2a'

  return (
    <div style={{
      width: 220,
      minHeight: 60,
      background: '#111',
      borderTop: `${sideW} solid ${topRightBottomColor}`,
      borderRight: `${sideW} solid ${topRightBottomColor}`,
      borderBottom: `${sideW} solid ${topRightBottomColor}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 6,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '5px 10px',
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={{ fontSize: '0.55rem', color: accent, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {sData.stepType.replace('step:', '')}
        </span>
        <span style={{ fontSize: '0.7rem', color: '#e5e5e5', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sData.auraNode?.text ?? meta?.displayName ?? sData.stepType}
        </span>
        {!sData.connected && (
          <span title="No edges connected" style={{ fontSize: '0.6rem', color: '#fbbf24' }}>⚠</span>
        )}
      </div>

      {/* ID row */}
      <div style={{ padding: '2px 10px', fontSize: '0.55rem', color: '#333', borderBottom: '1px solid #111', fontFamily: 'monospace' }}>
        {sData.auraNode?.id}
      </div>

      {/* Config summary */}
      <div style={{ padding: '3px 10px', fontSize: '0.6rem', color: '#444', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {configSummary}
      </div>

      {/* Port columns */}
      {(inputPorts.length > 0 || outputPorts.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '4px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {inputPorts.map(port => (
              <div key={port.name} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={port.name}
                  style={{ width: 8, height: 8, background: accent, border: '1px solid #2a2a2a', left: -4, opacity: 0.8 }}
                />
                <span style={{ fontSize: '0.55rem', color: '#555', marginLeft: 6 }}>{port.name}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {outputPorts.map(port => (
              <div key={port.name} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
                <span style={{ fontSize: '0.55rem', color: '#555', marginRight: 6 }}>{port.name}</span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={port.name}
                  style={{ width: 8, height: 8, background: accent, border: '1px solid #2a2a2a', right: -4 }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Static nodeTypes map ---------------------------------------------------

// All step types map to the unified StepNodeComponent
const STEP_NODE_TYPES = Object.fromEntries(
  Object.keys(STEP_NODE_REGISTRY).map(k => [k, StepNodeComponent as unknown as NodeTypes[string]])
)

const NODE_TYPES: NodeTypes = {
  widgetNode: WidgetNodeComponent,
  ...STEP_NODE_TYPES,
}

// ---- Pure helper: build a flow group from selected step nodes ---------------

export function buildGroupFromStepSelection(
  selectedStepNodes: AuraNode[],
  padding = 40,
): { groupNode: AuraNode; updatedStepNodes: AuraNode[] } {
  const NODE_W = 200
  const NODE_H = 80

  const xs = selectedStepNodes.map(n => parseFloat(n.style?.flowX ?? '0'))
  const ys = selectedStepNodes.map(n => parseFloat(n.style?.flowY ?? '0'))
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)

  const gx = minX - padding
  const gy = minY - padding
  const gw = maxX - minX + 2 * padding + NODE_W
  const gh = maxY - minY + 2 * padding + NODE_H

  const groupId = `group-${crypto.randomUUID().slice(0, 6)}`

  const groupNode: AuraNode = {
    element: 'flow:group',
    id: groupId,
    parentId: 'root',
    text: 'New Flow Group',
    style: {
      flowX: String(gx),
      flowY: String(gy),
      flowW: String(gw),
      flowH: String(gh),
    },
  }

  const updatedStepNodes: AuraNode[] = selectedStepNodes.map(n => ({
    ...n,
    style: {
      ...(n.style ?? {}),
      flowX: String(parseFloat(n.style?.flowX ?? '0') - gx),
      flowY: String(parseFloat(n.style?.flowY ?? '0') - gy),
      parentGroupId: groupId,
    },
  }))

  return { groupNode, updatedStepNodes }
}

// ---- Helper: stamp connected flag on step nodes ----------------------------

function applyConnected(nodes: Node[], connectedSet: Set<string>): Node[] {
  return nodes.map(n =>
    String(n.type ?? '').startsWith('step:')
      ? { ...n, data: { ...n.data, connected: connectedSet.has(n.id) } }
      : n
  )
}

// ---- Inner component (needs ReactFlowProvider in parent) --------------------

function FlowCanvasInner({ doc, selectedId, onSelect, onChange, workspaceId: _workspaceId, reactiveStore: _reactiveStore, onAddWidget }: FlowCanvasProps) {
  // Suppress unused param linting — will be used in C8
  void _workspaceId
  void _reactiveStore

  const rfInstance = useReactFlow()

  const [selectedStepNodeIds, setSelectedStepNodeIds] = useState<string[]>([])

  const connectedNodeIds = useMemo(
    () => new Set([...doc.edges.map(e => e.fromNodeId), ...doc.edges.map(e => e.toNodeId)]),
    [doc.edges],
  )

  const initialNodes = useMemo(() => applyConnected(docV2ToFlowNodes(doc), connectedNodeIds), []) // eslint-disable-line react-hooks/exhaustive-deps
  const initialEdges = useMemo(() => docV2ToFlowEdges(doc), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(initialNodes)
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync from doc changes (e.g. undo/redo or external changes)
  React.useEffect(() => {
    setRfNodes(applyConnected(docV2ToFlowNodes(doc), new Set([
      ...doc.edges.map(e => e.fromNodeId),
      ...doc.edges.map(e => e.toNodeId),
    ])))
    setRfEdges(docV2ToFlowEdges(doc))
  }, [doc, setRfNodes, setRfEdges])

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    const fromNode = doc.nodes.find(n => n.id === connection.source)
    const toNode = doc.nodes.find(n => n.id === connection.target)
    const edgeType =
      (fromNode?.element.startsWith('step:') || toNode?.element.startsWith('step:'))
        ? 'async' as const
        : 'reactive' as const

    const newEdge = {
      id: `e_${crypto.randomUUID().slice(0, 8)}`,
      fromNodeId: connection.source!,
      fromPort: connection.sourceHandle ?? '',
      toNodeId: connection.target!,
      toPort: connection.targetHandle ?? '',
      edgeType,
    }

    setRfEdges(eds => addEdge({
      id: newEdge.id,
      source: newEdge.fromNodeId,
      sourceHandle: newEdge.fromPort,
      target: newEdge.toNodeId,
      targetHandle: newEdge.toPort,
      type: 'smoothstep',
      animated: edgeType === 'reactive',
      style: {
        stroke: edgeType === 'reactive' ? '#3b82f6' : '#f97316',
        strokeWidth: 1.5,
        ...(edgeType === 'reactive' ? {} : { strokeDasharray: '6 3' }),
      },
    }, eds))

    onChange({ ...doc, edges: [...doc.edges, newEdge] })
  }, [doc, onChange, setRfEdges])

  const onEdgesDelete: OnEdgesDelete = useCallback((deleted: Edge[]) => {
    const deletedIds = new Set(deleted.map(e => e.id))
    onChange({ ...doc, edges: doc.edges.filter(e => !deletedIds.has(e.id)) })
  }, [doc, onChange])

  const onNodeDragStop: OnNodeDrag = useCallback((_event, node) => {
    const updatedNodes = doc.nodes.map(n => {
      if (n.id !== node.id) return n
      return {
        ...n,
        style: {
          ...(n.style ?? {}),
          flowX: String(node.position.x),
          flowY: String(node.position.y),
        },
      }
    })
    onChange({ ...doc, nodes: updatedNodes })
  }, [doc, onChange])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const widgetType = e.dataTransfer.getData('widget-type')
    if (widgetType) {
      onAddWidget?.(widgetType)
      return
    }
    const stepType = e.dataTransfer.getData('application/reactflow/step')
    if (!stepType) return
    const pos = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const newNode: AuraNode = {
      element: stepType,
      id: `${stepType.replace(':', '-')}-${crypto.randomUUID().slice(0, 6)}`,
      parentId: 'root',
      style: { flowX: String(pos.x), flowY: String(pos.y) },
    }
    onChange({ ...doc, nodes: [...doc.nodes, newNode] })
  }, [doc, onChange, rfInstance, onAddWidget])

  const onSelectionChange: OnSelectionChangeFunc = useCallback(({ nodes: selNodes }) => {
    const stepIds = selNodes
      .map(n => n.id)
      .filter(id => {
        const aNode = doc.nodes.find(n => n.id === id)
        return aNode?.element.startsWith('step:') ?? false
      })
    setSelectedStepNodeIds(stepIds)
  }, [doc.nodes])

  const onNodesDelete: OnNodesDelete = useCallback((deleted: Node[]) => {
    const deletedIds = new Set(deleted.map(n => n.id))
    // When a group is deleted, remove its child step nodes and their edges too
    const groupIds = deleted.filter(n => n.type === 'group').map(n => n.id)
    const childStepIds = groupIds.length > 0
      ? new Set(doc.nodes.filter(n => groupIds.includes(n.style?.parentGroupId ?? '')).map(n => n.id))
      : new Set<string>()
    const allRemovedIds = new Set([...deletedIds, ...childStepIds])
    const nextNodes = doc.nodes.filter(n => !allRemovedIds.has(n.id))
    const nextEdges = doc.edges.filter(e => !allRemovedIds.has(e.fromNodeId) && !allRemovedIds.has(e.toNodeId))
    onChange({ nodes: nextNodes, edges: nextEdges })
  }, [doc, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'g') {
      e.preventDefault()
      if (selectedStepNodeIds.length < 2) return
      const selectedAuraNodes = doc.nodes.filter(n => selectedStepNodeIds.includes(n.id))
      const { groupNode, updatedStepNodes } = buildGroupFromStepSelection(selectedAuraNodes)
      const updatedNodeIds = new Set(updatedStepNodes.map(n => n.id))
      const unchanged = doc.nodes.filter(n => !updatedNodeIds.has(n.id) && n.element !== 'flow:group' || !updatedNodeIds.has(n.id) && n.element === 'flow:group')
      onChange({ ...doc, nodes: [...unchanged.filter(n => !updatedNodeIds.has(n.id)), ...updatedStepNodes, groupNode] })
    }
  }, [doc, onChange, selectedStepNodeIds])

  return (
    // tabIndex={0} so keydown handler catches Ctrl+G (C6) without attaching to window
    <div
      style={{ flex: 1, minHeight: 0, background: '#0a0a0a' }}
      tabIndex={0}
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onSelectionChange={onSelectionChange}
        onNodeClick={(_e, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        nodeTypes={NODE_TYPES}
        fitView
        style={{ background: '#0a0a0a' }}
        deleteKeyCode="Delete"
      >
        <Background color="#1a1a1a" gap={16} />
        <Controls />
        <MiniMap
          nodeColor={() => '#1a1a1a'}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: '#111', border: '1px solid #2a2a2a' }}
        />
      </ReactFlow>
    </div>
  )
}

// ---- Public component (wraps with provider) --------------------------------

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
