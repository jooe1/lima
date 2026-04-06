'use client'

import React, { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAuth } from '../../../lib/auth'
import {
  testConnector, getConnectorSchema, patchConnector, deleteConnector,
  getManagedTableColumns, listConnectorActions, deleteConnectorAction,
  runConnectorQuery, seedManagedTableFromCSV, exportManagedTableCSV,
  getEditableConnector,
  type Connector, type ManagedTableColumn, type ActionDefinition, type DashboardQueryResponse,
} from '../../../lib/api'
import { ConnectorDrawer } from './ConnectorDrawer'
import { CATEGORY_ICONS, TYPE_TO_CATEGORY, CATEGORY_ACCENT } from './ConnectorIcons'
import { ConnectorStatusBadge } from './ConnectorStatusBadge'
import styles from './connectors.module.css'
import { ConnectorEducationCard } from './ConnectorEducationCard'
import { ConnectorSharingPanel } from './ConnectorSharingPanel'
import { ManagedColumnBuilder } from './ManagedColumnBuilder'
import { DatabaseStep, RestStep, CsvStep, ManagedStep, GraphQLStep } from './CredentialSteps'
import { ActionForm } from './ActionForm'

interface Props {
  connector: Connector | null
  workspaceId: string
  isOpen: boolean
  onClose: () => void
  onConnectorChange: () => void
}

// ---------------------------------------------------------------------------
// SchemaTree
// ---------------------------------------------------------------------------

function SchemaTree({ schema }: { schema: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  function toggle(key: string) {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const entries = Object.entries(schema)
  if (entries.length === 0) {
    return <p style={{ color: '#444', fontSize: '0.8rem', margin: 0 }}>Empty schema.</p>
  }

  const isTableMap = entries.every(
    ([, v]) => v && typeof v === 'object' && !Array.isArray(v) && 'columns' in (v as Record<string, unknown>)
  )

  if (isTableMap) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(([tableName, tableData]) => {
          const cols = (tableData as { columns: unknown[] }).columns
          const isOpen = !!expanded[tableName]
          return (
            <div key={tableName}>
              <button
                onClick={() => toggle(tableName)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#e5e5e5', fontSize: '0.8rem', fontFamily: 'monospace',
                  padding: '2px 0', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span style={{ color: '#555', fontSize: '0.7rem' }}>{isOpen ? '▼' : '▶'}</span>
                {tableName}
                <span style={{ color: '#444', fontSize: '0.7rem', fontFamily: 'sans-serif' }}>
                  ({Array.isArray(cols) ? cols.length : '?'} columns)
                </span>
              </button>
              {isOpen && Array.isArray(cols) && (
                <div style={{ paddingLeft: 20 }}>
                  {cols.map((col, i) => (
                    <div key={i} style={{ color: '#888', fontSize: '0.75rem', fontFamily: 'monospace', padding: '1px 0' }}>
                      {typeof col === 'string' ? col : typeof col === 'object' && col !== null
                        ? `${(col as Record<string, string>).name ?? ''}${(col as Record<string, string>).type ? ` (${(col as Record<string, string>).type})` : ''}`
                        : JSON.stringify(col)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <pre style={{
      background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 6,
      padding: '0.75rem', fontSize: '0.75rem', color: '#888',
      overflow: 'auto', maxHeight: 300, margin: 0,
    }}>
      {JSON.stringify(schema, null, 2)}
    </pre>
  )
}

// ---------------------------------------------------------------------------
// QueryResultTable
// ---------------------------------------------------------------------------

function QueryResultTable({ result }: { result: DashboardQueryResponse }) {
  if (!result.columns || result.columns.length === 0) {
    return <p style={{ color: '#444', fontSize: '0.8rem', margin: '8px 0 0' }}>No results.</p>
  }
  return (
    <div style={{ overflowX: 'auto', marginTop: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
        <thead>
          <tr>
            {result.columns.map(col => (
              <th key={col} style={{
                textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #1e1e1e',
                color: '#888', fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {result.columns.map(col => (
                <td key={col} style={{
                  padding: '4px 10px', borderBottom: '1px solid #141414',
                  color: '#ccc', whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row[col] == null ? <span style={{ color: '#444' }}>null</span> : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#555', fontSize: '0.7rem', margin: '6px 0 0' }}>
        {result.row_count} row(s) total · showing up to 10
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ActionCatalogInline
// ---------------------------------------------------------------------------

function ActionCatalogInline({
  workspaceId,
  connectorId,
  actions,
  loading,
  onActionsChange,
}: {
  workspaceId: string
  connectorId: string
  actions: ActionDefinition[]
  loading: boolean
  onActionsChange: (actions: ActionDefinition[]) => void
}) {
  const t = useTranslations('connectors.detail')
  const [showForm, setShowForm] = useState(false)
  const [editingAction, setEditingAction] = useState<ActionDefinition | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await deleteConnectorAction(workspaceId, connectorId, id)
      onActionsChange(actions.filter(a => a.id !== id))
    } catch { /* ignore */ } finally {
      setDeletingId(null)
    }
  }

  if (showForm) {
    return (
      <ActionForm
        workspaceId={workspaceId}
        connectorId={connectorId}
        action={editingAction ?? undefined}
        onSave={saved => {
          const idx = actions.findIndex(a => a.id === saved.id)
          if (idx >= 0) onActionsChange(actions.map(a => a.id === saved.id ? saved : a))
          else onActionsChange([...actions, saved])
          setShowForm(false)
          setEditingAction(null)
        }}
        onCancel={() => { setShowForm(false); setEditingAction(null) }}
      />
    )
  }

  if (loading) {
    return <p style={{ color: '#888', fontSize: '0.8rem' }}>{t('loadingActions')}</p>
  }

  return (
    <div>
      {actions.map(act => {
        const isExpanded = expandedId === act.id
        return (
          <div key={act.id} style={{
            borderRadius: 6,
            background: '#111',
            border: '1px solid #1e1e1e',
            marginBottom: 4,
            overflow: 'hidden',
          }}>
            {/* Row header — clickable to expand */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setExpandedId(isExpanded ? null : act.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setExpandedId(isExpanded ? null : act.id) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', cursor: 'pointer',
              }}
            >
              <span style={{ color: '#555', fontSize: '0.65rem' }}>{isExpanded ? '▼' : '▶'}</span>
              <span style={{
                fontSize: '0.62rem', padding: '1px 6px', borderRadius: 99,
                background: '#1e3a5f', color: '#60a5fa', fontFamily: 'monospace',
                flexShrink: 0,
              }}>{act.http_method}</span>
              <span style={{ color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }}>
                {act.action_label || act.action_key}
              </span>
              <button
                onClick={e => { e.stopPropagation(); void handleDelete(act.id) }}
                disabled={deletingId === act.id}
                style={dangerBtn}
              >
                {deletingId === act.id ? '…' : 'Delete'}
              </button>
            </div>
            {/* Expanded detail */}
            {isExpanded && (
              <div style={{ borderTop: '1px solid #1a1a1a', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ color: '#555', fontSize: '0.7rem', width: 80, flexShrink: 0 }}>Path</span>
                  <code style={{ color: '#93c5fd', fontSize: '0.75rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {act.path_template || '—'}
                  </code>
                </div>
                {act.resource_name && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: '#555', fontSize: '0.7rem', width: 80, flexShrink: 0 }}>Resource</span>
                    <span style={{ color: '#888', fontSize: '0.75rem' }}>{act.resource_name}</span>
                  </div>
                )}
                {act.description && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: '#555', fontSize: '0.7rem', width: 80, flexShrink: 0 }}>Description</span>
                    <span style={{ color: '#888', fontSize: '0.75rem' }}>{act.description}</span>
                  </div>
                )}
                <button
                  onClick={() => { setEditingAction(act); setShowForm(true) }}
                  style={{ ...ghostBtn, alignSelf: 'flex-start', marginTop: 4, fontSize: '0.75rem', padding: '3px 10px' }}
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        )
      })}
      <button
        onClick={() => { setEditingAction(null); setShowForm(true) }}
        style={ghostBtn}
      >
        {t('addAction')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConnectorDetailDrawer({
  connector,
  workspaceId,
  isOpen,
  onClose,
  onConnectorChange,
}: Props) {
  const t = useTranslations('connectors.detail')
  const { user } = useAuth()
  const isAdmin = user?.role === 'workspace_admin'

  // Section open/close (1 and 2 default open; 3, 4, 5 collapsed)
  const [open1, setOpen1] = useState(true)
  const [open2, setOpen2] = useState(true)
  const [open3, setOpen3] = useState(false)
  const [open4, setOpen4] = useState(false)
  const [open5, setOpen5] = useState(false)

  // Section 1 — education card dismissed state
  const [eduDismissed, setEduDismissed] = useState(false)

  // Section 2 — data
  const [managedCols, setManagedCols] = useState<ManagedTableColumn[]>([])
  const [managedColsLoading, setManagedColsLoading] = useState(false)
  const [seedLoading, setSeedLoading] = useState(false)
  const [seedFeedback, setSeedFeedback] = useState<{ text: string; color: string } | null>(null)
  const [actions, setActions] = useState<ActionDefinition[]>([])
  const [actionsLoading, setActionsLoading] = useState(false)
  const [schemaLoading, setSchemaLoading] = useState(false)

  // Section 3 — connection settings
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [credLoading, setCredLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Section 5 — developer query tester
  const [sql, setSql] = useState('')
  const [queryResult, setQueryResult] = useState<DashboardQueryResponse | null>(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [queryError, setQueryError] = useState('')

  // Reset all section-specific state when the connector changes
  useEffect(() => {
    if (!connector) return

    setOpen1(true)
    setOpen2(true)
    setOpen3(false)
    setOpen4(false)
    setOpen5(false)
    setEduDismissed(
      typeof window !== 'undefined' && !!localStorage.getItem('lima_edu_dismissed_' + connector.id)
    )
    setManagedCols([])
    setManagedColsLoading(false)
    setSeedLoading(false)
    setSeedFeedback(null)
    setActions([])
    setActionsLoading(false)
    setSchemaLoading(false)
    setCredValues({})
    setSaveLoading(false)
    setTestLoading(false)
    setTestResult(null)
    setDeleteLoading(false)
    setDeleteError('')
    setSql('')
    setQueryResult(null)
    setQueryError('')

    // Load existing credentials for non-managed connectors so the edit form is pre-filled
    if (connector.type !== 'managed') {
      setCredLoading(true)
      getEditableConnector(workspaceId, connector.id)
        .then(res => {
          const flat: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.editable_credentials ?? {})) {
            flat[k] = v == null ? '' : String(v)
          }
          setCredValues(flat)
        })
        .catch(() => {})
        .finally(() => setCredLoading(false))
    }

    if (connector.type === 'managed') {
      setManagedColsLoading(true)
      getManagedTableColumns(workspaceId, connector.id)
        .then(res => setManagedCols(res.columns ?? []))
        .catch(() => {})
        .finally(() => setManagedColsLoading(false))
    }

    if (connector.type === 'rest' || connector.type === 'graphql') {
      setActionsLoading(true)
      listConnectorActions(workspaceId, connector.id)
        .then(res => setActions(res.actions ?? []))
        .catch(() => {})
        .finally(() => setActionsLoading(false))
    }
  }, [connector?.id, workspaceId])

  if (!connector) return null

  const schemaObj = connector.schema_cache ?? null

  async function handleSaveSettings() {
    if (!connector) return
    setSaveLoading(true)
    try {
      await patchConnector(workspaceId, connector.id, { credentials: credValues })
      onConnectorChange()
    } catch { /* ignore */ } finally {
      setSaveLoading(false)
    }
  }

  async function handleTestConnection() {
    if (!connector) return
    setTestLoading(true)
    setTestResult(null)
    try {
      const res = await testConnector(workspaceId, connector.id)
      setTestResult(res)
    } catch {
      setTestResult({ ok: false, error: 'Request failed' })
    } finally {
      setTestLoading(false)
    }
  }

  async function handleRefreshSchema() {
    if (!connector) return
    setSchemaLoading(true)
    try {
      await getConnectorSchema(workspaceId, connector.id)
    } catch { /* ignore */ } finally {
      setSchemaLoading(false)
    }
  }

  async function handleRunQuery() {
    if (!connector || !sql.trim()) return
    setQueryLoading(true)
    setQueryError('')
    setQueryResult(null)
    try {
      const res = await runConnectorQuery(workspaceId, connector.id, { sql: sql.trim(), limit: 10 })
      if (res.error) setQueryError(res.error)
      else setQueryResult(res)
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setQueryLoading(false)
    }
  }

  async function handleDeleteConnector() {
    if (!connector) return

    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(t('deleteConfirm', { name: connector.name ?? t('title') }))

    if (!confirmed) return

    setDeleteLoading(true)
    setDeleteError('')
    try {
      await deleteConnector(workspaceId, connector.id)
      onClose()
      onConnectorChange()
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : t('deleteFailed'))
    } finally {
      setDeleteLoading(false)
    }
  }

  function getTestFeedback(): { text: string; color: string } | null {
    if (!testResult) return null
    if (testResult.ok) return { text: t('testOk'), color: '#4ade80' }
    const err = (testResult.error ?? '').toLowerCase()
    let hint = ''
    if (err.includes('password')) hint = ' Check your password'
    else if (err.includes('key')) hint = ' Check your API key'
    else if (err.includes('address')) hint = ' Check your address'
    return { text: t('testFail') + hint, color: '#f87171' }
  }

  const testFeedback = getTestFeedback()

  const category = TYPE_TO_CATEGORY[connector.type]
  const Icon = category ? CATEGORY_ICONS[category] : null

  const sectionHeaderStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
    padding: '0.75rem 0',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#e5e5e5',
    fontSize: '0.85rem',
    fontWeight: 600,
  }

  function handleCredChange(k: string, v: string) {
    setCredValues(prev => ({ ...prev, [k]: v }))
  }

  return (
    <ConnectorDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          {Icon && <Icon />}
          <span>{connector.name ?? t('title')}</span>
          <ConnectorStatusBadge connector={{ schema_cached_at: connector.schema_cached_at }} />
        </span>
      }
    >
      <div style={{ padding: '0 1.25rem 1.5rem', overflowY: 'auto', flex: 1 }}>

        {/* ── Section 1 — What you can do ── */}
        <div>
          <button
            type="button"
            aria-expanded={open1}
            onClick={() => setOpen1(prev => !prev)}
            style={sectionHeaderStyle}
            className={styles.drawerDivider}
          >
            <span>{open1 ? '▼' : '▶'}</span>
            {t('section1')}
          </button>
          {open1 && (
            <div style={{ paddingBottom: '0.75rem' }}>
              {eduDismissed ? (
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      localStorage.removeItem('lima_edu_dismissed_' + connector.id)
                    }
                    setEduDismissed(false)
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#60a5fa', fontSize: '0.8rem', padding: 0 }}
                >
                  {t('showTips')}
                </button>
              ) : (
                <ConnectorEducationCard
                  connector={connector}
                  onDismiss={() => setEduDismissed(true)}
                />
              )}
            </div>
          )}
        </div>

        {/* ── Section 2 — Your data ── */}
        <div>
          <button
            type="button"
            aria-expanded={open2}
            onClick={() => setOpen2(prev => !prev)}
            style={sectionHeaderStyle}
            className={styles.drawerDivider}
          >
            <span>{open2 ? '▼' : '▶'}</span>
            {t('section2')}
          </button>
          {open2 && (
            <div style={{ paddingBottom: '0.75rem' }}>
              {connector.type === 'managed' && (
                managedColsLoading ? (
                  <p style={{ color: '#888', fontSize: '0.8rem' }}>{t('loadingColumns')}</p>
                ) : (
                  <>
                    <ManagedColumnBuilder
                      connectorId={connector.id}
                      workspaceId={workspaceId}
                      columns={managedCols}
                      onColumnsChange={() => {
                        getManagedTableColumns(workspaceId, connector.id)
                          .then(res => setManagedCols(res.columns ?? []))
                          .catch(() => {})
                        onConnectorChange()
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                      <label style={{ position: 'relative', overflow: 'hidden' }}>
                        <button
                          type="button"
                          disabled={seedLoading}
                          style={{ ...ghostBtn, fontSize: '0.78rem', padding: '5px 12px', cursor: seedLoading ? 'default' : 'pointer' }}
                        >
                          {seedLoading ? 'Importing…' : 'Seed from CSV'}
                        </button>
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          disabled={seedLoading}
                          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%' }}
                          onChange={async e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            e.target.value = ''
                            setSeedLoading(true)
                            setSeedFeedback(null)
                            try {
                              const res = await seedManagedTableFromCSV(workspaceId, connector.id, file)
                              setSeedFeedback({ text: `Imported ${res.rows_inserted} row${res.rows_inserted === 1 ? '' : 's'}`, color: '#4ade80' })
                              onConnectorChange()
                            } catch (err) {
                              setSeedFeedback({ text: err instanceof Error ? err.message : 'Import failed', color: '#f87171' })
                            } finally {
                              setSeedLoading(false)
                            }
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={seedLoading}
                        style={{ ...ghostBtn, fontSize: '0.78rem', padding: '5px 12px' }}
                        onClick={async () => {
                          try {
                            const blob = await exportManagedTableCSV(workspaceId, connector.id)
                            const url = URL.createObjectURL(blob)
                            const a = document.createElement('a')
                            a.href = url
                            a.download = `${connector.name.replace(/\s+/g, '_')}.csv`
                            a.click()
                            URL.revokeObjectURL(url)
                          } catch (err) {
                            setSeedFeedback({ text: err instanceof Error ? err.message : 'Export failed', color: '#f87171' })
                          }
                        }}
                      >
                        Export CSV
                      </button>
                    </div>
                    {seedFeedback && (
                      <p style={{ color: seedFeedback.color, fontSize: '0.78rem', margin: '6px 0 0' }}>{seedFeedback.text}</p>
                    )}
                  </>
                )
              )}

              {(connector.type === 'rest' || connector.type === 'graphql') && (
                <ActionCatalogInline
                  workspaceId={workspaceId}
                  connectorId={connector.id}
                  actions={actions}
                  loading={actionsLoading}
                  onActionsChange={setActions}
                />
              )}

              {(connector.type === 'csv' || connector.type === 'postgres' || connector.type === 'mysql' || connector.type === 'mssql') && (
                schemaObj ? (
                  <SchemaTree schema={schemaObj} />
                ) : (
                  <div>
                    <p style={{ color: '#888', fontSize: '0.8rem', margin: '0 0 8px' }}>{t('noSchema')}</p>
                    <button
                      onClick={handleRefreshSchema}
                      disabled={schemaLoading}
                      style={ghostBtn}
                    >
                      {schemaLoading ? '…' : t('refreshSchema')}
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* ── Section 3 — Connection settings (hidden for managed tables) ── */}
        {connector.type !== 'managed' && (
          <div>
            <button
              type="button"
              aria-expanded={open3}
              onClick={() => setOpen3(prev => !prev)}
              style={sectionHeaderStyle}
              className={styles.drawerDivider}
            >
              <span>{open3 ? '▼' : '▶'}</span>
              {t('section3')}
            </button>
            {open3 && (
              <div style={{ paddingBottom: '0.75rem' }}>
                {credLoading ? (
                  <p style={{ color: '#888', fontSize: '0.8rem' }}>Loading…</p>
                ) : (
                  <>
                {(connector.type === 'postgres' || connector.type === 'mysql' || connector.type === 'mssql') && (
                  <DatabaseStep values={credValues} onChange={handleCredChange} />
                )}
                {connector.type === 'rest' && (
                  <RestStep values={credValues} onChange={handleCredChange} />
                )}
                {connector.type === 'csv' && (
                  <CsvStep values={credValues} onChange={handleCredChange} />
                )}
                {connector.type === 'graphql' && (
                  <GraphQLStep values={credValues} onChange={handleCredChange} />
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={handleSaveSettings} disabled={saveLoading} style={primaryBtn}>
                    {saveLoading ? '…' : t('saveSettings')}
                  </button>
                  <button onClick={handleTestConnection} disabled={testLoading} style={ghostBtn}>
                    {testLoading ? '…' : t('testConnection')}
                  </button>
                </div>
                {testFeedback && (
                  <p style={{ color: testFeedback.color, fontSize: '0.8rem', margin: '8px 0 0' }}>
                    {testFeedback.text}
                  </p>
                )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Section 4 — Who has access ── */}
        <div>
          <button
            type="button"
            aria-expanded={open4}
            onClick={() => setOpen4(prev => !prev)}
            style={sectionHeaderStyle}
            className={styles.drawerDivider}
          >
            <span>{open4 ? '▼' : '▶'}</span>
            {t('section4')}
          </button>
          {open4 && (
            <div style={{ paddingBottom: '0.75rem' }}>
              {connector && (
                <ConnectorSharingPanel
                  connectorId={connector.id}
                  workspaceId={workspaceId}
                />
              )}
            </div>
          )}
        </div>

        {/* ── Section 5 — For developers (admin only) ── */}
        {isAdmin && (
          <div data-testid="section-developers">
            <button
              type="button"
              aria-expanded={open5}
              onClick={() => setOpen5(prev => !prev)}
              style={sectionHeaderStyle}
              className={styles.drawerDivider}
            >
              <span>{open5 ? '▼' : '▶'}</span>
              {t('section5')}
            </button>
            {open5 && (
              <div style={{ paddingBottom: '0.75rem' }}>
                <div style={{ marginBottom: 12 }}>
                  <span style={{
                    fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
                    background: '#1e1e1e', color: '#888', marginBottom: 8, display: 'inline-block',
                  }}>
                    {connector.type}
                  </span>
                  {schemaObj && <SchemaTree schema={schemaObj} />}
                </div>
                <textarea
                  value={sql}
                  onChange={e => setSql(e.target.value)}
                  placeholder={
                    connector.type === 'managed'
                      ? `SELECT * FROM ${connector.name.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'data'}`
                      : 'SELECT * FROM ...'
                  }
                  rows={3}
                  style={{
                    width: '100%', resize: 'vertical',
                    background: '#1e1e1e', border: '1px solid #333',
                    borderRadius: 8, color: '#fff', fontSize: '0.8rem',
                    padding: '0.5rem 0.75rem', outline: 'none',
                    fontFamily: 'monospace', boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={handleRunQuery} disabled={queryLoading || !sql.trim()} style={primaryBtn}>
                    {queryLoading ? '…' : 'Run query'}
                  </button>
                </div>
                {queryError && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '8px 0 0' }}>{queryError}</p>}
                {queryResult && <QueryResultTable result={queryResult} />}

                <div style={{
                  marginTop: 16,
                  paddingTop: 12,
                  borderTop: '1px solid #1e1e1e',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}>
                  <p style={{ margin: 0, color: '#fca5a5', fontSize: '0.78rem', fontWeight: 600 }}>
                    {t('deleteHeading')}
                  </p>
                  <p style={{ margin: 0, color: '#888', fontSize: '0.78rem', lineHeight: 1.6 }}>
                    {t('deleteBody')}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={handleDeleteConnector}
                      disabled={deleteLoading}
                      style={dangerBtn}
                    >
                      {deleteLoading ? t('deleting') : t('deleteButton')}
                    </button>
                  </div>
                  {deleteError && (
                    <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>{deleteError}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </ConnectorDrawer>
  )
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #1e1e1e', borderRadius: 6,
  color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 12px',
}

const dangerBtn: React.CSSProperties = {
  padding: '4px 12px', background: '#7f1d1d', color: '#fca5a5',
  border: 'none', borderRadius: 6, fontWeight: 500, fontSize: '0.75rem', cursor: 'pointer',
}
