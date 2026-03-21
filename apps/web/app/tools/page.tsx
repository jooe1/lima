'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { listCompanyTools, type CompanyTool } from '../../lib/api'

export default function ToolsPage() {
  const { company } = useAuth()
  const [tools, setTools] = useState<CompanyTool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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
    return tools.filter(t => t.app_name.toLowerCase().includes(q))
  }, [tools, search])

  return (
    <div style={{ padding: '2rem', maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#e5e5e5' }}>Your Tools</h1>
        {tools.length > 0 && (
          <input
            type="text"
            placeholder="Search tools…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: '#111',
              border: '1px solid #1f1f1f',
              borderRadius: 6,
              padding: '0.4rem 0.75rem',
              color: '#e5e5e5',
              fontSize: '0.8rem',
              outline: 'none',
              width: 220,
            }}
          />
        )}
      </div>
      {error && <p style={{ color: '#f87171', fontSize: '0.8rem' }}>{error}</p>}
      {loading ? (
        <p style={{ color: '#555' }}>Loading…</p>
      ) : tools.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1f1f1f', borderRadius: 8 }}>
          <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>
            No published tools available. Tools will appear here once an admin publishes them.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1f1f1f', borderRadius: 8 }}>
          <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>No tools match &ldquo;{search}&rdquo;</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {filtered.map(tool => (
            <ToolCard key={tool.publication_id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCard({ tool }: { tool: CompanyTool }) {
  const [hovered, setHovered] = useState(false)
  return (
    <a
      href={`/app/${tool.app_id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        background: '#111',
        border: `1px solid ${hovered ? '#333' : '#1f1f1f'}`,
        borderRadius: 10,
        padding: '1.25rem',
        textDecoration: 'none',
        color: '#e5e5e5',
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>
        {tool.app_name}
      </div>
      {tool.app_description && (
        <div style={{ color: '#888', fontSize: '0.8rem', marginBottom: 8 }}>
          {tool.app_description}
        </div>
      )}
      <div style={{ color: '#555', fontSize: '0.75rem' }}>
        Published {new Date(tool.published_at).toLocaleDateString()}
      </div>
    </a>
  )
}
