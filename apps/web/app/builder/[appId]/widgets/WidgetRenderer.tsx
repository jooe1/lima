'use client'

import React, { useEffect, useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY } from '@lima/widget-catalog'
import { runConnectorQuery, type DashboardQueryResponse } from '../../../../lib/api'
import { getMissingRequiredProps, hasConnectorBinding, isSupportedChartType } from '../../../../lib/appValidation'
import { buildChartSeries } from '../../../../lib/charting'

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

function BuilderStateMessage({
  message,
  tone = 'muted',
}: {
  message: string
  tone?: 'muted' | 'warning' | 'error'
}) {
  const color = tone === 'error' ? '#f87171' : tone === 'warning' ? '#fbbf24' : '#444'
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color, fontSize: '0.65rem', lineHeight: 1.5 }}>
      {message}
    </div>
  )
}

function BuilderConfigurationRequired({ node, missing }: { node: AuraNode; missing: string[] }) {
  const meta = WIDGET_REGISTRY[node.element as keyof typeof WIDGET_REGISTRY]
  const labels = missing
    .map(propName => meta?.propSchema[propName]?.label ?? propName)
    .join(', ')

  return (
    <BuilderStateMessage
      message={`${meta?.displayName ?? node.element} requires ${labels} before it can be published.`}
      tone="warning"
    />
  )
}

function BuilderUnsupportedPreview({ node }: { node: AuraNode }) {
  const meta = WIDGET_REGISTRY[node.element as keyof typeof WIDGET_REGISTRY]
  return (
    <BuilderStateMessage
      message={`${meta?.displayName ?? node.element} is not supported in the production runtime.`}
      tone="error"
    />
  )
}

function renderBody(node: AuraNode, workspaceId: string): React.ReactNode {
  const dim: React.CSSProperties = { color: '#444', fontSize: '0.65rem' }

  switch (node.element) {
    case 'table': {
      return <CanvasTablePreview node={node} workspaceId={workspaceId} />
    }

    case 'form': {
      const missing = getMissingRequiredProps(node)
      if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

      const fields = (node.style?.fields ?? node.with?.fields ?? '')
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
      const missing = getMissingRequiredProps(node)
      if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

      const content = node.text ?? node.value ?? ''
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
      const missing = getMissingRequiredProps(node)
      if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

      const variant = node.style?.variant ?? 'primary'
      const bg = variant === 'danger' ? '#450a0a' : variant === 'secondary' ? '#1a1a1a' : '#1e3a8a'
      const color = variant === 'danger' ? '#fca5a5' : variant === 'secondary' ? '#aaa' : '#bfdbfe'
      const border = variant === 'secondary' ? '1px solid #333' : 'none'
      return (
        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: bg, border, borderRadius: 4, padding: '4px 14px', color, fontSize: '0.75rem' }}>
          {node.text ?? ''}
        </div>
      )
    }

    case 'chart': {
      return <CanvasChartPreview node={node} workspaceId={workspaceId} />
    }

    case 'kpi': {
      const missing = getMissingRequiredProps(node)
      if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

      const val = node.value ?? ''
      const label = node.text ?? node.style?.label ?? ''
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
      return <BuilderUnsupportedPreview node={node} />
    }

    case 'container': {
      return <BuilderUnsupportedPreview node={node} />
    }

    case 'modal': {
      return <BuilderUnsupportedPreview node={node} />
    }

    case 'tabs': {
      return <BuilderUnsupportedPreview node={node} />
    }

    case 'markdown': {
      const missing = getMissingRequiredProps(node)
      if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

      const content = node.text ?? node.style?.content ?? ''
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
  const rawColumns = node.with?.columns ?? node.style?.columns ?? ''
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
  const hasBinding = hasConnectorBinding(node)

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

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {columns.length > 0 && (
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #1e1e1e', paddingBottom: 4, marginBottom: 4 }}>
          {columns.map(column => (
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
      )}

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {error ? (
          <div style={{ color: '#f87171', fontSize: '0.62rem', lineHeight: 1.5 }}>{error}</div>
        ) : loading ? (
          <div style={{ color: '#444', fontSize: '0.62rem' }}>Loading preview…</div>
        ) : hasBinding ? (
          rows.length > 0 ? (
            rows.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                {columns.map(column => (
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
          <div style={{ color: '#333', fontSize: '0.62rem' }}>Connect a data source to preview rows.</div>
        )}
      </div>
    </div>
  )
}

function CanvasChartPreview({ node, workspaceId }: { node: AuraNode; workspaceId: string }) {
  const chartType = (node.style?.type ?? 'bar').trim() || 'bar'
  const connectorId = node.with?.connector
  const sql = node.with?.sql
  const labelCol = node.with?.labelCol ?? node.style?.labelCol ?? ''
  const valueCol = node.with?.valueCol ?? node.style?.valueCol ?? ''
  const hasBinding = hasConnectorBinding(node)
  const supportedType = isSupportedChartType(chartType)

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

    runConnectorQuery(workspaceId, connectorId, { sql, limit: 12 })
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

  const series = React.useMemo(
    () => buildChartSeries(data, { labelCol, valueCol, limit: 8 }),
    [data, labelCol, valueCol],
  )
  const maxValue = Math.max(...series.points.map(point => Math.abs(point.value)), 1)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ color: '#444', fontSize: '0.65rem' }}>{chartType} chart</div>
      {loading ? (
        <BuilderStateMessage message="Loading preview…" />
      ) : error ? (
        <BuilderStateMessage message={error} tone="error" />
      ) : !supportedType ? (
        <BuilderStateMessage message={`Chart type "${chartType}" is not supported in production.`} tone="error" />
      ) : !hasBinding ? (
        <BuilderStateMessage message="Connect a data source to preview this chart." tone="warning" />
      ) : series.error ? (
        <BuilderStateMessage message={series.error} tone="warning" />
      ) : series.points.length === 0 ? (
        <BuilderStateMessage message="Query returned no rows." />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 3, paddingBottom: 4, borderBottom: '1px solid #222', minHeight: 0 }}>
          {series.points.map((bar, i) => (
            <div key={`${bar.label}-${i}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 0, height: '100%' }}>
              <div
                title={`${bar.label}: ${bar.value}`}
                style={{
                  height: `${Math.max((Math.abs(bar.value) / maxValue) * 100, 4)}%`,
                  background: '#1e3a8a',
                  borderRadius: '2px 2px 0 0',
                  opacity: 0.75,
                }}
              />
              <div style={{ color: '#444', fontSize: '0.55rem', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {bar.label || ' '}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
