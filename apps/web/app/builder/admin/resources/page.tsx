'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../../lib/auth'
import type { CompanyResource, ConnectorType, ResourceGrant } from '../../../../lib/api'
import {
  listCompanyResources,
  createCompanyResource,
  patchCompanyResource,
  deleteCompanyResource,
  listResourceGrants,
  createResourceGrant,
  deleteResourceGrant,
} from '../../../../lib/api'

const CONNECTOR_TYPES: ConnectorType[] = ['postgres', 'mysql', 'mssql', 'rest', 'graphql', 'csv']
const SUBJECT_TYPES = ['user', 'group', 'workspace'] as const
const GRANT_ACTIONS = ['read', 'write', 'admin'] as const
const GRANT_EFFECTS = ['allow', 'deny'] as const

const s = {
  page: { padding: '1.5rem', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100vh' } as const,
  h1: { margin: '0 0 1.5rem', fontSize: '1rem', fontWeight: 600 } as const,
  surface: { background: '#111', border: '1px solid #1a1a1a', borderRadius: 6, padding: '0.75rem', marginBottom: '0.5rem' } as const,
  muted: { color: '#555', fontSize: '0.75rem' } as const,
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  input: { background: '#0a0a0a', border: '1px solid #1f1f1f', borderRadius: 4, padding: '0.35rem 0.5rem', color: '#e5e5e5', fontSize: '0.8rem', flex: 1 } as const,
  select: { background: '#0a0a0a', border: '1px solid #1f1f1f', borderRadius: 4, padding: '0.35rem 0.5rem', color: '#e5e5e5', fontSize: '0.8rem' } as const,
  textarea: { background: '#0a0a0a', border: '1px solid #1f1f1f', borderRadius: 4, padding: '0.35rem 0.5rem', color: '#e5e5e5', fontSize: '0.75rem', fontFamily: 'monospace', width: '100%', minHeight: 60, resize: 'vertical' as const } as const,
  btnPrimary: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, padding: '0.35rem 0.75rem', fontSize: '0.75rem', cursor: 'pointer' } as const,
  btnDanger: { background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: 4, padding: '0.25rem 0.5rem', fontSize: '0.7rem', cursor: 'pointer' } as const,
  btnGhost: { background: 'transparent', color: '#e5e5e5', border: '1px solid #1f1f1f', borderRadius: 4, padding: '0.25rem 0.5rem', fontSize: '0.7rem', cursor: 'pointer' } as const,
  badge: { display: 'inline-block', background: '#1f1f1f', borderRadius: 3, padding: '0.15rem 0.4rem', fontSize: '0.7rem', color: '#aaa' } as const,
  error: { color: '#ef4444', fontSize: '0.75rem', marginTop: '0.25rem' } as const,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.75rem' } as const,
  th: { textAlign: 'left' as const, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1f1f1f', color: '#888', fontWeight: 500, fontSize: '0.7rem' } as const,
  td: { padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a' } as const,
}

type ScopeEditorMode = 'structured' | 'json'
type WorkspaceScopeMode = 'none' | 'current' | 'specific'

interface ScopeFilterRow {
  id: string
  field: string
  value: string
}

interface GrantScopeDraft {
  table: string
  rowFilters: ScopeFilterRow[]
  columnsText: string
  workspaceMode: WorkspaceScopeMode
  workspaceId: string
}

interface StructuredGrantScopeResult {
  scope?: Record<string, unknown>
  error?: string
}

interface GrantScopeSummary {
  lines: string[]
  raw?: string
}

function createScopeFilterRow(field = '', value = ''): ScopeFilterRow {
  return {
    id: crypto.randomUUID(),
    field,
    value,
  }
}

function createEmptyGrantScopeDraft(currentWorkspaceId: string): GrantScopeDraft {
  return {
    table: '',
    rowFilters: [],
    columnsText: '',
    workspaceMode: 'none',
    workspaceId: currentWorkspaceId,
  }
}

function parseColumnAllowlist(columnsText: string) {
  return columnsText
    .split(/[\n,]/)
    .map(column => column.trim())
    .filter(Boolean)
}

function buildStructuredGrantScope(draft: GrantScopeDraft, currentWorkspaceId: string): StructuredGrantScopeResult {
  const scope: Record<string, unknown> = {}
  const table = draft.table.trim()

  if (table) {
    scope.table = table
  }

  const rowFilterEntries = draft.rowFilters
    .map(filter => ({
      field: filter.field.trim(),
      value: filter.value.trim(),
    }))
    .filter(filter => filter.field || filter.value)

  const incompleteRowFilter = rowFilterEntries.find(filter => !filter.field || !filter.value)
  if (incompleteRowFilter) {
    return { error: 'Complete or remove each row filter entry before adding the grant.' }
  }

  if (rowFilterEntries.length > 0) {
    scope.row_filter = rowFilterEntries.reduce<Record<string, string>>((next, filter) => {
      next[filter.field] = filter.value
      return next
    }, {})
  }

  const columns = parseColumnAllowlist(draft.columnsText)
  if (columns.length > 0) {
    scope.columns = columns
  }

  if (draft.workspaceMode === 'current') {
    if (!currentWorkspaceId) {
      return { error: 'No current workspace is available for the workspace scope preset.' }
    }
    scope.workspace_id = currentWorkspaceId
  }

  if (draft.workspaceMode === 'specific') {
    const workspaceId = draft.workspaceId.trim()
    if (!workspaceId) {
      return { error: 'Enter a workspace ID when using a specific workspace scope.' }
    }
    scope.workspace_id = workspaceId
  }

  if (Object.keys(scope).length === 0) {
    return {}
  }

  return { scope }
}

function summarizeGrantScope(scopeJson?: string): GrantScopeSummary {
  if (!scopeJson) {
    return { lines: [] }
  }

  try {
    const parsed = JSON.parse(scopeJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { lines: [], raw: scopeJson }
    }

    const scope = parsed as Record<string, unknown>
    const lines: string[] = []
    const supportedKeys = new Set(['table', 'row_filter', 'columns', 'workspace_id', 'workspace_scope'])
    const hasUnknownKeys = Object.keys(scope).some(key => !supportedKeys.has(key))

    const table = typeof scope.table === 'string' ? scope.table.trim() : ''
    if (table) {
      lines.push(`Table: ${table}`)
    }

    if (scope.row_filter && typeof scope.row_filter === 'object' && !Array.isArray(scope.row_filter)) {
      const filters = Object.entries(scope.row_filter as Record<string, unknown>)
        .map(([field, value]) => `${field}=${String(value)}`)
      if (filters.length > 0) {
        lines.push(`Rows: ${filters.join(', ')}`)
      }
    }

    if (Array.isArray(scope.columns)) {
      const columns = scope.columns.map(column => String(column).trim()).filter(Boolean)
      if (columns.length > 0) {
        lines.push(`Columns: ${columns.join(', ')}`)
      }
    }

    const workspaceId = typeof scope.workspace_id === 'string'
      ? scope.workspace_id.trim()
      : typeof scope.workspace_scope === 'string'
        ? scope.workspace_scope.trim()
        : ''
    if (workspaceId) {
      lines.push(`Workspace: ${workspaceId}`)
    }

    if (hasUnknownKeys) {
      return { lines, raw: formatJsonForDisplay(scopeJson) }
    }

    if (lines.length === 0) {
      return { lines: [], raw: formatJsonForDisplay(scopeJson) }
    }

    return { lines }
  } catch {
    return { lines: [], raw: scopeJson }
  }
}

function formatJsonForDisplay(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export default function ResourcesPage() {
  const { company, workspace } = useAuth()
  const companyId = company?.id ?? ''

  const [resources, setResources] = useState<CompanyResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<ConnectorType>('postgres')
  const [newCreds, setNewCreds] = useState('{}')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const loadResources = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError('')
    try {
      const res = await listCompanyResources(companyId)
      setResources(res.resources ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load resources')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { loadResources() }, [loadResources])

  const handleCreate = async () => {
    if (!newName.trim()) return
    let creds: Record<string, unknown>
    try {
      creds = JSON.parse(newCreds)
    } catch {
      setCreateError('Invalid JSON in credentials')
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      await createCompanyResource(companyId, {
        workspace_id: workspace?.id ?? '',
        name: newName.trim(),
        type: newType,
        credentials: creds,
      })
      setNewName('')
      setNewCreds('{}')
      setShowCreate(false)
      await loadResources()
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create resource')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (rid: string) => {
    if (!confirm('Delete this resource? This cannot be undone.')) return
    try {
      await deleteCompanyResource(companyId, rid)
      if (expandedId === rid) setExpandedId(null)
      await loadResources()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const handlePatchResource = async (rid: string, patch: { name?: string; credentials?: Record<string, unknown> }) => {
    const updated = await patchCompanyResource(companyId, rid, patch)
    setResources(prev => prev.map(resource => resource.id === rid ? updated : resource))
    return updated
  }

  if (!companyId) {
    return <div style={s.page}><p style={s.muted}>No company selected.</p></div>
  }

  return (
    <div style={s.page}>
      <div style={{ ...s.row, marginBottom: '1rem', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Company Resources</h1>
        <button style={s.btnPrimary} onClick={() => setShowCreate(v => !v)}>
          {showCreate ? 'Cancel' : '+ Create Resource'}
        </button>
      </div>

      {showCreate && (
        <div style={{ ...s.surface, marginBottom: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={s.row}>
              <input
                style={s.input}
                placeholder="Resource name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
              />
              <select style={s.select} value={newType} onChange={e => setNewType(e.target.value as ConnectorType)}>
                {CONNECTOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <textarea
              style={s.textarea}
              placeholder='Credentials JSON, e.g. {"host":"…","port":5432}'
              value={newCreds}
              onChange={e => setNewCreds(e.target.value)}
            />
            <div style={s.row}>
              <button style={s.btnPrimary} onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating…' : 'Create'}
              </button>
              {createError && <span style={s.error}>{createError}</span>}
            </div>
          </div>
        </div>
      )}

      {error && <p style={s.error}>{error}</p>}
      {loading && <p style={s.muted}>Loading resources…</p>}
      {!loading && resources.length === 0 && !error && (
        <p style={s.muted}>No resources yet. Click &quot;Create Resource&quot; to add one.</p>
      )}

      {resources.map(r => (
        <ResourceRow
          key={r.id}
          resource={r}
          companyId={companyId}
          workspaceId={workspace?.id ?? ''}
          expanded={expandedId === r.id}
          onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
          onDelete={() => handleDelete(r.id)}
          onPatchResource={(patch: { name?: string; credentials?: Record<string, unknown> }) => handlePatchResource(r.id, patch)}
        />
      ))}
    </div>
  )
}

/* ---- Resource row -------------------------------------------------------- */

function ResourceRow({
  resource: r,
  companyId,
  workspaceId,
  expanded,
  onToggle,
  onDelete,
  onPatchResource,
}: {
  resource: CompanyResource
  companyId: string
  workspaceId: string
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onPatchResource: (patch: { name?: string; credentials?: Record<string, unknown> }) => Promise<CompanyResource>
}) {
  const [editName, setEditName] = useState(r.name)
  const [credentialText, setCredentialText] = useState('{}')
  const [credentialError, setCredentialError] = useState('')
  const [credentialSaved, setCredentialSaved] = useState('')
  const [savingCredentials, setSavingCredentials] = useState(false)

  useEffect(() => { setEditName(r.name) }, [r.name])
  useEffect(() => {
    setCredentialText('{}')
    setCredentialError('')
    setCredentialSaved('')
  }, [r.id])

  const handleReplaceCredentials = async () => {
    let credentials: Record<string, unknown>

    try {
      const parsed = JSON.parse(credentialText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setCredentialError('Credentials must be a JSON object')
        return
      }
      credentials = parsed as Record<string, unknown>
    } catch {
      setCredentialError('Invalid JSON in credentials')
      return
    }

    setSavingCredentials(true)
    setCredentialError('')
    setCredentialSaved('')
    try {
      await onPatchResource({ credentials })
      setCredentialText('{}')
      setCredentialSaved('Credentials updated.')
    } catch (e: unknown) {
      setCredentialError(e instanceof Error ? e.message : 'Failed to update credentials')
    } finally {
      setSavingCredentials(false)
    }
  }

  return (
    <div style={s.surface}>
      <div style={{ ...s.row, justifyContent: 'space-between', cursor: 'pointer' }} onClick={onToggle}>
        <div style={s.row}>
          <span style={{ fontSize: '0.65rem', color: '#666', marginRight: 2 }}>{expanded ? '▼' : '▶'}</span>
          <strong style={{ fontSize: '0.85rem' }}>{r.name}</strong>
          <span style={s.badge}>{r.type}</span>
        </div>
        <span style={s.muted}>{r.id.slice(0, 8)}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem', fontSize: '0.75rem' }}>
            <div><span style={{ color: '#888' }}>Type:</span> {r.type}</div>
            <div><span style={{ color: '#888' }}>Scope:</span> {r.owner_scope}</div>
            <div><span style={{ color: '#888' }}>Created:</span> {new Date(r.created_at).toLocaleDateString()}</div>
          </div>

          <div style={{ ...s.row, marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.75rem', color: '#888' }}>Name:</label>
            <input
              style={{ ...s.input, maxWidth: 260 }}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => {
                const nextName = editName.trim()
                if (!nextName || nextName === r.name) return
                void onPatchResource({ name: nextName }).catch(() => setEditName(r.name))
              }}
            />
            <button style={s.btnDanger} onClick={onDelete}>Delete</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.75rem', color: '#888' }}>Replace credentials JSON</label>
            <textarea
              style={s.textarea}
              placeholder='Full replacement credentials JSON, e.g. {"host":"...","password":"..."}'
              value={credentialText}
              onChange={e => setCredentialText(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
              <span style={s.muted}>Existing credentials are never returned. Submit the full replacement object.</span>
              <button style={s.btnPrimary} onClick={handleReplaceCredentials} disabled={savingCredentials}>
                {savingCredentials ? 'Updating…' : 'Update Credentials'}
              </button>
            </div>
            {credentialError && <span style={s.error}>{credentialError}</span>}
            {credentialSaved && <span style={{ color: '#22c55e', fontSize: '0.75rem' }}>{credentialSaved}</span>}
          </div>

          <GrantsPanel companyId={companyId} resourceId={r.id} workspaceId={workspaceId} />
        </div>
      )}
    </div>
  )
}

/* ---- Grants panel -------------------------------------------------------- */

function GrantsPanel({ companyId, resourceId, workspaceId }: { companyId: string; resourceId: string; workspaceId: string }) {
  const [grants, setGrants] = useState<ResourceGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showAdd, setShowAdd] = useState(false)
  const [subjectType, setSubjectType] = useState<string>('user')
  const [subjectId, setSubjectId] = useState('')
  const [action, setAction] = useState<string>('read')
  const [effect, setEffect] = useState<string>('allow')
  const [scopeEditorMode, setScopeEditorMode] = useState<ScopeEditorMode>('structured')
  const [scopeDraft, setScopeDraft] = useState<GrantScopeDraft>(() => createEmptyGrantScopeDraft(workspaceId))
  const [scopeJson, setScopeJson] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

  const resetScopeEditor = useCallback(() => {
    setScopeDraft(createEmptyGrantScopeDraft(workspaceId))
    setScopeJson('')
    setScopeEditorMode('structured')
  }, [workspaceId])

  const loadGrants = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await listResourceGrants(companyId, resourceId)
      setGrants(res.grants ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load grants')
    } finally {
      setLoading(false)
    }
  }, [companyId, resourceId])

  useEffect(() => { loadGrants() }, [loadGrants])

  const structuredScopePreview = buildStructuredGrantScope(scopeDraft, workspaceId)

  const applyScopePreset = (preset: 'row-filter' | 'columns' | 'workspace') => {
    setScopeEditorMode('structured')
    setScopeDraft(prev => {
      switch (preset) {
        case 'row-filter':
          return {
            ...prev,
            rowFilters: prev.rowFilters.length > 0 ? prev.rowFilters : [createScopeFilterRow('tenant', 'acme')],
          }
        case 'columns':
          return {
            ...prev,
            columnsText: prev.columnsText.trim() ? prev.columnsText : 'id\nname',
          }
        case 'workspace':
          return {
            ...prev,
            workspaceMode: workspaceId ? 'current' : 'specific',
            workspaceId: workspaceId || prev.workspaceId,
          }
        default:
          return prev
      }
    })
  }

  const addRowFilter = () => {
    setScopeDraft(prev => ({
      ...prev,
      rowFilters: [...prev.rowFilters, createScopeFilterRow()],
    }))
  }

  const updateRowFilter = (filterId: string, patch: Partial<ScopeFilterRow>) => {
    setScopeDraft(prev => ({
      ...prev,
      rowFilters: prev.rowFilters.map(filter => filter.id === filterId ? { ...filter, ...patch } : filter),
    }))
  }

  const removeRowFilter = (filterId: string) => {
    setScopeDraft(prev => ({
      ...prev,
      rowFilters: prev.rowFilters.filter(filter => filter.id !== filterId),
    }))
  }

  const handleAdd = async () => {
    if (!subjectId.trim()) return

    let nextScope: string | undefined
    if (scopeEditorMode === 'json') {
      if (scopeJson.trim()) {
        try {
          const parsed = JSON.parse(scopeJson)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setAddError('Scope must be a JSON object')
            return
          }
          nextScope = JSON.stringify(parsed)
        } catch {
          setAddError('Invalid JSON in scope')
          return
        }
      }
    } else {
      const structuredScope = buildStructuredGrantScope(scopeDraft, workspaceId)
      if (structuredScope.error) {
        setAddError(structuredScope.error)
        return
      }
      if (structuredScope.scope) {
        nextScope = JSON.stringify(structuredScope.scope)
      }
    }

    setAdding(true)
    setAddError('')
    try {
      await createResourceGrant(companyId, resourceId, {
        subject_type: subjectType,
        subject_id: subjectId.trim(),
        action,
        effect,
        scope_json: nextScope,
      })
      setSubjectId('')
      resetScopeEditor()
      setShowAdd(false)
      await loadGrants()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed to create grant')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteGrant = async (grantId: string) => {
    try {
      await deleteResourceGrant(companyId, resourceId, grantId)
      setGrants(prev => prev.filter(g => g.id !== grantId))
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div style={{ background: '#0d0d0d', borderRadius: 4, padding: '0.5rem', border: '1px solid #1a1a1a' }}>
      <div style={{ ...s.row, justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Grants</span>
        <button style={s.btnGhost} onClick={() => setShowAdd(v => !v)}>
          {showAdd ? 'Cancel' : '+ Add Grant'}
        </button>
      </div>

      {showAdd && (
        <div style={{ ...s.surface, background: '#111', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
            <select style={s.select} value={subjectType} onChange={e => setSubjectType(e.target.value)}>
              {SUBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              style={{ ...s.input, maxWidth: 180 }}
              placeholder="Subject ID"
              value={subjectId}
              onChange={e => setSubjectId(e.target.value)}
            />
            <select style={s.select} value={action} onChange={e => setAction(e.target.value)}>
              {GRANT_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select style={s.select} value={effect} onChange={e => setEffect(e.target.value)}>
              {GRANT_EFFECTS.map(ef => <option key={ef} value={ef}>{ef}</option>)}
            </select>
            <button style={s.btnPrimary} onClick={handleAdd} disabled={adding}>
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: '#888' }}>Scoped access builder</div>
                <div style={s.muted}>Use presets for common grant shapes. JSON remains available for advanced cases.</div>
              </div>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={{
                    ...s.btnGhost,
                    borderColor: scopeEditorMode === 'structured' ? '#2563eb' : '#1f1f1f',
                    color: scopeEditorMode === 'structured' ? '#93c5fd' : '#aaa',
                  }}
                  onClick={() => setScopeEditorMode('structured')}
                >
                  Structured
                </button>
                <button
                  type="button"
                  style={{
                    ...s.btnGhost,
                    borderColor: scopeEditorMode === 'json' ? '#2563eb' : '#1f1f1f',
                    color: scopeEditorMode === 'json' ? '#93c5fd' : '#aaa',
                  }}
                  onClick={() => {
                    if (!scopeJson.trim() && structuredScopePreview.scope) {
                      setScopeJson(JSON.stringify(structuredScopePreview.scope, null, 2))
                    }
                    setScopeEditorMode('json')
                  }}
                >
                  Advanced JSON
                </button>
              </div>
            </div>

            {scopeEditorMode === 'structured' ? (
              <div style={{ display: 'grid', gap: '0.6rem', padding: '0.75rem', border: '1px solid #1f1f1f', borderRadius: 6, background: '#0d0d0d' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  <button type="button" style={s.btnGhost} onClick={() => applyScopePreset('row-filter')}>Tenant rows preset</button>
                  <button type="button" style={s.btnGhost} onClick={() => applyScopePreset('columns')}>Column allowlist preset</button>
                  <button type="button" style={s.btnGhost} onClick={() => applyScopePreset('workspace')}>Workspace scope preset</button>
                </div>

                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.72rem', color: '#888' }}>Table or collection</span>
                  <input
                    style={s.input}
                    placeholder="customers"
                    value={scopeDraft.table}
                    onChange={e => setScopeDraft(prev => ({ ...prev, table: e.target.value }))}
                  />
                </label>

                <div style={{ display: 'grid', gap: '0.35rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.72rem', color: '#888' }}>Row filters</span>
                    <button type="button" style={s.btnGhost} onClick={addRowFilter}>+ Add filter</button>
                  </div>
                  {scopeDraft.rowFilters.length === 0 ? (
                    <div style={s.muted}>No row filter yet. Add one to constrain records like tenant=acme.</div>
                  ) : (
                    <div style={{ display: 'grid', gap: '0.4rem' }}>
                      {scopeDraft.rowFilters.map(filter => (
                        <div key={filter.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: '0.4rem', alignItems: 'center' }}>
                          <input
                            style={s.input}
                            placeholder="tenant"
                            value={filter.field}
                            onChange={e => updateRowFilter(filter.id, { field: e.target.value })}
                          />
                          <input
                            style={s.input}
                            placeholder="acme"
                            value={filter.value}
                            onChange={e => updateRowFilter(filter.id, { value: e.target.value })}
                          />
                          <button type="button" style={s.btnDanger} onClick={() => removeRowFilter(filter.id)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.72rem', color: '#888' }}>Column allowlist</span>
                  <textarea
                    style={s.textarea}
                    placeholder={'id\nemail\nstatus'}
                    value={scopeDraft.columnsText}
                    onChange={e => setScopeDraft(prev => ({ ...prev, columnsText: e.target.value }))}
                  />
                  <span style={s.muted}>Enter one column per line or separate columns with commas.</span>
                </label>

                <div style={{ display: 'grid', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.72rem', color: '#888' }}>Workspace scope</span>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <select
                      style={s.select}
                      value={scopeDraft.workspaceMode}
                      onChange={e => setScopeDraft(prev => ({ ...prev, workspaceMode: e.target.value as WorkspaceScopeMode }))}
                    >
                      <option value="none">No workspace restriction</option>
                      <option value="current">Current workspace</option>
                      <option value="specific">Specific workspace ID</option>
                    </select>
                    {scopeDraft.workspaceMode === 'current' && workspaceId && (
                      <span style={{ ...s.badge, fontFamily: 'monospace' }}>{workspaceId}</span>
                    )}
                    {scopeDraft.workspaceMode === 'specific' && (
                      <input
                        style={{ ...s.input, maxWidth: 260 }}
                        placeholder="workspace UUID"
                        value={scopeDraft.workspaceId}
                        onChange={e => setScopeDraft(prev => ({ ...prev, workspaceId: e.target.value }))}
                      />
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.72rem', color: '#888' }}>Stored JSON preview</span>
                  {structuredScopePreview.error ? (
                    <span style={s.error}>{structuredScopePreview.error}</span>
                  ) : structuredScopePreview.scope ? (
                    <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.65rem', color: '#aaa', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#0a0a0a', border: '1px solid #1f1f1f', borderRadius: 4, padding: '0.5rem' }}>
                      {JSON.stringify(structuredScopePreview.scope, null, 2)}
                    </pre>
                  ) : (
                    <span style={s.muted}>No scope restrictions will be stored.</span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.35rem' }}>
                <span style={s.muted}>Advanced fallback for non-standard scope shapes. Structured edits are kept separately and are not derived from this JSON.</span>
                <textarea
                  style={s.textarea}
                  placeholder='Optional scope JSON, e.g. {"table":"customers","row_filter":{"tenant":"acme"}}'
                  value={scopeJson}
                  onChange={e => setScopeJson(e.target.value)}
                />
              </div>
            )}
          </div>
          {addError && <p style={s.error}>{addError}</p>}
        </div>
      )}

      {error && <p style={s.error}>{error}</p>}
      {loading && <p style={s.muted}>Loading grants…</p>}

      {!loading && grants.length === 0 && !error && (
        <p style={s.muted}>No grants for this resource.</p>
      )}

      {grants.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Subject Type</th>
              <th style={s.th}>Subject ID</th>
              <th style={s.th}>Action</th>
              <th style={s.th}>Scope</th>
              <th style={s.th}>Effect</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {grants.map(g => (
              <tr key={g.id}>
                <td style={s.td}>{g.subject_type}</td>
                <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>{g.subject_id}</span></td>
                <td style={s.td}>{g.action}</td>
                <td style={s.td}>
                  {g.scope_json ? (() => {
                    const summary = summarizeGrantScope(g.scope_json)
                    return (
                      <div style={{ display: 'grid', gap: '0.25rem' }}>
                        {summary.lines.map(line => (
                          <span key={line} style={{ color: '#ccc', fontSize: '0.65rem' }}>{line}</span>
                        ))}
                        {summary.raw && (
                          <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.62rem', color: '#777', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {summary.raw}
                          </pre>
                        )}
                      </div>
                    )
                  })() : (
                    <span style={s.muted}>-</span>
                  )}
                </td>
                <td style={s.td}>
                  <span style={{ color: g.effect === 'deny' ? '#ef4444' : '#22c55e' }}>{g.effect}</span>
                </td>
                <td style={s.td}>
                  <button style={s.btnDanger} onClick={() => handleDeleteGrant(g.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
