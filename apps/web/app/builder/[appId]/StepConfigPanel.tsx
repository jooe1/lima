'use client'

import React, { useState, useEffect } from 'react'
import { type AuraNode, type AuraDocumentV2 } from '@lima/aura-dsl'
import { listConnectors, runConnectorQuery, type Connector, type DashboardQueryResponse } from '../../../lib/api'
import { ExpressionInput, buildAvailableWidgets, type AvailableWidget } from './ExpressionInput'
import {
  defaultGuided, sqlFromGuided, tryParseSQL,
  type GuidedState, type WhereClause, type SetClause, type MutationOp, type WhereOp,
} from './stepSqlUtils'

interface Props {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
  onDelete: (id: string) => void
  workspaceId: string
  /** Full app document — used to enumerate bindable widget ports and detect
   *  drag-to-wire binding edges for this step node. */
  doc: AuraDocumentV2
}

// Shared style helpers
const panelStyle: React.CSSProperties = {
  width: 280,
  flexShrink: 0,
  borderLeft: '1px solid #1a1a1a',
  background: '#0d0d0d',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.65rem',
  color: '#555',
  marginBottom: 4,
  display: 'block',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #1e1e1e',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: '0.72rem',
  color: '#e5e5e5',
  boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 80,
  fontFamily: 'monospace',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid #1a1a1a' }}>
      <div style={{
        padding: '6px 1rem',
        fontSize: '0.6rem',
        fontWeight: 600,
        color: '#444',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
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
  label, value, onChange, type = 'text', placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'textarea'
  placeholder?: string
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {type === 'textarea' ? (
        <textarea
          style={textareaStyle}
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
        />
      ) : (
        <input
          style={inputStyle}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

// ---- Step type metadata ----------------------------------------------------

const STEP_META: Record<string, { icon: string; label: string; color: string }> = {
  'step:query':         { icon: '📋', label: 'Query',         color: '#3b82f6' },
  'step:mutation':      { icon: '✏️',  label: 'Mutation',     color: '#fb923c' },
  'step:condition':     { icon: '◆',  label: 'Condition',    color: '#facc15' },
  'step:approval_gate': { icon: '🔒', label: 'Approval Gate', color: '#a78bfa' },
  'step:notification':  { icon: '🔔', label: 'Notification', color: '#34d399' },
  'step:transform':     { icon: '{}', label: 'Transform',    color: '#e879f9' },
  'step:http':          { icon: '🌐', label: 'HTTP Request', color: '#38bdf8' },
}

// ---- SQL builder helpers ---------------------------------------------------

/**
 * Mirrors Go's managedTableName() in queryexec.go.
 * Collapses non-word characters to underscores, strips leading/trailing
 * underscores, prepends '_' if the name starts with a digit.
 */
function managedTableName(name: string): string {
  let s = name.replace(/\W+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) s = 'data'
  if (s[0] >= '0' && s[0] <= '9') s = '_' + s
  return s
}

interface SchemaTable {
  name: string
  columns: Array<{ name: string; type: string }>
}

/** Extract table → columns from whatever shape schema_cache was stored in. */
function extractTables(connector: Connector | undefined): SchemaTable[] {
  const cache = connector?.schema_cache
  if (!cache) return []

  // SQL connectors: { tables: { tableName: { Columns: [{Name,Type}] } } }
  if (cache.tables && typeof cache.tables === 'object') {
    return Object.entries(cache.tables as Record<string, unknown>).map(([name, tbl]) => {
      const t = tbl as Record<string, unknown>
      const cols = Array.isArray(t.Columns) ? t.Columns : (Array.isArray(t.columns) ? t.columns : [])
      return {
        name,
        columns: cols.map((c: unknown) => {
          const col = c as Record<string, unknown>
          return { name: String(col.Name ?? col.name ?? ''), type: String(col.Type ?? col.type ?? '') }
        }).filter(c => c.name),
      }
    })
  }

  // Managed connectors: { columns: [{name,col_type}] }
  if (Array.isArray(cache.columns)) {
    const cols = (cache.columns as Array<Record<string, unknown>>).map(c => ({
      name: String(c.name ?? ''),
      type: String(c.col_type ?? c.type ?? ''),
    })).filter(c => c.name)
    return [{ name: managedTableName(connector!.name), columns: cols }]
  }

  return []
}

// ---- Sub-editors per step type ---------------------------------------------

const WHERE_OPS: WhereOp[] = ['=', '!=', 'LIKE', '>', '<', '>=', '<=']

function WhereBuilder({
  clauses, columns, onChange, availableWidgets, boundSlots, emptyStateLabel,
}: {
  clauses: WhereClause[]
  columns: string[]
  onChange: (next: WhereClause[]) => void
  availableWidgets: AvailableWidget[]
  /** Set of slot indices that are locked via a drag-to-wire binding edge. */
  boundSlots: Set<number>
  emptyStateLabel: string
}) {
  const add = () => onChange([...clauses, { col: columns[0] ?? '', op: '=', val: '' }])
  const remove = (i: number) => onChange(clauses.filter((_, idx) => idx !== i))
  const update = (i: number, patch: Partial<WhereClause>) =>
    onChange(clauses.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={labelStyle}>Where (filters)</span>
        <button onClick={add} style={{ fontSize: '0.6rem', color: '#555', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add filter</button>
      </div>
      {clauses.length === 0 && (
        <div style={{ fontSize: '0.6rem', color: '#333', fontStyle: 'italic' }}>{emptyStateLabel}</div>
      )}
      {clauses.map((clause, i) => {
        const isWired = boundSlots.has(i)
        return (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr 18px', gap: 4, alignItems: 'center' }}>
          {columns.length > 0 ? (
            <select style={selectStyle} value={clause.col} onChange={e => update(i, { col: e.target.value })}>
              <option value="">Column…</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input style={inputStyle} value={clause.col} placeholder="column" onChange={e => update(i, { col: e.target.value })} />
          )}
          <select style={selectStyle} value={clause.op} onChange={e => update(i, { op: e.target.value as WhereOp })}>
            {WHERE_OPS.map(op => <option key={op} value={op}>{op}</option>)}
          </select>
          {isWired ? (
            <ExpressionInput
              value={clause.val}
              onChange={() => {}}
              availableWidgets={availableWidgets}
              locked
              lockLabel={clause.val.replace(/^\{\{|\}\}$/g, '')}
            />
          ) : (
            <ExpressionInput
              value={clause.val}
              onChange={v => update(i, { val: v })}
              placeholder="value or @widget"
              availableWidgets={availableWidgets}
            />
          )}
          <button onClick={() => remove(i)} style={{ fontSize: '0.7rem', color: '#555', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>
        )
      })}
    </div>
  )
}

function PreviewResults({ result, error, loading }: { result: DashboardQueryResponse | null; error: string; loading: boolean }) {
  if (loading) return <div style={{ fontSize: '0.65rem', color: '#555', padding: '6px 0' }}>Running…</div>
  if (error) return <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '4px 0' }}>{error}</div>
  if (!result) return null

  const cols = result.columns ?? []
  const rows = result.rows ?? []

  return (
    <div style={{ overflowX: 'auto', marginTop: 4 }}>
      <div style={{ fontSize: '0.6rem', color: '#444', marginBottom: 4 }}>
        {result.row_count} row{result.row_count !== 1 ? 's' : ''} — showing up to 10
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.6rem' }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '2px 6px', background: '#0c0c0c', color: '#555', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #111' }}>
              {cols.map(c => (
                <td key={c} style={{ padding: '2px 6px', color: '#666', whiteSpace: 'nowrap', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {String(row[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SqlStepEditor({
  node, onUpdate, workspaceId, availableWidgets, boundSetSlots, boundWhereSlots,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
  workspaceId: string
  availableWidgets: AvailableWidget[]
  /** SET clause slot indices wired via drag-to-wire binding edges. */
  boundSetSlots: Set<number>
  /** WHERE clause slot indices wired via drag-to-wire binding edges. */
  boundWhereSlots: Set<number>
}) {
  const isQuery = node.element === 'step:query'
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [mode, setMode] = useState<'guided' | 'sql'>('guided')
  // Initialise from the persisted SQL so fields survive page refresh / re-open.
  const [guided, setGuided] = useState<GuidedState>(() => {
    const sql = String((node.with ?? {}).sql ?? '')
    if (sql) {
      const parsed = tryParseSQL(sql, node.element === 'step:query')
      if (parsed) return parsed
    }
    return defaultGuided()
  })
  const [parseWarning, setParseWarning] = useState('')
  const [preview, setPreview] = useState<DashboardQueryResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    if (!workspaceId) return
    listConnectors(workspaceId).then(res => setConnectors(res.connectors ?? [])).catch(() => {})
  }, [workspaceId])

  const with_ = node.with ?? {}
  const connectorId = String(with_.connector_id ?? '')
  const currentSql = String(with_.sql ?? '')
  const selectedConnector = connectors.find(c => c.id === connectorId)
  const tables = extractTables(selectedConnector)

  const isManaged = selectedConnector?.type === 'managed'

  // When the connector changes, reset guided state and auto-fill the table
  // name for managed connectors (they always have exactly one table).
  const prevConnectorRef = React.useRef(connectorId)
  useEffect(() => {
    if (connectorId !== prevConnectorRef.current) {
      prevConnectorRef.current = connectorId
      const newConnector = connectors.find(c => c.id === connectorId)
      const autoTable = newConnector?.type === 'managed' ? managedTableName(newConnector.name) : ''
      setGuided({ ...defaultGuided(), table: autoTable })
      setPreview(null)
    }
  }, [connectorId, connectors])

  // When the connector list loads after mount and the selected connector is
  // managed, backfill guided.table if it is still empty (covers the case where
  // the panel opened with an already-configured managed connector).
  useEffect(() => {
    if (isManaged && selectedConnector && !guided.table) {
      setGuided(g => ({ ...g, table: managedTableName(selectedConnector.name) }))
    }
  }, [isManaged, selectedConnector]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the mode switches to guided, try to parse current SQL
  const switchToGuided = () => {
    const parsed = tryParseSQL(currentSql, isQuery)
    if (!parsed) {
      setParseWarning('This SQL is too complex for guided mode — editing in SQL.')
      return
    }
    setParseWarning('')
    setGuided(parsed)
    setMode('guided')
  }

  const switchToSql = () => {
    // Flush guided state → SQL
    const sql = sqlFromGuided(guided, isQuery)
    if (sql && !currentSql) {
      setWith('sql', sql)
    }
    setMode('sql')
  }

  const setWith = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: { ...(node.with ?? {}), [key]: value },
    })
  }

  const clearWith = (key: string) => {
    const next = { ...(node.with ?? {}) }
    delete next[key]
    onUpdate({ ...node, with: next })
  }

  // Sync guided state → node when guided changes
  const updateGuided = (patch: Partial<GuidedState>) => {
    const next = { ...guided, ...patch }
    setGuided(next)
    const sql = sqlFromGuided(next, isQuery)
    if (sql) setWith('sql', sql)
    else clearWith('sql')
  }

  const selectedTable = tables.find(t => t.name === guided.table)
  const tableColumns = selectedTable?.columns.map(c => c.name) ?? []

  const handlePreview = async () => {
    const sql = mode === 'guided' ? sqlFromGuided(guided, isQuery) : currentSql
    if (!connectorId || !sql) return
    setPreviewLoading(true)
    setPreviewError('')
    setPreview(null)
    try {
      const res = await runConnectorQuery(workspaceId, connectorId, { sql, limit: 10 })
      if (res.error) setPreviewError(res.error)
      else setPreview(res)
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setPreviewLoading(false)
    }
  }

  const effectiveSql = mode === 'guided' ? sqlFromGuided(guided, isQuery) : currentSql
  const canPreview = Boolean(connectorId && effectiveSql && isQuery)

  return (
    <>
      {/* Connector */}
      <div>
        <label style={labelStyle}>Connector</label>
        <select
          style={selectStyle}
          value={connectorId}
          onChange={e => setWith('connector_id', e.target.value)}
        >
          <option value="">Select a connector…</option>
          {connectors.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid #1e1e1e' }}>
        {(['guided', 'sql'] as const).map(m => (
          <button
            key={m}
            onClick={() => m === 'guided' ? switchToGuided() : switchToSql()}
            style={{
              flex: 1,
              padding: '4px 0',
              fontSize: '0.65rem',
              background: mode === m ? '#1a1a1a' : 'transparent',
              color: mode === m ? '#e5e5e5' : '#555',
              border: 'none',
              cursor: 'pointer',
              fontWeight: mode === m ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {m === 'guided' ? 'Guided' : 'SQL'}
          </button>
        ))}
      </div>

      {parseWarning && (
        <div style={{ fontSize: '0.6rem', color: '#fb923c', fontStyle: 'italic' }}>{parseWarning}</div>
      )}

      {/* Guided mode */}
      {mode === 'guided' && (
        <>
          {/* Table */}
          <div>
            <label style={labelStyle}>Table</label>
            {isManaged ? (
              // Managed connectors always have exactly one table — show it as
              // a read-only chip so the builder can't accidentally change it.
              <div style={{
                ...inputStyle,
                color: '#888',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'default',
              }}>
                <span style={{ fontSize: '0.6rem', background: '#1e1e1e', borderRadius: 3, padding: '1px 5px', color: '#f59e0b' }}>managed</span>
                {guided.table || (selectedConnector ? managedTableName(selectedConnector.name) : '—')}
              </div>
            ) : tables.length > 0 ? (
              <select style={selectStyle} value={guided.table} onChange={e => updateGuided({ table: e.target.value })}>
                <option value="">Select a table…</option>
                {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            ) : (
              <input
                style={inputStyle}
                value={guided.table}
                placeholder="table_name"
                onChange={e => updateGuided({ table: e.target.value })}
              />
            )}
          </div>

          {/* Mutation operation selector */}
          {!isQuery && (
            <div>
              <label style={labelStyle}>Operation</label>
              <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid #1e1e1e' }}>
                {(['INSERT', 'UPDATE', 'DELETE'] as MutationOp[]).map(op => (
                  <button
                    key={op}
                    onClick={() => updateGuided({ mutationOp: op })}
                    style={{
                      flex: 1, padding: '4px 0', fontSize: '0.6rem',
                      background: guided.mutationOp === op ? '#1a1a1a' : 'transparent',
                      color: guided.mutationOp === op ? '#e5e5e5' : '#555',
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    {op}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* SET clauses — INSERT / UPDATE */}
          {!isQuery && guided.mutationOp !== 'DELETE' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={labelStyle}>{guided.mutationOp === 'INSERT' ? 'Columns to set' : 'Fields to update'}</label>
                <button
                  onClick={() => updateGuided({ setClauses: [...guided.setClauses, { col: '', val: '' }] })}
                  style={{ fontSize: '0.6rem', color: '#555', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  + Add field
                </button>
              </div>
              {guided.setClauses.map((s, i) => {
                const isWired = boundSetSlots.has(i)
                return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 18px', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  {tableColumns.length > 0 ? (
                    <select style={selectStyle} value={s.col} onChange={e => {
                      const next = guided.setClauses.map((sc, idx) => idx === i ? { ...sc, col: e.target.value } : sc)
                      updateGuided({ setClauses: next })
                    }}>
                      <option value="">Column…</option>
                      {tableColumns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <input style={inputStyle} value={s.col} placeholder="column" onChange={e => {
                      const next = guided.setClauses.map((sc, idx) => idx === i ? { ...sc, col: e.target.value } : sc)
                      updateGuided({ setClauses: next })
                    }} />
                  )}
                  {isWired ? (
                    <ExpressionInput
                      value={s.val}
                      onChange={() => {}}
                      availableWidgets={availableWidgets}
                      locked
                      lockLabel={s.val.replace(/^\{\{|\}\}$/g, '')}
                    />
                  ) : (
                    <ExpressionInput
                      value={s.val}
                      onChange={v => {
                        const next = guided.setClauses.map((sc, idx) => idx === i ? { ...sc, val: v } : sc)
                        updateGuided({ setClauses: next })
                      }}
                      placeholder="value or @widget"
                      availableWidgets={availableWidgets}
                    />
                  )}
                  <button
                    onClick={() => updateGuided({ setClauses: guided.setClauses.filter((_, idx) => idx !== i) })}
                    style={{ fontSize: '0.7rem', color: '#555', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >✕</button>
                </div>
                )
              })}
            </div>
          )}

          {/* WHERE clauses — not applicable for INSERT */}
          {(isQuery || guided.mutationOp === 'UPDATE' || guided.mutationOp === 'DELETE') && (
            <WhereBuilder
              clauses={guided.whereClauses}
              columns={tableColumns}
              onChange={whereClauses => updateGuided({ whereClauses })}
              availableWidgets={availableWidgets}
              boundSlots={boundWhereSlots}
              emptyStateLabel={isQuery ? 'No filters — returns all rows.' : 'No filters — affects all rows.'}
            />
          )}

          {/* LIMIT — queries only */}
          {isQuery && (
            <Field
              label="Row limit"
              value={guided.limit}
              placeholder="50"
              onChange={limit => updateGuided({ limit })}
            />
          )}

          {/* Generated SQL preview */}
          {effectiveSql && (
            <div>
              <label style={labelStyle}>Generated SQL</label>
              <div style={{
                fontSize: '0.6rem', fontFamily: 'monospace', color: '#3b82f6',
                background: '#0a0a0a', borderRadius: 4, padding: '6px 8px',
                wordBreak: 'break-all', lineHeight: 1.5, border: '1px solid #1a1a1a',
              }}>
                {effectiveSql}
              </div>
            </div>
          )}
        </>
      )}

      {/* SQL mode */}
      {mode === 'sql' && (
        <>
          <Field
            label="SQL"
            type="textarea"
            value={currentSql}
            placeholder={isQuery
              ? 'SELECT * FROM users WHERE status = {{form1.status}}'
              : 'INSERT INTO orders (user_id, amount) VALUES ({{form1.userId}}, {{form1.amount}})'}
            onChange={v => setWith('sql', v)}
          />
          <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
            Use <code style={{ color: '#555' }}>{'{{widgetId.portName}}'}</code> to reference widget values.
          </div>
        </>
      )}

      {/* Preview — queries only */}
      {isQuery && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={labelStyle}>Preview results</label>
            <button
              disabled={!canPreview || previewLoading}
              onClick={handlePreview}
              style={{
                fontSize: '0.6rem',
                padding: '3px 8px',
                borderRadius: 4,
                background: canPreview ? '#1a2a1a' : 'transparent',
                color: canPreview ? '#4ade80' : '#333',
                border: `1px solid ${canPreview ? '#1e3a1e' : '#1a1a1a'}`,
                cursor: canPreview ? 'pointer' : 'default',
              }}
            >
              {previewLoading ? 'Running…' : 'Run preview'}
            </button>
          </div>
          <PreviewResults result={preview} error={previewError} loading={previewLoading} />
        </div>
      )}
    </>
  )
}

function ConditionEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}

  const set = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: {
        ...with_,
        ...(value ? { [key]: value } : {}),
        ...(value ? {} : Object.fromEntries(Object.entries(with_).filter(([k]) => k !== key))),
      },
    })
  }

  return (
    <>
      <Field
        label="Expression"
        type="textarea"
        value={String(with_.expression ?? '')}
        placeholder="e.g. {{form1.values.status}} === 'active'"
        onChange={v => set('expression', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
        Must evaluate to a boolean. The <span style={{ color: '#4ade80' }}>true branch</span> fires when truthy, <span style={{ color: '#f87171' }}>false branch</span> otherwise.
      </div>
    </>
  )
}

function NotificationEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}

  const set = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: {
        ...with_,
        ...(value ? { [key]: value } : {}),
        ...(value ? {} : Object.fromEntries(Object.entries(with_).filter(([k]) => k !== key))),
      },
    })
  }

  return (
    <>
      <Field
        label="Channel"
        value={String(with_.channel ?? '')}
        placeholder="#general"
        onChange={v => set('channel', v)}
      />
      <Field
        label="Message"
        type="textarea"
        value={String(with_.message ?? '')}
        placeholder="New submission from {{form1.values.name}}"
        onChange={v => set('message', v)}
      />
    </>
  )
}

function TransformEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}
  const set = (key: string, value: string) =>
    onUpdate({ ...node, with: { ...with_, [key]: value } })

  return (
    <>
      <Field
        label="Expression (JS)"
        type="textarea"
        value={String(with_.expression ?? '')}
        placeholder="e.g. ({ name: $input.firstName + ' ' + $input.lastName })"
        onChange={v => set('expression', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic', lineHeight: 1.5 }}>
        Use <code style={{ color: '#555' }}>$input</code> to access the node&apos;s input value.
        Return the reshaped object as a JS expression.
      </div>
    </>
  )
}

function HttpEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}
  const set = (key: string, value: string) =>
    onUpdate({ ...node, with: { ...with_, [key]: value } })

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8 }}>
        <div>
          <label style={labelStyle}>Method</label>
          <select
            style={selectStyle}
            value={String(with_.method ?? 'GET')}
            onChange={e => set('method', e.target.value)}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 0 }}>
          <Field
            label="URL"
            value={String(with_.url ?? '')}
            placeholder="https://api.example.com/endpoint"
            onChange={v => set('url', v)}
          />
        </div>
      </div>
      <Field
        label="Headers (JSON object)"
        type="textarea"
        value={String(with_.headers ?? '')}
        placeholder='{"Authorization": "Bearer {{token}}"}'
        onChange={v => set('headers', v)}
      />
      <Field
        label="Body (JSON)"
        type="textarea"
        value={String(with_.body ?? '')}
        placeholder='{"key": "{{widget.value}}"}'
        onChange={v => set('body', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
        Use <code style={{ color: '#555' }}>{'{{widgetId.portName}}'}</code> for dynamic values.
      </div>
    </>
  )
}

// ---- Main component --------------------------------------------------------

export function StepConfigPanel({ node, onUpdate, onDelete, workspaceId, doc }: Props) {
  const meta = STEP_META[node.element]

  // Derive available widgets for binding pickers
  const availableWidgets = buildAvailableWidgets(doc.nodes)

  // Derive which SET/WHERE slots are wired via drag-to-wire binding edges
  const bindingEdges = doc.edges.filter(
    e => e.edgeType === 'binding' && e.toNodeId === node.id,
  )
  const boundSetSlots = new Set(
    bindingEdges
      .filter(e => e.toPort.startsWith('bind:set:'))
      .map(e => parseInt(e.toPort.split(':')[2], 10)),
  )
  const boundWhereSlots = new Set(
    bindingEdges
      .filter(e => e.toPort.startsWith('bind:where:'))
      .map(e => parseInt(e.toPort.split(':')[2], 10)),
  )

  const handleNameChange = (value: string) => {
    onUpdate({ ...node, text: value || undefined })
  }

  return (
    <aside style={panelStyle}>
      {/* Header */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: '1rem' }}>{meta?.icon ?? '⚙️'}</span>
          <span style={{
            fontSize: '0.6rem',
            padding: '2px 7px',
            borderRadius: 99,
            background: (meta?.color ?? '#555') + '22',
            color: meta?.color ?? '#aaa',
            fontWeight: 500,
          }}>
            {meta?.label ?? node.element}
          </span>
        </div>
        <div>
          <label style={labelStyle}>Step name</label>
          <input
            style={inputStyle}
            type="text"
            value={node.text ?? ''}
            placeholder={node.id}
            onChange={e => handleNameChange(e.target.value)}
          />
        </div>
        <div style={{ fontSize: '0.6rem', color: '#333', fontFamily: 'monospace', marginTop: 4 }}>
          {node.id}
        </div>
      </div>

      {/* Config section — per step type */}
      {(node.element === 'step:query' || node.element === 'step:mutation') && (
        <Section title="Configuration">
          <SqlStepEditor
            node={node}
            onUpdate={onUpdate}
            workspaceId={workspaceId}
            availableWidgets={availableWidgets}
            boundSetSlots={boundSetSlots}
            boundWhereSlots={boundWhereSlots}
          />
        </Section>
      )}

      {node.element === 'step:condition' && (
        <Section title="Configuration">
          <ConditionEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:approval_gate' && (
        <Section title="Configuration">
          <div style={{ fontSize: '0.7rem', color: '#666' }}>
            Approval Gate pauses execution and waits for a workspace admin to approve or reject.
            No additional configuration required.
          </div>
        </Section>
      )}

      {node.element === 'step:notification' && (
        <Section title="Configuration">
          <NotificationEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:transform' && (
        <Section title="Configuration">
          <TransformEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:http' && (
        <Section title="Configuration">
          <HttpEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {/* With map debug view */}
      {node.with && Object.keys(node.with).length > 0 && (
        <Section title="Raw config">
          <div style={{
            fontSize: '0.6rem', fontFamily: 'monospace', color: '#444',
            background: '#0d0d0d', borderRadius: 4, padding: 8, wordBreak: 'break-all',
          }}>
            {Object.entries(node.with).map(([k, v]) => (
              <div key={k}><span style={{ color: '#555' }}>{k}</span>=&quot;{v}&quot;</div>
            ))}
          </div>
        </Section>
      )}

      {/* Delete */}
      <div style={{ padding: '0.75rem 1rem', marginTop: 'auto' }}>
        <button
          onClick={() => onDelete(node.id)}
          style={{
            width: '100%',
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: '0.75rem',
            background: 'transparent',
            border: '1px solid #2a1010',
            color: '#ef4444',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a0a0a' }}
          onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'transparent' }}
        >
          Delete step
        </button>
      </div>
    </aside>
  )
}
