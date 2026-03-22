'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../../lib/auth'
import {
  listCompanyGroups,
  createCompanyGroup,
  deleteCompanyGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  type CompanyGroup,
  type GroupMembership,
} from '../../../../lib/api'

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function isReadOnlyGroup(group: CompanyGroup) {
  return group.source_type !== 'manual'
}

function formatGroupSource(sourceType: string) {
  switch (sourceType) {
    case 'company_synthetic':
      return 'System'
    case 'workspace_sync':
      return 'Workspace Sync'
    case 'idp':
    case 'external':
      return 'IdP'
    case 'manual':
      return 'Manual'
    default:
      return sourceType.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
  }
}

const btn: React.CSSProperties = {
  background: 'none',
  border: '1px solid #1e1e1e',
  borderRadius: 4,
  color: '#555',
  cursor: 'pointer',
  fontSize: '0.75rem',
  padding: '4px 10px',
}

const inputStyle: React.CSSProperties = {
  background: '#0d0d0d',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#e5e5e5',
  fontSize: '0.75rem',
  padding: '4px 8px',
  outline: 'none',
}

export default function GroupsPage() {
  const { company } = useAuth()
  const [groups, setGroups] = useState<CompanyGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // Expanded group + members
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [members, setMembers] = useState<GroupMembership[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState('')

  // Add member
  const [addUserId, setAddUserId] = useState('')
  const [adding, setAdding] = useState(false)

  // Delete confirm
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const companyId = company?.id

  const load = useCallback(() => {
    if (!companyId) return
    setLoading(true)
    setError('')
    listCompanyGroups(companyId)
      .then(res => setGroups(res.groups ?? []))
      .catch(() => setError('Failed to load groups'))
      .finally(() => setLoading(false))
  }, [companyId])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!companyId || !newName.trim()) return
    setCreating(true)
    setError('')
    try {
      const group = await createCompanyGroup(companyId, {
        name: newName.trim(),
        slug: slugify(newName),
      })
      setGroups(prev => [...prev, group])
      setNewName('')
      setShowCreate(false)
    } catch {
      setError('Failed to create group')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (groupId: string) => {
    if (!companyId) return
    setDeleting(true)
    setError('')
    try {
      await deleteCompanyGroup(companyId, groupId)
      setGroups(prev => prev.filter(g => g.id !== groupId))
      if (expandedId === groupId) {
        setExpandedId(null)
        setMembers([])
      }
      setConfirmDeleteId(null)
    } catch {
      setError('Failed to delete group')
    } finally {
      setDeleting(false)
    }
  }

  const loadMembers = useCallback(
    (groupId: string) => {
      if (!companyId) return
      setMembersLoading(true)
      setMembersError('')
      listGroupMembers(companyId, groupId)
        .then(res => setMembers(res.members ?? []))
        .catch(() => setMembersError('Failed to load members'))
        .finally(() => setMembersLoading(false))
    },
    [companyId],
  )

  const toggleExpand = (groupId: string) => {
    if (expandedId === groupId) {
      setExpandedId(null)
      setMembers([])
      setMembersError('')
    } else {
      setExpandedId(groupId)
      setMembers([])
      setAddUserId('')
      loadMembers(groupId)
    }
  }

  const handleAddMember = async () => {
    if (!companyId || !expandedId || !addUserId.trim()) return
    setAdding(true)
    setMembersError('')
    try {
      await addGroupMember(companyId, expandedId, addUserId.trim())
      setAddUserId('')
      loadMembers(expandedId)
    } catch {
      setMembersError('Failed to add member')
    } finally {
      setAdding(false)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    if (!companyId || !expandedId) return
    setMembersError('')
    try {
      await removeGroupMember(companyId, expandedId, userId)
      setMembers(prev => prev.filter(m => m.user_id !== userId))
    } catch {
      setMembersError('Failed to remove member')
    }
  }

  const truncate = (s: string, len = 12) =>
    s.length > len ? s.slice(0, len) + '…' : s

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Groups</h1>
        <span style={{ color: '#555', fontSize: '0.75rem' }}>
          Manage manual company groups and inspect system-managed memberships.
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={btn}>Refresh</button>
        <button
          onClick={() => setShowCreate(prev => !prev)}
          style={{ ...btn, color: '#2563eb', borderColor: '#2563eb' }}
        >
          {showCreate ? 'Cancel' : '+ Create Group'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{ marginBottom: '1.25rem', padding: '0.75rem', background: '#111', border: '1px solid #1f1f1f', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Group name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              style={{ ...inputStyle, flex: 1 }}
            />
            <span style={{ color: '#555', fontSize: '0.65rem', fontFamily: 'monospace' }}>
              slug: {slugify(newName) || '—'}
            </span>
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              style={{ ...btn, color: creating ? '#333' : '#2563eb', borderColor: '#2563eb' }}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>
      )}

      {/* Loading */}
      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : groups.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1a1a1a', borderRadius: 8 }}>
          <p style={{ color: '#444', fontSize: '0.875rem', margin: 0 }}>No groups yet.</p>
          <p style={{ color: '#333', fontSize: '0.75rem', margin: '0.5rem 0 0' }}>
            Create a group to organise users.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map(group => {
            const isExpanded = expandedId === group.id
            const isDeleting = confirmDeleteId === group.id
            const isReadOnly = isReadOnlyGroup(group)

            return (
              <div
                key={group.id}
                style={{
                  background: '#111',
                  border: `1px solid ${isExpanded ? '#1f1f1f' : '#1a1a1a'}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {/* Group row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '0.6rem 0.75rem',
                    cursor: 'pointer',
                  }}
                  onClick={() => toggleExpand(group.id)}
                >
                  <span style={{ fontSize: '0.65rem', color: '#555', width: 12, textAlign: 'center' }}>
                    {isExpanded ? '▾' : '▸'}
                  </span>
                  <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>{group.name}</span>
                  <span style={{ fontSize: '0.65rem', color: '#555', fontFamily: 'monospace' }}>
                    {group.slug}
                  </span>
                  {isReadOnly ? (
                    <span style={{
                      fontSize: '0.6rem',
                      color: '#fbbf24',
                      background: 'rgba(251,191,36,0.12)',
                      borderRadius: 3,
                      padding: '1px 5px',
                    }}>
                      Read only · {formatGroupSource(group.source_type)}
                    </span>
                  ) : (
                    <span style={{
                      fontSize: '0.6rem',
                      color: '#888',
                      background: '#1a1a1a',
                      borderRadius: 3,
                      padding: '1px 5px',
                    }}>
                      {formatGroupSource(group.source_type)}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: '0.65rem', color: '#333', fontFamily: 'monospace' }}>
                    {truncate(group.id)}
                  </span>

                  {/* Delete */}
                  {!isReadOnly && (
                    isDeleting ? (
                      <span style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => handleDelete(group.id)}
                          disabled={deleting}
                          style={{ ...btn, color: '#ef4444', borderColor: '#ef4444', fontSize: '0.65rem' }}
                        >
                          {deleting ? '…' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ ...btn, fontSize: '0.65rem' }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); setConfirmDeleteId(group.id) }}
                        style={{ ...btn, color: '#555', fontSize: '0.65rem', padding: '2px 6px' }}
                        title="Delete group"
                      >
                        ✕
                      </button>
                    )
                  )}
                </div>

                {/* Expanded: members panel */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid #1a1a1a', padding: '0.6rem 0.75rem', background: '#0d0d0d' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.75rem', color: '#888', fontWeight: 500 }}>Members</span>
                      <div style={{ flex: 1 }} />
                      {isReadOnly ? (
                        <span style={{ color: '#555', fontSize: '0.72rem' }}>
                          Membership is managed automatically for this group.
                        </span>
                      ) : (
                        <>
                          <input
                            type="text"
                            placeholder="User ID"
                            value={addUserId}
                            onChange={e => setAddUserId(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAddMember()}
                            onClick={e => e.stopPropagation()}
                            style={{ ...inputStyle, width: 180 }}
                          />
                          <button
                            onClick={e => { e.stopPropagation(); handleAddMember() }}
                            disabled={adding || !addUserId.trim()}
                            style={{ ...btn, color: adding ? '#333' : '#2563eb', borderColor: '#2563eb', fontSize: '0.65rem' }}
                          >
                            {adding ? '…' : 'Add'}
                          </button>
                        </>
                      )}
                    </div>

                    {isReadOnly && (
                      <p style={{ color: '#555', fontSize: '0.72rem', margin: '0 0 0.5rem' }}>
                        This group is maintained by Lima or your identity provider, so membership edits are disabled here.
                      </p>
                    )}

                    {membersError && (
                      <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>
                        {membersError}
                      </p>
                    )}

                    {membersLoading ? (
                      <p style={{ color: '#555', fontSize: '0.75rem', margin: 0 }}>Loading members…</p>
                    ) : members.length === 0 ? (
                      <p style={{ color: '#444', fontSize: '0.75rem', margin: 0 }}>No members in this group.</p>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #1a1a1a' }}>
                            <th style={{ textAlign: 'left', padding: '4px 6px', color: '#555', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                              User ID
                            </th>
                            <th style={{ textAlign: 'left', padding: '4px 6px', color: '#555', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                              Joined
                            </th>
                            {!isReadOnly && <th style={{ width: 40 }} />}
                          </tr>
                        </thead>
                        <tbody>
                          {members.map(m => (
                            <tr key={m.user_id} style={{ borderBottom: '1px solid #111' }}>
                              <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: '#ccc' }}>
                                {m.user_id}
                              </td>
                              <td style={{ padding: '4px 6px', color: '#888' }}>
                                {new Date(m.joined_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                              </td>
                              {!isReadOnly && (
                                <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                                  <button
                                    onClick={e => { e.stopPropagation(); handleRemoveMember(m.user_id) }}
                                    style={{ ...btn, color: '#ef4444', fontSize: '0.6rem', padding: '1px 5px', borderColor: 'transparent' }}
                                    title="Remove member"
                                  >
                                    ✕
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
