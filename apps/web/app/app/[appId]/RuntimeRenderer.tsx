'use client'

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { type AuraDocument, type AuraEdge, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { runConnectorQuery, type DashboardQueryResponse } from '../../../lib/api'
import { getMissingRequiredProps, hasConnectorBinding, isProductionReadyWidget, isSupportedChartType } from '../../../lib/appValidation'
import { buildChartSeries } from '../../../lib/charting'
import { applyTableDataBinding, getConnectorQuerySQL, getVisibleTableColumns } from '../../../lib/tableBinding'
import { DashboardFilterProvider, useDashboardFilters } from '../../../lib/dashboardFilters'

const CELL = 40
// COLS removed — canvas width is computed dynamically from content

interface Props {
  doc: AuraDocument
  edges: AuraEdge[]
  workspaceId: string
  appId: string
}

// ---- Client-side flow execution engine ------------------------------------

/** portValues['widgetId']['portName'] = value written by the flow engine */
type PortValues = Record<string, Record<string, unknown>>

interface FlowEngine {
  portValues: PortValues
  /** Fire an output port (widget click, form submit, step output) and run downstream. */
  firePort: (nodeId: string, portName: string, value: unknown) => Promise<void>
}

const FlowEngineContext = React.createContext<FlowEngine>({
  portValues: {},
  firePort: async () => {},
})

function useFlowEngine() {
  return useContext(FlowEngineContext)
}

/** Safely evaluate a JS expression string with $input bound to the given value. */
function evalExpression(expression: string, $input: unknown): unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('$input', `return (${expression})`)($input)
  } catch {
    return $input
  }
}

function FlowEngineProvider({
  nodes,
  edges,
  workspaceId,
  children,
}: {
  nodes: AuraNode[]
  edges: AuraEdge[]
  workspaceId: string
  children: React.ReactNode
}) {
  const [portValues, setPortValues] = useState<PortValues>({})

  // Build a lookup: "nodeId.portName" -> edges leaving that port
  const edgeMap = useMemo(() => {
    const map = new Map<string, AuraEdge[]>()
    for (const edge of edges) {
      const key = `${edge.fromNodeId}.${edge.fromPort}`
      const list = map.get(key) ?? []
      list.push(edge)
      map.set(key, list)
    }
    return map
  }, [edges])

  // Node lookup by id
  const nodeMap = useMemo(() => {
    const map = new Map<string, AuraNode>()
    for (const n of nodes) map.set(n.id, n)
    return map
  }, [nodes])

  // firePort is stable across renders; use refs to access latest state
  const edgeMapRef = useRef(edgeMap)
  const nodeMapRef = useRef(nodeMap)
  const workspaceIdRef = useRef(workspaceId)
  useEffect(() => { edgeMapRef.current = edgeMap }, [edgeMap])
  useEffect(() => { nodeMapRef.current = nodeMap }, [nodeMap])
  useEffect(() => { workspaceIdRef.current = workspaceId }, [workspaceId])

  const setPort = useCallback((nodeId: string, portName: string, value: unknown) => {
    setPortValues(prev => ({
      ...prev,
      [nodeId]: { ...(prev[nodeId] ?? {}), [portName]: value },
    }))
  }, [])

  const firePort = useCallback(async (nodeId: string, portName: string, value: unknown): Promise<void> => {
    const downstreamEdges = edgeMapRef.current.get(`${nodeId}.${portName}`) ?? []
    for (const edge of downstreamEdges) {
      const targetNode = nodeMapRef.current.get(edge.toNodeId)
      if (!targetNode) continue

      if (targetNode.element.startsWith('step:')) {
        // Execute the step and fire its output port(s)
        const stepType = targetNode.element
        const w = targetNode.with ?? {}

        if (stepType === 'step:transform') {
          const expression = String(w.expression ?? '$input')
          const result = evalExpression(expression, value)
          await firePort(targetNode.id, 'output', result)

        } else if (stepType === 'step:query' || stepType === 'step:mutation') {
          try {
            const connectorId = String(w.connector ?? '')
            const sql = String(w.sql ?? '')
            if (connectorId && sql) {
              const { runConnectorQuery: runQuery } = await import('../../../lib/api')
              const res = await runQuery(workspaceIdRef.current, connectorId, { sql })
              await firePort(targetNode.id, 'result', res.rows ?? [])
            }
          } catch { /* step error — stop chain */ }

        } else if (stepType === 'step:http') {
          try {
            const method = String(w.method ?? 'GET')
            const url = String(w.url ?? '')
            if (url) {
              const res = await fetch(url, {
                method,
                headers: w.headers ? JSON.parse(String(w.headers)) : undefined,
                body: method !== 'GET' && w.body ? String(w.body) : undefined,
              })
              const json = await res.json().catch(() => null)
              await firePort(targetNode.id, 'responseBody', json)
              await firePort(targetNode.id, 'status', res.status)
              await firePort(targetNode.id, res.ok ? 'ok' : 'error', json)
            }
          } catch { /* network error */ }

        } else if (stepType === 'step:condition') {
          const expression = String(w.expression ?? 'false')
          const result = Boolean(evalExpression(expression, value))
          await firePort(targetNode.id, result ? 'true' : 'false', value)
        }
        // step:approval_gate and step:notification have no client-side execution

      } else {
        // It's a widget — write the value to its incoming port
        setPort(edge.toNodeId, edge.toPort, value)
      }
    }
  }, [setPort])

  const engine = useMemo(() => ({ portValues, firePort }), [portValues, firePort])

  return (
    <FlowEngineContext.Provider value={engine}>
      {children}
    </FlowEngineContext.Provider>
  )
}

/** Reads grid placement from an AuraNode's style map. */
function getGrid(node: AuraNode) {
  const s = node.style ?? {}
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  const defW = meta?.defaultSize.w ?? 4
  const defH = meta?.defaultSize.h ?? 3
  return {
    x: Math.max(0, parseInt(s.gridX ?? '0', 10) || 0),
    y: Math.max(0, parseInt(s.gridY ?? '0', 10) || 0),
    w: Math.max(2, parseInt(s.gridW ?? String(defW), 10) || defW),
    h: Math.max(1, parseInt(s.gridH ?? String(defH), 10) || defH),
  }
}

export function RuntimeRenderer({ doc, edges, workspaceId, appId }: Props) {
  const canvasWidth = React.useMemo(() => {
    let maxRight = 10
    for (const n of doc) {
      const g = getGrid(n)
      maxRight = Math.max(maxRight, g.x + g.w)
    }
    return maxRight * CELL + 120
  }, [doc])

  const canvasHeight = React.useMemo(() => {
    let maxBottom = 10
    for (const n of doc) {
      const g = getGrid(n)
      maxBottom = Math.max(maxBottom, g.y + g.h)
    }
    return maxBottom * CELL + 120
  }, [doc])

  if (doc.length === 0) {
    return <RuntimeStateMessage tone="muted" message="This tool has no content yet." />
  }

  return (
    <FlowEngineProvider nodes={doc} edges={edges} workspaceId={workspaceId}>
    <DashboardFilterProvider>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#0a0a0a',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: canvasWidth,
            minHeight: canvasHeight,
            margin: '0 auto',
          }}
        >
          {doc.filter(node => !node.element.startsWith('step:') && !node.element.startsWith('flow:')).map(node => {
            const g = getGrid(node)
            return (
              <div
                key={node.id}
                style={{
                  position: 'absolute',
                  left: g.x * CELL,
                  top: g.y * CELL,
                  width: g.w * CELL,
                  height: g.h * CELL,
                  border: '1px solid #1a1a1a',
                  borderRadius: 4,
                  overflow: 'hidden',
                  background: '#0f0f0f',
                }}
              >
                <RuntimeWidget node={node} workspaceId={workspaceId} appId={appId} />
              </div>
            )
          })}
        </div>
      </div>
    </DashboardFilterProvider>
    </FlowEngineProvider>
  )
}

// ---------------------------------------------------------------------------
// Per-widget runtime renders
// ---------------------------------------------------------------------------

interface WidgetProps {
  node: AuraNode
  workspaceId: string
  appId: string
}

export function RuntimeStateMessage({ tone, message }: { tone: 'muted' | 'warning' | 'error'; message: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    muted: 'var(--color-text-subtle, #555)',
    warning: 'var(--color-warning, #f59e0b)',
    error: 'var(--color-error, #f87171)',
  }
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '1rem',
        color: colors[tone] ?? colors.muted,
        fontSize: '0.8rem',
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  )
}

function RuntimeConfigurationRequired({ node, missing }: { node: AuraNode; missing: string[] }) {
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  const labels = missing
    .map(propName => meta?.propSchema[propName]?.label ?? propName)
    .join(', ')

  return (
    <RuntimeStateMessage
      message={`${meta?.displayName ?? node.element} requires ${labels} before it can be used.`}
      tone="warning"
    />
  )
}

function RuntimeUnsupportedWidget({ node }: { node: AuraNode }) {
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  return (
    <RuntimeStateMessage
      message={`${meta?.displayName ?? node.element} is not supported in the production runtime yet.`}
      tone="error"
    />
  )
}

function RuntimeWidget({ node, workspaceId, appId }: WidgetProps) {
  if (!isProductionReadyWidget(node.element)) {
    return <RuntimeUnsupportedWidget node={node} />
  }

  switch (node.element) {
    case 'text':     return <RuntimeText node={node} />
    case 'button':   return <RuntimeButton node={node} workspaceId={workspaceId} appId={appId} />
    case 'table':    return <RuntimeTable node={node} workspaceId={workspaceId} appId={appId} />
    case 'form':     return <RuntimeForm node={node} workspaceId={workspaceId} appId={appId} />
    case 'kpi':      return <RuntimeKPI node={node} />
    case 'chart':    return <RuntimeChart node={node} workspaceId={workspaceId} appId={appId} />
    case 'filter':   return <RuntimeFilter node={node} workspaceId={workspaceId} />
    case 'markdown': return <RuntimeMarkdown node={node} />
    default:
      return <RuntimeUnsupportedWidget node={node} />
  }
}

function RuntimeText({ node }: { node: AuraNode }) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const { portValues } = useFlowEngine()
  const dynamicContent = portValues[node.id]?.['setContent']
  const content = dynamicContent !== undefined ? String(dynamicContent) : (node.text ?? node.value ?? '')
  const variant = node.style?.variant ?? 'body'
  const fz = variant === 'heading1' ? '1.5rem' : variant === 'heading2' ? '1.125rem' : variant === 'caption' ? '0.75rem' : '0.875rem'
  const fw = variant === 'heading1' || variant === 'heading2' ? 700 : 400
  const color = variant === 'heading1' || variant === 'heading2' ? '#e5e5e5' : '#aaa'
  return (
    <div style={{ padding: '0.75rem', height: '100%', overflow: 'hidden' }}>
      <p style={{ margin: 0, fontSize: fz, fontWeight: fw, color, lineHeight: 1.4 }}>{content}</p>
    </div>
  )
}

function RuntimeButton({ node, workspaceId, appId }: WidgetProps) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const { bumpRefreshSeq } = useDashboardFilters()
  const { firePort } = useFlowEngine()
  const variant = node.style?.variant ?? 'primary'
  const bg = variant === 'danger' ? '#7f1d1d' : variant === 'secondary' ? '#1a1a1a' : '#1d4ed8'
  const hoverBg = variant === 'danger' ? '#991b1b' : variant === 'secondary' ? '#252525' : '#1e40af'
  const color = variant === 'danger' ? '#fca5a5' : variant === 'secondary' ? '#ccc' : '#fff'

  async function handleClick() {
    if (status === 'pending') return
    setStatus('pending')
    setStatusMessage('')
    try {
      if (node.action) {
        const { triggerWorkflow } = await import('../../../lib/api')
        const run = await triggerWorkflow(workspaceId, appId, node.action, {})
        if (run.status === 'awaiting_approval') {
          setStatusMessage('Submitted for approval')
        } else {
          setStatusMessage('Processing…')
          bumpRefreshSeq()
        }
      } else {
        // Fire the flow engine for this button's clicked port
        await firePort(node.id, 'clicked', true)
        bumpRefreshSeq()
      }
      setStatus('done')
      setTimeout(() => { setStatus('idle'); setStatusMessage('') }, 3000)
    } catch (err) {
      setStatus('error')
      setStatusMessage(err instanceof Error ? err.message : 'An error occurred')
      setTimeout(() => { setStatus('idle'); setStatusMessage('') }, 3000)
    }
  }

  const { portValues } = useFlowEngine()
  const dynamicLabel = portValues[node.id]?.['setLabel']
  const dynamicDisabled = portValues[node.id]?.['setDisabled']
  const baseLabel = dynamicLabel !== undefined ? String(dynamicLabel) : (node.text ?? '')
  const label = status === 'pending' ? 'Submitting…' : (status !== 'idle' && statusMessage) ? statusMessage : baseLabel

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem' }}>
      <button
        onClick={handleClick}
        disabled={status === 'pending' || Boolean(dynamicDisabled)}
        style={{
          background: bg,
          border: variant === 'secondary' ? '1px solid #333' : 'none',
          borderRadius: 6,
          color,
          cursor: status === 'pending' ? 'default' : 'pointer',
          fontSize: '0.875rem',
          fontWeight: 500,
          padding: '0.5rem 1.25rem',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (status === 'idle') (e.currentTarget as HTMLButtonElement).style.background = hoverBg }}
        onMouseLeave={e => { if (status === 'idle') (e.currentTarget as HTMLButtonElement).style.background = bg }}
      >
        {label}
      </button>
    </div>
  )
}

function parseFilterLinks(
  filterWidgets: string | undefined,
  filterWidgetColumns: string | undefined,
  filterWidget: string | undefined,
  filterWidgetColumn: string | undefined,
): Array<{ widgetId: string; column: string }> {
  const ids = (filterWidgets ?? '').split(';').map(s => s.trim()).filter(Boolean)
  if (ids.length > 0) {
    const cols = (filterWidgetColumns ?? '').split(';').map(s => s.trim())
    return ids.map((id, i) => ({ widgetId: id, column: cols[i] ?? '' }))
  }
  if (filterWidget?.trim()) {
    return [{ widgetId: filterWidget.trim(), column: filterWidgetColumn?.trim() ?? '' }]
  }
  return []
}

function RuntimeTable({ node, workspaceId }: WidgetProps) {
  const connectorId: string | undefined = node.with?.connector
  const connectorType: string | undefined = node.with?.connectorType
  const sql: string | undefined = node.with?.sql
  const configuredColumns = node.style?.columns ?? ''
  const filterLinks = parseFilterLinks(node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn)
  const hasBinding = hasConnectorBinding(node)
  const querySql = getConnectorQuerySQL(connectorType, sql)
  const { values: dashboardFilters, refreshSeq } = useDashboardFilters()
  const { portValues } = useFlowEngine()
  const tablePorts = portValues[node.id] ?? {}

  // refresh port — trigger a re-fetch
  const [localRefreshSeq, setLocalRefreshSeq] = useState(0)
  const prevTableRefreshRef = useRef<unknown>(undefined)
  useEffect(() => {
    const trigger = tablePorts['refresh']
    if (trigger !== undefined && trigger !== prevTableRefreshRef.current) {
      prevTableRefreshRef.current = trigger
      setLocalRefreshSeq(s => s + 1)
    }
  })

  // setRows port — override displayed rows entirely
  const overrideRows = tablePorts['setRows'] as Array<Record<string, unknown>> | undefined
  // setFilter port — apply additional {column: value} filter pairs
  const overrideFilter = tablePorts['setFilter'] as Record<string, string> | undefined

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectorId || querySql === null) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    runConnectorQuery(workspaceId, connectorId, {
      sql: querySql,
      limit: connectorType === 'csv' ? 100 : undefined,
    })
      .then(res => {
        if (cancelled) return
        if (res.error) {
          setError(res.error)
          setData(null)
          return
        }
        setData(res)
      })
      .catch(err => {
        if (!cancelled) setError(String(err?.message ?? err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, connectorId, connectorType, querySql, refreshSeq, localRefreshSeq])

  const effectiveTableData: DashboardQueryResponse | null = overrideRows
    ? { rows: overrideRows, columns: overrideRows.length > 0 ? Object.keys(overrideRows[0]) : [] }
    : data

  const boundData = applyTableDataBinding(effectiveTableData, {
    filters: [
      ...filterLinks.map(link => ({ column: link.column, value: dashboardFilters[link.widgetId] ?? '' })),
      ...(overrideFilter ? Object.entries(overrideFilter).map(([column, value]) => ({ column, value })) : []),
    ],
    filterColumn: node.with?.filterColumn,
    filterValue: node.with?.filterValue,
    aggregate: node.with?.aggregate,
    groupBy: node.with?.groupBy,
    aggregateColumn: node.with?.aggregateColumn,
  })
  const cols = getVisibleTableColumns(boundData, configuredColumns)
  const rows = boundData?.rows ?? []
  const runtimeError = boundData?.error ?? error

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '0.5rem' }}>
      {loading && <RuntimeStateMessage tone="muted" message="Loading table data…" />}
      {!loading && runtimeError && <RuntimeStateMessage tone="error" message="Couldn't load data right now. Try refreshing the page." />}
      {!loading && !runtimeError && cols.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr>
              {cols.map((col: string) => (
                <th key={col} style={{
                  textAlign: 'left', padding: '4px 8px', color: '#666',
                  borderBottom: '1px solid #1e1e1e', fontWeight: 500,
                  textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.7rem',
                }}>{col}</th>
              ))}
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #111' }}>
                  {cols.map((col: string) => (
                    <td key={col} style={{ padding: '6px 8px', color: '#ccc', fontSize: '0.78rem' }}>
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      )}
      {!loading && !runtimeError && !hasBinding && (
        <RuntimeStateMessage tone="warning" message="Data not connected yet. Open this tool in the builder to add a data source." />
      )}
      {!loading && !runtimeError && hasBinding && rows.length === 0 && (
        <RuntimeStateMessage tone="muted" message="No rows match the current data binding." />
      )}
    </div>
  )
}

function RuntimeForm({ node, workspaceId, appId }: WidgetProps) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const rawFields = node.style?.fields ?? node.with?.fields ?? ''
  const fields = rawFields.split(',').map((f: string) => f.trim()).filter(Boolean)
  const [values, setValues] = useState<Record<string, string>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const { bumpRefreshSeq } = useDashboardFilters()
  const { portValues, firePort } = useFlowEngine()
  const formPorts = portValues[node.id] ?? {}

  // setValues port — populate fields programmatically
  const inboundFormValues = formPorts['setValues'] as Record<string, string> | undefined
  const prevInboundFormRef = useRef<unknown>(undefined)
  useEffect(() => {
    if (inboundFormValues && inboundFormValues !== prevInboundFormRef.current) {
      prevInboundFormRef.current = inboundFormValues
      setValues(prev => ({ ...prev, ...inboundFormValues }))
    }
  })

  // setErrors port — show per-field validation errors
  const inboundFormErrors = formPorts['setErrors'] as Record<string, string> | undefined
  const prevFormErrorsRef = useRef<unknown>(undefined)
  useEffect(() => {
    if (inboundFormErrors && inboundFormErrors !== prevFormErrorsRef.current) {
      prevFormErrorsRef.current = inboundFormErrors
      setFieldErrors(inboundFormErrors)
    }
  })

  // reset port — clear all fields and errors
  const formResetTrigger = formPorts['reset']
  const prevFormResetRef = useRef<unknown>(undefined)
  useEffect(() => {
    if (formResetTrigger !== undefined && formResetTrigger !== prevFormResetRef.current) {
      prevFormResetRef.current = formResetTrigger
      setValues({})
      setFieldErrors({})
    }
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (status === 'pending') return
    setStatus('pending')
    setStatusMessage('')
    try {
      if (node.action) {
        const { triggerWorkflow } = await import('../../../lib/api')
        const inputData: Record<string, unknown> = { ...values }
        const run = await triggerWorkflow(workspaceId, appId, node.action, inputData)
        if (run.status === 'awaiting_approval') {
          setStatusMessage('Submitted for approval')
        } else {
          setStatusMessage('Processing…')
          bumpRefreshSeq()
        }
        setValues({})
      } else {
        // Fire the flow engine 'submitted' port with form values
        await firePort(node.id, 'submitted', { ...values })
        bumpRefreshSeq()
        setValues({})
      }
      setStatus('done')
      setTimeout(() => { setStatus('idle'); setStatusMessage('') }, 4000)
    } catch (err) {
      setStatus('error')
      setStatusMessage(err instanceof Error ? err.message : 'Submission failed. Try again.')
      setTimeout(() => { setStatus('idle'); setStatusMessage('') }, 3000)
    }
  }

  if (status === 'done') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4ade80', fontSize: '0.875rem' }}>
        {statusMessage || 'Submitted for review'}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} style={{ padding: '0.75rem', height: '100%', overflow: 'auto' }}>
      {fields.map((field: string) => (
        <div key={field} style={{ marginBottom: '0.75rem' }}>
          <label style={{ display: 'block', color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem', textTransform: 'capitalize' }}>
            {field}
          </label>
          <input
            type="text"
            value={values[field] ?? ''}
            onChange={e => setValues(prev => ({ ...prev, [field]: e.target.value }))}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#141414',
              border: fieldErrors[field] ? '1px solid #f87171' : '1px solid #2a2a2a',
              borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem',
              padding: '0.4rem 0.5rem',
            }}
          />
          {fieldErrors[field] && (
            <p style={{ color: '#f87171', fontSize: '0.7rem', margin: '2px 0 0' }}>{fieldErrors[field]}</p>
          )}
        </div>
      ))}
      {status === 'error' && (
        <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>{statusMessage || 'Submission failed. Try again.'}</p>
      )}
      <button
        type="submit"
        disabled={status === 'pending'}
        style={{
          background: status === 'pending' ? '#1e3a8a66' : '#1d4ed8',
          border: 'none', borderRadius: 4, color: status === 'pending' ? '#93c5fd66' : '#fff',
          cursor: status === 'pending' ? 'default' : 'pointer',
          fontSize: '0.8rem', fontWeight: 500, padding: '0.4rem 1rem',
        }}
      >
        {status === 'pending' ? 'Submitting…' : (node.style?.submitLabel ?? node.text ?? 'Submit')}
      </button>
    </form>
  )
}

function RuntimeKPI({ node }: { node: AuraNode }) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const label = node.style?.label ?? node.text ?? ''
  const { portValues } = useFlowEngine()
  const kpiPorts = portValues[node.id] ?? {}
  const value = kpiPorts['setValue'] !== undefined ? String(kpiPorts['setValue']) : (node.value ?? '')
  const prefix = node.style?.prefix ?? ''
  const suffix = node.style?.suffix ?? ''
  const trend = kpiPorts['setTrend'] !== undefined ? String(kpiPorts['setTrend']) : (node.style?.trend ?? '')
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '1rem 1.25rem' }}>
      <p style={{ margin: '0 0 0.25rem', color: '#666', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
      <p style={{ margin: 0, color: '#e5e5e5', fontSize: '1.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {prefix}{value}{suffix}
      </p>
      {trend && (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: trend.startsWith('-') ? '#f87171' : '#4ade80' }}>
          {trend}
        </p>
      )}
    </div>
  )
}

function RuntimeChart({ node, workspaceId }: WidgetProps) {
  const chartType = (node.style?.type ?? 'bar').trim() || 'bar'
  const connectorId: string | undefined = node.with?.connector
  const connectorType: string | undefined = node.with?.connectorType
  const sql: string | undefined = node.with?.sql
  const filterLinks = parseFilterLinks(node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn)
  const labelCol: string = node.with?.labelCol ?? node.style?.labelCol ?? ''
  const valueCol: string = node.with?.valueCol ?? node.style?.valueCol ?? ''
  const aggregate = node.with?.aggregate ?? 'none'
  const sortBy = node.with?.sortBy ?? 'none'
  const sortDirection = node.with?.sortDirection ?? 'desc'
  const pointLimit = node.with?.limit ?? '20'
  const hasBinding = hasConnectorBinding(node)
  const supportedType = isSupportedChartType(chartType)
  const querySql = getConnectorQuerySQL(connectorType, sql)
  const { values: dashboardFilters, refreshSeq } = useDashboardFilters()
  const { portValues } = useFlowEngine()
  const chartPorts = portValues[node.id] ?? {}
  const overrideChartData = chartPorts['setData'] as Array<Record<string, unknown>> | undefined
  const [chartLocalRefreshSeq, setChartLocalRefreshSeq] = useState(0)
  const prevChartRefreshRef = useRef<unknown>(undefined)
  useEffect(() => {
    const trigger = chartPorts['refresh']
    if (trigger !== undefined && trigger !== prevChartRefreshRef.current) {
      prevChartRefreshRef.current = trigger
      setChartLocalRefreshSeq(s => s + 1)
    }
  })

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectorId || querySql === null) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    runConnectorQuery(workspaceId, connectorId, {
      sql: querySql,
      limit: connectorType === 'csv' ? 100 : 50,
    })
      .then(res => {
        if (cancelled) return
        if (res.error) {
          setError(res.error)
          setData(null)
          return
        }
        setData(res)
      })
      .catch(err => { if (!cancelled) setError(String(err?.message ?? err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, connectorId, connectorType, querySql, refreshSeq, chartLocalRefreshSeq])

  const effectiveChartData: DashboardQueryResponse | null = overrideChartData
    ? { rows: overrideChartData, columns: overrideChartData.length > 0 ? Object.keys(overrideChartData[0]) : [] }
    : data

  const series = React.useMemo(
    () => buildChartSeries(effectiveChartData, {
      labelCol,
      valueCol,
      aggregate,
      sortBy,
      sortDirection,
      limit: pointLimit,
      filters: [
        ...filterLinks.map(link => ({ column: link.column, value: dashboardFilters[link.widgetId] ?? '' })),
        {
          column: node.with?.filterColumn,
          value: node.with?.filterValue,
        },
      ],
    }),
    [aggregate, dashboardFilters, effectiveChartData, labelCol, pointLimit, sortBy, sortDirection, valueCol, node.with?.filterColumn, node.with?.filterValue, node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn],
  )
  const maxValue = Math.max(...series.points.map(point => Math.abs(point.value)), 1)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
      <p style={{ margin: '0 0 0.5rem', color: '#555', fontSize: '0.7rem' }}>{chartType} chart</p>
      {loading ? (
        <RuntimeStateMessage tone="muted" message="Loading chart data…" />
      ) : error ? (
        <RuntimeStateMessage tone="error" message="Couldn't load data right now. Try refreshing the page." />
      ) : !supportedType ? (
        <RuntimeStateMessage message={`Chart type "${chartType}" is not supported in the production runtime.`} tone="error" />
      ) : !hasBinding ? (
        <RuntimeStateMessage tone="warning" message="Data not connected yet. Open this tool in the builder to add a data source." />
      ) : series.error ? (
        <RuntimeStateMessage message={series.error} tone="warning" />
      ) : series.points.length === 0 ? (
        <RuntimeStateMessage tone="muted" message="No rows match the current data binding." />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 6, minHeight: 0 }}>
          {series.points.map((bar, i) => {
            const pct = Math.max((Math.abs(bar.value) / maxValue) * 100, 4)
            const formatted = Number.isInteger(bar.value)
              ? bar.value.toLocaleString()
              : bar.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
            return (
              <div
                key={`${bar.label}-${i}`}
                title={`${bar.label}: ${formatted}`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 0, height: '100%', cursor: 'default' }}
              >
                {/* Value label above bar */}
                <div
                  style={{
                    color: '#93c5fd',
                    fontSize: '0.62rem',
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginBottom: 2,
                    opacity: pct < 15 ? 0 : 1,
                  }}
                >
                  {formatted}
                </div>
                <div
                  style={{
                    height: `${pct}%`,
                    background: '#1e40af',
                    borderRadius: '2px 2px 0 0',
                    opacity: 0.85,
                    position: 'relative',
                    transition: 'opacity 0.1s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.opacity = '1' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.opacity = '0.85' }}
                >
                  {/* Inline value for short bars where label above is hidden */}
                  {pct < 15 && (
                    <div style={{
                      position: 'absolute',
                      bottom: '100%',
                      left: 0,
                      right: 0,
                      textAlign: 'center',
                      color: '#93c5fd',
                      fontSize: '0.55rem',
                      fontVariantNumeric: 'tabular-nums',
                      pointerEvents: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      padding: '0 2px',
                    }}>
                      {formatted}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    color: '#666',
                    fontSize: '0.6rem',
                    marginTop: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                  }}
                >
                  {bar.label || ' '}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RuntimeFilter({ node, workspaceId }: { node: AuraNode; workspaceId: string }) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const label = node.text ?? node.style?.label ?? 'Filter'
  const placeholder = node.style?.placeholder ?? 'Type to filter…'
  const staticOptions = parseFilterOptions(node.style?.options)
  const { values, setFilterValue } = useDashboardFilters()
  const { portValues } = useFlowEngine()
  const filterPortValues = portValues[node.id] ?? {}

  // setValue port — set the current filter value programmatically
  const inboundFilterValue = filterPortValues['setValue'] as string | undefined
  const prevFilterValueRef = useRef<unknown>(undefined)
  useEffect(() => {
    if (inboundFilterValue !== undefined && inboundFilterValue !== prevFilterValueRef.current) {
      prevFilterValueRef.current = inboundFilterValue
      setFilterValue(node.id, inboundFilterValue)
    }
  })

  // setOptions port — override dropdown options
  const inboundOptions = filterPortValues['setOptions'] as string[] | undefined

  const value = values[node.id] ?? ''

  const optionsConnectorId = node.with?.optionsConnector ?? ''
  const optionsColumn = node.with?.optionsColumn ?? ''
  const optionsConnectorType = node.with?.optionsConnectorType ?? ''
  const [dynamicOptions, setDynamicOptions] = useState<string[]>([])

  const optionsEndpoint = node.with?.optionsEndpoint ?? ''

  useEffect(() => {
    if (!optionsConnectorId || !optionsColumn || !workspaceId) {
      setDynamicOptions([])
      return
    }
    const querySql =
      optionsConnectorType === 'csv'     ? 'SELECT * FROM csv' :
      optionsConnectorType === 'managed' ? '' :
      optionsConnectorType === 'rest'    ? (optionsEndpoint || '/') :
      null
    if (querySql === null) {
      setDynamicOptions([])
      return
    }
    let cancelled = false
    runConnectorQuery(workspaceId, optionsConnectorId, { sql: querySql, limit: 200 })
      .then(res => {
        if (cancelled || res.error) return
        const vals = Array.from(
          new Set(res.rows.map((r: Record<string, unknown>) => String(r[optionsColumn] ?? '')).filter(Boolean))
        ).sort() as string[]
        setDynamicOptions(vals)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId, optionsConnectorId, optionsColumn, optionsConnectorType, optionsEndpoint])

  const resolvedOptions = inboundOptions ?? (dynamicOptions.length > 0 ? dynamicOptions : staticOptions)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0.75rem', gap: '0.4rem' }}>
      <label style={{ color: '#888', fontSize: '0.72rem', fontWeight: 600 }}>{label}</label>
      {resolvedOptions.length > 0 ? (
        <select
          value={value}
          onChange={e => setFilterValue(node.id, e.target.value)}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#141414',
            border: '1px solid #2a2a2a',
            borderRadius: 4,
            color: '#e5e5e5',
            fontSize: '0.8rem',
            padding: '0.4rem 0.5rem',
            appearance: 'auto',
          }}
        >
          <option value="">All</option>
          {resolvedOptions.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => setFilterValue(node.id, e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#141414',
            border: '1px solid #2a2a2a',
            borderRadius: 4,
            color: '#e5e5e5',
            fontSize: '0.8rem',
            padding: '0.4rem 0.5rem',
          }}
        />
      )}
    </div>
  )
}

function parseFilterOptions(rawOptions: string | undefined): string[] {
  return (rawOptions ?? '')
    .split(',')
    .map(option => option.trim())
    .filter(Boolean)
}

function RuntimeMarkdown({ node }: { node: AuraNode }) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <RuntimeConfigurationRequired node={node} missing={missing} />

  const { portValues } = useFlowEngine()
  const dynamicMarkdownContent = portValues[node.id]?.['setContent']
  const content = dynamicMarkdownContent !== undefined ? String(dynamicMarkdownContent) : (node.style?.content ?? node.text ?? '')
  // Minimal markdown rendering without a library — just paragraphs
  const lines = content.split('\n')
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '0.75rem', color: '#aaa', fontSize: '0.8rem', lineHeight: 1.6 }}>
      {lines.map((line, i) => {
        if (line.startsWith('# ')) return <h1 key={i} style={{ color: '#e5e5e5', fontSize: '1.2rem', margin: '0 0 0.5rem' }}>{line.slice(2)}</h1>
        if (line.startsWith('## ')) return <h2 key={i} style={{ color: '#e5e5e5', fontSize: '1rem', margin: '0 0 0.5rem' }}>{line.slice(3)}</h2>
        if (line.startsWith('### ')) return <h3 key={i} style={{ color: '#e5e5e5', fontSize: '0.875rem', margin: '0 0 0.5rem' }}>{line.slice(4)}</h3>
        if (line === '') return <br key={i} />
        return <p key={i} style={{ margin: '0 0 0.25rem' }}>{line}</p>
      })}
    </div>
  )
}
