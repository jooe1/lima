'use client'

import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../../lib/auth'
import { listMembers, type Member } from '../../../../lib/api'

const roleBadgeColors: Record<string, { bg: string; text: string }> = {
  workspace_admin: { bg: 'rgba(37,99,235,0.15)', text: '#2563eb' },
  app_builder: { bg: 'rgba(147,51,234,0.15)', text: '#a855f7' },
  end_user: { bg: 'rgba(85,85,85,0.15)', text: '#888' },
}

function roleBadge(role: string) {
  return roleBadgeColors[role] ?? roleBadgeColors.end_user
}

function formatRole(role: string) {
  return role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

export default function MembersPage() {
  const { company, workspace } = useAuth()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!company?.id || !workspace?.id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listMembers(company.id, workspace.id)
      .then(res => {
        if (!cancelled) setMembers(res.members ?? [])
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load members')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [company?.id, workspace?.id])

  const filtered = useMemo(() => {
    if (!search.trim()) return members
    const q = search.toLowerCase()
    return members.filter(
      m => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    )
  }, [members, search])

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Workspace Members</h1>
          {!loading && !error && (
            <span style={{ fontSize: '0.75rem', color: '#555' }}>
              {filtered.length === members.length
                ? `${members.length} member${members.length !== 1 ? 's' : ''}`
                : `${filtered.length} of ${members.length}`}
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Filter by name or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%',
            maxWidth: 320,
            padding: '0.4rem 0.6rem',
            fontSize: '0.8rem',
            background: '#111',
            border: '1px solid #1f1f1f',
            borderRadius: 6,
            color: '#e5e5e5',
            outline: 'none',
          }}
        />
      </div>

      {/* Loading */}
      {loading && (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading members…</p>
      )}

      {/* Error */}
      {error && (
        <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>
      )}

      {/* Empty */}
      {!loading && !error && members.length === 0 && (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>No members found in this workspace.</p>
      )}

      {/* No search results */}
      {!loading && !error && members.length > 0 && filtered.length === 0 && (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>No members match &ldquo;{search}&rdquo;</p>
      )}

      {/* Table */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ border: '1px solid #1a1a1a', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ background: '#111', borderBottom: '1px solid #1a1a1a' }}>
                {['Name', 'Email', 'Role', 'Joined'].map(h => (
                  <th
                    key={h}
                    style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'left',
                      fontWeight: 500,
                      fontSize: '0.75rem',
                      color: '#555',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => {
                const badge = roleBadge(m.role)
                return (
                  <tr key={m.user_id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                    <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>{m.name}</td>
                    <td style={{ padding: '0.5rem 0.75rem', color: '#999' }}>{m.email}</td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '0.15rem 0.5rem',
                          fontSize: '0.65rem',
                          fontWeight: 500,
                          borderRadius: 9999,
                          background: badge.bg,
                          color: badge.text,
                        }}
                      >
                        {formatRole(m.role)}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: '#555', fontSize: '0.75rem' }}>
                      {formatDate(m.joined_at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
