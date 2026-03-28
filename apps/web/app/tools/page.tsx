'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import { listCompanyTools, type CompanyTool } from '../../lib/api'

export type ToolCardState = 'launchable' | 'discover-only' | 'inaccessible'

export default function ToolsPage() {
  const router = useRouter()
  const { company, workspace, workspaces, selectWorkspace } = useAuth()
  const [tools, setTools] = useState<CompanyTool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [launchError, setLaunchError] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    if (!company) return
    setLoading(true)
    setError('')
    listCompanyTools(company.id)
      .then(res => setTools(res.tools ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load tools'))
      .finally(() => setLoading(false))
  }, [company])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return tools
    const q = search.toLowerCase()
    return tools.filter(tool => {
      const nameMatch = tool.app_name.toLowerCase().includes(q)
      const descriptionMatch = tool.app_description.toLowerCase().includes(q)
      return nameMatch || descriptionMatch
    })
  }, [tools, search])

  const workspaceNamesByID = useMemo(() => {
    return workspaces.reduce<Record<string, string>>((next, candidate) => {
      next[candidate.id] = candidate.name
      return next
    }, {})
  }, [workspaces])

  const handleOpenTool = useCallback((tool: CompanyTool) => {
    if (tool.capability !== 'use') {
      return
    }

    const targetWorkspace = workspaces.find(candidate => candidate.id === tool.workspace_id)
      ?? (workspace?.id === tool.workspace_id ? workspace : null)

    if (!targetWorkspace) {
      setLaunchError('You no longer have access to the workspace that owns this tool.')
      return
    }

    setLaunchError('')
    if (workspace?.id !== targetWorkspace.id) {
      selectWorkspace(targetWorkspace)
    }

    const params = new URLSearchParams({
      workspace: targetWorkspace.id,
      publication: tool.publication_id,
    })
    router.push(`/app/${tool.app_id}?${params.toString()}`)
  }, [router, selectWorkspace, workspace, workspaces])

  return (
    <main style={{ padding: '2rem', maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-text, #e5e5e5)' }}>Your Tools</h1>
        <label htmlFor="tool-search" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="tool-search"
            type="search"
            placeholder="Search tools…"
            aria-label="Search tools"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: 'var(--color-surface, #111)',
              border: '1px solid var(--color-border, #1f1f1f)',
              borderRadius: 6,
              padding: '0.4rem 0.75rem',
              color: 'var(--color-text, #e5e5e5)',
              fontSize: '0.8rem',
              outline: 'none',
              width: 220,
            }}
          />
        </label>
      </div>
      {(error || launchError) && (
        <div role="alert" aria-live="polite">
          {error && <p style={{ color: 'var(--color-error, #f87171)', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>{error}</p>}
          {launchError && (
            <p style={{ color: 'var(--color-error, #f87171)', fontSize: '0.8rem', background: 'var(--color-surface, #141414)', padding: '0.75rem', borderRadius: 6, border: '1px solid #f8717133', margin: 0 }}>{launchError}</p>
          )}
        </div>
      )}
      {loading ? (
        <p style={{ color: '#555' }}>Loading…</p>
      ) : tools.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid var(--color-border, #1f1f1f)', borderRadius: 8 }}>
          <p style={{ color: 'var(--color-text-muted, #555)', fontSize: '0.875rem', margin: 0, lineHeight: 1.6 }}>
            No tools are available to you yet.
          </p>
          <p style={{ color: 'var(--color-text-subtle, #444)', fontSize: '0.8rem', margin: '0.5rem 0 0 0' }}>
            Tools appear here once they have been published. You can create and publish tools in the{' '}
            <a href="/builder" style={{ color: 'var(--color-primary, #2563eb)', textDecoration: 'none' }}>builder</a>.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1f1f1f', borderRadius: 8 }}>
          <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>No tools match &ldquo;{search}&rdquo;</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {filtered.map(tool => (
            <ToolCard
              key={tool.publication_id}
              tool={tool}
              workspaceName={workspaceNamesByID[tool.workspace_id]}
              onOpen={() => handleOpenTool(tool)}
            />
          ))}
        </div>
      )}
    </main>
  )
}

function ToolCard({
  tool,
  workspaceName,
  onOpen,
}: {
  tool: CompanyTool
  workspaceName?: string
  onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const canLaunch = tool.capability === 'use'

  const cardStyles = {
    display: 'block',
    width: '100%',
    background: '#111',
    border: `1px solid ${hovered && canLaunch ? '#333' : '#1f1f1f'}`,
    borderRadius: 10,
    padding: '1.25rem',
    color: '#e5e5e5',
    transition: 'border-color 0.15s',
    textAlign: 'left' as const,
    cursor: canLaunch ? 'pointer' : 'default',
  }

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
          {tool.app_name}
        </div>
        <span style={capabilityPill(tool.capability)}>
          {tool.capability === 'use' ? 'Ready to use' : 'Discover only'}
        </span>
      </div>
      {tool.app_description && (
        <div style={{ color: '#888', fontSize: '0.8rem', marginBottom: 8 }}>
          {tool.app_description}
        </div>
      )}
      {workspaceName && (
        <div style={{ color: '#666', fontSize: '0.72rem', marginBottom: 8 }}>
          Workspace {workspaceName}
        </div>
      )}
      <div style={{ color: '#555', fontSize: '0.75rem' }}>
        Published {new Date(tool.published_at).toLocaleDateString()}
      </div>
      {canLaunch ? (
        <div style={{ color: 'var(--color-primary, #2563eb)', fontSize: '0.8rem', marginTop: 10, fontWeight: 500 }}>
          Open →
        </div>
      ) : (
        <div style={{ color: '#555', fontSize: '0.72rem', marginTop: 10 }}>
          Available to discover — ask your admin for access
        </div>
      )}
    </>
  )

  if (!canLaunch) {
    return (
      <div
        style={cardStyles}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardStyles,
        appearance: 'none',
      }}
    >
      {content}
    </button>
  )
}

function capabilityPill(capability: CompanyTool['capability']) {
  if (capability === 'use') {
    return {
      background: '#16653433',
      borderRadius: 99,
      color: '#4ade80',
      fontSize: '0.62rem',
      padding: '2px 8px',
      whiteSpace: 'nowrap' as const,
    }
  }

  return {
    background: '#1e3a8a33',
    borderRadius: 99,
    color: '#93c5fd',
    fontSize: '0.62rem',
    padding: '2px 8px',
    whiteSpace: 'nowrap' as const,
  }
}
