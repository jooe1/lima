'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../lib/auth'
import {
  listConnectors, createConnector, deleteConnector,
  getManagedTableColumns, setManagedTableColumns,
  type Connector, type ConnectorType, type ManagedTableColumn, type ActionDefinition,
} from '../../../lib/api'
import { ConnectorWizard } from './ConnectorWizard'
import { ConnectorDrawer } from './ConnectorDrawer'
import { ConnectorDetailDrawer } from './ConnectorDetailDrawer'
import { ConnectorTypePicker } from './ConnectorTypePicker'
import { ActionForm } from './ActionForm'
import { ConnectorEducationCard } from './ConnectorEducationCard'
import { ConnectorList, type ConnectorCategory } from './ConnectorList'

// ---------------------------------------------------------------------------
// Types / constants
// ---------------------------------------------------------------------------

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
  const [drawerState, setDrawerState] = useState<'closed' | 'type-picker' | 'wizard' | 'detail'>('closed')
  const [wizardType, setWizardType] = useState<ConnectorType | null>(null)
  const [wizardDbBrand, setWizardDbBrand] = useState<'postgres' | 'mysql' | 'mssql' | undefined>(undefined)

  const [pickerCategory, setPickerCategory] = useState<ConnectorCategory | undefined>(undefined)

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

  function handleManage(c: Connector) {
    setSelected(c)
    setDrawerState('detail')
  }

  function handleNew() {
    setPickerCategory(undefined)
    setEditing(null)
    setShowForm(false)
    setSelected(null)
    setDrawerState('type-picker')
  }

  function handleAdd(category: ConnectorCategory) {
    setPickerCategory(category)
    setEditing(null)
    setShowForm(false)
    setSelected(null)
    setDrawerState('type-picker')
  }

  function handleTypeSelected(type: ConnectorType, dbBrand?: 'postgres' | 'mysql' | 'mssql') {
    setWizardType(type)
    setWizardDbBrand(dbBrand)
    setDrawerState('wizard')
  }

  function handleDrawerClose() {
    setDrawerState('closed')
    setWizardType(null)
    setWizardDbBrand(undefined)
    setPickerCategory(undefined)
  }

  function handleWizardComplete(c: Connector) {
    handleSaved(c)
    setDrawerState('closed')
    setWizardType(null)
    setWizardDbBrand(undefined)
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
        <button onClick={load} style={ghostBtn} title="Refresh">↻</button>
        {isAdmin && <button onClick={handleNew} style={primaryBtn}>New connector</button>}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>}

      {/* Drawer: new connector flow (type picker → wizard) */}
      <ConnectorDrawer
        isOpen={drawerState === 'type-picker' || drawerState === 'wizard'}
        onClose={handleDrawerClose}
        title="New connector"
      >
        {drawerState === 'type-picker' && (
          <ConnectorTypePicker onSelect={handleTypeSelected} initialCategory={pickerCategory} />
        )}
        {drawerState === 'wizard' && wizardType && workspace && (
          <ConnectorWizard
            connectorType={wizardType}
            dbBrand={wizardDbBrand}
            workspaceId={workspace.id}
            onComplete={handleWizardComplete}
            onBack={() => setDrawerState('type-picker')}
          />
        )}
      </ConnectorDrawer>

      {/* Connector list */}
      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : (
        <ConnectorList
          connectors={connectors}
          onManage={handleManage}
          onAdd={handleAdd}
        />
      )}

      <ConnectorDetailDrawer
        connector={selected}
        workspaceId={workspace?.id ?? ''}
        isOpen={drawerState === 'detail'}
        onClose={() => { setDrawerState('closed'); setSelected(null) }}
        onConnectorChange={load}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  connector: Connector
  workspaceId: string
  isAdmin: boolean
  openActionsOnMount?: boolean
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
    setActiveTab(openActionsOnMount ? 'actions' : 'details')
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
  }, [connector.id, connector.type, workspaceId, openActionsOnMount])

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
              <ManagedColumnBuilder
                connectorId={c.id}
                workspaceId={workspaceId}
                columns={managedCols}
                onColumnsChange={handleLoadManagedCols}
              />
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

