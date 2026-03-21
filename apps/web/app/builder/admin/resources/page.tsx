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

  const handlePatchName = async (rid: string, name: string) => {
    try {
      await patchCompanyResource(companyId, rid, { name })
      setResources(prev => prev.map(r => r.id === rid ? { ...r, name } : r))
    } catch {
      // silent – name reverts on next load
    }
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
          expanded={expandedId === r.id}
          onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
          onDelete={() => handleDelete(r.id)}
          onPatchName={(name: string) => handlePatchName(r.id, name)}
        />
      ))}
    </div>
  )
}

/* ---- Resource row -------------------------------------------------------- */

function ResourceRow({
  resource: r,
  companyId,
  expanded,
  onToggle,
  onDelete,
  onPatchName,
}: {
  resource: CompanyResource
  companyId: string
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onPatchName: (name: string) => void
}) {
  const [editName, setEditName] = useState(r.name)

  useEffect(() => { setEditName(r.name) }, [r.name])

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
              onBlur={() => { if (editName.trim() && editName !== r.name) onPatchName(editName.trim()) }}
            />
            <button style={s.btnDanger} onClick={onDelete}>Delete</button>
          </div>

          <GrantsPanel companyId={companyId} resourceId={r.id} />
        </div>
      )}
    </div>
  )
}

/* ---- Grants panel -------------------------------------------------------- */

function GrantsPanel({ companyId, resourceId }: { companyId: string; resourceId: string }) {
  const [grants, setGrants] = useState<ResourceGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showAdd, setShowAdd] = useState(false)
  const [subjectType, setSubjectType] = useState<string>('user')
  const [subjectId, setSubjectId] = useState('')
  const [action, setAction] = useState<string>('read')
  const [effect, setEffect] = useState<string>('allow')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

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

  const handleAdd = async () => {
    if (!subjectId.trim()) return
    setAdding(true)
    setAddError('')
    try {
      await createResourceGrant(companyId, resourceId, {
        subject_type: subjectType,
        subject_id: subjectId.trim(),
        action,
        effect,
      })
      setSubjectId('')
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
