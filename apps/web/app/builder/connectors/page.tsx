'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../lib/auth'
import {
  listConnectors, createConnector, getEditableConnector, patchConnector, deleteConnector,
  testConnector, getConnectorSchema, runConnectorQuery,
  getManagedTableColumns, setManagedTableColumns,
  listManagedTableRows, insertManagedTableRow, updateManagedTableRow, deleteManagedTableRow,
  seedManagedTableFromCSV, exportManagedTableCSVUrl,
  listConnectorActions, upsertConnectorAction, deleteConnectorAction,
  type Connector, type ConnectorType, type TestConnectorResponse,
  type ConnectorSchemaResponse, type ManagedTableColumn, type ManagedTableRow,
  type DashboardQueryResponse, type ActionDefinition, type ActionDefinitionInput, type ActionFieldType,
} from '../../../lib/api'
import { ConnectorGrantsTab } from './ConnectorGrantsTab'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorFormData = {
  name: string
  type: ConnectorType
  credentials: Record<string, unknown>
}

const CONNECTOR_TYPES: ConnectorType[] = ['postgres', 'mysql', 'mssql', 'rest', 'graphql', 'managed', 'csv']

const TYPE_COLORS: Record<ConnectorType, { bg: string; fg: string }> = {
  postgres: { bg: '#336791', fg: '#e5e5e5' },
  mysql: { bg: '#00758f', fg: '#e5e5e5' },
  mssql: { bg: '#a91d22', fg: '#e5e5e5' },
  rest: { bg: '#854d0e', fg: '#fbbf24' },
  graphql: { bg: '#99015544', fg: '#e535ab' },
  managed: { bg: '#1e3a5f', fg: '#60a5fa' },
  csv: { bg: '#166534', fg: '#86efac' },
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ConnectorsPage() {
  const { workspace, user } = useAuth()
  const isAdmin = user?.role === 'workspace_admin'

  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Selection & panels
  const [selected, setSelected] = useState<Connector | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Connector | null>(null)

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    setError('')
    listConnectors(workspace.id)
      .then(res => setConnectors(res.connectors ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load connectors'))
      .finally(() => setLoading(false))
  }, [workspace])

  useEffect(() => { load() }, [load])

  function handleSelect(c: Connector) {
    setSelected(prev => prev?.id === c.id ? null : c)
    setShowForm(false)
  }

  function handleNew() {
    setEditing(null)
    setShowForm(true)
    setSelected(null)
  }

  function handleEdit(c: Connector) {
    setEditing(c)
    setShowForm(true)
  }

  function handleSaved(c: Connector) {
    setConnectors(prev => {
      const idx = prev.findIndex(x => x.id === c.id)
      if (idx >= 0) return prev.map(x => x.id === c.id ? c : x)
      return [...prev, c]
    })
    setShowForm(false)
    setEditing(null)
    setSelected(c)
  }

  function handleDeleted(id: string) {
    setConnectors(prev => prev.filter(c => c.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  function handleCancel() {
    setShowForm(false)
    setEditing(null)
  }

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Connectors</h1>
        <span style={{ color: '#555', fontSize: '0.75rem' }}>
          Manage data source connections for your workspace.
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={ghostBtn}>Refresh</button>
        {isAdmin && <button onClick={handleNew} style={primaryBtn}>New connector</button>}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>}

      {/* Create / Edit form */}
      {showForm && workspace && (
        <ConnectorForm
          workspaceId={workspace.id}
          editing={editing}
          onSaved={handleSaved}
          onCancel={handleCancel}
        />
      )}

      {/* Connector grid */}
      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : connectors.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1a1a1a', borderRadius: 8 }}>
          <p style={{ color: '#444', fontSize: '0.875rem', margin: 0 }}>No connectors yet.</p>
          {isAdmin && (
            <button onClick={handleNew} style={{ ...primaryBtn, marginTop: 16 }}>Create your first connector</button>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: selected ? 16 : 0 }}>
          {connectors.map(c => (
            <ConnectorCard
              key={c.id}
              connector={c}
              isSelected={selected?.id === c.id}
              onClick={() => handleSelect(c)}
            />
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selected && workspace && (
        <DetailPanel
          connector={selected}
          workspaceId={workspace.id}
          isAdmin={isAdmin}
          onEdit={() => handleEdit(selected)}
          onDeleted={handleDeleted}
          onUpdated={(c) => {
            setSelected(c)
            setConnectors(prev => prev.map(x => x.id === c.id ? c : x))
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connector card
// ---------------------------------------------------------------------------

function ConnectorCard({ connector, isSelected, onClick }: {
  connector: Connector
  isSelected: boolean
  onClick: () => void
}) {
  const c = connector
  const tc = TYPE_COLORS[c.type]
  return (
    <button
      onClick={onClick}
      style={{
        background: '#111', border: `1px solid ${isSelected ? '#2563eb' : '#1f1f1f'}`,
        borderRadius: 10, padding: '1.25rem', textAlign: 'left', cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = '#333' }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = '#1f1f1f' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: '#e5e5e5', fontSize: '0.9rem' }}>{c.name}</span>
        <span style={{
          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
          background: tc.bg, color: tc.fg,
        }}>
          {c.type}
        </span>
      </div>
      <p style={{ color: '#555', fontSize: '0.75rem', margin: '0 0 4px' }}>
        Schema: {c.schema_cached_at
          ? new Date(c.schema_cached_at).toLocaleDateString()
          : 'No schema'}
      </p>
      <p style={{ color: '#444', fontSize: '0.7rem', margin: 0 }}>
        Created {new Date(c.created_at).toLocaleDateString()}
      </p>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Create / Edit form
// ---------------------------------------------------------------------------

function ConnectorForm({ workspaceId, editing, onSaved, onCancel }: {
  workspaceId: string
  editing: Connector | null
  onSaved: (c: Connector) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ConnectorType>('postgres')
  const [creds, setCreds] = useState<Record<string, unknown>>({})
  const [storedSecrets, setStoredSecrets] = useState<Record<string, boolean>>({})
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [readyToSubmit, setReadyToSubmit] = useState(editing == null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
  let cancelled = false

  if (!editing) {
    setName('')
    setType('postgres')
    setCreds({})
    setStoredSecrets({})
    setLoadingExisting(false)
    setReadyToSubmit(true)
    setErr('')
    return () => {
    cancelled = true
    }
  }

  setLoadingExisting(true)
  setReadyToSubmit(false)
  setErr('')
  getEditableConnector(workspaceId, editing.id)
    .then(result => {
    if (cancelled) return
    setName(result.connector.name)
    setType(result.connector.type)
    setCreds(result.editable_credentials ?? {})
    setStoredSecrets(result.stored_secrets ?? {})
    setReadyToSubmit(true)
    })
    .catch((e: unknown) => {
    if (cancelled) return
    setErr(e instanceof Error ? e.message : 'Failed to load connector settings')
    })
    .finally(() => {
    if (!cancelled) setLoadingExisting(false)
    })

  return () => {
    cancelled = true
  }
  }, [editing, workspaceId])

  function updateCred(key: string, value: unknown) {
    setCreds(prev => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!readyToSubmit) return
    if (!name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    setErr('')
    try {
      let result: Connector
      if (editing) {
        result = await patchConnector(workspaceId, editing.id, { name: name.trim(), credentials: creds })
      } else {
        result = await createConnector(workspaceId, { name: name.trim(), type, credentials: creds })
      }
      onSaved(result)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{
      background: '#141414', border: '1px solid #222', borderRadius: 10,
      padding: '1.25rem', marginBottom: '1.25rem',
    }}>
      <h3 style={{ margin: '0 0 1rem', fontSize: '0.9rem', fontWeight: 600, color: '#e5e5e5' }}>
        {editing ? 'Edit connector' : 'New connector'}
      </h3>

      {err && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 0.75rem' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <input
          autoFocus
          type="text"
          placeholder="Connector name"
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <select
          value={type}
          onChange={e => { setType(e.target.value as ConnectorType); setCreds({}) }}
          disabled={!!editing}
          style={{ ...inputStyle, width: 140 }}
        >
          {CONNECTOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Dynamic credential fields */}
      {loadingExisting ? (
        <p style={{ color: '#555', fontSize: '0.8rem', margin: '0 0 8px' }}>Loading saved connector settings…</p>
      ) : (
        <CredentialFields type={type} creds={creds} storedSecrets={storedSecrets} onChange={updateCred} />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="submit" disabled={saving || !readyToSubmit} style={primaryBtn}>
          {saving ? 'Saving…' : editing ? 'Update' : 'Create'}
        </button>
        <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Dynamic credential fields
// ---------------------------------------------------------------------------

function CredentialFields({ type, creds, storedSecrets, onChange }: {
  type: ConnectorType
  creds: Record<string, unknown>
  storedSecrets: Record<string, boolean>
  onChange: (key: string, value: unknown) => void
}) {
  if (type === 'managed') return (
    <p style={{ color: '#555', fontSize: '0.75rem', margin: '0 0 8px' }}>
      Lima Table — no credentials needed. Define columns and manage rows after creating the connector.
    </p>
  )

  if (type === 'postgres' || type === 'mysql' || type === 'mssql') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Host" value={(creds.host as string) ?? ''} onChange={e => onChange('host', e.target.value)} style={{ ...inputStyle, flex: 2 }} />
          <input placeholder="Port" type="number" value={(creds.port as string) ?? ''} onChange={e => onChange('port', parseInt(e.target.value) || '')} style={{ ...inputStyle, flex: 1 }} />
        </div>
        <input placeholder="Database" value={(creds.database as string) ?? ''} onChange={e => onChange('database', e.target.value)} style={inputStyle} />
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Username" value={(creds.username as string) ?? ''} onChange={e => onChange('username', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <input placeholder={storedSecrets.password ? 'Stored password unchanged' : 'Password'} type="password" value={(creds.password as string) ?? ''} onChange={e => onChange('password', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
        </div>
        {storedSecrets.password && <span style={helperTextStyle}>Leave the password blank to keep the current stored password.</span>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#888', fontSize: '0.8rem' }}>
          <input type="checkbox" checked={!!creds.ssl} onChange={e => onChange('ssl', e.target.checked)} />
          Use SSL
        </label>
      </div>
    )
  }

  if (type === 'rest') {
    const authType = (creds.auth_type as string) ?? 'none'
    const endpoints = (creds.endpoints as Array<{ label: string; path: string }>) ?? []
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input placeholder="Base URL  (e.g. https://api.example.com/v1)" value={(creds.base_url as string) ?? ''} onChange={e => onChange('base_url', e.target.value)} style={inputStyle} />
        <select value={authType} onChange={e => onChange('auth_type', e.target.value)} style={inputStyle}>
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="token">Token auth (e.g. MOCO)</option>
          <option value="basic">Basic auth</option>
          <option value="api_key">API key</option>
        </select>
        {authType === 'bearer' && (
          <>
            <input placeholder={storedSecrets.token ? 'Stored token unchanged' : 'Token'} type="password" value={(creds.token as string) ?? ''} onChange={e => onChange('token', e.target.value)} style={inputStyle} />
            {storedSecrets.token && <span style={helperTextStyle}>Leave the token blank to keep the current stored token.</span>}
          </>
        )}
        {authType === 'token' && (
          <>
            <input placeholder={storedSecrets.token ? 'Stored token unchanged' : 'API token'} type="password" value={(creds.token as string) ?? ''} onChange={e => onChange('token', e.target.value)} style={inputStyle} />
            <span style={helperTextStyle}>Sends: <code>Authorization: Token token=&lt;value&gt;</code> — used by MOCO and similar APIs.</span>
            {storedSecrets.token && <span style={helperTextStyle}>Leave the token blank to keep the current stored token.</span>}
          </>
        )}
        {authType === 'basic' && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="Username" value={(creds.username as string) ?? ''} onChange={e => onChange('username', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <input placeholder={storedSecrets.password ? 'Stored password unchanged' : 'Password'} type="password" value={(creds.password as string) ?? ''} onChange={e => onChange('password', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </div>
            {storedSecrets.password && <span style={helperTextStyle}>Leave the password blank to keep the current stored password.</span>}
          </>
        )}
        {authType === 'api_key' && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder={storedSecrets.api_key ? 'Stored API key unchanged' : 'API key'} type="password" value={(creds.api_key as string) ?? ''} onChange={e => onChange('api_key', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <input placeholder="Header name (default: X-API-Key)" value={(creds.api_key_header as string) ?? ''} onChange={e => onChange('api_key_header', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </div>
            {storedSecrets.api_key && <span style={helperTextStyle}>Leave the API key blank to keep the current stored key.</span>}
          </>
        )}

        {/* Named endpoints — let widget users pick from a dropdown instead of typing raw paths */}
        <div style={{ borderTop: '1px solid #222', paddingTop: 10, marginTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#888', fontSize: '0.75rem', fontWeight: 500 }}>Named endpoints</span>
            <button
              type="button"
              onClick={() => onChange('endpoints', [...endpoints, { label: '', path: '' }])}
              style={{ ...ghostBtn, padding: '2px 8px', fontSize: '0.7rem' }}
            >
              + Add
            </button>
          </div>
          {endpoints.length === 0 ? (
            <p style={{ color: '#444', fontSize: '0.7rem', margin: 0, lineHeight: 1.5 }}>
              Optional: name your API endpoints so widget users can pick them from a dropdown instead of typing paths manually.
            </p>
          ) : (
            endpoints.map((ep, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input
                  placeholder="Label  (e.g. Sales data)"
                  value={ep.label}
                  onChange={e => {
                    const next = [...endpoints]
                    next[i] = { ...ep, label: e.target.value }
                    onChange('endpoints', next)
                  }}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <input
                  placeholder="Path  (e.g. /api/sales)"
                  value={ep.path}
                  onChange={e => {
                    const next = [...endpoints]
                    next[i] = { ...ep, path: e.target.value }
                    onChange('endpoints', next)
                  }}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => onChange('endpoints', endpoints.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: '0 4px', fontSize: '1.1rem', lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  if (type === 'graphql') {
    const authType = (creds.auth_type as string) ?? 'none'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input placeholder="GraphQL endpoint" value={(creds.endpoint as string) ?? ''} onChange={e => onChange('endpoint', e.target.value)} style={inputStyle} />
        <select value={authType} onChange={e => onChange('auth_type', e.target.value)} style={inputStyle}>
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
        </select>
        {authType === 'bearer' && (
          <>
            <input placeholder={storedSecrets.token ? 'Stored token unchanged' : 'Token'} type="password" value={(creds.token as string) ?? ''} onChange={e => onChange('token', e.target.value)} style={inputStyle} />
            {storedSecrets.token && <span style={helperTextStyle}>Leave the token blank to keep the current stored token.</span>}
          </>
        )}
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function DetailPanel({ connector, workspaceId, isAdmin, onEdit, onDeleted, onUpdated }: {
  connector: Connector
  workspaceId: string
  isAdmin: boolean
  onEdit: () => void
  onDeleted: (id: string) => void
  onUpdated: (c: Connector) => void
}) {
  const c = connector
  const tc = TYPE_COLORS[c.type]

  // Test connection
  const [testResult, setTestResult] = useState<TestConnectorResponse | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // Schema
  const [schemaData, setSchemaData] = useState<ConnectorSchemaResponse | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Managed table
  const [managedCols, setManagedCols] = useState<ManagedTableColumn[]>([])
  const [managedColsLoaded, setManagedColsLoaded] = useState(false)
  const [seedFile, setSeedFile] = useState<File | null>(null)
  const [seedLoading, setSeedLoading] = useState(false)
  const [seedResult, setSeedResult] = useState<{ rows_inserted: number; columns_created: number } | null>(null)
  const [seedError, setSeedError] = useState('')

  // Query tester
  const [sql, setSql] = useState('')
  const [queryResult, setQueryResult] = useState<DashboardQueryResponse | null>(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [queryError, setQueryError] = useState('')

  // Active tab
  const [activeTab, setActiveTab] = useState<'details' | 'permissions' | 'actions'>('details')

  // Action catalog (REST/GraphQL connectors)
  const [connActions, setConnActions] = useState<ActionDefinition[]>([])
  const [actionsLoading, setActionsLoading] = useState(false)
  const [actionsError, setActionsError] = useState('')
  const [editingAction, setEditingAction] = useState<ActionDefinition | null>(null)
  const [showActionForm, setShowActionForm] = useState(false)

  // Reset state when connector changes and auto-load columns for managed connectors
  useEffect(() => {
    setTestResult(null)
    setSchemaData(null)
    setConfirmDelete(false)
    setManagedCols([])
    setManagedColsLoaded(false)
    setSeedFile(null)
    setSeedResult(null)
    setSeedError('')
    setSql('')
    setQueryResult(null)
    setQueryError('')
    setActiveTab('details')
    setConnActions([])
    setActionsError('')
    setShowActionForm(false)
    setEditingAction(null)
    if (connector.type === 'managed') {
      getManagedTableColumns(workspaceId, connector.id)
        .then(res => { setManagedCols(res.columns ?? []); setManagedColsLoaded(true) })
        .catch(() => setManagedColsLoaded(true))
    }
    if (connector.type === 'rest' || connector.type === 'graphql') {
      setActionsLoading(true)
      listConnectorActions(workspaceId, connector.id)
        .then(res => setConnActions(res.actions ?? []))
        .catch(() => setActionsError('Failed to load actions'))
        .finally(() => setActionsLoading(false))
    }
  }, [connector.id, connector.type, workspaceId])

  async function handleTest() {
    setTestLoading(true)
    setTestResult(null)
    try {
      const res = await testConnector(workspaceId, c.id)
      setTestResult(res)
    } catch {
      setTestResult({ ok: false, error: 'Request failed' })
    } finally {
      setTestLoading(false)
    }
  }

  async function handleRefreshSchema() {
    setSchemaLoading(true)
    try {
      const res = await getConnectorSchema(workspaceId, c.id)
      setSchemaData(res)
    } catch {
      setSchemaData(null)
    } finally {
      setSchemaLoading(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteConnector(workspaceId, c.id)
      onDeleted(c.id)
    } catch {
      setDeleting(false)
    }
  }

  async function handleLoadManagedCols() {
    setManagedColsLoaded(true)
    try {
      const res = await getManagedTableColumns(workspaceId, c.id)
      setManagedCols(res.columns ?? [])
    } catch { /* ignore */ }
  }

  async function handleSeed(replace: boolean) {
    if (!seedFile) return
    setSeedLoading(true)
    setSeedError('')
    setSeedResult(null)
    try {
      const res = await seedManagedTableFromCSV(workspaceId, c.id, seedFile, replace)
      setSeedResult(res)
      handleLoadManagedCols()
    } catch (e: unknown) {
      setSeedError(e instanceof Error ? e.message : 'Seed failed')
    } finally {
      setSeedLoading(false)
    }
  }

  async function handleRunQuery() {
    if (!sql.trim()) return
    setQueryLoading(true)
    setQueryError('')
    setQueryResult(null)
    try {
      const res = await runConnectorQuery(workspaceId, c.id, { sql: sql.trim(), limit: 10 })
      if (res.error) setQueryError(res.error)
      else setQueryResult(res)
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setQueryLoading(false)
    }
  }

  // Build schema tree from connector's schema_cache or fetched schema
  const schemaObj = schemaData?.schema ?? c.schema_cache ?? null

  return (
    <div style={{
      background: '#0d0d0d', border: '1px solid #1e1e1e', borderRadius: 10,
      padding: '1.25rem', marginTop: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#e5e5e5' }}>{c.name}</h2>
        <span style={{
          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
          background: tc.bg, color: tc.fg,
        }}>
          {c.type}
        </span>
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <>
            <button onClick={onEdit} style={ghostBtn}>Edit</button>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} style={dangerBtn}>Delete</button>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }}>
                <span style={{ color: '#f87171' }}>Are you sure? This cannot be undone.</span>
                <button onClick={handleDelete} disabled={deleting} style={dangerBtn}>
                  {deleting ? 'Deleting…' : 'Confirm'}
                </button>
                <button onClick={() => setConfirmDelete(false)} style={ghostBtn}>Cancel</button>
              </span>
            )}
          </>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1a1a1a', marginBottom: '1rem' }}>
        <button
          onClick={() => setActiveTab('details')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '6px 14px', fontSize: '0.8rem', fontWeight: 500,
            color: activeTab === 'details' ? '#e5e5e5' : '#555',
            borderBottom: activeTab === 'details' ? '2px solid #2563eb' : '2px solid transparent',
          }}
        >
          Details
        </button>
        {isAdmin && (
          <button
            onClick={() => setActiveTab('permissions')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '6px 14px', fontSize: '0.8rem', fontWeight: 500,
              color: activeTab === 'permissions' ? '#e5e5e5' : '#555',
              borderBottom: activeTab === 'permissions' ? '2px solid #2563eb' : '2px solid transparent',
            }}
          >
            Permissions
          </button>
        )}
        {(c.type === 'rest' || c.type === 'graphql') && (
          <button
            onClick={() => setActiveTab('actions')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '6px 14px', fontSize: '0.8rem', fontWeight: 500,
              color: activeTab === 'actions' ? '#e5e5e5' : '#555',
              borderBottom: activeTab === 'actions' ? '2px solid #2563eb' : '2px solid transparent',
            }}
          >
            Actions
          </button>
        )}
      </div>

      {/* Permissions tab */}
      {activeTab === 'permissions' && isAdmin && (
        <ConnectorGrantsTab workspaceId={workspaceId} connectorId={c.id} />
      )}

      {/* Actions tab */}
      {activeTab === 'actions' && (
        <ActionCatalogPanel
          workspaceId={workspaceId}
          connectorId={c.id}
          isAdmin={isAdmin}
          actions={connActions}
          loading={actionsLoading}
          error={actionsError}
          editingAction={editingAction}
          showActionForm={showActionForm}
          onShowForm={(act) => { setEditingAction(act ?? null); setShowActionForm(true) }}
          onHideForm={() => { setShowActionForm(false); setEditingAction(null) }}
          onSaved={saved => {
            setConnActions(prev => {
              const idx = prev.findIndex(a => a.id === saved.id)
              if (idx >= 0) return prev.map(a => a.id === saved.id ? saved : a)
              return [...prev, saved]
            })
            setShowActionForm(false)
            setEditingAction(null)
          }}
          onDeleted={id => setConnActions(prev => prev.filter(a => a.id !== id))}
        />
      )}

      {/* Details tab */}
      {activeTab === 'details' && (<>

      {/* Test connection */}
      <Section title="Test connection">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={handleTest} disabled={testLoading} style={primaryBtn}>
            {testLoading ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            testResult.ok
              ? <span style={{ color: '#4ade80', fontSize: '0.8rem' }}>Connection OK</span>
              : <span style={{ color: '#f87171', fontSize: '0.8rem' }}>{testResult.error ?? 'Failed'}</span>
          )}
        </div>
      </Section>

      {/* Schema */}
      <Section title="Schema">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <button onClick={handleRefreshSchema} disabled={schemaLoading} style={ghostBtn}>
            {schemaLoading ? 'Loading…' : 'Refresh schema'}
          </button>
          {schemaData?.refreshing && (
            <span style={{ color: '#fbbf24', fontSize: '0.75rem' }}>Schema discovery in progress…</span>
          )}
          {(schemaData?.schema_cached_at ?? c.schema_cached_at) && (
            <span style={{ color: '#555', fontSize: '0.7rem' }}>
              Cached: {new Date((schemaData?.schema_cached_at ?? c.schema_cached_at)!).toLocaleString()}
            </span>
          )}
        </div>
        {schemaObj ? <SchemaTree schema={schemaObj} /> : (
          <p style={{ color: '#444', fontSize: '0.8rem', margin: 0 }}>
            {c.type === 'managed'
              ? 'No schema yet. Define columns via the Lima Table section below.'
              : 'No schema discovered. The schema is refreshed asynchronously after connector creation.'}
          </p>
        )}
      </Section>

      {/* Lima Table (managed type only) */}
      {c.type === 'managed' && (
        <Section title="Lima Table">
          {/* Columns */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ color: '#888', fontSize: '0.8rem' }}>Columns</span>
              <button onClick={handleLoadManagedCols} style={ghostBtn}>Refresh</button>
            </div>
            {!managedColsLoaded && (
              <p style={{ color: '#555', fontSize: '0.75rem', margin: 0 }}>Loading columns…</p>
            )}
            {managedColsLoaded && (
              managedCols.length === 0
                ? <p style={{ color: '#444', fontSize: '0.75rem', margin: 0 }}>No columns yet. Upload a CSV below — columns are auto-created from the header row.</p>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {managedCols.map(col => (
                      <span key={col.id} style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: 99, background: '#1e293b', color: '#94a3b8' }}>
                        {col.name} <span style={{ color: '#475569' }}>({col.col_type})</span>
                      </span>
                    ))}
                  </div>
            )}
          </div>

          {/* Seed from CSV */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <input
              type="file"
              accept=".csv"
              onChange={e => setSeedFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: '0.8rem', color: '#888' }}
            />
            <button onClick={() => handleSeed(false)} disabled={seedLoading || !seedFile} style={primaryBtn}>
              {seedLoading ? 'Seeding…' : 'Append from CSV'}
            </button>
            <button onClick={() => handleSeed(true)} disabled={seedLoading || !seedFile} style={ghostBtn}>
              Replace all rows
            </button>
          </div>
          {seedError && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '4px 0 0' }}>{seedError}</p>}
          {seedResult && (
            <p style={{ color: '#4ade80', fontSize: '0.8rem', margin: '4px 0 0' }}>
              {seedResult.rows_inserted} row(s) inserted, {seedResult.columns_created} column(s) created.
            </p>
          )}

          {/* Export */}
          <div style={{ marginTop: 10 }}>
            <a
              href={exportManagedTableCSVUrl(workspaceId, c.id)}
              download
              style={{ fontSize: '0.75rem', color: '#60a5fa', textDecoration: 'underline' }}
            >
              Export rows as CSV
            </a>
          </div>
        </Section>
      )}

      {/* Query tester */}
      <Section title="Query Tester">
        <textarea
          value={sql}
          onChange={e => setSql(e.target.value)}
          placeholder="SELECT * FROM ..."
          rows={3}
          style={{
            ...inputStyle, width: '100%', resize: 'vertical',
            fontFamily: 'monospace', fontSize: '0.8rem',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={handleRunQuery} disabled={queryLoading || !sql.trim()} style={primaryBtn}>
            {queryLoading ? 'Running…' : 'Run query'}
          </button>
        </div>
        {queryError && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '8px 0 0' }}>{queryError}</p>}
        {queryResult && <QueryResultTable result={queryResult} />}
      </Section>

      </>)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: '1rem', marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', fontWeight: 600, color: '#ccc' }}>{title}</h3>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schema tree viewer
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

  // Try to render as tables → columns structure
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

  // Fallback: formatted JSON
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
// Query result table
// ---------------------------------------------------------------------------

function QueryResultTable({ result }: { result: DashboardQueryResponse }) {
  if (result.columns.length === 0) {
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
// Action Catalog panel (REST / GraphQL connectors)
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const FIELD_TYPES: ActionFieldType[] = ['text', 'email', 'number', 'boolean', 'date', 'enum', 'textarea']

function ActionCatalogPanel({
  workspaceId, connectorId, isAdmin, actions, loading, error,
  editingAction, showActionForm, onShowForm, onHideForm, onSaved, onDeleted,
}: {
  workspaceId: string
  connectorId: string
  isAdmin: boolean
  actions: ActionDefinition[]
  loading: boolean
  error: string
  editingAction: ActionDefinition | null
  showActionForm: boolean
  onShowForm: (act?: ActionDefinition) => void
  onHideForm: () => void
  onSaved: (a: ActionDefinition) => void
  onDeleted: (id: string) => void
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await deleteConnectorAction(workspaceId, connectorId, id)
      onDeleted(id)
    } catch { /* ignore */ } finally {
      setDeletingId(null)
    }
  }

  // Group by resource_name
  const groups: Record<string, ActionDefinition[]> = {}
  actions.forEach(a => {
    const g = a.resource_name || 'General'
    ;(groups[g] = groups[g] ?? []).push(a)
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#888', fontSize: '0.8rem', flex: 1 }}>
          {actions.length} action{actions.length !== 1 ? 's' : ''} defined
        </span>
        {isAdmin && !showActionForm && (
          <button onClick={() => onShowForm()} style={ghostBtn}>+ Add action</button>
        )}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0 0 8px' }}>{error}</p>}
      {loading && <p style={{ color: '#555', fontSize: '0.75rem' }}>Loading actions…</p>}

      {!loading && !showActionForm && Object.entries(groups).map(([grp, acts]) => (
        <div key={grp} style={{ marginBottom: 12 }}>
          <div style={{ color: '#555', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            {grp}
          </div>
          {acts.map(act => (
            <div key={act.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6, background: '#111',
              border: '1px solid #1e1e1e', marginBottom: 4,
            }}>
              <span style={{
                fontSize: '0.62rem', padding: '1px 6px', borderRadius: 99,
                background: '#1e3a5f', color: '#60a5fa', fontFamily: 'monospace',
              }}>{act.http_method}</span>
              <span style={{ color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }}>
                {act.action_label || act.action_key}
              </span>
              <span style={{ color: '#555', fontSize: '0.68rem' }}>{act.path_template}</span>
              {isAdmin && (
                <>
                  <button onClick={() => onShowForm(act)} style={ghostBtn}>Edit</button>
                  <button
                    onClick={() => handleDelete(act.id)}
                    disabled={deletingId === act.id}
                    style={dangerBtn}>
                    {deletingId === act.id ? '…' : 'Delete'}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      ))}

      {!loading && showActionForm && (
        <ActionForm
          workspaceId={workspaceId}
          connectorId={connectorId}
          editing={editingAction}
          onSaved={onSaved}
          onCancel={onHideForm}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Action form (create / edit)
// ---------------------------------------------------------------------------

type ActionFieldDraft = {
  key: string; label: string; field_type: ActionFieldType
  required: boolean; enum_values: string; description: string
}

function emptyField(): ActionFieldDraft {
  return { key: '', label: '', field_type: 'text', required: false, enum_values: '', description: '' }
}

function ActionForm({
  workspaceId, connectorId, editing, onSaved, onCancel,
}: {
  workspaceId: string
  connectorId: string
  editing: ActionDefinition | null
  onSaved: (a: ActionDefinition) => void
  onCancel: () => void
}) {
  const [resource, setResource] = useState(editing?.resource_name ?? '')
  const [actionKey, setActionKey] = useState(editing?.action_key ?? '')
  const [label, setLabel] = useState(editing?.action_label ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [method, setMethod] = useState(editing?.http_method ?? 'POST')
  const [path, setPath] = useState(editing?.path_template ?? '')
  const [fields, setFields] = useState<ActionFieldDraft[]>(
    editing?.input_fields?.map(f => ({
      key: f.key, label: f.label, field_type: f.field_type,
      required: f.required, enum_values: f.enum_values?.join(', ') ?? '', description: f.description ?? '',
    })) ?? [emptyField()]
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function updateField(i: number, patch: Partial<ActionFieldDraft>) {
    setFields(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    const input: ActionDefinitionInput = {
      resource_name: resource.trim(),
      action_key: actionKey.trim(),
      action_label: label.trim(),
      description: description.trim(),
      http_method: method,
      path_template: path.trim(),
      input_fields: fields.filter(f => f.key.trim()).map(f => ({
        key: f.key.trim(),
        label: f.label.trim(),
        field_type: f.field_type,
        required: f.required,
        enum_values: f.enum_values ? f.enum_values.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        description: f.description.trim() || undefined,
      })),
    }
    try {
      const saved = await upsertConnectorAction(workspaceId, connectorId, input)
      onSaved(saved)
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const is = inputStyle

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h4 style={{ margin: '0 0 4px', color: '#ccc', fontSize: '0.85rem' }}>
        {editing ? 'Edit action' : 'New action'}
      </h4>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          Resource / group
          <input style={is} value={resource} onChange={e => setResource(e.target.value)} placeholder="Contacts" />
        </label>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          Action key <span style={{ color: '#555' }}>(unique, no spaces)</span>
          <input style={is} value={actionKey} onChange={e => setActionKey(e.target.value)} placeholder="create_contact" required />
        </label>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          Label
          <input style={is} value={label} onChange={e => setLabel(e.target.value)} placeholder="Create contact" />
        </label>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          Description
          <input style={is} value={description} onChange={e => setDescription(e.target.value)} placeholder="Creates a new contact" />
        </label>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          HTTP method
          <select style={is} value={method} onChange={e => setMethod(e.target.value)}>
            {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label style={{ color: '#888', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          Path template
          <input style={is} value={path} onChange={e => setPath(e.target.value)} placeholder="/contacts/people" required />
        </label>
      </div>

      {/* Input fields */}
      <div style={{ borderTop: '1px solid #1e1e1e', paddingTop: 8, marginTop: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ color: '#888', fontSize: '0.75rem', flex: 1 }}>Input fields</span>
          <button type='button' onClick={() => setFields(prev => [...prev, emptyField()])} style={ghostBtn}>
            + Add field
          </button>
        </div>
        {fields.map((f, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <input style={is} placeholder="key" value={f.key} onChange={e => updateField(i, { key: e.target.value })} />
            <input style={is} placeholder="label" value={f.label} onChange={e => updateField(i, { label: e.target.value })} />
            <select style={is} value={f.field_type} onChange={e => updateField(i, { field_type: e.target.value as ActionFieldType })}>
              {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label style={{ color: '#777', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
              <input type='checkbox' checked={f.required} onChange={e => updateField(i, { required: e.target.checked })} />
              required
            </label>
            <button type='button'
              onClick={() => setFields(prev => prev.filter((_, j) => j !== i))}
              style={{ ...dangerBtn, padding: '3px 8px', fontSize: '0.7rem' }}>✕</button>
          </div>
        ))}
      </div>

      {saveError && <p style={{ color: '#f87171', fontSize: '0.75rem', margin: 0 }}>{saveError}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type='submit' disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
        <button type='button' onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </form>
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

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem', background: '#1e1e1e', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: '0.85rem', outline: 'none',
  boxSizing: 'border-box',
}

const helperTextStyle: React.CSSProperties = {
  color: '#666',
  fontSize: '0.72rem',
  lineHeight: 1.4,
}
