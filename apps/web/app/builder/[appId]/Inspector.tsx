'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { type AuraNode, type AuraDocument } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType, type PropDef } from '@lima/widget-catalog'
import { getGrid, CELL, COLS } from './CanvasEditor'
import { listConnectors, runConnectorQuery, createWorkflow, getWorkflow, type Connector, type DashboardQueryResponse, type Workflow } from '../../../lib/api'
import { applyTableDataBinding, getConnectorQuerySQL, getConnectorSchemaColumns, mergeColumns } from '../../../lib/tableBinding'
import { WorkflowSelector } from './widgets/WorkflowSelector'

interface Props {
  node: AuraNode | null
  doc: AuraDocument
  onUpdate: (node: AuraNode) => void
  onDelete: (id: string) => void
  workspaceId: string
  appId: string
  pageId: string
  onOpenCanvas?: (workflowId: string) => void
  onOpenSplitView?: (workflowId: string) => void
}

/**
 * Map a widget prop name to the AuraNode field that stores it.
 * The DSL has dedicated clauses for text, value, and transform; everything
 * else goes into the style map as a pseudo-prop.
 */
function getPropValue(node: AuraNode, propName: string): string {
  if (propName === 'text' || propName === 'label' || propName === 'content') {
    return node.text ?? ''
  }
  if (propName === 'value' || propName === 'data') {
    return node.value ?? ''
  }
  if (propName === 'transform') {
    return node.transform ?? ''
  }
  return node.style?.[propName] ?? ''
}

function setPropValue(node: AuraNode, propName: string, value: string): AuraNode {
  // Any manual prop edit marks this node as manually edited (FR-22)
  const updated: AuraNode = { ...node, manuallyEdited: true }

  if (propName === 'text' || propName === 'label' || propName === 'content') {
    updated.text = value || undefined
    return updated
  }
  if (propName === 'value' || propName === 'data') {
    updated.value = value || undefined
    return updated
  }
  if (propName === 'transform') {
    updated.transform = value || undefined
    return updated
  }

  updated.style = { ...(node.style ?? {}), [propName]: value }
  if (!value) {
    const { [propName]: _removed, ...rest } = updated.style
    updated.style = rest
  }
  return updated
}

export function Inspector({ node, doc, onUpdate, onDelete, workspaceId, appId, pageId, onOpenCanvas, onOpenSplitView }: Props) {
  if (!node) {
    return (
      <aside style={panelStyle}>
        <div style={{ padding: '1rem', color: '#2a2a2a', fontSize: '0.75rem', textAlign: 'center', marginTop: '3rem' }}>
          Select a widget to inspect
        </div>
      </aside>
    )
  }

  // Capture narrowed reference — function declarations are hoisted and TypeScript
  // conservatively treats them as possibly seeing the pre-guard value.
  const n: AuraNode = node

  const meta = WIDGET_REGISTRY[n.element as WidgetType]
  const g = getGrid(n)
  const filterWidgets = doc
    .filter(candidate => candidate.element === 'filter' && candidate.id !== n.id)
    .map(candidate => ({
      id: candidate.id,
      label: candidate.text ?? candidate.style?.label ?? candidate.id,
    }))

  const handleGridChange = (field: 'gridX' | 'gridY' | 'gridW' | 'gridH', raw: string) => {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    let clamped = Math.max(0, v)
    if (field === 'gridW') clamped = Math.max(2, clamped)
    if (field === 'gridH') clamped = Math.max(1, clamped)
    if (field === 'gridX') clamped = Math.max(0, clamped)

    onUpdate({
      ...n,
      style: { ...(n.style ?? {}), [field]: String(clamped) },
    })
  }

  const handlePropChange = (propName: string, value: string) => {
    onUpdate(setPropValue(n, propName, value))
  }

  const handleWithChange = (key: string, value: string) => {
    const updated: AuraNode = {
      ...n,
      manuallyEdited: true,
      with: { ...(n.with ?? {}), [key]: value },
    }
    if (!value) {
      const { [key]: _removed, ...rest } = updated.with!
      updated.with = Object.keys(rest).length > 0 ? rest : undefined
    }
    onUpdate(updated)
  }

  // Atomic multi-key update — avoids the stale-closure issue where calling
  // onWithChange multiple times in the same event handler causes each call
  // to overwrite the previous (all read the same n reference).
  const handleWithChangeMany = (updates: Record<string, string>) => {
    let withMap: Record<string, string> = { ...(n.with ?? {}) }
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        withMap[key] = value
      } else {
        const { [key]: _removed, ...rest } = withMap
        withMap = rest
      }
    }
    onUpdate({
      ...n,
      manuallyEdited: true,
      with: Object.keys(withMap).length > 0 ? withMap : undefined,
    })
  }

  const isDataWidget = n.element === 'table' || n.element === 'chart'

  return (
    <aside style={panelStyle}>
      {/* Widget identity */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            fontSize: '0.6rem', padding: '2px 7px', borderRadius: 99,
            background: '#1e3a8a33', color: '#93c5fd', fontWeight: 500,
          }}>
            {meta?.displayName ?? n.element}
          </span>
          {n.manuallyEdited && (
            <span title="Manually edited — protected from AI rewrites" style={{
              fontSize: '0.55rem', padding: '2px 6px', borderRadius: 99,
              background: '#78350f33', color: '#fcd34d',
            }}>
              manual
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e5e5e5', fontFamily: 'monospace' }}>
          {n.id}
        </div>
        {meta?.description && (
          <div style={{ fontSize: '0.65rem', color: '#444', marginTop: 4 }}>{meta.description}</div>
        )}
      </div>

      {/* Layout section */}
      <Section title="Layout">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="X" value={String(g.x)} type="number"
            onChange={v => handleGridChange('gridX', v)} />
          <Field label="Y" value={String(g.y)} type="number"
            onChange={v => handleGridChange('gridY', v)} />
          <Field label={`W (${g.w * CELL}px)`} value={String(g.w)} type="number"
            onChange={v => handleGridChange('gridW', v)} />
          <Field label={`H (${g.h * CELL}px)`} value={String(g.h)} type="number"
            onChange={v => handleGridChange('gridH', v)} />
        </div>
      </Section>

      {/* Props section */}
      {meta && (
        <Section title="Props">
          {Object.entries(meta.propSchema).map(([propName, def]) =>
            def.type === 'workflow_trigger' ? (
              <div key={propName}>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {def.label}
                </label>
                <WorkflowCard
                  workspaceId={workspaceId}
                  appId={appId}
                  pageId={pageId}
                  triggerType={n.element === 'form' ? 'form_submit' : 'button_click'}
                  widgetId={n.id}
                  workflowId={n.action}
                  onLink={workflowId => onUpdate({ ...n, manuallyEdited: true, action: workflowId })}
                  onUnlink={() => onUpdate({ ...n, manuallyEdited: true, action: undefined })}
                  onOpenCanvas={onOpenCanvas}
                  onOpenSplitView={onOpenSplitView}
                />
              </div>
            ) : (
              <PropField
                key={propName}
                name={propName}
                def={def}
                value={getPropValue(n, propName)}
                onChange={v => handlePropChange(propName, v)}
              />
            )
          )}
        </Section>
      )}

      {/* Filter data source */}
      {n.element === 'filter' && (
        <Section title="Filter data source">
          <FilterDataSourceEditor
            node={n}
            workspaceId={workspaceId}
            onWithChange={handleWithChange}
          />
        </Section>
      )}

      {/* Data binding (with clause) */}
      {isDataWidget ? (
        <Section title="Data binding">
          <DataBindingEditor
            node={n}
            workspaceId={workspaceId}
            filterWidgets={filterWidgets}
            onWithChange={handleWithChange}
            onWithChangeMany={handleWithChangeMany}
          />
        </Section>
      ) : n.with && Object.keys(n.with).length > 0 ? (
        <Section title="Data binding">
          <div style={{ fontSize: '0.65rem', color: '#444', fontFamily: 'monospace', background: '#0d0d0d', borderRadius: 4, padding: 8 }}>
            {Object.entries(n.with).map(([k, v]) => (
              <div key={k}>{k}=&quot;{v}&quot;</div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Danger zone */}
      <div style={{ padding: '0.75rem 1rem', marginTop: 'auto' }}>
        <button
          onClick={() => onDelete(n.id)}
          style={{
            width: '100%', padding: '6px 12px', borderRadius: 4, fontSize: '0.75rem',
            background: 'transparent', border: '1px solid #2a1010', color: '#ef4444',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a0a0a' }}
          onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'transparent' }}
        >
          Delete widget
        </button>
      </div>
    </aside>
  )
}

/* ---- Sub-components --------------------------------------------------- */

/* ---- Query-builder helpers -------------------------------------------- */

function getConnectorTables(connector: { schema_cache?: Record<string, unknown> } | undefined): string[] {
  const tables = connector?.schema_cache?.tables
  if (!Array.isArray(tables)) return []
  return tables.flatMap(t => {
    if (typeof t === 'string') return [t]
    if (t && typeof t === 'object' && 'name' in t) {
      const name = (t as Record<string, unknown>).name
      return typeof name === 'string' && name.trim() ? [name] : []
    }
    return []
  })
}

function getTableColumns(
  connector: { schema_cache?: Record<string, unknown> } | undefined,
  tableName: string,
): string[] {
  if (!tableName) return []
  const tables = connector?.schema_cache?.tables
  if (!Array.isArray(tables)) return []
  const found = tables.find(t => {
    if (!t || typeof t !== 'object') return false
    return (t as Record<string, unknown>).name === tableName
  })
  if (!found || typeof found !== 'object') return []
  const cols = (found as Record<string, unknown>).columns
  if (!Array.isArray(cols)) return []
  return cols.flatMap(c => {
    if (typeof c === 'string') return [c]
    if (c && typeof c === 'object' && 'name' in c) {
      const name = (c as Record<string, unknown>).name
      return typeof name === 'string' && name.trim() ? [name] : []
    }
    return []
  })
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteVal(val: string): string {
  return `'${val.replace(/'/g, "''")}'`
}

type WhereOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'is_null' | 'not_null'

function buildCondition(col: string, op: WhereOp, val: string): string {
  const qc = quoteIdent(col)
  switch (op) {
    case 'eq':       return `${qc} = ${quoteVal(val)}`
    case 'neq':      return `${qc} != ${quoteVal(val)}`
    case 'gt':       return `${qc} > ${quoteVal(val)}`
    case 'gte':      return `${qc} >= ${quoteVal(val)}`
    case 'lt':       return `${qc} < ${quoteVal(val)}`
    case 'lte':      return `${qc} <= ${quoteVal(val)}`
    case 'like':     return `${qc} ILIKE ${quoteVal('%' + val + '%')}`
    case 'is_null':  return `${qc} IS NULL`
    case 'not_null': return `${qc} IS NOT NULL`
    default:         return `${qc} = ${quoteVal(val)}`
  }
}

interface WhereClause {
  col: string
  op: WhereOp
  val: string
}

function generateQBSQL(
  table: string,
  wheres: WhereClause[],
  groupBy: string,
  orderBy: string,
  dir: string,
  limit: string,
): string {
  if (!table.trim()) return ''
  let sql = `SELECT * FROM ${quoteIdent(table)}`
  const conditions = wheres
    .filter(w => w.col.trim() && (w.op === 'is_null' || w.op === 'not_null' || w.val.trim()))
    .map(w => buildCondition(w.col, w.op, w.val))
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
  if (groupBy.trim()) sql += ` GROUP BY ${quoteIdent(groupBy)}`
  if (orderBy.trim()) sql += ` ORDER BY ${quoteIdent(orderBy)} ${dir === 'desc' ? 'DESC' : 'ASC'}`
  const lim = parseInt(limit, 10)
  if (lim > 0) sql += ` LIMIT ${lim}`
  return sql
}

function DataBindingEditor({ node, workspaceId, filterWidgets, onWithChange, onWithChangeMany }: {
  node: AuraNode
  workspaceId: string
  filterWidgets: Array<{ id: string; label: string }>
  onWithChange: (key: string, value: string) => void
  onWithChangeMany: (updates: Record<string, string>) => void
}) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [preview, setPreview] = useState<DashboardQueryResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    listConnectors(workspaceId)
      .then(res => { if (!cancelled) setConnectors(res.connectors ?? []) })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [workspaceId])

  const connectorId = node.with?.connector ?? ''
  const sql = node.with?.sql ?? ''
  const selectedConnector = connectors.find(connector => connector.id === connectorId)
  const connectorType = selectedConnector?.type ?? node.with?.connectorType ?? ''
  const isCSVConnector = connectorType === 'csv'
  const isManagedConnector = connectorType === 'managed'
  const isRESTConnector = connectorType === 'rest'
  const restEndpoints = isRESTConnector
    ? ((selectedConnector?.schema_cache?.endpoints ?? []) as Array<{ label: string; path: string }>)
    : []
  const hasNamedEndpoints = restEndpoints.length > 0
  // Derive what the endpoint dropdown currently shows:
  // '' = nothing selected, a path = that endpoint is active, '__custom__' = user-typed path
  const endpointDropdownValue = (() => {
    if (!hasNamedEndpoints || !sql) return sql
    if (restEndpoints.some(ep => ep.path === sql)) return sql
    return '__custom__'
  })()
  const isChart = node.element === 'chart'
  const widgetMeta = WIDGET_REGISTRY[node.element as WidgetType]

  useEffect(() => {
    if (!selectedConnector?.type) return
    if (node.with?.connectorType === selectedConnector.type) return
    onWithChange('connectorType', selectedConnector.type)
  }, [selectedConnector?.type, node.with?.connectorType, onWithChange])

  const querySql = getConnectorQuerySQL(connectorType, sql)

  // Auto-fetch a 1-row preview whenever connector + query changes so that
  // availableColumns is populated and column pickers render as dropdowns.
  useEffect(() => {
    if (!workspaceId || !connectorId || !querySql) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await runConnectorQuery(workspaceId, connectorId, {
          sql: querySql,
          limit: 1,
        })
        if (!cancelled && !res.error) {
          setPreview(prev => {
            // Keep a richer existing preview; only update when columns change.
            const prevCols = prev?.columns ?? []
            const resCols = res.columns ?? []
            if (prev && prevCols.join(',') === resCols.join(',')) return prev
            return { ...res, columns: resCols }
          })
        }
      } catch {
        // Silently ignore — the user can still type column names manually.
      }
    })()
    return () => { cancelled = true }
  }, [workspaceId, connectorId, querySql])

  const handlePreview = useCallback(async () => {
    if (!connectorId || !querySql || !workspaceId) return
    setPreviewLoading(true)
    setPreviewError('')
    setPreview(null)
    try {
      const res = await runConnectorQuery(workspaceId, connectorId, {
        sql: querySql,
        limit: isCSVConnector ? 100 : 10,
      })
      if (res.error) {
        setPreviewError(res.error)
      } else {
        setPreview(res)
      }
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setPreviewLoading(false)
    }
  }, [workspaceId, connectorId, querySql, isCSVConnector])

  const schemaColumns = getConnectorSchemaColumns(selectedConnector)
  const previewColumns = preview?.columns ?? []
  const availableColumns = mergeColumns(previewColumns, schemaColumns)
  const transformedPreview = node.element === 'table'
    ? applyTableDataBinding(preview, {
      filterColumn: node.with?.filterColumn,
      filterValue: node.with?.filterValue,
      aggregate: node.with?.aggregate,
      groupBy: node.with?.groupBy,
      aggregateColumn: node.with?.aggregateColumn,
    })
    : preview
  const previewResult = transformedPreview ?? preview
  const effectivePreviewError = transformedPreview?.error ?? previewError
  const aggregateMode = (node.with?.aggregate ?? 'none').trim() || 'none'
  const needsAggregateColumn = ['sum', 'avg', 'min', 'max'].includes(aggregateMode)
  const sortBy = node.with?.sortBy ?? 'none'
  const sortDirection = node.with?.sortDirection ?? 'desc'
  const canPreview = Boolean(connectorId && querySql)

  const renderColumnField = (
    label: string,
    bindingKey: string,
    value: string,
    placeholder: string,
    includeAnyOption = false,
  ) => (
    <div>
      <label style={labelStyle}>{label}</label>
      {availableColumns.length > 0 ? (
        <select
          value={value}
          onChange={e => onWithChange(bindingKey, e.target.value)}
          style={{ ...inputStyle, appearance: 'auto' }}
        >
          <option value="">{includeAnyOption ? 'Any column' : '— select column —'}</option>
          {availableColumns.map(column => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onWithChange(bindingKey, e.target.value)}
          placeholder={placeholder}
          style={inputStyle}
        />
      )}
    </div>
  )

  return (
    <>
      <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
        Props control how the widget renders. Data binding controls where its data comes from and how that data is shaped before rendering.
      </div>

      {(node.element === 'table' || node.element === 'chart') && (
        <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
          {isRESTConnector
            ? 'Select an endpoint to load data from, then use the controls below to filter and summarize the results.'
            : 'Start with base rows from a connector, then use the controls below to filter, group, summarize, and sort them without writing SQL. Use Advanced SQL only when you need joins or server-side logic.'}
        </div>
      )}

      {/* Connector picker */}
      <div>
        <label style={labelStyle}>Connector</label>
        <select
          value={connectorId}
          onChange={e => onWithChange('connector', e.target.value)}
          style={{ ...inputStyle, appearance: 'auto' }}
        >
          <option value="">— select connector —</option>
          {connectors.map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
          ))}
        </select>
      </div>

      {isCSVConnector || isManagedConnector ? (
        <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
          {isManagedConnector
            ? 'Lima Table — all rows are loaded automatically. No SQL needed.'
            : 'CSV connectors use the imported rows directly. SQL is not used here.'}
        </div>
      ) : isRESTConnector ? (
        /* REST connector: endpoint picker (named) or path input (custom / no endpoints defined) */
        <>
          {hasNamedEndpoints ? (
            <div>
              <label style={labelStyle}>Endpoint</label>
              <select
                value={endpointDropdownValue}
                onChange={e => {
                  if (e.target.value === '__custom__') {
                    // Entering custom mode: seed with '/' so the input appears
                    if (endpointDropdownValue !== '__custom__') onWithChange('sql', '/')
                  } else {
                    onWithChange('sql', e.target.value)
                  }
                }}
                style={{ ...inputStyle, appearance: 'auto' }}
              >
                <option value=''>— select endpoint —</option>
                {restEndpoints.map(ep => (
                  <option key={ep.path} value={ep.path}>{ep.label}</option>
                ))}
                <option value='__custom__'>Custom path…</option>
              </select>
              {endpointDropdownValue === '__custom__' && (
                <input
                  type='text'
                  value={sql === '/' ? '' : sql}
                  onChange={e => onWithChange('sql', e.target.value || '/')}
                  placeholder='/api/your-endpoint'
                  autoFocus
                  style={{ ...inputStyle, marginTop: 6, fontFamily: 'monospace', fontSize: '0.75rem' }}
                />
              )}
            </div>
          ) : (
            <details open={!sql} style={{ border: '1px solid #1a1a1a', borderRadius: 4, background: '#0d0d0d' }}>
              <summary style={{ padding: '8px 10px', cursor: 'pointer', color: '#cbd5e1', fontSize: '0.68rem', fontWeight: 600 }}>
                API endpoint
              </summary>
              <div style={{ padding: '0 10px 10px' }}>
                <label style={labelStyle}>Endpoint path</label>
                <textarea
                  value={sql}
                  onChange={e => onWithChange('sql', e.target.value)}
                  rows={2}
                  placeholder='/api/resource'
                  style={{
                    ...inputStyle,
                    fontFamily: 'monospace',
                    fontSize: '0.65rem',
                    resize: 'vertical',
                    minHeight: 40,
                  }}
                />
                <div style={{ marginTop: 6, fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
                  Optional path to append to the base URL (e.g. <span style={{ fontFamily: 'monospace' }}>/sales</span>). Leave empty to call the base URL directly.
                </div>
              </div>
            </details>
          )}
        </>
      ) : (
        <>
          <VisualQueryBuilder
            node={node}
            selectedConnector={selectedConnector}
            availableColumns={availableColumns}
            onWithChange={onWithChange}
          />
        <details open={!sql} style={{ border: '1px solid #1a1a1a', borderRadius: 4, background: '#0d0d0d' }}>
          <summary style={{ padding: '8px 10px', cursor: 'pointer', color: '#cbd5e1', fontSize: '0.68rem', fontWeight: 600 }}>
            Advanced SQL
          </summary>
          <div style={{ padding: '0 10px 10px' }}>
            <label style={labelStyle}>Base query</label>
            <textarea
              value={sql}
              onChange={e => onWithChange('sql', e.target.value)}
              rows={4}
              style={{
                ...inputStyle,
                fontFamily: 'monospace',
                fontSize: '0.65rem',
                resize: 'vertical',
                minHeight: 60,
              }}
            />
            <div style={{ marginTop: 6, fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
              Lima sends this read-only query to the selected database connector. Only <span style={{ fontFamily: 'monospace' }}>SELECT</span> and <span style={{ fontFamily: 'monospace' }}>WITH</span> queries are allowed.
            </div>
            {widgetMeta?.dashboardHint.exampleSQL && (
              <pre style={{
                margin: '8px 0 0',
                padding: '8px 10px',
                borderRadius: 4,
                background: '#090909',
                border: '1px solid #1a1a1a',
                color: '#7dd3fc',
                fontSize: '0.6rem',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
              }}>
                {widgetMeta.dashboardHint.exampleSQL}
              </pre>
            )}
          </div>
        </details>
        </>
      )}

      {node.element === 'table' && (
        <>
          {renderColumnField(
            'Filter this column',
            'filterColumn',
            node.with?.filterColumn ?? '',
            'e.g. status',
            true,
          )}
          <div>
            <label style={labelStyle}>Match text</label>
            <input
              type="text"
              value={node.with?.filterValue ?? ''}
              onChange={e => onWithChange('filterValue', e.target.value)}
              placeholder="Contains text..."
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Summarize rows</label>
            <select
              value={aggregateMode}
              onChange={e => onWithChange('aggregate', e.target.value)}
              style={{ ...inputStyle, appearance: 'auto' }}
            >
              <option value="none">None</option>
              <option value="count">Count rows</option>
              <option value="sum">Sum column</option>
              <option value="avg">Average column</option>
              <option value="min">Minimum column</option>
              <option value="max">Maximum column</option>
            </select>
          </div>
          {aggregateMode !== 'none' && renderColumnField(
            'Group rows by',
            'groupBy',
            node.with?.groupBy ?? '',
            'e.g. region',
            true,
          )}
          {aggregateMode !== 'none' && needsAggregateColumn && renderColumnField(
            'Value column',
            'aggregateColumn',
            node.with?.aggregateColumn ?? '',
            'e.g. revenue',
          )}
        </>
      )}

      {/* Chart-specific: labelCol, valueCol */}
      {isChart && (
        <>
          <div>
            <label style={labelStyle}>Metric calculation</label>
            <select
              value={aggregateMode}
              onChange={e => onWithChange('aggregate', e.target.value)}
              style={{ ...inputStyle, appearance: 'auto' }}
            >
              <option value="none">Use row values as-is</option>
              <option value="count">Count rows per category</option>
              <option value="sum">Sum values per category</option>
              <option value="avg">Average values per category</option>
              <option value="min">Minimum value per category</option>
              <option value="max">Maximum value per category</option>
            </select>
          </div>
          {renderColumnField(
            'Category / X-axis column',
            'labelCol',
            node.with?.labelCol ?? node.style?.labelCol ?? '',
            'e.g. month',
          )}
          {aggregateMode !== 'count' && renderColumnField(
            aggregateMode === 'none' ? 'Value / Y-axis column' : 'Value column',
            'valueCol',
            node.with?.valueCol ?? node.style?.valueCol ?? '',
            'e.g. total',
          )}
          {renderColumnField(
            'Filter this column',
            'filterColumn',
            node.with?.filterColumn ?? '',
            'e.g. region',
            true,
          )}
          <div>
            <label style={labelStyle}>Match text</label>
            <input
              type="text"
              value={node.with?.filterValue ?? ''}
              onChange={e => onWithChange('filterValue', e.target.value)}
              placeholder="Contains text..."
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Sort points by</label>
            <select
              value={sortBy}
              onChange={e => onWithChange('sortBy', e.target.value)}
              style={{ ...inputStyle, appearance: 'auto' }}
            >
              <option value="none">Keep source order</option>
              <option value="label">Category</option>
              <option value="value">Value</option>
            </select>
          </div>
          {sortBy !== 'none' && (
            <div>
              <label style={labelStyle}>Sort direction</label>
              <select
                value={sortDirection}
                onChange={e => onWithChange('sortDirection', e.target.value)}
                style={{ ...inputStyle, appearance: 'auto' }}
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </div>
          )}
          <div>
            <label style={labelStyle}>Max points</label>
            <input
              type="number"
              min="1"
              value={node.with?.limit ?? '20'}
              onChange={e => onWithChange('limit', e.target.value)}
              placeholder="20"
              style={inputStyle}
            />
          </div>
        </>
      )}

      {(node.element === 'table' || node.element === 'chart') && (
        <FilterLinksEditor
          node={node}
          filterWidgets={filterWidgets}
          availableColumns={availableColumns}
          onWithChangeMany={onWithChangeMany}
        />
      )}

      {/* Preview button + results */}
      <div>
        <button
          onClick={handlePreview}
          disabled={!canPreview || previewLoading}
          style={{
            width: '100%',
            padding: '5px 10px',
            borderRadius: 4,
            fontSize: '0.7rem',
            fontWeight: 600,
            background: !canPreview ? '#111' : '#1e3a8a',
            border: '1px solid #222',
            color: !canPreview ? '#444' : '#93c5fd',
            cursor: (!canPreview || previewLoading) ? 'default' : 'pointer',
          }}
        >
          {previewLoading ? 'Running…' : isCSVConnector ? 'Preview imported rows' : 'Preview (10 rows)'}
        </button>
      </div>

      {effectivePreviewError && (
        <div style={{ fontSize: '0.65rem', color: '#f87171', background: '#1a0a0a', borderRadius: 4, padding: 8 }}>
          {effectivePreviewError}
        </div>
      )}

      {previewResult && previewResult.rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.6rem' }}>
            <thead>
              <tr>
                {previewResult.columns.map(col => (
                  <th key={col} style={{
                    textAlign: 'left', padding: '3px 6px', color: '#888',
                    borderBottom: '1px solid #222', fontWeight: 600, whiteSpace: 'nowrap',
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewResult.rows.map((row, i) => (
                <tr key={i}>
                  {previewResult.columns.map(col => (
                    <td key={col} style={{
                      padding: '2px 6px', color: '#bbb',
                      borderBottom: '1px solid #151515', whiteSpace: 'nowrap',
                      maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {row[col] == null ? '' : (typeof row[col] === 'object' ? JSON.stringify(row[col]) : String(row[col]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: '0.6rem', color: '#444', marginTop: 4 }}>
            {previewResult.row_count} row{previewResult.row_count !== 1 ? 's' : ''} returned
          </div>
        </div>
      )}

      {previewResult && previewResult.rows.length === 0 && !effectivePreviewError && (
        <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
          No rows match the current data binding.
        </div>
      )}
    </>
  )
}

function FilterLinksEditor({
  node,
  filterWidgets,
  availableColumns,
  onWithChangeMany,
}: {
  node: AuraNode
  filterWidgets: Array<{ id: string; label: string }>
  availableColumns: string[]
  onWithChangeMany: (updates: Record<string, string>) => void
}) {
  // Parse stored semicolon-separated values into rows
  function parseRows(): Array<{ widgetId: string; column: string }> {
    const rawIds = node.with?.filterWidgets ?? ''
    const ids = rawIds.split(';').map((s: string) => s.trim()).filter(Boolean)
    if (ids.length > 0) {
      const cols = (node.with?.filterWidgetColumns ?? '').split(';').map((s: string) => s.trim())
      return ids.map((id, i) => ({ widgetId: id, column: cols[i] ?? '' }))
    }
    // Legacy single-filter fallback
    if (node.with?.filterWidget) {
      return [{ widgetId: node.with.filterWidget, column: node.with?.filterWidgetColumn ?? '' }]
    }
    return [{ widgetId: '', column: '' }]
  }

  const [rows, setRows] = React.useState<Array<{ widgetId: string; column: string }>>(parseRows)

  // Keep rows in sync when node changes (e.g. after undo or AI edit)
  React.useEffect(() => {
    setRows(parseRows())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.with?.filterWidgets, node.with?.filterWidgetColumns, node.with?.filterWidget, node.with?.filterWidgetColumn])

  function save(nextRows: Array<{ widgetId: string; column: string }>) {
    setRows(nextRows)
    const filled = nextRows.filter(r => r.widgetId.trim())
    // Use a single atomic update to avoid the stale-closure bug where multiple
    // sequential onWithChange calls each spread the same old node reference and
    // the last one overwrites all previous changes.
    onWithChangeMany({
      filterWidgets: filled.length > 0 ? filled.map(r => r.widgetId).join(';') : '',
      filterWidgetColumns: filled.length > 0 ? filled.map(r => r.column).join(';') : '',
      filterWidget: '',
      filterWidgetColumn: '',
    })
  }

  function updateRow(index: number, field: 'widgetId' | 'column', value: string) {
    const next = rows.map((r, i) => i === index ? { ...r, [field]: value } : r)
    save(next)
  }

  function addRow() {
    save([...rows, { widgetId: '', column: '' }])
  }

  function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index)
    save(next.length > 0 ? next : [{ widgetId: '', column: '' }])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
        Link filter widgets to let end users narrow this widget interactively. Each row matches one filter.
      </div>
      {filterWidgets.length === 0 && (
        <div style={{ fontSize: '0.62rem', color: '#444', lineHeight: 1.5 }}>
          Add a Filter widget to the canvas to enable interactive filtering.
        </div>
      )}
      {rows.map((row, index) => (
        <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', background: '#0d0d0d', borderRadius: 4, border: '1px solid #1a1a1a' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Filter widget</label>
              <select
                value={row.widgetId}
                onChange={e => updateRow(index, 'widgetId', e.target.value)}
                style={{ ...inputStyle, appearance: 'auto' }}
              >
                <option value="">— select —</option>
                {filterWidgets.map(fw => (
                  <option key={fw.id} value={fw.id}>{fw.label}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => removeRow(index)}
              title="Remove"
              style={{
                alignSelf: 'flex-end',
                marginBottom: 0,
                background: 'transparent',
                border: '1px solid #2a1010',
                borderRadius: 4,
                color: '#ef4444',
                cursor: 'pointer',
                fontSize: '0.7rem',
                padding: '4px 8px',
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
          {row.widgetId && (
            <div>
              <label style={labelStyle}>Match column (optional)</label>
              {availableColumns.length > 0 ? (
                <select
                  value={row.column}
                  onChange={e => updateRow(index, 'column', e.target.value)}
                  style={{ ...inputStyle, appearance: 'auto' }}
                >
                  <option value="">Any column</option>
                  {availableColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={row.column}
                  onChange={e => updateRow(index, 'column', e.target.value)}
                  placeholder="e.g. region"
                  style={inputStyle}
                />
              )}
            </div>
          )}
        </div>
      ))}
      {filterWidgets.length > 0 && (
        <button
          onClick={addRow}
          style={{
            background: 'transparent',
            border: '1px solid #1e3a8a',
            borderRadius: 4,
            color: '#60a5fa',
            cursor: 'pointer',
            fontSize: '0.68rem',
            padding: '4px 10px',
            textAlign: 'left',
          }}
        >
          + Link another filter
        </button>
      )}
    </div>
  )
}

function VisualQueryBuilder({
  node,
  selectedConnector,
  availableColumns,
  onWithChange,
}: {
  node: AuraNode
  selectedConnector: Connector | undefined
  availableColumns: string[]
  onWithChange: (key: string, value: string) => void
}) {
  const tables = getConnectorTables(selectedConnector)
  const qbTable = node.with?.qbTable ?? ''
  const tableColumns = getTableColumns(selectedConnector, qbTable)
  const cols = tableColumns.length > 0 ? tableColumns : availableColumns

  const rawWheres = node.with?.qbWheres ?? '[]'
  let wheres: WhereClause[] = []
  try { wheres = JSON.parse(rawWheres) } catch { wheres = [] }
  if (!Array.isArray(wheres) || wheres.length === 0) wheres = [{ col: '', op: 'eq', val: '' }]

  const qbGroupBy = node.with?.qbGroupBy ?? ''
  const qbOrderBy = node.with?.qbOrderBy ?? ''
  const qbDir = node.with?.qbDir ?? 'asc'
  const qbLimit = node.with?.qbLimit ?? ''

  function applyQB(
    table: string,
    nextWheres: WhereClause[],
    groupBy: string,
    orderBy: string,
    dir: string,
    limit: string,
  ) {
    const sql = generateQBSQL(table, nextWheres, groupBy, orderBy, dir, limit)
    onWithChange('qbTable', table)
    onWithChange('qbWheres', JSON.stringify(nextWheres))
    onWithChange('qbGroupBy', groupBy)
    onWithChange('qbOrderBy', orderBy)
    onWithChange('qbDir', dir)
    onWithChange('qbLimit', limit)
    if (sql) onWithChange('sql', sql)
  }

  function updateWhere(index: number, field: keyof WhereClause, value: string) {
    const next = wheres.map((w, i) => i === index ? { ...w, [field]: value } : w)
    applyQB(qbTable, next, qbGroupBy, qbOrderBy, qbDir, qbLimit)
  }

  function addWhere() {
    applyQB(qbTable, [...wheres, { col: '', op: 'eq', val: '' }], qbGroupBy, qbOrderBy, qbDir, qbLimit)
  }

  function removeWhere(index: number) {
    const next = wheres.filter((_, i) => i !== index)
    applyQB(qbTable, next.length > 0 ? next : [{ col: '', op: 'eq', val: '' }], qbGroupBy, qbOrderBy, qbDir, qbLimit)
  }

  if (tables.length === 0) return null

  const opLabels: Record<WhereOp, string> = {
    eq: 'equals', neq: 'not equals', gt: '>', gte: '>=', lt: '<', lte: '<=',
    like: 'contains', is_null: 'is empty', not_null: 'is not empty',
  }

  return (
    <details open={!!qbTable} style={{ border: '1px solid #1a1a1a', borderRadius: 4, background: '#0d0d0d' }}>
      <summary style={{ padding: '8px 10px', cursor: 'pointer', color: '#cbd5e1', fontSize: '0.68rem', fontWeight: 600 }}>
        Query builder
      </summary>
      <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
          Choose a table and optional filters. The generated SQL is applied to the base query below.
        </div>

        {/* Table picker */}
        <div>
          <label style={labelStyle}>Source table</label>
          <select
            value={qbTable}
            onChange={e => applyQB(e.target.value, [{ col: '', op: 'eq', val: '' }], '', '', 'asc', qbLimit)}
            style={{ ...inputStyle, appearance: 'auto' }}
          >
            <option value="">— select table —</option>
            {tables.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* WHERE conditions */}
        {qbTable && (
          <>
            <div style={{ fontSize: '0.62rem', color: '#555' }}>Filter rows (WHERE)</div>
            {wheres.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                {/* Column */}
                <div style={{ flex: '1 1 80px' }}>
                  {cols.length > 0 ? (
                    <select
                      value={w.col}
                      onChange={e => updateWhere(i, 'col', e.target.value)}
                      style={{ ...inputStyle, appearance: 'auto', fontSize: '0.65rem' }}
                    >
                      <option value="">— column —</option>
                      {cols.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={w.col}
                      onChange={e => updateWhere(i, 'col', e.target.value)}
                      placeholder="column"
                      style={{ ...inputStyle, fontSize: '0.65rem' }}
                    />
                  )}
                </div>
                {/* Operator */}
                <div style={{ flex: '0 0 90px' }}>
                  <select
                    value={w.op}
                    onChange={e => updateWhere(i, 'op', e.target.value as WhereOp)}
                    style={{ ...inputStyle, appearance: 'auto', fontSize: '0.65rem' }}
                  >
                    {(Object.keys(opLabels) as WhereOp[]).map(op => (
                      <option key={op} value={op}>{opLabels[op]}</option>
                    ))}
                  </select>
                </div>
                {/* Value (hidden for null checks) */}
                {w.op !== 'is_null' && w.op !== 'not_null' && (
                  <div style={{ flex: '1 1 80px' }}>
                    <input
                      type="text"
                      value={w.val}
                      onChange={e => updateWhere(i, 'val', e.target.value)}
                      placeholder="value"
                      style={{ ...inputStyle, fontSize: '0.65rem' }}
                    />
                  </div>
                )}
                {/* Remove */}
                <button
                  onClick={() => removeWhere(i)}
                  style={{ background: 'transparent', border: '1px solid #2a1010', borderRadius: 3, color: '#ef4444', cursor: 'pointer', fontSize: '0.65rem', padding: '3px 7px', flexShrink: 0 }}
                >×</button>
              </div>
            ))}
            <button
              onClick={addWhere}
              style={{ background: 'transparent', border: '1px solid #1a1a1a', borderRadius: 3, color: '#555', cursor: 'pointer', fontSize: '0.65rem', padding: '3px 8px', textAlign: 'left' }}
            >+ Add condition</button>

            {/* ORDER BY */}
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Order by</label>
                {cols.length > 0 ? (
                  <select
                    value={qbOrderBy}
                    onChange={e => applyQB(qbTable, wheres, qbGroupBy, e.target.value, qbDir, qbLimit)}
                    style={{ ...inputStyle, appearance: 'auto' }}
                  >
                    <option value="">None</option>
                    {cols.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={qbOrderBy}
                    onChange={e => applyQB(qbTable, wheres, qbGroupBy, e.target.value, qbDir, qbLimit)}
                    placeholder="column"
                    style={inputStyle}
                  />
                )}
              </div>
              {qbOrderBy && (
                <div style={{ flex: '0 0 70px' }}>
                  <label style={labelStyle}>Direction</label>
                  <select
                    value={qbDir}
                    onChange={e => applyQB(qbTable, wheres, qbGroupBy, qbOrderBy, e.target.value, qbLimit)}
                    style={{ ...inputStyle, appearance: 'auto' }}
                  >
                    <option value="asc">ASC</option>
                    <option value="desc">DESC</option>
                  </select>
                </div>
              )}
            </div>

            {/* LIMIT */}
            <div>
              <label style={labelStyle}>Row limit</label>
              <input
                type="number"
                min="1"
                value={qbLimit}
                onChange={e => applyQB(qbTable, wheres, qbGroupBy, qbOrderBy, qbDir, e.target.value)}
                placeholder="None"
                style={inputStyle}
              />
            </div>
          </>
        )}
      </div>
    </details>
  )
}

function FilterDataSourceEditor({
  node,
  workspaceId,
  onWithChange,
}: {
  node: AuraNode
  workspaceId: string
  onWithChange: (key: string, value: string) => void
}) {
  const [connectors, setConnectors] = useState<Connector[]>([])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    listConnectors(workspaceId)
      .then(res => { if (!cancelled) setConnectors(res.connectors ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  const connectorId = node.with?.optionsConnector ?? ''
  const selectedConnector = connectors.find(c => c.id === connectorId)
  const schemaColumns = getConnectorSchemaColumns(selectedConnector)
  const optionsColumn = node.with?.optionsColumn ?? ''
  const optionsEndpoint = node.with?.optionsEndpoint ?? ''
  const isREST = selectedConnector?.type === 'rest'
  const restEndpoints = (() => {
    if (!isREST) return []
    const eps = selectedConnector?.schema_cache?.endpoints
    if (!Array.isArray(eps)) return []
    return eps as { label: string; path: string }[]
  })()

  // Sync optionsConnectorType whenever the selected connector changes — mirrors
  // the same pattern DataBindingEditor uses for connectorType to avoid the
  // double-onWithChange overwrite bug (both calls share the same stale node ref).
  useEffect(() => {
    if (!selectedConnector?.type) return
    if (node.with?.optionsConnectorType === selectedConnector.type) return
    onWithChange('optionsConnectorType', selectedConnector.type)
  }, [selectedConnector?.type, node.with?.optionsConnectorType, onWithChange])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: '0.62rem', color: '#555', lineHeight: 1.5 }}>
        Connect this filter to a CSV, managed, or REST connector to auto-populate its dropdown from a data column. Overrides manual options in Props.
      </div>
      <div>
        <label style={labelStyle}>Connector (CSV, Lima Table, or REST)</label>
        <select
          value={connectorId}
          onChange={e => onWithChange('optionsConnector', e.target.value)}
          style={{ ...inputStyle, appearance: 'auto' }}
        >
          <option value="">— select connector —</option>
          {connectors.filter(c => c.type === 'csv' || c.type === 'managed' || c.type === 'rest').map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      {connectorId && isREST && (
        <div>
          <label style={labelStyle}>Endpoint</label>
          {restEndpoints.length > 0 ? (
            <select
              value={optionsEndpoint}
              onChange={e => onWithChange('optionsEndpoint', e.target.value)}
              style={{ ...inputStyle, appearance: 'auto' }}
            >
              <option value="">— select endpoint —</option>
              {restEndpoints.map(ep => (
                <option key={ep.path} value={ep.path}>{ep.label || ep.path}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={optionsEndpoint}
              onChange={e => onWithChange('optionsEndpoint', e.target.value)}
              placeholder="e.g. /users"
              style={inputStyle}
            />
          )}
        </div>
      )}
      {connectorId && (
        <div>
          <label style={labelStyle}>Options column</label>
          {schemaColumns.length > 0 ? (
            <select
              value={optionsColumn}
              onChange={e => onWithChange('optionsColumn', e.target.value)}
              style={{ ...inputStyle, appearance: 'auto' }}
            >
              <option value="">— select column —</option>
              {schemaColumns.map(col => (
                <option key={col} value={col}>{col}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={optionsColumn}
              onChange={e => onWithChange('optionsColumn', e.target.value)}
              placeholder="e.g. category"
              style={inputStyle}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ---- WorkflowCard: widget-centric workflow binding ----------------------- */

interface WorkflowCardProps {
  workspaceId: string
  appId: string
  pageId: string
  triggerType: 'form_submit' | 'button_click'
  widgetId: string
  workflowId?: string
  onLink: (workflowId: string) => void
  onUnlink: () => void
  onOpenCanvas?: (workflowId: string) => void
  onOpenSplitView?: (workflowId: string) => void
}

function WorkflowCard({
  workspaceId, appId, pageId, triggerType, widgetId,
  workflowId, onLink, onUnlink, onOpenCanvas, onOpenSplitView,
}: WorkflowCardProps) {
  const [workflow, setWorkflow] = React.useState<Workflow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [linkExpanded, setLinkExpanded] = React.useState(false)
  const [error, setError] = React.useState('')

  // Load bound workflow details when workflowId changes.
  React.useEffect(() => {
    if (!workflowId || !workspaceId || !appId) { setWorkflow(null); return }
    let cancelled = false
    getWorkflow(workspaceId, appId, workflowId)
      .then(wf => { if (!cancelled) setWorkflow(wf) })
      .catch(() => { if (!cancelled) setWorkflow(null) })
    return () => { cancelled = true }
  }, [workflowId, workspaceId, appId])

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    setError('')
    try {
      const label = triggerType === 'form_submit' ? 'Form' : 'Button'
      const wf = await createWorkflow(workspaceId, appId, {
        name: `${label} Workflow`,
        trigger_type: triggerType,
        trigger_config: { widget_id: widgetId },
        requires_approval: true,
        steps: [],
        source_widget_id: widgetId,
        source_page_id: pageId,
      })
      onLink(wf.id)
      setWorkflow(wf)
      onOpenSplitView?.(wf.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow')
    } finally {
      setCreating(false)
    }
  }

  const cardStyle: React.CSSProperties = {
    background: '#111',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
    padding: '8px 10px',
  }

  const smallBtn = (primary = false): React.CSSProperties => ({
    background: primary ? '#1d4ed8' : '#1a1a1a',
    color: primary ? '#bfdbfe' : '#aaa',
    border: primary ? 'none' : '1px solid #1e1e1e',
    borderRadius: 3,
    padding: '3px 9px',
    fontSize: '0.68rem',
    cursor: 'pointer',
  })

  if (workflow) {
    const statusColor = workflow.status === 'active' ? '#4ade80' : workflow.status === 'archived' ? '#555' : '#fbbf24'
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#e5e5e5', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {workflow.name}
          </span>
          <span style={{ fontSize: '0.58rem', padding: '1px 6px', borderRadius: 99, background: statusColor + '22', color: statusColor, flexShrink: 0 }}>
            {workflow.status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <button
            style={smallBtn(true)}
            onClick={() => (onOpenSplitView ?? onOpenCanvas)?.(workflow.id)}
          >
            Edit workflow
          </button>
          <button
            style={smallBtn()}
            onClick={onUnlink}
          >
            Unlink
          </button>
        </div>
        {error && <div style={{ fontSize: '0.65rem', color: '#fca5a5', marginTop: 5 }}>{error}</div>}
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <button
        style={{ ...smallBtn(true), width: '100%', textAlign: 'center' }}
        onClick={handleCreate}
        disabled={creating}
      >
        {creating ? 'Creating…' : '+ Create Workflow'}
      </button>

      {/* Link existing — advanced / escape hatch */}
      <button
        style={{ ...smallBtn(), width: '100%', textAlign: 'center', marginTop: 5 }}
        onClick={() => setLinkExpanded(e => !e)}
      >
        {linkExpanded ? '▴ Link existing' : '▾ Link existing'}
      </button>

      {linkExpanded && (
        <div style={{ marginTop: 5 }}>
          <WorkflowSelector
            workspaceId={workspaceId}
            appId={appId}
            triggerType={triggerType}
            value={workflowId}
            onChange={id => { if (id) onLink(id) }}
          />
        </div>
      )}
      {error && <div style={{ fontSize: '0.65rem', color: '#fca5a5', marginTop: 5 }}>{error}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid #1a1a1a' }}>
      <div style={{
        padding: '6px 1rem', fontSize: '0.6rem', fontWeight: 600,
        color: '#444', textTransform: 'uppercase', letterSpacing: '0.08em',
        background: '#0c0c0c',
      }}>
        {title}
      </div>
      <div style={{ padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  )
}

function Field({
  label, value, type = 'text', onChange,
}: {
  label: string
  value: string
  type?: 'text' | 'number'
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  )
}

function PropField({ name, def, value, onChange }: {
  name: string
  def: PropDef
  value: string
  onChange: (v: string) => void
}) {
  const isBoolean = def.type === 'boolean'
  const isMono = def.type === 'expression' || def.type === 'action'

  return (
    <div>
      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
        {def.label}
        {def.required && <span style={{ color: '#ef4444', fontSize: '0.6rem' }}>*</span>}
      </label>
      {isBoolean ? (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          style={{ accentColor: '#3b82f6', marginTop: 2 }}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={def.default !== undefined ? String(def.default) : ''}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, fontFamily: isMono ? 'monospace' : 'inherit', fontSize: isMono ? '0.65rem' : '0.75rem' }}
        />
      )}
      {def.description && (
        <div style={{ fontSize: '0.6rem', color: '#333', marginTop: 3 }}>{def.description}</div>
      )}
    </div>
  )
}

/* ---- Styles ----------------------------------------------------------- */

const panelStyle: React.CSSProperties = {
  width: 260,
  flexShrink: 0,
  borderLeft: '1px solid #1a1a1a',
  background: '#0a0a0a',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.65rem',
  color: '#555',
  marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #222',
  borderRadius: 4,
  color: '#e5e5e5',
  padding: '4px 8px',
  fontSize: '0.75rem',
  boxSizing: 'border-box',
  outline: 'none',
}
