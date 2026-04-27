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
// @ts-ignore -- Next bundles this global stylesheet; the editor lacks a declaration for the side-effect import.
import '@xyflow/react/dist/style.css'
import { WIDGET_REGISTRY, STEP_NODE_REGISTRY, expandWidgetPorts, type WidgetType, type StepNodeType } from '@lima/widget-catalog'
import { type AuraDocumentV2, type AuraNode, type ReactiveStore, type AuraEdge } from '@lima/aura-dsl'
import { tryParseSQL, defaultGuided, sqlFromGuided } from './stepSqlUtils'
import { computeFlowLayout } from './flow-layout'

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
  /** Buttons that have `formRef` pointing to this widget (only populated for form nodes). */
  attachedButtons?: AuraNode[]
}

// ---- Pure conversion helpers (exported for tests) --------------------------

/**
 * Convert a V2 document into React Flow nodes.
 * Widget nodes → type 'widgetNode', positioned from flowX/Y or derived from grid coords.
 * Step nodes (element starts with 'step:') → type matching element, positioned from flowX/Y.
 * Flow:group nodes → type 'group', positioned from flowX/Y with explicit size.
 */
export function docV2ToFlowNodes(doc: AuraDocumentV2): Node[] {
  // Buttons with formRef are absorbed into their form node — no standalone flow node
  const absorbedButtonIds = new Set(
    doc.nodes.filter(n => n.element === 'button' && n.formRef).map(n => n.id),
  )

  const computedPositions = computeFlowLayout(doc)

  return doc.nodes.filter(node => !absorbedButtonIds.has(node.id)).map((node, index) => {
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
      const x = hasFlowPos ? parseFloat(node.style!.flowX!) : (computedPositions.get(node.id)?.x ?? 900)
      const y = hasFlowPos ? parseFloat(node.style!.flowY!) : (computedPositions.get(node.id)?.y ?? index * 160)
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
    const x = hasFlowPos ? parseFloat(node.style!.flowX!) : (computedPositions.get(node.id)?.x ?? gx * 60)
    const y = hasFlowPos ? parseFloat(node.style!.flowY!) : (computedPositions.get(node.id)?.y ?? gy * 60)

    const meta = WIDGET_REGISTRY[node.element as WidgetType]
    const data: WidgetNodeData = {
      auraNode: node,
      displayName: meta?.displayName ?? node.element,
      element: node.element,
    }
    if (node.element === 'form') {
      data.attachedButtons = doc.nodes.filter(n => n.element === 'button' && n.formRef === node.id)
    }
    return {
      id: node.id,
      type: 'widgetNode',
      position: { x, y },
      data,
    } satisfies Node
  })
}

/**
 * Convert V2 document edges into React Flow edges.
 * Reactive → blue animated smoothstep.
 * Async → orange dashed smoothstep.
 * Binding → purple dashed (drag-to-wire data bindings).
 */
export function docV2ToFlowEdges(doc: AuraDocumentV2): Edge[] {
  // Build map: absorbed button ID -> its form node ID
  const absorbedToForm = new Map<string, string>()
  for (const node of doc.nodes) {
    if (node.element === 'button' && node.formRef) {
      absorbedToForm.set(node.id, node.formRef)
    }
  }

  return doc.edges.map(edge => {
    // Remap edges that touch an absorbed button to use the form node
    // with a compound handle ID: `btn:<buttonId>:<portName>`
    const fromNodeId = absorbedToForm.has(edge.fromNodeId) ? absorbedToForm.get(edge.fromNodeId)! : edge.fromNodeId
    const fromPort   = absorbedToForm.has(edge.fromNodeId) ? `btn:${edge.fromNodeId}:${edge.fromPort}` : edge.fromPort
    const toNodeId   = absorbedToForm.has(edge.toNodeId)   ? absorbedToForm.get(edge.toNodeId)!   : edge.toNodeId
    const toPort     = absorbedToForm.has(edge.toNodeId)   ? `btn:${edge.toNodeId}:${edge.toPort}` : edge.toPort

    const isReactive = edge.edgeType === 'reactive'
    const isBinding  = edge.edgeType === 'binding'
    return {
      id: edge.id,
      source: fromNodeId,
      sourceHandle: fromPort,
      target: toNodeId,
      targetHandle: toPort,
      type: 'smoothstep',
      animated: isReactive,
      style: {
        stroke: isReactive ? '#3b82f6' : isBinding ? '#a78bfa' : '#f97316',
        strokeWidth: isBinding ? 1 : 1.5,
        strokeDasharray: isBinding ? '4 3' : isReactive ? undefined : '6 3',
        opacity: isBinding ? 0.7 : 1,
      },
    } satisfies Edge
  })
}

function getExpandedOutputPortDataType(node: AuraNode | undefined, handleName: string | null | undefined): string | undefined {
  if (!node || !handleName) return undefined

  if (node.element.startsWith('step:')) {
    return STEP_NODE_REGISTRY[node.element as StepNodeType]?.ports.find(
      port => port.direction === 'output' && port.name === handleName,
    )?.dataType
  }

  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  const ports = expandWidgetPorts({ ...(node.style ?? {}), ...(node.with ?? {}) }, meta?.ports ?? [])
  return ports.find(port => port.direction === 'output' && port.name === handleName)?.dataType
}

function isBindableSqlValueType(dataType: string | undefined): boolean {
  return Boolean(dataType) && dataType !== 'array' && dataType !== 'object' && dataType !== 'trigger'
}

function slotKeyFromHandle(handle: string): string {
  return handle.replace(/^bind:/, 'slot.').replace(':', '.')
}

function slotTokenFromHandle(handle: string): string {
  return `{{${slotKeyFromHandle(handle)}}}`
}

function getSlotColumnName(node: AuraNode | undefined, handle: string): string | undefined {
  if (!node?.with?.sql) return undefined

  const parts = handle.split(':')
  if (parts.length !== 3) return undefined

  const slotType = parts[1] as 'set' | 'where'
  const slotIdx = parseInt(parts[2], 10)
  if (Number.isNaN(slotIdx)) return undefined

  const guided = tryParseSQL(String(node.with.sql), node.element === 'step:query')
  if (!guided) return undefined

  return slotType === 'set'
    ? guided.setClauses[slotIdx]?.col
    : guided.whereClauses[slotIdx]?.col
}

function getBindableFieldNames(node: AuraNode | undefined): string[] {
  if (!node) return []

  const raw = String(node.with?.fields ?? node.style?.fields ?? '')
  return raw.split(',').map((field: string) => field.trim()).filter(Boolean)
}

export function migrateLegacyBindingTokens(doc: AuraDocumentV2): AuraDocumentV2 {
  const nextEdges = doc.edges.map(edge => {
    if (edge.edgeType !== 'binding' || edge.fromPort !== '*') return edge

    const sourceNode = doc.nodes.find(node => node.id === edge.fromNodeId)
    const targetNode = doc.nodes.find(node => node.id === edge.toNodeId)
    const slotColumn = getSlotColumnName(targetNode, edge.toPort)
    if (!slotColumn) return edge

    const availableFields = getBindableFieldNames(sourceNode)
    if (!availableFields.includes(slotColumn)) return edge

    return { ...edge, fromPort: slotColumn }
  })

  const nextNodes = doc.nodes.map(node => {
    const sql = typeof node.with?.sql === 'string' ? node.with.sql : ''
    if (!sql) return node

    const relevantEdges = nextEdges.filter(edge => edge.edgeType === 'binding' && edge.toNodeId === node.id)
    if (relevantEdges.length === 0) return node

    let nextSql = sql
    for (const edge of relevantEdges) {
      const legacyToken = `{{${edge.fromNodeId}.${edge.fromPort}}}`
      nextSql = nextSql.split(legacyToken).join(slotTokenFromHandle(edge.toPort))
    }

    if (nextSql === sql) return node
    return { ...node, with: { ...(node.with ?? {}), sql: nextSql } }
  })

  return { ...doc, nodes: nextNodes, edges: nextEdges }
}

export interface BindingValidationIssue {
  severity: 'error' | 'warning'
  nodeId: string
  message: string
}

export function validateBindings(doc: AuraDocumentV2): BindingValidationIssue[] {
  const issues: BindingValidationIssue[] = []

  for (const node of doc.nodes) {
    if (node.element !== 'step:mutation') continue

    const sql = typeof node.with?.sql === 'string' ? node.with.sql : ''
    if (!sql) continue

    const referencedSlots = new Set(
      Array.from(sql.matchAll(/\{\{(slot\.(set|where)\.\d+)\}\}/g), match => match[1]),
    )
    const bindingEdges = doc.edges.filter(edge => edge.edgeType === 'binding' && edge.toNodeId === node.id)
    const boundSlots = new Set(bindingEdges.map(edge => slotKeyFromHandle(edge.toPort)))

    for (const slot of referencedSlots) {
      if (!boundSlots.has(slot)) {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          message: `Mutation step ${node.id} has an unwired binding slot: ${slot}`,
        })
      }
    }

    if (bindingEdges.length > 0) {
      const hasRunTrigger = doc.edges.some(edge => edge.toNodeId === node.id && (edge.toPort === 'run' || edge.edgeType === 'async'))
      if (!hasRunTrigger) {
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          message: `Mutation step ${node.id} has bindings but no run trigger edge.`,
        })
      }
    }
  }

  return issues
}

// ---- Widget node custom component ------------------------------------------

function WidgetNodeComponent({ data, selected }: NodeProps) {
  const wData = data as WidgetNodeData
  const meta = WIDGET_REGISTRY[wData.element as WidgetType]
  const [areFieldOutputsExpanded, setAreFieldOutputsExpanded] = useState(false)
  const [expandedInputPorts, setExpandedInputPorts] = useState<Map<string, boolean>>(new Map())
  const [expandedOutputPorts, setExpandedOutputPorts] = useState<Map<string, boolean>>(new Map())
  const [expandedButtonIds, setExpandedButtonIds] = useState<Set<string>>(new Set())
  const rawPorts = meta?.ports ?? []
  const ports = expandWidgetPorts({ ...(wData.auraNode.style ?? {}), ...(wData.auraNode.with ?? {}) }, rawPorts)
  const inputPorts = ports.filter(p => p.direction === 'input')
  const outputPorts = ports.filter(p => p.direction === 'output')
  const isFormWidget = wData.element === 'form'
  const visibleOutputPorts = isFormWidget
    ? outputPorts.filter(port => rawPorts.some(rawPort => rawPort.direction === 'output' && rawPort.name !== '*' && rawPort.name === port.name))
    : outputPorts
  const fieldOutputPorts = isFormWidget
    ? outputPorts.filter(port => !visibleOutputPorts.some(visiblePort => visiblePort.name === port.name))
    : []

  // Group input ports: for each expandable parent, collect its children
  const inputPortGroups = useMemo(() => {
    const groups: Array<{ parent: typeof inputPorts[0]; children: typeof inputPorts[0][] } | { parent: typeof inputPorts[0]; children: null }> = []
    for (const port of inputPorts) {
      if (port.name.includes('.')) continue // skip children, they're added via parent
      const children = inputPorts.filter(p => p.name.startsWith(`${port.name}.`))
      groups.push({ parent: port, children: children.length > 0 ? children : null })
    }
    return groups
  }, [inputPorts])

  // Group output ports: for each expandable parent (e.g. table.selectedRow), collect its children
  const outputPortGroups = useMemo(() => {
    const groups: Array<{ parent: typeof visibleOutputPorts[0]; children: typeof visibleOutputPorts[0][] | null }> = []
    for (const port of visibleOutputPorts) {
      if (port.name === '*') continue
      if (port.name.includes('.')) continue // skip children
      const children = visibleOutputPorts.filter(p => p.name.startsWith(`${port.name}.`))
      groups.push({ parent: port, children: children.length > 0 ? children : null })
    }
    return groups
  }, [visibleOutputPorts])

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
          {inputPortGroups.map(({ parent: port, children }) => {
            const isExpanded = expandedInputPorts.get(port.name) ?? false
            return (
              <React.Fragment key={port.name}>
                <div title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={port.name}
                    style={{
                      width: 8, height: 8,
                      background: '#3b82f6',
                      border: '1px solid #2a2a2a',
                      left: -4,
                      outline: port.dynamic ? '1.5px dashed #3b82f6' : 'none',
                      outlineOffset: '2px',
                    }}
                  />
                  <span style={{ fontSize: '0.65rem', color: '#888', marginLeft: 6 }}>
                    {port.name}{port.dynamic ? ' +' : ''}
                  </span>
                  <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginLeft: 3 }}>
                    {dataTypeBadge(port.dataType)}
                  </span>
                  {children && children.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedInputPorts(prev => {
                        const next = new Map(prev)
                        next.set(port.name, !isExpanded)
                        return next
                      })}
                      style={{
                        border: '1px solid #2a2a2a',
                        borderRadius: 999,
                        background: '#161616',
                        color: '#f5f5f5',
                        cursor: 'pointer',
                        fontSize: '0.55rem',
                        fontWeight: 600,
                        marginLeft: 4,
                        padding: '1px 5px',
                      }}
                    >
                      {isExpanded ? '▲' : `▼ ${children.length}`}
                    </button>
                  )}
                </div>
                {children && isExpanded && children.map(child => (
                  <div key={child.name} title={child.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 22 }}>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={child.name}
                      style={{
                        width: 7, height: 7,
                        background: '#6366f1',
                        border: '1px solid #2a2a2a',
                        left: -4,
                      }}
                    />
                    <span style={{ fontSize: '0.6rem', color: '#6b7280', marginLeft: 6 }}>
                      {child.name.split('.').pop()}
                    </span>
                    <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginLeft: 3 }}>
                      {dataTypeBadge(child.dataType)}
                    </span>
                  </div>
                ))}
              </React.Fragment>
            )
          })}
        </div>

        {/* Output ports on the right */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0', alignItems: 'flex-end' }}>
          {outputPortGroups.map(({ parent: port, children }) => {
            const isExpanded = expandedOutputPorts.get(port.name) ?? false
            return (
              <React.Fragment key={port.name}>
                <div title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
                  {children && children.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedOutputPorts(prev => {
                        const next = new Map(prev)
                        next.set(port.name, !isExpanded)
                        return next
                      })}
                      style={{
                        border: '1px solid #2a2a2a',
                        borderRadius: 999,
                        background: '#161616',
                        color: '#f5f5f5',
                        cursor: 'pointer',
                        fontSize: '0.55rem',
                        fontWeight: 600,
                        marginRight: 4,
                        padding: '1px 5px',
                      }}
                    >
                      {isExpanded ? '▲' : `▼ ${children.length}`}
                    </button>
                  )}
                  <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>
                    {dataTypeBadge(port.dataType)}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: '#888', marginRight: 6 }}>
                    {port.name}{port.dynamic ? ' +' : ''}
                  </span>
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={port.name}
                    style={{
                      width: 8, height: 8,
                      background: port.dataType === 'trigger' ? '#f59e0b' : '#f97316',
                      border: '1px solid #2a2a2a',
                      right: -4,
                      outline: port.dynamic ? `1.5px dashed ${port.dataType === 'trigger' ? '#f59e0b' : '#f97316'}` : 'none',
                      outlineOffset: '2px',
                    }}
                  />
                </div>
                {children && isExpanded && children.map(child => (
                  <div key={child.name} title={child.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 22 }}>
                    <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>
                      {dataTypeBadge(child.dataType)}
                    </span>
                    <span style={{ fontSize: '0.6rem', color: '#6b7280', marginRight: 6 }}>
                      {child.name.split('.').pop()}
                    </span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={child.name}
                      style={{
                        width: 7, height: 7,
                        background: '#6366f1',
                        border: '1px solid #2a2a2a',
                        right: -4,
                      }}
                    />
                  </div>
                ))}
              </React.Fragment>
            )
          })}
          {isFormWidget && fieldOutputPorts.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setAreFieldOutputsExpanded(expanded => !expanded)}
                style={{
                  border: '1px solid #2a2a2a',
                  borderRadius: 999,
                  background: '#161616',
                  color: '#f5f5f5',
                  cursor: 'pointer',
                  fontSize: '0.6rem',
                  fontWeight: 600,
                  marginRight: 10,
                  padding: '2px 8px',
                }}
              >
                Fields ({fieldOutputPorts.length})
              </button>
              {areFieldOutputsExpanded && (
                fieldOutputPorts.map(port => (
                  <div key={port.name} title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
                    <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>
                      {dataTypeBadge(port.dataType)}
                    </span>
                    <span style={{ fontSize: '0.65rem', color: '#888', marginRight: 6 }}>
                      {port.name}{port.dynamic ? ' +' : ''}
                    </span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={port.name}
                      style={{
                        width: 8, height: 8,
                        background: port.dataType === 'trigger' ? '#f59e0b' : '#f97316',
                        border: '1px solid #2a2a2a',
                        right: -4,
                        outline: port.dynamic ? `1.5px dashed ${port.dataType === 'trigger' ? '#f59e0b' : '#f97316'}` : 'none',
                        outlineOffset: '2px',
                      }}
                    />
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* Attached button sections — one per button linked via formRef */}
      {wData.attachedButtons && wData.attachedButtons.length > 0 && (
        <div style={{ borderTop: '1px solid #1a1a1a' }}>
          <div style={{ padding: '3px 10px 2px', fontSize: '0.55rem', color: '#7c3aed', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Attached buttons
          </div>
          {wData.attachedButtons.map((btn: AuraNode) => {
            const isExpanded = expandedButtonIds.has(btn.id)
            const btnLabel = btn.text ?? btn.id
            const scopedFields = btn.formFields ? btn.formFields.split(',').map((f: string) => f.trim()).filter(Boolean) : []
            const allFormFields = String(wData.auraNode.with?.fields ?? wData.auraNode.style?.fields ?? '')
              .split(',').map((f: string) => f.trim()).filter(Boolean)
            const displayFields = scopedFields.length > 0 ? scopedFields : allFormFields
            const btnMeta = WIDGET_REGISTRY['button']
            const btnPorts = btnMeta?.ports ?? []
            const btnInputPorts = btnPorts.filter(p => p.direction === 'input')
            const btnOutputPorts = btnPorts.filter(p => p.direction === 'output')
            return (
              <div key={btn.id} style={{ borderTop: '1px solid #111' }}>
                {/* Button header row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '3px 10px',
                    gap: 6,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onClick={() => setExpandedButtonIds(prev => {
                    const next = new Set(prev)
                    if (next.has(btn.id)) next.delete(btn.id)
                    else next.add(btn.id)
                    return next
                  })}
                >
                  <span style={{ fontSize: '0.6rem', color: '#a78bfa', fontWeight: 600 }}>◈</span>
                  <span style={{ fontSize: '0.65rem', color: '#d4d4d4', flex: 1 }}>{btnLabel}</span>
                  {btn.action && (
                    <span style={{ fontSize: '0.5rem', color: '#f59e0b', fontFamily: 'monospace' }}>wf</span>
                  )}
                  <span style={{ fontSize: '0.55rem', color: '#555' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
                {/* Expanded: port handles + optional scoped field list */}
                {isExpanded && (
                  <div style={{ paddingBottom: 4 }}>
                    {/* Port grid — mirrors the main widget port layout */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '2px 0' }}>
                        {btnInputPorts.map(port => (
                          <div key={port.name} title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
                            <Handle
                              type="target"
                              position={Position.Left}
                              id={`btn:${btn.id}:${port.name}`}
                              style={{ width: 7, height: 7, background: '#3b82f6', border: '1px solid #2a2a2a', left: -4 }}
                            />
                            <span style={{ fontSize: '0.6rem', color: '#888', marginLeft: 6 }}>{port.name}</span>
                            <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginLeft: 3 }}>{dataTypeBadge(port.dataType)}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '2px 0', alignItems: 'flex-end' }}>
                        {btnOutputPorts.map(port => (
                          <div key={port.name} title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
                            <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>{dataTypeBadge(port.dataType)}</span>
                            <span style={{ fontSize: '0.6rem', color: '#888', marginRight: 6 }}>{port.name}</span>
                            <Handle
                              type="source"
                              position={Position.Right}
                              id={`btn:${btn.id}:${port.name}`}
                              style={{ width: 7, height: 7, background: port.dataType === 'trigger' ? '#f59e0b' : '#f97316', border: '1px solid #2a2a2a', right: -4 }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Scoped field indicator */}
                    {displayFields.length > 0 && (
                      <div style={{ padding: '4px 10px 0 18px' }}>
                        <div style={{ fontSize: '0.5rem', color: '#555', marginBottom: 2 }}>
                          {scopedFields.length > 0 ? 'scoped fields:' : 'fields (all):'}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px' }}>
                          {displayFields.map((field: string) => (
                            <span key={field} style={{
                              fontSize: '0.55rem',
                              color: scopedFields.length > 0 ? '#a78bfa' : '#666',
                              fontFamily: 'monospace',
                            }}>{field}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {btn.action && (
                      <div style={{ padding: '3px 10px 0', fontSize: '0.5rem', color: '#f59e0b', fontFamily: 'monospace' }}>
                        → {btn.action}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- Accent colors per step type -------------------------------------------

const MUTATION_OP_LABEL: Record<string, string> = {
  insert: 'INSERT INTO',
  sehrupdate: 'UPDATE',
  delete: 'DELETE FROM',
}

const STEP_ACCENT: Record<string, string> = {
  'step:query':         '#3b82f6',
  'step:mutation':      '#fb923c',
  'step:condition':     '#facc15',
  'step:approval_gate': '#a78bfa',
  'step:notification':  '#34d399',
  'step:transform':     '#e879f9',
  'step:http':          '#38bdf8',
}

// Semantic output handle colors — override the per-step accent for ports whose
// name carries an unambiguous positive or negative meaning.
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
  failed:      '#f87171',
}

// Returns a short badge string representing a port data type.
const DATA_TYPE_BADGE_MAP: Record<string, string> = {
  trigger: '⚡',
  array:   '[]',
  object:  '{}',
  number:  '#',
  string:  '"',
  boolean: 'T/F',
  date:    '📅',
}
function dataTypeBadge(dataType: string): string {
  return DATA_TYPE_BADGE_MAP[dataType] ?? dataType.slice(0, 3)
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
  const emptyValueSlotHelperCopy = 'Drop field value here'
  const emptyFilterSlotHelperCopy = 'Drop filter field here'
  const [expandedInputPorts, setExpandedInputPorts] = useState<Map<string, boolean>>(new Map())
  const [expandedOutputPorts, setExpandedOutputPorts] = useState<Map<string, boolean>>(new Map())
  const allPorts = useMemo(
    () => expandWidgetPorts(sData.auraNode.with ?? {}, meta?.ports ?? []),
    [sData.auraNode.with, meta?.ports],
  )
  const inputPorts = allPorts.filter(p => p.direction === 'input')
  const outputPorts = allPorts.filter(p => p.direction === 'output')

  // Group input ports: for each expandable parent, collect its children
  const inputPortGroups = useMemo(() => {
    const groups: Array<{ parent: typeof inputPorts[0]; children: typeof inputPorts[0][] } | { parent: typeof inputPorts[0]; children: null }> = []
    for (const port of inputPorts) {
      if (port.name.includes('.')) continue // skip children, they're added via parent
      const children = inputPorts.filter(p => p.name.startsWith(`${port.name}.`))
      groups.push({ parent: port, children: children.length > 0 ? children : null })
    }
    return groups
  }, [inputPorts])

  // Group output ports: for each expandable parent, collect its children
  const outputPortGroups = useMemo(() => {
    const groups: Array<{ parent: typeof outputPorts[0]; children: typeof outputPorts[0][] | null }> = []
    for (const port of outputPorts) {
      if (port.name === '*') continue
      if (port.name.includes('.')) continue // skip children
      const children = outputPorts.filter(p => p.name.startsWith(`${port.name}.`))
      groups.push({ parent: port, children: children.length > 0 ? children : null })
    }
    return groups
  }, [outputPorts])

  // Config summary
  const w = sData.auraNode?.with ?? {}
  let configSummary = 'Not configured'
  if (sData.stepType === 'step:query') {
    const sql  = w.sql          as string | undefined
    const conn = w.connector_id as string | undefined
    if (sql)       configSummary = sql.slice(0, 40) + (sql.length > 40 ? '\u2026' : '')
    else if (conn) configSummary = `connector: ${conn.slice(0, 20)}`
  } else if (sData.stepType === 'step:mutation') {
    const sql  = w.sql          as string | undefined
    const conn = w.connector_id as string | undefined
    if (sql)       configSummary = sql.slice(0, 40) + (sql.length > 40 ? '\u2026' : '')
    else if (conn) configSummary = `connector: ${conn.slice(0, 20)}`
    else           configSummary = 'Not configured'
  } else if (sData.stepType === 'step:condition') {
    const left  = w.left  as string | undefined
    const op    = w.op    as string | undefined
    const right = w.right as string | undefined
    if (left !== undefined || op !== undefined || right !== undefined) {
      const raw = `${left ?? '?'} ${op ?? '=='} ${right ?? '?'}`
      configSummary = raw.length > 40 ? raw.slice(0, 40) + '\u2026' : raw
    }
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
    const role = w.approver_role as string | undefined
    const desc = w.description   as string | undefined
    if (role)      configSummary = `Requires: ${role}`
    else if (desc) configSummary = desc.slice(0, 40) + (desc.length > 40 ? '\u2026' : '')
    else           configSummary = 'Awaits admin approval'
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
            {inputPortGroups.map(({ parent: port, children }) => {
              const isExpanded = expandedInputPorts.get(port.name) ?? false
              return (
                <React.Fragment key={port.name}>
                  <div title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={port.name}
                      style={{
                        width: 8, height: 8,
                        background: accent,
                        border: '1px solid #2a2a2a',
                        left: -4,
                        opacity: 0.8,
                        outline: port.dynamic ? `1.5px dashed ${accent}` : 'none',
                        outlineOffset: '2px',
                      }}
                    />
                    <span style={{ fontSize: '0.65rem', color: '#888', marginLeft: 6 }}>
                      {port.name}{port.dynamic ? ' +' : ''}
                    </span>
                    <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginLeft: 3 }}>
                      {dataTypeBadge(port.dataType)}
                    </span>
                    {children && children.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedInputPorts(prev => {
                          const next = new Map(prev)
                          next.set(port.name, !isExpanded)
                          return next
                        })}
                        style={{
                          border: '1px solid #2a2a2a',
                          borderRadius: 999,
                          background: '#161616',
                          color: '#f5f5f5',
                          cursor: 'pointer',
                          fontSize: '0.55rem',
                          fontWeight: 600,
                          marginLeft: 4,
                          padding: '1px 5px',
                        }}
                      >
                        {isExpanded ? '▲' : `▼ ${children.length}`}
                      </button>
                    )}
                  </div>
                  {children && isExpanded && children.map(child => (
                    <div key={child.name} title={child.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 22 }}>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={child.name}
                        style={{
                          width: 7, height: 7,
                          background: '#6366f1',
                          border: '1px solid #2a2a2a',
                          left: -4,
                        }}
                      />
                      <span style={{ fontSize: '0.6rem', color: '#6b7280', marginLeft: 6 }}>
                        {child.name.split('.').pop()}
                      </span>
                      <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginLeft: 3 }}>
                        {dataTypeBadge(child.dataType)}
                      </span>
                    </div>
                  ))}
                </React.Fragment>
              )
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {outputPortGroups.map(({ parent: port, children }) => {
              const isExpanded = expandedOutputPorts.get(port.name) ?? false
              return (
                <React.Fragment key={port.name}>
                  <div title={port.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
                    {children && children.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedOutputPorts(prev => {
                          const next = new Map(prev)
                          next.set(port.name, !isExpanded)
                          return next
                        })}
                        style={{
                          border: '1px solid #2a2a2a',
                          borderRadius: 999,
                          background: '#161616',
                          color: '#f5f5f5',
                          cursor: 'pointer',
                          fontSize: '0.55rem',
                          fontWeight: 600,
                          marginRight: 4,
                          padding: '1px 5px',
                        }}
                      >
                        {isExpanded ? '▲' : `▼ ${children.length}`}
                      </button>
                    )}
                    <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>
                      {dataTypeBadge(port.dataType)}
                    </span>
                    <span style={{ fontSize: '0.65rem', color: '#888', marginRight: 6 }}>
                      {port.name}{port.dynamic ? ' +' : ''}
                    </span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={port.name}
                      style={{
                        width: 8, height: 8,
                        background: SEMANTIC_HANDLE_COLORS[port.name] ?? accent,
                        border: '1px solid #2a2a2a',
                        right: -4,
                        outline: port.dynamic ? `1.5px dashed ${accent}` : 'none',
                        outlineOffset: '2px',
                      }}
                    />
                  </div>
                  {children && isExpanded && children.map(child => (
                    <div key={child.name} title={child.description} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 22 }}>
                      <span style={{ fontSize: '0.5rem', color: '#444', fontFamily: 'monospace', marginRight: 3 }}>
                        {dataTypeBadge(child.dataType)}
                      </span>
                      <span style={{ fontSize: '0.6rem', color: '#6b7280', marginRight: 6 }}>
                        {child.name.split('.').pop()}
                      </span>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={child.name}
                        style={{
                          width: 7, height: 7,
                          background: '#6366f1',
                          border: '1px solid #2a2a2a',
                          right: -4,
                        }}
                      />
                    </div>
                  ))}
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* Binding slot handles — mutation SET clauses (drag-to-wire) */}
      {(sData.stepType === 'step:mutation' || sData.stepType === 'step:query') && (() => {
        const sql = String(sData.auraNode?.with?.sql ?? '')
        if (!sql) return null
        const isQuery = sData.stepType === 'step:query'
        const guided = tryParseSQL(sql, isQuery) ?? defaultGuided()
        const setSlots = !isQuery && guided.mutationOp !== 'DELETE' ? guided.setClauses : []
        const whereSlots = guided.whereClauses
        if (setSlots.length === 0 && whereSlots.length === 0) return null
        return (
          <div style={{ borderTop: '1px solid #1a1a1a', padding: '4px 0' }}>
            {setSlots.length > 0 && (
              <div style={{ padding: '2px 10px 0', fontSize: '0.5rem', color: '#333', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Bind values
              </div>
            )}
            {setSlots.map((s, i) => (
              (() => {
                const isBoundSlot = s.val.startsWith('{{')
                return (
              <div
                key={`set-${i}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  margin: '2px 8px 0 6px',
                  paddingLeft: 10,
                  paddingTop: 3,
                  paddingBottom: 3,
                  border: isBoundSlot ? '1px solid transparent' : '1px dashed rgba(167, 139, 250, 0.35)',
                  borderRadius: 6,
                  background: isBoundSlot ? 'transparent' : 'rgba(167, 139, 250, 0.08)',
                }}
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`bind:set:${i}`}
                  style={{
                    width: 7, height: 7,
                    background: '#a78bfa',
                    border: '1px solid #2a2a2a',
                    left: -4,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: '0.6rem', color: '#666', marginLeft: 6 }}>
                  {s.col || `col ${i}`}
                </span>
                {isBoundSlot ? (
                  <span style={{ fontSize: '0.5rem', color: '#a78bfa', marginLeft: 4, fontFamily: 'monospace' }}>
                    {s.val.replace(/^\{\{|\}\}$/g, '')}
                  </span>
                ) : (
                  <span style={{ fontSize: '0.5rem', color: '#c4b5fd', marginLeft: 4 }}>
                    {emptyValueSlotHelperCopy}
                  </span>
                )}
              </div>
                )
              })()
            ))}
            {whereSlots.length > 0 && (
              <div style={{ padding: '4px 10px 0', fontSize: '0.5rem', color: '#333', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Bind filters
              </div>
            )}
            {whereSlots.map((w, i) => (
              (() => {
                const isBoundSlot = w.val.startsWith('{{')
                return (
              <div
                key={`where-${i}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  margin: '2px 8px 0 6px',
                  paddingLeft: 10,
                  paddingTop: 3,
                  paddingBottom: 3,
                  border: isBoundSlot ? '1px solid transparent' : '1px dashed rgba(96, 165, 250, 0.35)',
                  borderRadius: 6,
                  background: isBoundSlot ? 'transparent' : 'rgba(96, 165, 250, 0.08)',
                }}
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`bind:where:${i}`}
                  style={{
                    width: 7, height: 7,
                    background: '#60a5fa',
                    border: '1px solid #2a2a2a',
                    left: -4,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: '0.6rem', color: '#666', marginLeft: 6 }}>
                  {w.col || `filter ${i}`}
                </span>
                {isBoundSlot ? (
                  <span style={{ fontSize: '0.5rem', color: '#60a5fa', marginLeft: 4, fontFamily: 'monospace' }}>
                    {w.val.replace(/^\{\{|\}\}$/g, '')}
                  </span>
                ) : (
                  <span style={{ fontSize: '0.5rem', color: '#93c5fd', marginLeft: 4 }}>
                    {emptyFilterSlotHelperCopy}
                  </span>
                )}
              </div>
                )
              })()
            ))}
          </div>
        )
      })()}
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
    // ---- Drag-to-wire binding (Approach 1) ---------------------------------
    // When the user drops a widget output port onto a step node's bind:set:N
    // or bind:where:N handle, write the stable {{slot.*}} token into
    // the corresponding SQL slot and persist a 'binding' edge.
    if (connection.targetHandle?.startsWith('bind:')) {
      const parts = connection.targetHandle.split(':') // ['bind', 'set'|'where', index]
      const slotType = parts[1] as 'set' | 'where'
      const slotIdx  = parseInt(parts[2], 10)
      const targetNode = doc.nodes.find(n => n.id === connection.target)
      const sourceNode = doc.nodes.find(n => n.id === connection.source)
      const sourceDataType = getExpandedOutputPortDataType(sourceNode, connection.sourceHandle)
      if (!isBindableSqlValueType(sourceDataType)) return
      if (targetNode) {
        const isQuery  = targetNode.element === 'step:query'
        const sql      = String(targetNode.with?.sql ?? '')
        const guided   = tryParseSQL(sql, isQuery) ?? defaultGuided()
        const binding  = slotTokenFromHandle(connection.targetHandle)

        let updatedGuided = guided
        if (slotType === 'set') {
          const setClauses = guided.setClauses.map((c, i) =>
            i === slotIdx ? { ...c, val: binding, quoted: true } : c,
          )
          updatedGuided = { ...guided, setClauses }
        } else if (slotType === 'where') {
          const whereClauses = guided.whereClauses.map((c, i) =>
            i === slotIdx ? { ...c, val: binding, quoted: true } : c,
          )
          updatedGuided = { ...guided, whereClauses }
        }

        const newSql = sqlFromGuided(updatedGuided, isQuery)
        const updatedNodes = doc.nodes.map(n =>
          n.id === connection.target
            ? { ...n, with: { ...(n.with ?? {}), sql: newSql } }
            : n,
        )

        // Remove any pre-existing binding edge on this same slot so there is
        // never more than one binding per slot.
        const existingSlotEdge = doc.edges.find(
          e => e.edgeType === 'binding' && e.toNodeId === connection.target && e.toPort === connection.targetHandle,
        )
        const filteredEdges = existingSlotEdge
          ? doc.edges.filter(e => e.id !== existingSlotEdge.id)
          : doc.edges

        const bindingEdge: AuraEdge = {
          id: `bind_${crypto.randomUUID().slice(0, 8)}`,
          fromNodeId: connection.source!,
          fromPort:   connection.sourceHandle ?? '',
          toNodeId:   connection.target!,
          toPort:     connection.targetHandle!,
          edgeType:   'binding',
        }

        const rfEdge = {
          id: bindingEdge.id,
          source: bindingEdge.fromNodeId,
          sourceHandle: bindingEdge.fromPort,
          target: bindingEdge.toNodeId,
          targetHandle: bindingEdge.toPort,
          type: 'smoothstep' as const,
          animated: false,
          style: { stroke: '#a78bfa', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.7 },
        }
        if (existingSlotEdge) {
          setRfEdges(eds => [...eds.filter(e => e.id !== existingSlotEdge.id), rfEdge])
        } else {
          setRfEdges(eds => [...eds, rfEdge])
        }

        onChange({ ...doc, nodes: updatedNodes, edges: [...filteredEdges, bindingEdge] })
        return
      }
    }

    // ---- Normal flow edge --------------------------------------------------
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

    // For each deleted binding edge, clear the corresponding SQL slot value
    let updatedNodes = doc.nodes
    for (const de of doc.edges.filter(e => deletedIds.has(e.id) && e.edgeType === 'binding')) {
      const parts    = de.toPort.split(':') // ['bind', 'set'|'where', index]
      const slotType = parts[1] as 'set' | 'where'
      const slotIdx  = parseInt(parts[2], 10)
      const target   = updatedNodes.find(n => n.id === de.toNodeId)
      if (!target) continue
      const isQuery  = target.element === 'step:query'
      const sql      = String(target.with?.sql ?? '')
      const guided   = tryParseSQL(sql, isQuery) ?? defaultGuided()
      let next = guided
      if (slotType === 'set') {
        next = { ...guided, setClauses: guided.setClauses.map((c, i) => i === slotIdx ? { ...c, val: '' } : c) }
      } else if (slotType === 'where') {
        next = { ...guided, whereClauses: guided.whereClauses.map((c, i) => i === slotIdx ? { ...c, val: '' } : c) }
      }
      const newSql = sqlFromGuided(next, isQuery)
      updatedNodes = updatedNodes.map(n =>
        n.id === de.toNodeId ? { ...n, with: { ...(n.with ?? {}), sql: newSql } } : n,
      )
    }

    onChange({ ...doc, nodes: updatedNodes, edges: doc.edges.filter(e => !deletedIds.has(e.id)) })
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
