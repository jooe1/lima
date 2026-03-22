'use client'

import React, { useEffect, useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY } from '@lima/widget-catalog'
import { runConnectorQuery, type DashboardQueryResponse } from '../../../../lib/api'

interface Props {
  node: AuraNode
  selected: boolean
  workspaceId: string
}

export function WidgetRenderer({ node, workspaceId }: Props) {
  const meta = WIDGET_REGISTRY[node.element as keyof typeof WIDGET_REGISTRY]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontSize: '0.75rem', userSelect: 'none', overflow: 'hidden' }}>
      {/* Widget label bar */}
      <div style={{
        background: '#0d0d0d',
        padding: '3px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderBottom: '1px solid #1e1e1e',
        flexShrink: 0,
      }}>
        <span style={{ color: '#555', fontSize: '0.65rem', fontWeight: 500 }}>
          {meta?.displayName ?? node.element}
        </span>
        <span style={{ color: '#333', fontSize: '0.6rem', marginLeft: 'auto', fontFamily: 'monospace' }}>
          {node.id}
        </span>
      </div>
      {/* Widget body */}
      <div style={{ flex: 1, overflow: 'hidden', padding: 6 }}>
        {renderBody(node, workspaceId)}
      </div>
    </div>
  )
}

function renderBody(node: AuraNode, workspaceId: string): React.ReactNode {
  const dim: React.CSSProperties = { color: '#444', fontSize: '0.65rem' }

  switch (node.element) {
    case 'table': {
      return <CanvasTablePreview node={node} workspaceId={workspaceId} />
    }

    case 'form': {
      const fields = (node.style?.fields ?? 'name, email')
        .split(',').map(f => f.trim()).slice(0, 3)
      return (
        <div>
          {fields.map(f => (
            <div key={f} style={{ marginBottom: 8 }}>
              <div style={{ color: '#555', fontSize: '0.6rem', marginBottom: 2 }}>{f}</div>
              <div style={{ height: 20, background: '#161616', borderRadius: 3, border: '1px solid #222' }} />
            </div>
          ))}
          <div style={{ marginTop: 8, display: 'inline-block', background: '#1d4ed8', borderRadius: 3, padding: '3px 12px', color: '#c7d9ff', fontSize: '0.65rem' }}>
            {node.text ?? node.style?.submitLabel ?? 'Submit'}
          </div>
        </div>
      )
    }

    case 'text': {
      const content = node.text ?? node.value ?? 'Text content'
      const variant = node.style?.variant ?? 'body'
      const fz = variant === 'heading1' ? '1.1rem' : variant === 'heading2' ? '0.9rem' : variant === 'caption' ? '0.6rem' : '0.75rem'
      const fw = variant === 'heading1' || variant === 'heading2' ? 600 : 400
      return (
        <div style={{ color: '#aaa', fontSize: fz, fontWeight: fw, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
          {content}
        </div>
      )
    }

    case 'button': {
      const variant = node.style?.variant ?? 'primary'
      const bg = variant === 'danger' ? '#450a0a' : variant === 'secondary' ? '#1a1a1a' : '#1e3a8a'
      const color = variant === 'danger' ? '#fca5a5' : variant === 'secondary' ? '#aaa' : '#bfdbfe'
      const border = variant === 'secondary' ? '1px solid #333' : 'none'
      return (
        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: bg, border, borderRadius: 4, padding: '4px 14px', color, fontSize: '0.75rem' }}>
          {node.text ?? 'Button'}
        </div>
      )
    }

    case 'chart': {
      const type = node.style?.type ?? 'bar'
      const heights = [55, 80, 45, 70, 60, 90, 35]
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={dim}>{type} chart</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 3, paddingBottom: 4, borderBottom: '1px solid #222' }}>
            {heights.map((h, i) => (
              <div key={i} style={{ flex: 1, height: `${h}%`, background: '#1e3a8a', borderRadius: '2px 2px 0 0', opacity: 0.7 }} />
            ))}
          </div>
        </div>
      )
    }

    case 'kpi': {
      const val = node.value ?? '—'
      const label = node.text ?? node.style?.label ?? 'Metric'
      const trend = node.style?.trend
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#e5e5e5', fontVariantNumeric: 'tabular-nums' }}>
            {node.style?.prefix ?? ''}{val}{node.style?.suffix ?? ''}
          </div>
          <div style={{ fontSize: '0.65rem', color: '#555' }}>{label}</div>
          {trend && <div style={{ fontSize: '0.6rem', color: parseFloat(trend) >= 0 ? '#4ade80' : '#f87171' }}>{trend}</div>}
        </div>
      )
    }

    case 'filter': {
      const label = node.text ?? node.style?.label ?? 'Filter'
      return (
        <div>
          <div style={{ color: '#555', fontSize: '0.6rem', marginBottom: 4 }}>{label}</div>
          <div style={{ height: 24, background: '#161616', borderRadius: 3, border: '1px solid #222', display: 'flex', alignItems: 'center', padding: '0 8px', justifyContent: 'space-between' }}>
            <span style={{ color: '#333', fontSize: '0.65rem' }}>Select…</span>
            <span style={{ color: '#333', fontSize: '0.6rem' }}>▾</span>
          </div>
        </div>
      )
    }

    case 'container': {
      const dir = node.style?.direction ?? 'column'
      return (
        <div style={{ height: '100%', border: '1px dashed #222', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={dim}>{dir} container</span>
        </div>
      )
    }

    case 'modal': {
      const title = node.text ?? node.style?.title ?? 'Modal'
      return (
        <div style={{ border: '1px solid #222', borderRadius: 4, overflow: 'hidden', height: '100%' }}>
          <div style={{ background: '#141414', padding: '4px 8px', borderBottom: '1px solid #1e1e1e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#888', fontSize: '0.7rem' }}>{title}</span>
            <span style={{ color: '#444', fontSize: '0.8rem', cursor: 'default' }}>×</span>
          </div>
          <div style={{ padding: 8 }}>
            <div style={{ height: 8, background: '#161616', borderRadius: 2, marginBottom: 4 }} />
            <div style={{ height: 8, background: '#161616', borderRadius: 2, width: '65%' }} />
          </div>
        </div>
      )
    }

    case 'tabs': {
      const tabLabels = (node.style?.tabs ?? node.text ?? 'Tab 1,Tab 2,Tab 3')
        .split(',').map(t => t.trim()).slice(0, 5)
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #222', gap: 2 }}>
            {tabLabels.map((t, i) => (
              <div key={t} style={{
                padding: '3px 10px',
                fontSize: '0.65rem',
                color: i === 0 ? '#e5e5e5' : '#444',
                borderBottom: i === 0 ? '2px solid #3b82f6' : '2px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}>
                {t}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, background: '#0a0a0a', borderRadius: '0 4px 4px 4px' }} />
        </div>
      )
    }

    case 'markdown': {
      const content = node.text ?? node.style?.content ?? '# Markdown\nContent here…'
      return (
        <div style={{ color: '#555', fontSize: '0.65rem', fontFamily: 'monospace', overflow: 'hidden', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          {content.slice(0, 120)}
        </div>
      )
    }

    default:
      return <div style={dim}>{node.element}</div>
  }
}

function CanvasTablePreview({ node, workspaceId }: { node: AuraNode; workspaceId: string }) {
  const rawColumns = node.with?.columns ?? node.style?.columns ?? 'id, name, status'
  const fallbackColumns = rawColumns
    .split(',')
    .map(column => column.trim())
    .filter(Boolean)
    .slice(0, 4)
  const connectorId = node.with?.connector
  const sql = node.with?.sql

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !connectorId || !sql) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    runConnectorQuery(workspaceId, connectorId, { sql, limit: 3 })
      .then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error)
          setData(null)
          return
        }
        setData(result)
      })
      .catch(err => {
        if (cancelled) return
        setError(String(err instanceof Error ? err.message : err))
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [workspaceId, connectorId, sql])

  const columns = (data?.columns?.length ? data.columns : fallbackColumns).slice(0, 4)
  const rows = (data?.rows ?? []).slice(0, 3)
  const hasBinding = Boolean(workspaceId && connectorId && sql)
  const emptyColumns = columns.length === 0 ? ['value'] : columns

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #1e1e1e', paddingBottom: 4, marginBottom: 4 }}>
        {emptyColumns.map(column => (
          <div
            key={column}
            style={{
              flex: 1,
              color: '#555',
              fontSize: '0.6rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {column}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {error ? (
          <div style={{ color: '#f87171', fontSize: '0.62rem', lineHeight: 1.5 }}>{error}</div>
        ) : loading ? (
          [0, 1, 2].map(index => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              {emptyColumns.map((column, columnIndex) => (
                <div key={`${column}-${columnIndex}`} style={{ flex: 1, height: 10, background: '#161616', borderRadius: 2 }} />
              ))}
            </div>
          ))
        ) : hasBinding ? (
          rows.length > 0 ? (
            rows.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                {emptyColumns.map(column => (
                  <div
                    key={column}
                    style={{
                      flex: 1,
                      color: '#bdbdbd',
                      fontSize: '0.65rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {String(row[column] ?? '')}
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div style={{ color: '#444', fontSize: '0.62rem' }}>Query returned no rows.</div>
          )
        ) : (
          [0, 1, 2].map(index => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              {emptyColumns.map((column, columnIndex) => (
                <div key={`${column}-${columnIndex}`} style={{ flex: 1, height: 10, background: '#161616', borderRadius: 2 }} />
              ))}
            </div>
          ))
        )}
      </div>

      {!hasBinding && !loading && !error && (
        <div style={{ color: '#333', fontSize: '0.6rem', marginTop: 4 }}>
          Connect a data source to display live rows.
        </div>
      )}
    </div>
  )
}
