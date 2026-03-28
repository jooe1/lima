'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import { listApps, createApp, createWorkspace, type App } from '../../lib/api'
import { SurfaceCard, InlineAlert, EmptyState } from '../_components/UxPrimitives'

// Internal view state type — consumed by tests and later builder changes.
export type BuilderHomeView = 'setup' | 'apps'

export default function BuilderHome() {
  const router = useRouter()
  const { workspace, user, selectWorkspace } = useAuth()
  const [apps, setApps] = useState<App[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [wsCreating, setWsCreating] = useState(false)
  const [wsName, setWsName] = useState('My workspace')

  const view: BuilderHomeView = workspace ? 'apps' : 'setup'

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
    setError('')
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
      const ws = await createWorkspace(
        user.companyId,
        wsName.trim(),
        wsName.trim().toLowerCase().replace(/\s+/g, '-'),
      )
      selectWorkspace(ws)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setWsCreating(false)
    }
  }

  // ── Setup view (no workspace yet) ─────────────────────────────────────────
  if (view === 'setup') {
    return (
      <div style={{ padding: 'var(--space-8)', maxWidth: 480 }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', marginBottom: 'var(--space-2)' }}>
          Welcome to Lima
        </h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--space-8)' }}>
          Let&#39;s get you set up. First, create a workspace — it&#39;s where your apps and team will live.
        </p>
        <SurfaceCard title="Create a workspace">
          {error && <div style={{ marginBottom: 'var(--space-4)' }}><InlineAlert tone="error" message={error} /></div>}
          <form onSubmit={handleCreateWorkspace} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label htmlFor="ws-name" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', fontWeight: 500 }}>
                Workspace name
              </label>
              <input
                id="ws-name"
                autoFocus
                type="text"
                placeholder="e.g. My Team"
                value={wsName}
                onChange={e => setWsName(e.target.value)}
                style={inputStyle}
              />
            </div>
            <button type="submit" disabled={wsCreating} style={wsCreating ? btnDisabled : btnPrimary}>
              {wsCreating ? 'Creating…' : 'Create workspace'}
            </button>
          </form>
        </SurfaceCard>
      </div>
    )
  }

  // ── Apps view (workspace exists) ──────────────────────────────────────────
  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
            Your apps
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginTop: 'var(--space-1)', marginBottom: 0 }}>
            {workspace!.name}
          </p>
        </div>
        <button onClick={() => setShowCreate(v => !v)} style={btnPrimary}>
          New app
        </button>
      </div>

      {error && <div style={{ marginBottom: 'var(--space-4)' }}><InlineAlert tone="error" message={error} /></div>}

      {showCreate && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <SurfaceCard title="Name your new app">
            <form onSubmit={handleCreate} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <input
                autoFocus
                type="text"
                placeholder="App name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="submit" disabled={creating} style={creating ? btnDisabled : btnPrimary}>
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setNewName('') }}
                style={btnGhost}
              >
                Cancel
              </button>
            </form>
          </SurfaceCard>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>Loading apps…</p>
      ) : apps.filter(a => a.status !== 'archived').length === 0 ? (
        <EmptyState
          title="No apps yet"
          body="Create your first app to start building an internal tool. It only takes a minute."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--space-3)' }}>
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
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        width: '100%',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--color-border-muted)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--color-border)')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-2)' }}>
        <span style={{ fontWeight: 600, color: 'var(--color-text)', fontSize: 'var(--font-size-sm)' }}>{app.name}</span>
        <StatusBadge status={app.status} />
      </div>
      {app.description && (
        <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: '0 0 var(--space-2)' }}>{app.description}</p>
      )}
      <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: 0 }}>
        Updated {new Date(app.updated_at).toLocaleDateString()}
      </p>
    </button>
  )
}

function StatusBadge({ status }: { status: App['status'] }) {
  const colorMap: Record<App['status'], string> = {
    draft: 'var(--color-warning)',
    published: 'var(--color-success)',
    archived: 'var(--color-text-subtle)',
  }
  return (
    <span style={{
      fontSize: 'var(--font-size-xs)',
      padding: '2px 8px',
      borderRadius: 99,
      background: 'var(--color-surface-raised)',
      color: colorMap[status],
    }}>
      {status}
    </span>
  )
}

const inputStyle: React.CSSProperties = {
  padding: 'var(--space-3)',
  background: 'var(--color-surface-raised)',
  border: '1px solid var(--color-border-muted)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-text)',
  fontSize: 'var(--font-size-sm)',
  outline: 'none',
  boxSizing: 'border-box',
}

const btnPrimary: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-4)',
  background: 'var(--color-primary)',
  color: '#fff',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  fontWeight: 600,
  fontSize: 'var(--font-size-sm)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const btnDisabled: React.CSSProperties = {
  ...btnPrimary,
  background: 'var(--color-surface-raised)',
  color: 'var(--color-text-muted)',
  cursor: 'not-allowed',
}

const btnGhost: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-4)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  border: '1px solid var(--color-border-muted)',
  borderRadius: 'var(--radius-md)',
  fontWeight: 600,
  fontSize: 'var(--font-size-sm)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

