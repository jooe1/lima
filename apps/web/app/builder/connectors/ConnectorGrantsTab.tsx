'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  listConnectorGrants, createConnectorGrant, deleteConnectorGrant,
  type ResourceGrant,
} from '../../../lib/api'

const SUBJECT_TYPES = ['user', 'group', 'workspace', 'app', 'service_principal']
const ACTIONS = ['query', 'mutate', 'bind', 'read_schema', 'manage']

export function ConnectorGrantsTab({ workspaceId, connectorId }: {
  workspaceId: string
  connectorId: string
}) {
  const [grants, setGrants] = useState<ResourceGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showForm, setShowForm] = useState(false)
  const [subjectType, setSubjectType] = useState('user')
  const [subjectId, setSubjectId] = useState('')
  const [action, setAction] = useState('query')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    listConnectorGrants(workspaceId, connectorId)
      .then(res => setGrants(res.grants ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load grants'))
      .finally(() => setLoading(false))
  }, [workspaceId, connectorId])

  useEffect(() => { load() }, [load])

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault()
    if (!subjectId.trim()) { setFormError('Subject ID is required'); return }
    setSubmitting(true)
    setFormError('')
    try {
      const grant = await createConnectorGrant(workspaceId, connectorId, {
        subject_type: subjectType,
        subject_id: subjectId.trim(),
        action,
      })
      setGrants(prev => [...prev, grant])
      setShowForm(false)
      setSubjectId('')
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create grant')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(grantId: string) {
    try {
      await deleteConnectorGrant(workspaceId, connectorId, grantId)
      setGrants(prev => prev.filter(g => g.id !== grantId))
    } catch {
      // swallow — user can retry via load()
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <span style={{ color: '#888', fontSize: '0.8rem' }}>
          Resource grants control who can access this connector and with what permission.
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={ghostBtn}>Refresh</button>
          <button onClick={() => { setShowForm(v => !v); setFormError('') }} style={primaryBtn}>
            {showForm ? 'Cancel' : 'Grant access'}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleGrant} style={{
          background: '#141414', border: '1px solid #222', borderRadius: 8,
          padding: '1rem', marginBottom: '1rem', display: 'flex', gap: 8,
          flexWrap: 'wrap', alignItems: 'flex-end',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#777', fontSize: '0.7rem' }}>Subject type</label>
            <select
              value={subjectType}
              onChange={e => setSubjectType(e.target.value)}
              style={{ ...inputStyle, width: 160 }}
            >
              {SUBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 }}>
            <label style={{ color: '#777', fontSize: '0.7rem' }}>Subject ID</label>
            <input
              placeholder="user-uuid or group-slug…"
              value={subjectId}
              onChange={e => setSubjectId(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#777', fontSize: '0.7rem' }}>Action</label>
            <select
              value={action}
              onChange={e => setAction(e.target.value)}
              style={{ ...inputStyle, width: 140 }}
            >
              {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          <button type="submit" disabled={submitting} style={primaryBtn}>
            {submitting ? 'Granting…' : 'Grant'}
          </button>

          {formError && (
            <p style={{ color: '#f87171', fontSize: '0.75rem', margin: 0, width: '100%' }}>
              {formError}
            </p>
          )}
        </form>
      )}

      {error && <p style={{ color: '#f87171', fontSize: '0.8rem' }}>{error}</p>}

      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : grants.length === 0 ? (
        <p style={{ color: '#444', fontSize: '0.8rem' }}>No grants yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr>
                {(['Subject Type', 'Subject ID', 'Action', 'Effect', 'Created', ''] as const).map(h => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #1e1e1e',
                    color: '#888', fontWeight: 600, whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grants.map(g => (
                <tr key={g.id}>
                  <td style={cell}>{g.subject_type}</td>
                  <td style={{ ...cell, fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {g.subject_id}
                  </td>
                  <td style={cell}>{g.action}</td>
                  <td style={{ ...cell, color: g.effect === 'allow' ? '#4ade80' : '#f87171' }}>
                    {g.effect}
                  </td>
                  <td style={{ ...cell, color: '#555' }}>
                    {new Date(g.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button onClick={() => handleRevoke(g.id)} style={dangerBtn}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cell: React.CSSProperties = {
  padding: '5px 10px', borderBottom: '1px solid #141414',
  color: '#ccc', whiteSpace: 'nowrap',
}

const primaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #1e1e1e', borderRadius: 6,
  color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 12px',
}

const dangerBtn: React.CSSProperties = {
  padding: '3px 10px', background: '#7f1d1d', color: '#fca5a5',
  border: 'none', borderRadius: 6, fontWeight: 500, fontSize: '0.72rem', cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem', background: '#1e1e1e', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: '0.85rem', outline: 'none',
  boxSizing: 'border-box',
}
