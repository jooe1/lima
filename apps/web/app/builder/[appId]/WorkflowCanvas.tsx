'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  getWorkflow,
  putWorkflowSteps,
  activateWorkflow,
  archiveWorkflow,
  reviewStep,
  patchWorkflow,
  createThread,
  listThreads,
  postMessage,
  listConnectors,
  type WorkflowWithSteps,
  type WorkflowStep,
  type WorkflowStepInput,
  type WorkflowStepType,
  type Connector,
} from '../../../lib/api'
import {
  StartNode, QueryNode, MutationNode, ConditionNode,
  ApprovalGateNode, NotificationNode, EndNode,
  type WFNode, type WFEdge, type WFNodeData,
} from './workflow-nodes'

// ---- colour palette ---------------------------------------------------------
const C = {
  bg:      '#060606',
  surface: '#0f0f0f',
  border:  '#1e1e1e',
  text:    '#e5e5e5',
  muted:   '#555',
  accent:  '#1d4ed8',
  accentFg:'#bfdbfe',
  danger:  '#450a0a',
  dangerFg:'#fca5a5',
}

const nodeTypes: NodeTypes = {
  start:         StartNode as React.ComponentType<any>,
  query:         QueryNode as React.ComponentType<any>,
  mutation:      MutationNode as React.ComponentType<any>,
  condition:     ConditionNode as React.ComponentType<any>,
  approval_gate: ApprovalGateNode as React.ComponentType<any>,
  notification:  NotificationNode as React.ComponentType<any>,
  end:           EndNode as React.ComponentType<any>,
}

const STEP_DEFAULT_CONFIGS: Record<WorkflowStepType, Record<string, unknown>> = {
  query:         { connector_id: '', sql: '' },
  mutation:      { connector_id: '', operation: 'insert', table: '' },
  condition:     { left: '', op: 'eq', right: '' },
  approval_gate: { description: '' },
  notification:  { message: '' },
}

const STEP_DEFAULT_NAMES: Record<WorkflowStepType, string> = {
  query:            'Read data',
  mutation:         'Save to database',
  condition:        'Check condition',
  approval_gate:    'Require approval',
  notification:     'Send notification',
}

const STEP_PALETTE: { type: WorkflowStepType; label: string; color: string; hint: string }[] = [
  { type: 'query',         label: '📋 Read Data',          color: '#1e3a8a', hint: 'Fetch records from a table or API' },
  { type: 'mutation',      label: '💾 Save to Database',   color: '#7c2d12', hint: 'Insert, update, or delete rows in a table' },
  { type: 'condition',     label: '◆ Check Condition',    color: '#78350f', hint: 'Take different paths based on a value' },
  { type: 'approval_gate', label: '✅ Require Approval',   color: '#4c1d95', hint: 'Pause and wait for a manager to approve' },
  { type: 'notification',  label: '🔔 Send Notification',  color: '#064e3b', hint: 'Send a message or alert' },
]

const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: danger ? C.danger : primary ? C.accent : '#1a1a1a',
  color:      danger ? C.dangerFg : primary ? C.accentFg : '#aaa',
  border:     primary || danger ? 'none' : `1px solid ${C.border}`,
  borderRadius: 4,
  padding: '5px 14px',
  fontSize: '0.72rem',
  cursor: 'pointer',
  flexShrink: 0,
})

// ---- helpers: convert WorkflowStep[] <-> React Flow nodes/edges ------------

function stepsToFlow(steps: WorkflowStep[], triggerLabel: string): { nodes: WFNode[]; edges: WFEdge[] } {
  const nodes: WFNode[] = []
  const edges: WFEdge[] = []

  // Start node
  nodes.push({
    id: '__start__',
    type: 'start',
    position: { x: 160, y: 0 },
    data: { label: triggerLabel },
    deletable: false,
  })

  let prevId = '__start__'
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)

  sorted.forEach((step, i) => {
    const x = 160
    const y = 120 + i * 120
    nodes.push({
      id: step.id,
      type: step.step_type as WFNode['type'],
      position: { x, y },
      data: {
        label: step.name,
        stepType: step.step_type,
        stepId: step.id,
        config: step.config,
        aiGenerated: step.ai_generated,
        reviewed: !!step.reviewed_by,
      },
    })

    // Default edge: previous → this step
    if (prevId) {
      if (step.next_step_id || sorted[i - 1]?.false_branch_step_id === step.id) {
        // Branching edges handled separately below
      } else {
        edges.push({ id: `e-${prevId}-${step.id}`, source: prevId, target: step.id, animated: false })
      }
    }
    prevId = step.id
  })

  // End node
  nodes.push({
    id: '__end__',
    type: 'end',
    position: { x: 160, y: 120 + sorted.length * 120 },
    data: { label: 'End' },
    deletable: false,
  })

  // Add explicit branching edges where next_step_id / false_branch_step_id is set
  const stepById = Object.fromEntries(sorted.map(s => [s.id, s]))
  const handledEdges = new Set<string>()

  for (const step of sorted) {
    const defaultNextIdx = sorted.findIndex(s => s.step_order === step.step_order + 1)
    const defaultNextId = defaultNextIdx >= 0 ? sorted[defaultNextIdx].id : null

    if (step.step_type === 'condition') {
      // true branch
      const trueTarget = step.next_step_id ?? defaultNextId
      if (trueTarget && stepById[trueTarget]) {
        const eid = `e-${step.id}-true-${trueTarget}`
        if (!handledEdges.has(eid)) {
          edges.push({ id: eid, source: step.id, sourceHandle: 'true', target: trueTarget, label: 'true', animated: false, style: { stroke: '#4ade80' } })
          handledEdges.add(eid)
        }
      }
      // false branch
      if (step.false_branch_step_id && stepById[step.false_branch_step_id]) {
        const eid = `e-${step.id}-false-${step.false_branch_step_id}`
        if (!handledEdges.has(eid)) {
          edges.push({ id: eid, source: step.id, sourceHandle: 'false', target: step.false_branch_step_id, label: 'false', animated: false, style: { stroke: '#f87171' } })
          handledEdges.add(eid)
        }
      }
    } else if (step.next_step_id && stepById[step.next_step_id]) {
      const eid = `e-${step.id}-${step.next_step_id}`
      if (!handledEdges.has(eid)) {
        edges.push({ id: eid, source: step.id, target: step.next_step_id, animated: false })
        handledEdges.add(eid)
      }
    } else {
      // linear: connect to next by step_order
      const eid = `e-${step.id}-auto`
      if (!handledEdges.has(eid)) {
        const nextTarget = defaultNextId ?? '__end__'
        edges.push({ id: eid, source: step.id, target: nextTarget, animated: false })
        handledEdges.add(eid)
      }
    }
  }

  // Start always connects to first step or end
  if (sorted.length === 0) {
    edges.push({ id: 'e-start-end', source: '__start__', target: '__end__' })
  } else {
    edges.push({ id: 'e-start-first', source: '__start__', target: sorted[0].id })
  }

  return { nodes, edges }
}

// Convert the current canvas nodes/edges back to WorkflowStepInput[] for saving.
function flowToSteps(nodes: WFNode[], edges: WFEdge[], existingSteps: WorkflowStep[]): WorkflowStepInput[] {
  const stepNodes = nodes.filter(n => n.type !== 'start' && n.type !== 'end' && n.data.stepType)
  const existingById = Object.fromEntries(existingSteps.map(s => [s.id, s]))

  return stepNodes.map((node) => {
    const existing = existingById[node.id]
    // Resolve next_step_id and false_branch_step_id from edges
    const outEdges = edges.filter(e => e.source === node.id)
    const trueEdge = outEdges.find(e => e.sourceHandle === 'true' || (node.type !== 'condition' && !e.sourceHandle))
    const falseEdge = outEdges.find(e => e.sourceHandle === 'false')

    const nextStepId = trueEdge && trueEdge.target !== '__end__' ? trueEdge.target : undefined
    const falseBranchStepId = falseEdge && falseEdge.target !== '__end__' ? falseEdge.target : undefined

    return {
      name: String(node.data.label),
      step_type: node.data.stepType!,
      config: (node.data.config ?? {}) as Record<string, unknown>,
      ai_generated: existing?.ai_generated ?? false,
      next_step_id: nextStepId,
      false_branch_step_id: falseBranchStepId,
    } satisfies WorkflowStepInput
  })
}

// ---- Schema helpers (mirror of Inspector's helpers) -------------------------

function getConnectorTables(connector: Connector | undefined): string[] {
  const tables = connector?.schema_cache?.tables
  if (!Array.isArray(tables)) return []
  return tables.flatMap(t => {
    if (typeof t === 'string') return [t]
    if (t && typeof t === 'object' && 'name' in t) {
      const n = (t as Record<string, unknown>).name
      return typeof n === 'string' && n.trim() ? [n] : []
    }
    return []
  })
}

function getConnectorColumns(connector: Connector | undefined, tableName: string): string[] {
  if (!tableName) return []
  const tables = connector?.schema_cache?.tables
  if (!Array.isArray(tables)) return []
  const found = tables.find(t => t && typeof t === 'object' && (t as Record<string, unknown>).name === tableName)
  if (!found || typeof found !== 'object') return []
  const cols = (found as Record<string, unknown>).columns
  if (!Array.isArray(cols)) return []
  return cols.flatMap(c => {
    if (typeof c === 'string') return [c]
    if (c && typeof c === 'object' && 'name' in c) {
      const n = (c as Record<string, unknown>).name
      return typeof n === 'string' && n.trim() ? [n] : []
    }
    return []
  })
}

function buildInsertSQL(table: string, mapping: { column: string; value: string }[]): string {
  const filled = mapping.filter(m => m.value.trim())
  if (!table || filled.length === 0) return ''
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const cols = filled.map(m => q(m.column)).join(', ')
  const vals = filled.map(m => m.value.trim()).join(', ')
  return `INSERT INTO ${q(table)} (${cols}) VALUES (${vals})`
}

// ---- Config panel for a selected node ---------------------------------------

function NodeConfigPanel({
  node, onSave, onReview, canReview, connectors,
}: {
  node: WFNode
  onSave: (nodeId: string, updatedData: Partial<WFNodeData>) => void
  onReview: (stepId: string) => void
  canReview: boolean
  connectors: Connector[]
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(node.data.config ?? {})
  const [name, setName] = useState(String(node.data.label))
  const [advancedSql, setAdvancedSql] = useState(false)

  // Reset when selected node changes
  useEffect(() => {
    setConfig(node.data.config ?? {})
    setName(String(node.data.label))
    setAdvancedSql(false)
  }, [node.id])

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: '#111', border: `1px solid ${C.border}`,
    borderRadius: 3, padding: '4px 8px',
    color: C.text, fontSize: '0.72rem',
  }
  const fieldLabel: React.CSSProperties = {
    fontSize: '0.65rem', color: C.muted, marginBottom: 3, marginTop: 10, display: 'block',
  }
  const hintStyle: React.CSSProperties = {
    fontSize: '0.6rem', color: '#555', marginTop: 4, lineHeight: 1.5, display: 'block',
  }
  const linkBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: '#60a5fa', fontSize: '0.6rem',
    cursor: 'pointer', textDecoration: 'underline', padding: '0 2px',
  }

  const setField = (key: string, value: unknown) => setConfig(prev => ({ ...prev, [key]: value }))

  // Resolved connector + schema
  const selectedConnector = connectors.find(c => c.id === String(config.connector_id ?? ''))
  const isSql = selectedConnector && ['postgres', 'mysql', 'mssql'].includes(selectedConnector.type)
  const tables = getConnectorTables(selectedConnector)
  const tableName = String(config.table ?? '')
  const columns = getConnectorColumns(selectedConnector, tableName)

  // Field mapping for INSERT: use saved mapping or derive from schema columns
  const savedMapping = Array.isArray(config.field_mapping)
    ? (config.field_mapping as { column: string; value: string }[])
    : null
  const fieldMapping: { column: string; value: string }[] =
    savedMapping ?? columns.map(c => ({ column: c, value: '' }))

  const handleConnectorChange = (connId: string) => {
    setConfig(prev => ({ ...prev, connector_id: connId, table: '', field_mapping: undefined, sql: '' }))
  }

  const handleTableChange = (table: string) => {
    const conn = connectors.find(c => c.id === String(config.connector_id ?? ''))
    const cols = getConnectorColumns(conn, table)
    const newMapping = cols.map(c => ({ column: c, value: '' }))
    const insertSql = buildInsertSQL(table, newMapping)
    const selectSql = table ? `SELECT * FROM "${table.replace(/"/g, '""')}"` : ''
    setConfig(prev => ({
      ...prev,
      table,
      field_mapping: newMapping,
      sql: node.data.stepType === 'query' ? selectSql : (prev.operation === 'insert' ? insertSql : ''),
    }))
  }

  const handleMappingChange = (column: string, value: string) => {
    const newMapping = fieldMapping.map(m => m.column === column ? { ...m, value } : m)
    setConfig(prev => ({ ...prev, field_mapping: newMapping, sql: buildInsertSQL(tableName, newMapping) }))
  }

  // Shared: connector dropdown
  const connectorPicker = (
    <>
      <label style={fieldLabel}>Database / API connection</label>
      <select
        style={inputStyle}
        value={String(config.connector_id ?? '')}
        onChange={e => handleConnectorChange(e.target.value)}
      >
        <option value="">— choose a connection —</option>
        {connectors.map(c => (
          <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
        ))}
      </select>
      {connectors.length === 0 && (
        <span style={hintStyle}>No connections found. Add one in the Connectors panel first.</span>
      )}
    </>
  )

  // Shared: table dropdown (SQL connectors only)
  const tablePicker = isSql && tables.length > 0 && (
    <>
      <label style={fieldLabel}>Table</label>
      <select
        style={inputStyle}
        value={tableName}
        onChange={e => handleTableChange(e.target.value)}
      >
        <option value="">— choose a table —</option>
        {tables.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </>
  )

  const renderFields = () => {
    switch (node.data.stepType) {

      // ── Read Data ──────────────────────────────────────────────────────────
      case 'query': {
        const autoSelect = tableName ? `SELECT * FROM "${tableName.replace(/"/g, '""')}"` : ''
        return (
          <>
            {connectorPicker}
            {isSql && tablePicker}
            {isSql && tableName && !advancedSql && (
              <div style={{ marginTop: 8 }}>
                <span style={{ ...hintStyle, marginTop: 0 }}>
                  Will read all rows from <strong style={{ color: '#93c5fd' }}>{tableName}</strong>.{' '}
                  <button style={linkBtn} onClick={() => { setAdvancedSql(true); if (!config.sql) setField('sql', autoSelect) }}>
                    Add a filter (advanced)
                  </button>
                </span>
              </div>
            )}
            {(!isSql || advancedSql) && (
              <>
                <label style={fieldLabel}>SQL query</label>
                <textarea
                  style={{ ...inputStyle, height: 80, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.65rem' }}
                  value={String(config.sql ?? '')}
                  onChange={e => setField('sql', e.target.value)}
                  placeholder="SELECT * FROM contacts WHERE status = '{{input.status}}'"
                />
                <span style={hintStyle}>Tip: use {'{{input.fieldname}}'} to filter by a value the user entered in a form.</span>
                {advancedSql && (
                  <button style={{ ...linkBtn, marginTop: 4 }} onClick={() => setAdvancedSql(false)}>← Back to simple mode</button>
                )}
              </>
            )}
          </>
        )
      }

      // ── Save to Database ───────────────────────────────────────────────────
      case 'mutation': {
        const operation = String(config.operation ?? 'insert')
        const showMapper = isSql && tableName && operation === 'insert' && !advancedSql
        const showSqlHint = isSql && tableName && operation !== 'insert' && !advancedSql

        return (
          <>
            {connectorPicker}
            <label style={fieldLabel}>What should this step do?</label>
            <select
              style={inputStyle}
              value={operation}
              onChange={e => { setField('operation', e.target.value); if (e.target.value !== 'insert') setAdvancedSql(false) }}
            >
              <option value="insert">Add a new record</option>
              <option value="update">Update existing records</option>
              <option value="delete">Delete records</option>
            </select>
            {isSql && tablePicker}

            {/* INSERT: visual field mapper */}
            {showMapper && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                  <span style={{ fontSize: '0.65rem', color: C.muted, fontWeight: 600 }}>
                    {columns.length > 0 ? 'What values to save?' : 'Set column values'}
                  </span>
                  <button style={linkBtn} onClick={() => setAdvancedSql(true)}>SQL mode</button>
                </div>
                {fieldMapping.length === 0 && tableName && (
                  <span style={hintStyle}>No columns found for this table. Try refreshing the schema in the Connectors panel.</span>
                )}
                <span style={hintStyle}>
                  Use {'{{input.fieldname}}'} to copy a value the user typed into the form.
                  Leave a field blank to skip it.
                </span>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {fieldMapping.map(m => (
                    <div key={m.column} style={{ display: 'grid', gridTemplateColumns: '1fr 14px 1fr', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: '0.65rem', color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.column}>
                        {m.column}
                      </span>
                      <span style={{ fontSize: '0.6rem', color: C.muted, textAlign: 'center' }}>=</span>
                      <input
                        style={{ ...inputStyle, padding: '3px 6px' }}
                        value={m.value}
                        placeholder={`{{input.${m.column}}}`}
                        onChange={e => handleMappingChange(m.column, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* UPDATE/DELETE: guided SQL with placeholder */}
            {showSqlHint && (
              <>
                <label style={fieldLabel}>SQL statement</label>
                <textarea
                  style={{ ...inputStyle, height: 80, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.65rem' }}
                  value={String(config.sql ?? '')}
                  onChange={e => setField('sql', e.target.value)}
                  placeholder={operation === 'update'
                    ? `UPDATE "${tableName}" SET "field" = '{{input.field}}'\nWHERE "id" = '{{input.id}}'`
                    : `DELETE FROM "${tableName}" WHERE "id" = '{{input.id}}'`
                  }
                />
                <span style={hintStyle}>Use {'{{input.fieldname}}'} to reference a value the user entered.</span>
              </>
            )}

            {/* Advanced SQL mode */}
            {advancedSql && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                  <span style={{ fontSize: '0.65rem', color: C.muted, fontWeight: 600 }}>SQL statement</span>
                  {operation === 'insert' && (
                    <button style={linkBtn} onClick={() => setAdvancedSql(false)}>← Field mapper</button>
                  )}
                </div>
                <textarea
                  style={{ ...inputStyle, height: 90, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.65rem' }}
                  value={String(config.sql ?? '')}
                  onChange={e => setField('sql', e.target.value)}
                  placeholder="INSERT INTO ..."
                />
                <span style={hintStyle}>Use {'{{input.fieldname}}'} to reference form values.</span>
              </>
            )}
          </>
        )
      }

      // ── Check Condition ────────────────────────────────────────────────────
      case 'condition':
        return (
          <>
            <label style={fieldLabel}>If this value…</label>
            <input
              style={inputStyle}
              value={String(config.left ?? '')}
              onChange={e => setField('left', e.target.value)}
              placeholder="{{input.status}}"
            />
            <span style={hintStyle}>Use {'{{input.fieldname}}'} to reference a value from the form.</span>
            <label style={fieldLabel}>…is…</label>
            <select style={inputStyle} value={String(config.op ?? 'eq')} onChange={e => setField('op', e.target.value)}>
              <option value="eq">equal to</option>
              <option value="neq">not equal to</option>
              <option value="gt">greater than</option>
              <option value="lt">less than</option>
            </select>
            <label style={fieldLabel}>…this value</label>
            <input
              style={inputStyle}
              value={String(config.right ?? '')}
              onChange={e => setField('right', e.target.value)}
              placeholder="active"
            />
            <span style={hintStyle}>
              The workflow takes the <strong style={{ color: '#4ade80' }}>green (true)</strong> path if the condition matches,
              otherwise the <strong style={{ color: '#f87171' }}>red (false)</strong> path.
            </span>
          </>
        )

      // ── Require Approval ───────────────────────────────────────────────────
      case 'approval_gate':
        return (
          <>
            <label style={fieldLabel}>Instructions for the approver</label>
            <textarea
              style={{ ...inputStyle, height: 70, resize: 'vertical' }}
              value={String(config.description ?? '')}
              onChange={e => setField('description', e.target.value)}
              placeholder="Please review the new contact details and approve before saving to the database."
            />
            <span style={hintStyle}>The workflow will pause here until a workspace admin approves or rejects the request.</span>
          </>
        )

      // ── Send Notification ──────────────────────────────────────────────────
      case 'notification':
        return (
          <>
            <label style={fieldLabel}>Message to send</label>
            <textarea
              style={{ ...inputStyle, height: 70, resize: 'vertical' }}
              value={String(config.message ?? '')}
              onChange={e => setField('message', e.target.value)}
              placeholder="New contact {{input.first_name}} {{input.last_name}} has been added."
            />
            <span style={hintStyle}>Use {'{{input.fieldname}}'} to include form values in the message.</span>
          </>
        )

      default:
        return null
    }
  }

  if (node.type === 'start' || node.type === 'end') return null

  const stepTypeLabel: Record<string, string> = {
    query: 'Read Data', mutation: 'Save to Database',
    condition: 'Check Condition', approval_gate: 'Require Approval',
    notification: 'Send Notification',
  }

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: '0.7rem', color: C.muted, marginBottom: 8, fontWeight: 600 }}>
        {stepTypeLabel[node.data.stepType ?? ''] ?? node.data.stepType?.toUpperCase()}
      </div>
      <label style={{ ...fieldLabel, marginTop: 0 }}>Step name</label>
      <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
      {renderFields()}
      <button
        style={{ ...btn(true), marginTop: 14, width: '100%' }}
        onClick={() => onSave(node.id, { label: name, config })}
      >
        Apply changes
      </button>
      {node.data.aiGenerated && !node.data.reviewed && canReview && node.data.stepId && (
        <button
          style={{ ...btn(), marginTop: 8, width: '100%', borderColor: '#92400e', color: '#fbbf24' }}
          onClick={() => onReview(node.data.stepId!)}
        >
          ✓ Mark as reviewed
        </button>
      )}
    </div>
  )
}


// ---- Main component ---------------------------------------------------------

export interface WorkflowCanvasProps {
  workspaceId: string
  appId: string
  workflowId: string
  triggerLabel?: string   // e.g. "button1" or "Submit form"
  onClose: () => void
  isAdmin: boolean
  threadId?: string       // optional; if provided, AI messages go to this thread
}

export function WorkflowCanvas({ workspaceId, appId, workflowId, triggerLabel = 'Trigger', onClose, isAdmin, threadId: threadIdProp }: WorkflowCanvasProps) {
  const [wf, setWf] = useState<WorkflowWithSteps | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<WFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<WFEdge>([])
  const [selectedNode, setSelectedNode] = useState<WFNode | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const nameEditRef = useRef(false)
  const [aiPromptOpen, setAiPromptOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [connectors, setConnectors] = useState<Connector[]>([])

  // Load workflow
  useEffect(() => {
    if (!workspaceId || !appId || !workflowId) return
    let cancelled = false
    getWorkflow(workspaceId, appId, workflowId)
      .then(data => {
        if (cancelled) return
        setWf(data)
        setName(data.name)
        const { nodes: n, edges: e } = stepsToFlow(data.steps, triggerLabel)
        setNodes(n)
        setEdges(e)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load') })
    return () => { cancelled = true }
  }, [workspaceId, appId, workflowId, triggerLabel, setNodes, setEdges])

  // Load connectors for the config panel pickers
  useEffect(() => {
    if (!workspaceId) return
    listConnectors(workspaceId).then(res => setConnectors(res.connectors)).catch(() => {})
  }, [workspaceId])

  const onConnect = useCallback(
    (connection: Connection) => setEdges(eds => addEdge(connection, eds)),
    [setEdges],
  )

  const onNodeClick = useCallback((_: React.MouseEvent, node: WFNode) => {
    if (node.type === 'start' || node.type === 'end') { setSelectedNode(null); return }
    setSelectedNode(node)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNode(null), [])

  // Add a new step node from the palette
  const addNode = useCallback((type: WorkflowStepType) => {
    const id = `new-${Date.now()}`
    const newNode: WFNode = {
      id,
      type: type as WFNode['type'],
      position: { x: 160 + Math.random() * 40 - 20, y: 200 + nodes.length * 80 },
      data: {
        label: STEP_DEFAULT_NAMES[type],
        stepType: type,
        config: { ...STEP_DEFAULT_CONFIGS[type] },
        aiGenerated: false,
        reviewed: true,
      },
    }
    setNodes(ns => [...ns, newNode])
  }, [nodes.length, setNodes])

  // Update node data from config panel
  const handleNodeSave = useCallback((nodeId: string, updatedData: Partial<WFNodeData>) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...updatedData } } : n))
    setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data: { ...prev.data, ...updatedData } } : prev)
  }, [setNodes])

  // Save all steps to API
  const handleSave = useCallback(async () => {
    if (!wf) return
    setSaving(true)
    setError('')
    try {
      const steps = flowToSteps(nodes, edges, wf.steps)
      const res = await putWorkflowSteps(workspaceId, appId, workflowId, steps)
      setWf(prev => prev ? { ...prev, steps: res.steps } : null)
      // Re-sync to reflect any server-assigned IDs / step_order
      const { nodes: n, edges: e } = stepsToFlow(res.steps, triggerLabel)
      setNodes(n)
      setEdges(e)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [wf, nodes, edges, workspaceId, appId, workflowId, triggerLabel, setNodes, setEdges])

  // Activate
  const handleActivate = useCallback(async () => {
    if (!wf) return
    setError('')
    try {
      const updated = await activateWorkflow(workspaceId, appId, workflowId)
      setWf(prev => prev ? { ...prev, ...updated } : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to activate')
    }
  }, [wf, workspaceId, appId, workflowId])

  // Archive
  const handleArchive = useCallback(async () => {
    if (!wf) return
    setError('')
    try {
      const updated = await archiveWorkflow(workspaceId, appId, workflowId)
      setWf(prev => prev ? { ...prev, ...updated } : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive')
    }
  }, [wf, workspaceId, appId, workflowId])

  // Review step
  const handleReview = useCallback(async (stepId: string) => {
    setError('')
    try {
      await reviewStep(workspaceId, appId, workflowId, stepId)
      setNodes(ns => ns.map(n =>
        n.data.stepId === stepId ? { ...n, data: { ...n.data, reviewed: true } } : n,
      ))
      setSelectedNode(prev =>
        prev?.data.stepId === stepId ? { ...prev, data: { ...prev.data, reviewed: true } } : prev,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to review step')
    }
  }, [workspaceId, appId, workflowId, setNodes])

  // Rename workflow
  const handleRename = useCallback(async () => {
    if (!wf || name === wf.name) return
    try {
      const updated = await patchWorkflow(workspaceId, appId, workflowId, { name })
      setWf(prev => prev ? { ...prev, ...updated } : null)
    } catch {
      setName(wf.name) // revert
    }
  }, [wf, name, workspaceId, appId, workflowId])

  const handleAiGenerate = useCallback(async () => {
    if (!aiPrompt.trim() || !wf) return
    setAiGenerating(true)
    setError('')
    try {
      // Resolve thread: use prop if given, else find/create one for this app
      let resolvedThreadId = threadIdProp
      if (!resolvedThreadId) {
        const { threads } = await listThreads(workspaceId, appId)
        if (threads.length > 0) {
          resolvedThreadId = threads[0].id
        } else {
          const t = await createThread(workspaceId, appId)
          resolvedThreadId = t.id
        }
      }

      // Build context string
      const stepSummary = wf.steps.length === 0
        ? 'no steps yet'
        : wf.steps
            .sort((a, b) => a.step_order - b.step_order)
            .map(s => `${s.step_order + 1}. ${s.name} (${s.step_type})`)
            .join(', ')
      const context = `[Workflow: "${wf.name}" | Trigger: ${triggerLabel} | Steps: ${stepSummary}]`
      const fullContent = `${context}\n\n${aiPrompt.trim()}`

      await postMessage(workspaceId, appId, resolvedThreadId, fullContent)

      setAiPromptOpen(false)
      setAiPrompt('')
      // Show a temporary success hint — reuse the error slot with a neutral message
      setError('✓ Generation queued — reload canvas in a moment to see new steps')
      setTimeout(() => setError(''), 6000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send generation request')
    } finally {
      setAiGenerating(false)
    }
  }, [aiPrompt, wf, threadIdProp, workspaceId, appId, triggerLabel])

  const statusColor = wf?.status === 'active' ? '#4ade80' : wf?.status === 'archived' ? '#555' : '#fbbf24'
  const hasUnreviewed = nodes.some(n => n.data.aiGenerated && !n.data.reviewed)

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: C.bg, display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        height: 48, display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <button
          style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '0.8rem', padding: '4px 8px' }}
          onClick={onClose}
        >
          ← Back
        </button>
        <div style={{ width: 1, height: 20, background: C.border }} />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={e => { if (e.key === 'Enter') handleRename() }}
          style={{
            background: 'none', border: 'none', color: C.text,
            fontSize: '0.9rem', fontWeight: 600, outline: 'none',
            flex: 1, minWidth: 0,
          }}
        />
        {wf && (
          <span style={{ fontSize: '0.6rem', padding: '2px 8px', borderRadius: 99, background: statusColor + '22', color: statusColor }}>
            {wf.status}
          </span>
        )}
        {error && (
          <span style={{ fontSize: '0.65rem', color: '#fca5a5', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error}
          </span>
        )}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          {aiPromptOpen ? (
            <div style={{ display: 'flex', gap: 6, flex: 1, maxWidth: 440 }}>
              <input
                autoFocus
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAiGenerate()
                  if (e.key === 'Escape') { setAiPromptOpen(false); setAiPrompt('') }
                }}
                placeholder="Describe what this workflow should do… (reload after generating)"
                style={{
                  flex: 1, background: '#111', border: '1px solid #1e3a8a',
                  borderRadius: 4, padding: '4px 10px',
                  color: '#e5e5e5', fontSize: '0.72rem', outline: 'none',
                }}
                disabled={aiGenerating}
              />
              <button style={btn(true)} onClick={handleAiGenerate} disabled={aiGenerating || !aiPrompt.trim()}>
                {aiGenerating ? 'Generating…' : 'Generate'}
              </button>
              <button style={btn()} onClick={() => { setAiPromptOpen(false); setAiPrompt('') }} disabled={aiGenerating}>
                Cancel
              </button>
            </div>
          ) : (
            <button style={btn()} onClick={() => setAiPromptOpen(true)}>✦ Generate with AI</button>
          )}
          <button style={btn()} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {isAdmin && wf?.status === 'draft' && (
            <button
              style={btn(true)}
              onClick={handleActivate}
              disabled={hasUnreviewed}
              title={hasUnreviewed ? 'Review all AI-generated steps first' : undefined}
            >
              Activate
            </button>
          )}
          {isAdmin && wf?.status === 'active' && (
            <button style={btn(false, true)} onClick={handleArchive}>Archive</button>
          )}
        </div>
      </div>

      {/* Body: palette | canvas | config */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left palette */}
        <div style={{
          width: 160, borderRight: `1px solid ${C.border}`,
          padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 6,
          overflowY: 'auto', flexShrink: 0,
        }}>
          <div style={{ fontSize: '0.65rem', color: C.muted, fontWeight: 600, marginBottom: 4, paddingLeft: 2 }}>ADD STEP</div>
          {STEP_PALETTE.map(({ type, label, color, hint }) => (
            <button
              key={type}
              onClick={() => addNode(type)}
              title={hint}
              style={{
                background: color + '22', border: `1px solid ${color}66`,
                borderRadius: 4, padding: '7px 10px',
                color: C.text, fontSize: '0.68rem', cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* React Flow canvas */}
        <div style={{ flex: 1, position: 'relative' }}>
          {/* Empty state hint */}
          {nodes.filter(n => n.type !== 'start' && n.type !== 'end').length === 0 && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5,
            }}>
              <div style={{ textAlign: 'center', maxWidth: 280 }}>
                <div style={{ fontSize: '2rem', marginBottom: 8, opacity: 0.15 }}>◈</div>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#3a3a3a', marginBottom: 6 }}>
                  No steps yet
                </div>
                <div style={{ fontSize: '0.7rem', color: '#2a2a2a', lineHeight: 1.6 }}>
                  Click a step type on the left to add it,<br />
                  or use <strong style={{ color: '#1d4ed8' }}>✦ Generate with AI</strong> to build<br />
                  this workflow automatically.
                </div>
              </div>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            style={{ background: C.bg }}
            deleteKeyCode="Delete"
          >
            <Background color="#1a1a1a" gap={20} />
            <Controls style={{ background: '#111', border: `1px solid ${C.border}`, borderRadius: 4 }} />
            <MiniMap
              style={{ background: '#111', border: `1px solid ${C.border}` }}
              nodeColor={() => '#1e3a8a'}
            />
          </ReactFlow>
        </div>

        {/* Right config panel */}
        {selectedNode && (
          <div style={{
            width: 260, borderLeft: `1px solid ${C.border}`,
            overflowY: 'auto', flexShrink: 0,
          }}>
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: C.text }}>Step Config</span>
              <button style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: '0.75rem' }} onClick={() => setSelectedNode(null)}>✕</button>
            </div>
            <NodeConfigPanel
              node={selectedNode}
              onSave={handleNodeSave}
              onReview={handleReview}
              canReview={isAdmin || true}
              connectors={connectors}
            />
          </div>
        )}
      </div>
    </div>
  )
}
