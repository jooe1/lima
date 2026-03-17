'use client'

import React, { useEffect, useState } from 'react'
import { type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { runConnectorQuery, type DashboardQueryResponse } from '../../../lib/api'

const CELL = 40
// COLS removed — canvas width is computed dynamically from content

interface Props {
  doc: AuraDocument
  workspaceId: string
  appId: string
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

export function RuntimeRenderer({ doc, workspaceId, appId }: Props) {
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
    return (
      <div style={{ padding: '3rem', color: '#555', textAlign: 'center' }}>
        This app has no widgets yet.
      </div>
    )
  }

  return (
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
        {doc.map(node => {
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

function RuntimeWidget({ node, workspaceId, appId }: WidgetProps) {
  switch (node.element) {
    case 'text':     return <RuntimeText node={node} />
    case 'button':   return <RuntimeButton node={node} workspaceId={workspaceId} appId={appId} />
    case 'table':    return <RuntimeTable node={node} workspaceId={workspaceId} appId={appId} />
    case 'form':     return <RuntimeForm node={node} workspaceId={workspaceId} appId={appId} />
    case 'kpi':      return <RuntimeKPI node={node} />
    case 'chart':    return <RuntimeChart node={node} workspaceId={workspaceId} appId={appId} />
    case 'filter':   return <RuntimeFilter node={node} />
    case 'markdown': return <RuntimeMarkdown node={node} />
    case 'container':
    case 'modal':
    case 'tabs':
    default:
      return <RuntimePlaceholder node={node} />
  }
}

function RuntimeText({ node }: { node: AuraNode }) {
  const content = node.text ?? node.value ?? ''
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
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle')
  const variant = node.style?.variant ?? 'primary'
  const bg = variant === 'danger' ? '#7f1d1d' : variant === 'secondary' ? '#1a1a1a' : '#1d4ed8'
  const hoverBg = variant === 'danger' ? '#991b1b' : variant === 'secondary' ? '#252525' : '#1e40af'
  const color = variant === 'danger' ? '#fca5a5' : variant === 'secondary' ? '#ccc' : '#fff'

  async function handleClick() {
    if (status === 'pending') return
    setStatus('pending')
    try {
      const { createApproval } = await import('../../../lib/api')
      await createApproval(workspaceId, {
        app_id: appId,
        description: `Button action: ${node.text ?? node.id}`,
        payload: { node_id: node.id, element: node.element, app_id: appId },
      })
      setStatus('done')
      setTimeout(() => setStatus('idle'), 3000)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  const label = status === 'pending' ? 'Submitting…' : status === 'done' ? 'Submitted for review' : status === 'error' ? 'Error' : (node.text ?? 'Button')

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem' }}>
      <button
        onClick={handleClick}
        disabled={status === 'pending'}
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

function RuntimeTable({ node, workspaceId }: WidgetProps) {
  const connectorId: string | undefined = node.with?.connector
  const sql: string | undefined = node.with?.sql
  const rawCols = node.style?.columns ?? node.with?.columns ?? 'id, name, status'
  const staticCols = rawCols.split(',').map((c: string) => c.trim()).filter(Boolean)

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectorId || !sql) return
    let cancelled = false
    setLoading(true)
    setError(null)
    runConnectorQuery(workspaceId, connectorId, { sql })
      .then(res => { if (!cancelled) setData(res) })
      .catch(err => { if (!cancelled) setError(String(err?.message ?? err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, connectorId, sql])

  const cols = data?.columns ?? staticCols
  const rows = data?.rows ?? []
  const hasLiveData = Boolean(connectorId && sql)

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '0.5rem' }}>
      {loading && (
        <p style={{ margin: '0.5rem', color: '#555', fontSize: '0.75rem' }}>Loading…</p>
      )}
      {error && (
        <p style={{ margin: '0.5rem', color: '#f87171', fontSize: '0.75rem' }}>{error}</p>
      )}
      {!loading && (
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
          <tbody>
            {hasLiveData
              ? rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #111' }}>
                    {cols.map((col: string) => (
                      <td key={col} style={{ padding: '6px 8px', color: '#ccc', fontSize: '0.78rem' }}>
                        {String(row[col] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))
              : [1, 2, 3].map(r => (
                  <tr key={r} style={{ borderBottom: '1px solid #111' }}>
                    {cols.map((col: string) => (
                      <td key={col} style={{ padding: '6px 8px' }}>
                        <div style={{ height: 12, background: '#181818', borderRadius: 2, width: '70%' }} />
                      </td>
                    ))}
                  </tr>
                ))
            }
          </tbody>
        </table>
      )}
      {!hasLiveData && !loading && (
        <p style={{ margin: '0.5rem 0 0', color: '#333', fontSize: '0.65rem' }}>
          Connect a data source to display live data.
        </p>
      )}
    </div>
  )
}

function RuntimeForm({ node, workspaceId, appId }: WidgetProps) {
  const rawFields = node.style?.fields ?? node.with?.fields ?? 'name, email'
  const fields = rawFields.split(',').map((f: string) => f.trim()).filter(Boolean)
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (status === 'pending') return
    setStatus('pending')
    try {
      const { createApproval } = await import('../../../lib/api')
      await createApproval(workspaceId, {
        app_id: appId,
        description: `Form submission: ${node.id}`,
        payload: { node_id: node.id, element: 'form', values, app_id: appId },
      })
      setStatus('done')
      setValues({})
      setTimeout(() => setStatus('idle'), 4000)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  if (status === 'done') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4ade80', fontSize: '0.875rem' }}>
        Submitted for review
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
              background: '#141414', border: '1px solid #2a2a2a',
              borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem',
              padding: '0.4rem 0.5rem',
            }}
          />
        </div>
      ))}
      {status === 'error' && (
        <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>Submission failed. Try again.</p>
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
  const label = node.style?.label ?? node.text ?? 'KPI'
  const value = node.value ?? '—'
  const prefix = node.style?.prefix ?? ''
  const suffix = node.style?.suffix ?? ''
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '1rem 1.25rem' }}>
      <p style={{ margin: '0 0 0.25rem', color: '#666', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
      <p style={{ margin: 0, color: '#e5e5e5', fontSize: '1.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {prefix}{value}{suffix}
      </p>
    </div>
  )
}

function RuntimeChart({ node, workspaceId }: WidgetProps) {
  const chartType = node.style?.type ?? 'bar'
  const connectorId: string | undefined = node.with?.connector
  const sql: string | undefined = node.with?.sql
  const labelCol: string = node.with?.labelCol ?? node.style?.labelCol ?? ''
  const valueCol: string = node.with?.valueCol ?? node.style?.valueCol ?? ''

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectorId || !sql) return
    let cancelled = false
    setLoading(true)
    setError(null)
    runConnectorQuery(workspaceId, connectorId, { sql, limit: 50 })
      .then(res => { if (!cancelled) setData(res) })
      .catch(err => { if (!cancelled) setError(String(err?.message ?? err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, connectorId, sql])

  // Resolve bar data: use live rows if available, otherwise placeholder heights
  const hasLiveData = Boolean(connectorId && sql && data && !error)
  const barData: { label: string; value: number }[] = React.useMemo(() => {
    if (!hasLiveData || !data) return [40, 65, 50, 80, 55, 75, 45].map((v, i) => ({ label: String(i), value: v }))
    const vc = valueCol || data.columns[1] || data.columns[0] || ''
    const lc = labelCol || data.columns[0] || ''
    const maxVal = Math.max(...data.rows.map(r => Number(r[vc]) || 0), 1)
    return data.rows.slice(0, 20).map(r => ({
      label: String(r[lc] ?? ''),
      value: Math.round(((Number(r[vc]) || 0) / maxVal) * 100),
    }))
  }, [hasLiveData, data, labelCol, valueCol])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
      <p style={{ margin: '0 0 0.5rem', color: '#555', fontSize: '0.7rem' }}>{chartType} chart</p>
      {loading && <p style={{ color: '#555', fontSize: '0.7rem' }}>Loading…</p>}
      {error && <p style={{ color: '#f87171', fontSize: '0.7rem' }}>{error}</p>}
      {!loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 4 }}>
          {barData.map((bar, i) => (
            <div key={i} title={`${bar.label}: ${bar.value}`} style={{ flex: 1, height: `${Math.max(bar.value, 4)}%`, background: '#1e40af', borderRadius: '2px 2px 0 0', opacity: 0.8 }} />
          ))}
        </div>
      )}
      {!connectorId && !loading && (
        <p style={{ margin: '0.5rem 0 0', color: '#333', fontSize: '0.65rem' }}>Connect a data source to display live data.</p>
      )}
    </div>
  )
}

function RuntimeFilter({ node }: { node: AuraNode }) {
  const label = node.style?.label ?? node.text ?? 'Filter'
  const [value, setValue] = useState('')
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', padding: '0.5rem 0.75rem', gap: '0.5rem' }}>
      <label style={{ color: '#888', fontSize: '0.75rem', flexShrink: 0 }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Filter…"
        style={{
          flex: 1, background: '#141414', border: '1px solid #2a2a2a',
          borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem', padding: '0.3rem 0.5rem',
        }}
      />
    </div>
  )
}

function RuntimeMarkdown({ node }: { node: AuraNode }) {
  const content = node.style?.content ?? node.text ?? ''
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

function RuntimePlaceholder({ node }: { node: AuraNode }) {
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: '0.75rem' }}>
      {meta?.displayName ?? node.element}
    </div>
  )
}
