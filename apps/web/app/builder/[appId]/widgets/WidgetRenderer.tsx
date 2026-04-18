'use client'

import React, { useEffect, useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY } from '@lima/widget-catalog'
import { runConnectorQuery, type DashboardQueryResponse } from '../../../../lib/api'
import { getMissingRequiredProps, hasConnectorBinding, isSupportedChartType } from '../../../../lib/appValidation'
import { FormWidgetPreview } from './FormWidgetPreview'
import { TextWidgetPreview } from './TextWidgetPreview'
import { ButtonWidgetPreview } from './ButtonWidgetPreview'
import { TableWidgetPreview } from './TableWidgetPreview'
import { ChartWidgetPreview } from './ChartWidgetPreview'
import { buildChartSeries } from '../../../../lib/charting'
import { applyTableDataBinding, getConnectorQuerySQL, getVisibleTableColumns } from '../../../../lib/tableBinding'
import { useDashboardFilters } from '../../../../lib/dashboardFilters'

interface Props {
  node: AuraNode
  selected: boolean
  workspaceId: string
  onUpdate?: (node: AuraNode) => void
}

// formatCellValue safely converts any row value to a display string.
// Objects and arrays are JSON-stringified rather than producing "[object Object]".
function formatCellValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function WidgetRenderer({ node, workspaceId, onUpdate }: Props) {
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
        {renderBody(node, workspaceId, onUpdate)}
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

function renderBody(node: AuraNode, workspaceId: string, onUpdate?: (node: AuraNode) => void): React.ReactNode {
  const dim: React.CSSProperties = { color: '#444', fontSize: '0.65rem' }

  switch (node.element) {
    case 'table': {
      return (
        <TableWidgetPreview node={node} workspaceId={workspaceId} onUpdate={onUpdate}>
          <CanvasTablePreview node={node} workspaceId={workspaceId} />
        </TableWidgetPreview>
      )
    }

    case 'form': {
      return (
        <FormWidgetPreview
          node={node}
          onUpdate={(newFieldsStr) => {
            if (!onUpdate) return
            const updated: AuraNode = {
              ...node,
              manuallyEdited: true,
              style: { ...(node.style ?? {}), fields: newFieldsStr },
            }
            if (!newFieldsStr) {
              const { fields: _f, ...rest } = updated.style!
              updated.style = rest
            }
            onUpdate(updated)
          }}
        />
      )
    }

    case 'text': {
      return <TextWidgetPreview node={node} onUpdate={onUpdate} />
    }

    case 'button': {
      return <ButtonWidgetPreview node={node} onUpdate={onUpdate} />
    }

    case 'chart': {
      return (
        <ChartWidgetPreview node={node} workspaceId={workspaceId} onUpdate={onUpdate}>
          <CanvasChartPreview node={node} workspaceId={workspaceId} />
        </ChartWidgetPreview>
      )
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
      return <CanvasFilterPreview node={node} workspaceId={workspaceId} />
    }

    case 'container': {
      const direction = node.with?.direction ?? node.style?.direction ?? 'column'
      const gap = node.with?.gap ?? node.style?.gap ?? '16px'
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: '0.6rem', color: '#444', fontFamily: 'monospace' }}>
            direction: {direction} &nbsp;|&nbsp; gap: {gap}
          </div>
          <div style={{
            flex: 1,
            border: '1px dashed #2a2a2a',
            borderRadius: 3,
            display: 'flex',
            flexDirection: direction as React.CSSProperties['flexDirection'],
            gap: '4px',
            padding: '4px',
            alignItems: 'stretch',
          }}>
            <div style={{ flex: 1, background: '#151515', borderRadius: 2, minHeight: 14 }} />
            <div style={{ flex: 1, background: '#151515', borderRadius: 2, minHeight: 14 }} />
          </div>
        </div>
      )
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

function CanvasTablePreview({ node, workspaceId }: { node: AuraNode; workspaceId: string }) {
  const configuredColumns = node.style?.columns ?? ''
  const connectorId = node.with?.connector
  const connectorType = node.with?.connectorType
  const sql = node.with?.sql
  const filterLinks = parseFilterLinks(node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn)
  const { values: dashboardFilters } = useDashboardFilters()

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasBinding = hasConnectorBinding(node)
  const querySql = getConnectorQuerySQL(connectorType, sql)

  useEffect(() => {
    if (!workspaceId || !connectorId || querySql === null) {
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
      limit: connectorType === 'csv' ? 100 : 3,
    })
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
  }, [workspaceId, connectorId, connectorType, querySql])

  const boundData = applyTableDataBinding(data, {
    filters: filterLinks.map(link => ({ column: link.column, value: dashboardFilters[link.widgetId] ?? '' })),
    filterColumn: node.with?.filterColumn,
    filterValue: node.with?.filterValue,
    aggregate: node.with?.aggregate,
    groupBy: node.with?.groupBy,
    aggregateColumn: node.with?.aggregateColumn,
  })
  const previewError = boundData?.error ?? error
  const columns = getVisibleTableColumns(boundData, configuredColumns)
  const rows = (boundData?.rows ?? []).slice(0, 3)

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {previewError ? (
          <div style={{ color: '#f87171', fontSize: '0.62rem', lineHeight: 1.5 }}>{previewError}</div>
        ) : loading ? (
          <div style={{ color: '#444', fontSize: '0.62rem' }}>Loading preview…</div>
        ) : hasBinding ? (
          rows.length > 0 && columns.length > 0 ? (
            <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: '0.62rem' }}>
              <thead>
                <tr>
                  {columns.map(column => (
                    <th key={column} style={{
                      textAlign: 'left',
                      padding: '0 8px 4px 0',
                      color: '#555',
                      fontSize: '0.58rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                      borderBottom: '1px solid #1e1e1e',
                    }}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map(column => (
                      <td key={column} style={{
                        padding: '5px 8px 0 0',
                        color: '#bdbdbd',
                        whiteSpace: 'nowrap',
                        maxWidth: 180,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {formatCellValue(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#444', fontSize: '0.62rem' }}>No rows match the current data binding.</div>
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
  const connectorType = node.with?.connectorType
  const sql = node.with?.sql
  const filterLinks = parseFilterLinks(node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn)
  const labelCol = node.with?.labelCol ?? node.style?.labelCol ?? ''
  const valueCol = node.with?.valueCol ?? node.style?.valueCol ?? ''
  const aggregate = node.with?.aggregate ?? 'none'
  const sortBy = node.with?.sortBy ?? 'none'
  const sortDirection = node.with?.sortDirection ?? 'desc'
  const pointLimit = node.with?.limit ?? '8'
  const hasBinding = hasConnectorBinding(node)
  const supportedType = isSupportedChartType(chartType)
  const querySql = getConnectorQuerySQL(connectorType, sql)
  const { values: dashboardFilters } = useDashboardFilters()

  const [data, setData] = useState<DashboardQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !connectorId || querySql === null) {
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
      limit: connectorType === 'csv' ? 100 : 12,
    })
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
  }, [workspaceId, connectorId, connectorType, querySql])

  const series = React.useMemo(
    () => buildChartSeries(data, {
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
    [aggregate, dashboardFilters, data, labelCol, pointLimit, sortBy, sortDirection, valueCol, node.with?.filterColumn, node.with?.filterValue, node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn],
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
        <BuilderStateMessage message="No rows match the current data binding." />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 3, paddingBottom: 4, borderBottom: '1px solid #222', minHeight: 0 }}>
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
                <div style={{
                  color: '#60a5fa',
                  fontSize: '0.52rem',
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: 1,
                  opacity: pct < 20 ? 0 : 1,
                }}>
                  {formatted}
                </div>
                <div
                  style={{
                    height: `${pct}%`,
                    background: '#1e3a8a',
                    borderRadius: '2px 2px 0 0',
                    opacity: 0.75,
                    position: 'relative',
                  }}
                >
                  {pct < 20 && (
                    <div style={{
                      position: 'absolute',
                      bottom: '100%',
                      left: 0,
                      right: 0,
                      textAlign: 'center',
                      color: '#60a5fa',
                      fontSize: '0.48rem',
                      fontVariantNumeric: 'tabular-nums',
                      pointerEvents: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      padding: '0 1px',
                    }}>
                      {formatted}
                    </div>
                  )}
                </div>
                <div style={{ color: '#444', fontSize: '0.52rem', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
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

function CanvasFilterPreview({ node, workspaceId }: { node: AuraNode; workspaceId: string }) {
  const missing = getMissingRequiredProps(node)
  if (missing.length > 0) return <BuilderConfigurationRequired node={node} missing={missing} />

  const label = node.text ?? node.style?.label ?? 'Filter'
  const placeholder = node.style?.placeholder ?? 'Type to filter…'
  const options = parseFilterOptions(node.style?.options)
  const { values, setFilterValue } = useDashboardFilters()
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

  const resolvedOptions = dynamicOptions.length > 0 ? dynamicOptions : options

  return (
    <div data-interactive-preview="1" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ color: '#666', fontSize: '0.6rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>
      {resolvedOptions.length > 0 ? (
        <select
          data-interactive-preview="1"
          value={value}
          onChange={e => setFilterValue(node.id, e.target.value)}
          style={{
            width: '100%',
            background: '#151515',
            border: '1px solid #262626',
            borderRadius: 4,
            color: '#d4d4d4',
            fontSize: '0.7rem',
            padding: '5px 7px',
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
          data-interactive-preview="1"
          type="text"
          value={value}
          onChange={e => setFilterValue(node.id, e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#151515',
            border: '1px solid #262626',
            borderRadius: 4,
            color: '#d4d4d4',
            fontSize: '0.7rem',
            padding: '5px 7px',
          }}
        />
      )}
      <div style={{ color: '#444', fontSize: '0.58rem', lineHeight: 1.4 }}>
        Link this filter from a table or chart to let end users narrow that widget without SQL.
      </div>
    </div>
  )
}

function parseFilterOptions(rawOptions: string | undefined): string[] {
  return (rawOptions ?? '')
    .split(',')
    .map(option => option.trim())
    .filter(Boolean)
}
