'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../../lib/auth'
import {
  getWorkspaceAccessPolicy,
  listCompanyGroups,
  listMembers,
  putWorkspaceAccessPolicy,
  removeWorkspaceMember,
  upsertWorkspaceMember,
  type CompanyGroup,
  type Member,
  type WorkspaceAccessPolicyMatchKind,
  type WorkspaceAccessPolicyRule,
  type WorkspaceAccessPolicyRuleInput,
  type WorkspaceRole,
} from '../../../../lib/api'

const ROLE_OPTIONS: WorkspaceRole[] = ['workspace_admin', 'app_builder', 'end_user']
const MATCH_KIND_OPTIONS: WorkspaceAccessPolicyMatchKind[] = [
  'all_company_members',
  'company_group',
  'idp_group',
]

const MATCH_KIND_LABELS: Record<WorkspaceAccessPolicyMatchKind, string> = {
  all_company_members: 'All company members',
  company_group: 'Company group',
  idp_group: 'IdP group',
}

const roleBadgeColors: Record<WorkspaceRole, { bg: string; text: string }> = {
  workspace_admin: { bg: 'rgba(37,99,235,0.15)', text: '#2563eb' },
  app_builder: { bg: 'rgba(147,51,234,0.15)', text: '#a855f7' },
  end_user: { bg: 'rgba(85,85,85,0.15)', text: '#888' },
}

type PolicyDraftRule = {
  id: string
  match_kind: WorkspaceAccessPolicyMatchKind
  group_id: string
  role: WorkspaceRole
}

function createDraftId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createPolicyDraftRule(overrides: Partial<Omit<PolicyDraftRule, 'id'>> = {}): PolicyDraftRule {
  return {
    id: createDraftId(),
    match_kind: 'all_company_members',
    group_id: '',
    role: 'end_user',
    ...overrides,
  }
}

function mapPolicyRuleToDraft(rule: WorkspaceAccessPolicyRule): PolicyDraftRule {
  return createPolicyDraftRule({
    match_kind: rule.match_kind,
    group_id: rule.group_id ?? '',
    role: rule.role,
  })
}

function roleBadge(role: WorkspaceRole | string) {
  return roleBadgeColors[role as WorkspaceRole] ?? roleBadgeColors.end_user
}

function formatRole(role: string) {
  return role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

function isIdpGroup(group: CompanyGroup) {
  return group.source_type === 'idp' || group.source_type === 'external'
}

function groupOptionLabel(group: CompanyGroup) {
  return `${group.name} (${group.slug})`
}

export default function MembersPage() {
  const { company, workspace } = useAuth()
  const companyId = company?.id
  const workspaceId = workspace?.id

  const [members, setMembers] = useState<Member[]>([])
  const [groups, setGroups] = useState<CompanyGroup[]>([])
  const [policyRules, setPolicyRules] = useState<PolicyDraftRule[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [manualUserId, setManualUserId] = useState('')
  const [manualRole, setManualRole] = useState<WorkspaceRole>('end_user')
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  const [memberActionError, setMemberActionError] = useState<string | null>(null)
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)

  const [policySaving, setPolicySaving] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)

  const loadData = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!companyId || !workspaceId) return

      if (mode === 'initial') {
        setLoading(true)
      } else {
        setRefreshing(true)
      }

      setError(null)

      try {
        const [membersRes, policyRes, groupsRes] = await Promise.all([
          listMembers(companyId, workspaceId),
          getWorkspaceAccessPolicy(companyId, workspaceId),
          listCompanyGroups(companyId),
        ])

        setMembers(membersRes.members ?? [])
        setGroups(groupsRes.groups ?? [])
        setPolicyRules((policyRes.rules ?? []).map(mapPolicyRuleToDraft))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load workspace access data')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [companyId, workspaceId],
  )

  useEffect(() => {
    if (!companyId || !workspaceId) {
      setLoading(false)
      return
    }

    void loadData('initial')
  }, [companyId, workspaceId, loadData])

  const filteredMembers = useMemo(() => {
    if (!search.trim()) return members

    const query = search.toLowerCase()
    return members.filter(member =>
      [member.name, member.email, member.user_id].some(value =>
        value.toLowerCase().includes(query),
      ),
    )
  }, [members, search])

  const companyGroupOptions = useMemo(
    () => groups.filter(group => !isIdpGroup(group)),
    [groups],
  )

  const idpGroupOptions = useMemo(
    () => groups.filter(group => isIdpGroup(group)),
    [groups],
  )

  const handleManualSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!companyId || !workspaceId || !manualUserId.trim()) return

    setManualSubmitting(true)
    setManualError(null)
    setMemberActionError(null)

    try {
      await upsertWorkspaceMember(companyId, workspaceId, {
        user_id: manualUserId.trim(),
        role: manualRole,
      })
      setManualUserId('')
      await loadData('refresh')
    } catch (err) {
      setManualError(err instanceof Error ? err.message : 'Failed to update manual membership')
    } finally {
      setManualSubmitting(false)
    }
  }

  const handleRemoveManualGrant = async (userId: string) => {
    if (!companyId || !workspaceId) return

    setRemovingUserId(userId)
    setMemberActionError(null)

    try {
      await removeWorkspaceMember(companyId, workspaceId, userId)
      await loadData('refresh')
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : 'Failed to remove manual grant')
    } finally {
      setRemovingUserId(null)
    }
  }

  const handleMatchKindChange = (ruleId: string, matchKind: WorkspaceAccessPolicyMatchKind) => {
    setPolicyRules(prev =>
      prev.map(rule =>
        rule.id === ruleId
          ? { ...rule, match_kind: matchKind, group_id: '' }
          : rule,
      ),
    )
  }

  const handleRuleChange = (ruleId: string, patch: Partial<PolicyDraftRule>) => {
    setPolicyRules(prev =>
      prev.map(rule => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    )
  }

  const handleAddPolicyRule = () => {
    setPolicyRules(prev => [...prev, createPolicyDraftRule()])
    setPolicyError(null)
  }

  const handleRemovePolicyRule = (ruleId: string) => {
    setPolicyRules(prev => prev.filter(rule => rule.id !== ruleId))
    setPolicyError(null)
  }

  const buildPolicyPayload = (): WorkspaceAccessPolicyRuleInput[] | null => {
    const payload: WorkspaceAccessPolicyRuleInput[] = []
    const seen = new Set<string>()

    for (const rule of policyRules) {
      if (rule.match_kind === 'all_company_members') {
        const key = 'all_company_members:'
        if (seen.has(key)) {
          setPolicyError('Only one all-company-members rule is allowed.')
          return null
        }
        seen.add(key)
        payload.push({ match_kind: rule.match_kind, role: rule.role })
        continue
      }

      const groupId = rule.group_id.trim()
      if (!groupId) {
        setPolicyError('Select a group for each group-based access-policy rule.')
        return null
      }

      const validGroups = rule.match_kind === 'company_group'
        ? companyGroupOptions
        : idpGroupOptions

      if (!validGroups.some(group => group.id === groupId)) {
        setPolicyError(
          rule.match_kind === 'company_group'
            ? 'Select a valid non-IdP group for each company-group rule.'
            : 'Select a valid IdP group for each IdP-group rule.',
        )
        return null
      }

      const key = `${rule.match_kind}:${groupId}`
      if (seen.has(key)) {
        setPolicyError('Duplicate access-policy rules are not allowed.')
        return null
      }

      seen.add(key)
      payload.push({
        match_kind: rule.match_kind,
        group_id: groupId,
        role: rule.role,
      })
    }

    setPolicyError(null)
    return payload
  }

  const handleSavePolicy = async () => {
    if (!companyId || !workspaceId) return

    const payload = buildPolicyPayload()
    if (!payload) return

    setPolicySaving(true)
    setMemberActionError(null)

    try {
      await putWorkspaceAccessPolicy(companyId, workspaceId, payload)
      await loadData('refresh')
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : 'Failed to save workspace access policy')
    } finally {
      setPolicySaving(false)
    }
  }

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Workspace Members</h1>
          {!loading && !error && (
            <span style={{ fontSize: '0.75rem', color: '#555' }}>
              {filteredMembers.length === members.length
                ? `${members.length} member${members.length !== 1 ? 's' : ''}`
                : `${filteredMembers.length} of ${members.length}`}
            </span>
          )}
          {refreshing && (
            <span style={{ fontSize: '0.75rem', color: '#555' }}>Refreshing…</span>
          )}
        </div>
      </div>

      {!companyId || !workspaceId ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Select a workspace to manage members.</p>
      ) : (
        <>
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#111', border: '1px solid #1f1f1f', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600 }}>Manual Membership</h2>
                <p style={{ margin: '0.25rem 0 0', color: '#555', fontSize: '0.72rem' }}>
                  Create or update a manual workspace grant for a company user by ID.
                </p>
              </div>
            </div>

            <form onSubmit={handleManualSubmit} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="User ID"
                value={manualUserId}
                onChange={event => setManualUserId(event.target.value)}
                style={{
                  flex: '1 1 280px',
                  padding: '0.4rem 0.6rem',
                  fontSize: '0.8rem',
                  background: '#0d0d0d',
                  border: '1px solid #1f1f1f',
                  borderRadius: 6,
                  color: '#e5e5e5',
                  outline: 'none',
                }}
              />
              <select
                value={manualRole}
                onChange={event => setManualRole(event.target.value as WorkspaceRole)}
                style={{
                  padding: '0.4rem 0.6rem',
                  fontSize: '0.8rem',
                  background: '#0d0d0d',
                  border: '1px solid #1f1f1f',
                  borderRadius: 6,
                  color: '#e5e5e5',
                  minWidth: 180,
                }}
              >
                {ROLE_OPTIONS.map(role => (
                  <option key={role} value={role}>{formatRole(role)}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={manualSubmitting || !manualUserId.trim()}
                style={{
                  padding: '0.4rem 0.85rem',
                  borderRadius: 6,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  border: '1px solid #2563eb',
                  background: manualSubmitting || !manualUserId.trim() ? '#1e3a8a33' : '#2563eb',
                  color: manualSubmitting || !manualUserId.trim() ? '#93c5fd66' : '#fff',
                  cursor: manualSubmitting || !manualUserId.trim() ? 'default' : 'pointer',
                }}
              >
                {manualSubmitting ? 'Saving…' : 'Save Grant'}
              </button>
            </form>

            {manualError && (
              <p style={{ margin: '0.5rem 0 0', color: '#ef4444', fontSize: '0.75rem' }}>{manualError}</p>
            )}
          </div>

          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#111', border: '1px solid #1f1f1f', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600 }}>Workspace Access Policy</h2>
                <p style={{ margin: '0.25rem 0 0', color: '#555', fontSize: '0.72rem', lineHeight: 1.5 }}>
                  Automatic rules grant workspace access to matching company members or groups.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleAddPolicyRule}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: 6,
                    border: '1px solid #1f1f1f',
                    background: 'transparent',
                    color: '#e5e5e5',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  + Add Rule
                </button>
                <button
                  type="button"
                  onClick={handleSavePolicy}
                  disabled={policySaving}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: 6,
                    border: '1px solid #2563eb',
                    background: policySaving ? '#1e3a8a33' : '#2563eb',
                    color: policySaving ? '#93c5fd66' : '#fff',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: policySaving ? 'default' : 'pointer',
                  }}
                >
                  {policySaving ? 'Saving…' : 'Save Rules'}
                </button>
              </div>
            </div>

            {policyError && (
              <p style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.75rem' }}>{policyError}</p>
            )}

            {policyRules.length === 0 ? (
              <p style={{ margin: 0, color: '#555', fontSize: '0.75rem' }}>
                No automatic access rules. This workspace stays manual-only.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {policyRules.map(rule => {
                  const targetOptions = rule.match_kind === 'company_group'
                    ? companyGroupOptions
                    : rule.match_kind === 'idp_group'
                      ? idpGroupOptions
                      : []
                  const currentGroup = groups.find(group => group.id === rule.group_id)
                  const showCurrentGroupOption = Boolean(
                    rule.group_id &&
                    currentGroup &&
                    !targetOptions.some(group => group.id === rule.group_id),
                  )

                  return (
                    <div
                      key={rule.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        padding: '0.55rem',
                        background: '#0d0d0d',
                        border: '1px solid #1a1a1a',
                        borderRadius: 6,
                      }}
                    >
                      <select
                        value={rule.match_kind}
                        onChange={event => handleMatchKindChange(rule.id, event.target.value as WorkspaceAccessPolicyMatchKind)}
                        style={{
                          padding: '0.35rem 0.55rem',
                          fontSize: '0.75rem',
                          background: '#111',
                          border: '1px solid #1f1f1f',
                          borderRadius: 6,
                          color: '#e5e5e5',
                          minWidth: 190,
                        }}
                      >
                        {MATCH_KIND_OPTIONS.map(matchKind => (
                          <option key={matchKind} value={matchKind}>{MATCH_KIND_LABELS[matchKind]}</option>
                        ))}
                      </select>

                      {rule.match_kind === 'all_company_members' ? (
                        <span style={{ color: '#555', fontSize: '0.72rem', flex: '1 1 220px' }}>
                          Applies to every current company member.
                        </span>
                      ) : targetOptions.length === 0 && !showCurrentGroupOption ? (
                        <span style={{ color: '#555', fontSize: '0.72rem', flex: '1 1 220px' }}>
                          {rule.match_kind === 'company_group'
                            ? 'No non-IdP groups are available yet.'
                            : 'No IdP groups are available yet.'}
                        </span>
                      ) : (
                        <select
                          value={rule.group_id}
                          onChange={event => handleRuleChange(rule.id, { group_id: event.target.value })}
                          style={{
                            flex: '1 1 260px',
                            padding: '0.35rem 0.55rem',
                            fontSize: '0.75rem',
                            background: '#111',
                            border: '1px solid #1f1f1f',
                            borderRadius: 6,
                            color: '#e5e5e5',
                          }}
                        >
                          <option value="">
                            {rule.match_kind === 'company_group' ? 'Select company group…' : 'Select IdP group…'}
                          </option>
                          {showCurrentGroupOption && currentGroup && (
                            <option value={currentGroup.id}>{groupOptionLabel(currentGroup)}</option>
                          )}
                          {targetOptions.map(group => (
                            <option key={group.id} value={group.id}>{groupOptionLabel(group)}</option>
                          ))}
                        </select>
                      )}

                      <select
                        value={rule.role}
                        onChange={event => handleRuleChange(rule.id, { role: event.target.value as WorkspaceRole })}
                        style={{
                          padding: '0.35rem 0.55rem',
                          fontSize: '0.75rem',
                          background: '#111',
                          border: '1px solid #1f1f1f',
                          borderRadius: 6,
                          color: '#e5e5e5',
                          minWidth: 170,
                        }}
                      >
                        {ROLE_OPTIONS.map(role => (
                          <option key={role} value={role}>{formatRole(role)}</option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => handleRemovePolicyRule(rule.id)}
                        style={{
                          padding: '0.3rem 0.55rem',
                          borderRadius: 6,
                          border: '1px solid #1f1f1f',
                          background: 'transparent',
                          color: '#888',
                          fontSize: '0.72rem',
                          cursor: 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <input
              type="text"
              placeholder="Filter by name, email, or user ID…"
              value={search}
              onChange={event => setSearch(event.target.value)}
              style={{
                width: '100%',
                maxWidth: 360,
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

          {error && (
            <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>
          )}

          {memberActionError && (
            <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{memberActionError}</p>
          )}

          {loading && (
            <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading members…</p>
          )}

          {!loading && !error && members.length === 0 && (
            <p style={{ color: '#555', fontSize: '0.8rem' }}>No members found in this workspace.</p>
          )}

          {!loading && !error && members.length > 0 && filteredMembers.length === 0 && (
            <p style={{ color: '#555', fontSize: '0.8rem' }}>No members match &ldquo;{search}&rdquo;</p>
          )}

          {!loading && !error && filteredMembers.length > 0 && (
            <div style={{ border: '1px solid #1a1a1a', borderRadius: 8, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: 980 }}>
                <thead>
                  <tr style={{ background: '#111', borderBottom: '1px solid #1a1a1a' }}>
                    {['Name', 'Email / User', 'Role', 'Why', 'Joined', 'Actions'].map(header => (
                      <th
                        key={header}
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
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map(member => {
                    const badge = roleBadge(member.role)
                    const grants = member.grants ?? []
                    const manualGrant = grants.find(grant => grant.grant_source === 'manual')

                    return (
                      <tr key={member.user_id} style={{ borderBottom: '1px solid #1a1a1a', verticalAlign: 'top' }}>
                        <td style={{ padding: '0.6rem 0.75rem', fontWeight: 500 }}>{member.name}</td>
                        <td style={{ padding: '0.6rem 0.75rem' }}>
                          <div style={{ color: '#999' }}>{member.email}</div>
                          <div style={{ color: '#555', fontSize: '0.7rem', fontFamily: 'monospace', marginTop: 4 }}>
                            {member.user_id}
                          </div>
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem' }}>
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
                            {formatRole(member.role)}
                          </span>
                          {grants.length > 0 && (
                            <div style={{ color: '#555', fontSize: '0.68rem', marginTop: 6 }}>
                              {grants.length} grant{grants.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem', minWidth: 320 }}>
                          {grants.length === 0 ? (
                            <span style={{ color: '#555', fontSize: '0.72rem' }}>No grant details provided.</span>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {grants.map((grant, index) => (
                                <div
                                  key={`${grant.grant_source}-${grant.source_ref}-${index}`}
                                  style={{ color: index === 0 ? '#ccc' : '#777', fontSize: '0.72rem', lineHeight: 1.5 }}
                                >
                                  {grant.explanation}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem', color: '#555', fontSize: '0.75rem' }}>
                          {formatDate(member.joined_at)}
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem' }}>
                          {manualGrant ? (
                            <button
                              type="button"
                              onClick={() => handleRemoveManualGrant(member.user_id)}
                              disabled={removingUserId === member.user_id}
                              style={{
                                padding: '0.3rem 0.55rem',
                                borderRadius: 6,
                                border: '1px solid #7f1d1d',
                                background: 'transparent',
                                color: removingUserId === member.user_id ? '#7f1d1d' : '#ef4444',
                                fontSize: '0.72rem',
                                cursor: removingUserId === member.user_id ? 'default' : 'pointer',
                              }}
                            >
                              {removingUserId === member.user_id ? 'Removing…' : 'Remove Manual Grant'}
                            </button>
                          ) : (
                            <span style={{ color: '#555', fontSize: '0.72rem' }}>Automatic only</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
