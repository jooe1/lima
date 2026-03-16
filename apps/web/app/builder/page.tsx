'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import { listApps, createApp, createWorkspace, type App } from '../../lib/api'

export default function BuilderHome() {
  const router = useRouter()
  const { workspace, user } = useAuth()
  const [apps, setApps] = useState<App[]>([])
  const [loading, setLoading] = useState(true)
  const { selectWorkspace } = useAuth()
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [wsCreating, setWsCreating] = useState(false)
  const [wsName, setWsName] = useState('default')

  const load = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const res = await listApps(workspace.id)
      setApps(res.apps)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load apps')
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!workspace || !newName.trim()) return
    setCreating(true)
    try {
      const app = await createApp(workspace.id, newName.trim())
      router.push(`/builder/${app.id}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create app')
      setCreating(false)
    }
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault()
    if (!user || !wsName.trim()) return
    setWsCreating(true)
    setError('')
    try {
      const ws = await createWorkspace(user.companyId, wsName.trim(), wsName.trim().toLowerCase().replace(/\s+/g, '-'))
      selectWorkspace(ws)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setWsCreating(false)
    }
  }

  if (!workspace) {
    return (
      <div style={pageStyle}>
        <h2 style={{ fontWeight: 700, fontSize: '1.25rem', color: '#fff', marginBottom: '0.5rem' }}>Create your first workspace</h2>
        <p style={{ color: '#555', marginBottom: '1.5rem', fontSize: '0.875rem' }}>A workspace groups your apps and members.</p>
        {error && <p style={{ color: '#f87171', marginBottom: 12, fontSize: '0.8rem' }}>{error}</p>}
        <form onSubmit={handleCreateWorkspace} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            autoFocus
            type="text"
            placeholder="Workspace name"
            value={wsName}
            onChange={e => setWsName(e.target.value)}
            style={{ ...inputStyle, width: 240 }}
          />
          <button type="submit" disabled={wsCreating} style={primaryBtn}>
            {wsCreating ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <h2 style={{ fontWeight: 700, fontSize: '1.25rem', color: '#fff', margin: 0 }}>Your apps</h2>
        <button onClick={() => setShowCreate(true)} style={primaryBtn}>New app</button>
      </div>

      {error && <p style={{ color: '#f87171', marginBottom: 16 }}>{error}</p>}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          style={{
            background: '#141414', border: '1px solid #222', borderRadius: 10,
            padding: '1.25rem', marginBottom: '1.5rem', display: 'flex', gap: 10, alignItems: 'center',
          }}
        >
          <input
            autoFocus
            type="text"
            placeholder="App name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="submit" disabled={creating} style={primaryBtn}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => { setShowCreate(false); setNewName('') }}
            style={{ ...primaryBtn, background: 'transparent', border: '1px solid #333', color: '#888' }}
          >
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <p style={{ color: '#555' }}>Loading…</p>
      ) : apps.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '4rem 0', color: '#444',
        }}>
          <p style={{ marginBottom: '1rem' }}>No apps yet.</p>
          <button onClick={() => setShowCreate(true)} style={primaryBtn}>Create your first app</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {apps.filter(a => a.status !== 'archived').map(app => (
            <AppCard key={app.id} app={app} onClick={() => router.push(`/builder/${app.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function AppCard({ app, onClick }: { app: App; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#111', border: '1px solid #1f1f1f', borderRadius: 10,
        padding: '1.25rem', textAlign: 'left', cursor: 'pointer', transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = '#333')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = '#1f1f1f')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: '#e5e5e5', fontSize: '0.9rem' }}>{app.name}</span>
        <StatusBadge status={app.status} />
      </div>
      {app.description && (
        <p style={{ color: '#555', fontSize: '0.8rem', margin: '0 0 6px' }}>{app.description}</p>
      )}
      <p style={{ color: '#444', fontSize: '0.75rem', margin: 0 }}>
        Updated {new Date(app.updated_at).toLocaleDateString()}
      </p>
    </button>
  )
}

function StatusBadge({ status }: { status: App['status'] }) {
  const colors: Record<App['status'], string> = {
    draft: '#854d0e',
    published: '#166534',
    archived: '#374151',
  }
  return (
    <span style={{
      fontSize: '0.7rem', padding: '2px 8px', borderRadius: 99,
      background: colors[status] + '33',
      color: status === 'published' ? '#4ade80' : status === 'draft' ? '#fbbf24' : '#9ca3af',
    }}>
      {status}
    </span>
  )
}

const pageStyle: React.CSSProperties = {
  padding: '2rem',
  maxWidth: 900,
}

const primaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem', background: '#1e1e1e', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: '0.875rem', outline: 'none',
  boxSizing: 'border-box',
}

