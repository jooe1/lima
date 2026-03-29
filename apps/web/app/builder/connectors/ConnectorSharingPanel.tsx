'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  listConnectorGrants,
  createConnectorGrant,
  deleteConnectorGrant,
  type ResourceGrant,
} from '../../../lib/api'
import { useAuth } from '../../../lib/auth'

interface Props {
  connectorId: string
  workspaceId: string
}

const ACTION_TO_LABEL: Record<string, string> = {
  query: 'Can view data',
  mutate: 'Can view and edit data',
}
const LABEL_TO_ACTION: Record<string, string> = {
  'Can view data': 'query',
  'Can view and edit data': 'mutate',
}
const ACTION_LEVEL: Record<string, number> = { query: 1, mutate: 2, manage: 3 }

function labelForAction(action: string): string {
  return ACTION_TO_LABEL[action] ?? action
}

function chipStyle(isOwner: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 6,
    background: isOwner ? '#0f1e0f' : '#111',
    border: `1px solid ${isOwner ? '#1a3a1a' : '#1e1e1e'}`,
    marginBottom: 4,
  }
}

export function ConnectorSharingPanel({ connectorId, workspaceId }: Props) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'workspace_admin'

  const [grants, setGrants] = useState<ResourceGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addInput, setAddInput] = useState('')
  const [addRole, setAddRole] = useState('Can view data')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [restrictReadOnly, setRestrictReadOnly] = useState(false)

  const loadGrants = useCallback(() => {
    setLoading(true)
    setError(null)
    listConnectorGrants(workspaceId, connectorId)
      .then(res => setGrants(res.grants ?? []))
      .catch(() => setError('Could not load the access list. Please try again.'))
      .finally(() => setLoading(false))
  }, [workspaceId, connectorId])

  useEffect(() => {
    loadGrants()
  }, [loadGrants])

  // Determine the current user's effective action level
  const myGrant = grants.find(g => g.subject_id === user?.id)
  const myAction: string = myGrant?.action ?? (isAdmin ? 'manage' : 'query')
  const myLevel = ACTION_LEVEL[myAction] ?? 1

  // Identify the owner grant: first manage grant (pinned, cannot be removed)
  const ownerGrant = grants.find(g => g.action === 'manage')

  async function handleAdd() {
    const val = addInput.trim()
    if (!val) return
    setAdding(true)
    setAddError(null)
    try {
      const action = LABEL_TO_ACTION[addRole] ?? 'query'
      const created = await createConnectorGrant(workspaceId, connectorId, {
        subject_type: 'user',
        subject_id: val,
        action,
      })
      setGrants(prev => [...prev, created])
      setAddInput('')
    } catch {
      setAddError('Could not add this person. Check the email or ID and try again.')
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(grant: ResourceGrant) {
    setDeletingId(grant.id)
    try {
      await deleteConnectorGrant(workspaceId, connectorId, grant.id)
      setGrants(prev => prev.filter(g => g.id !== grant.id))
    } catch {
      // silent — keep in list
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <p style={{ color: '#888', fontSize: '0.8rem', margin: 0 }}>
        Loading access list…
      </p>
    )
  }

  if (error) {
    return (
      <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>{error}</p>
    )
  }

  const otherGrants = grants.filter(g => g.id !== ownerGrant?.id)

  return (
    <div>
      {/* Owner chip */}
      {ownerGrant && (
        <div style={chipStyle(true)}>
          <span style={{ color: '#e5e5e5', fontSize: '0.8rem', flex: 1 }}>
            {ownerGrant.subject_id}
          </span>
          <span style={{
            fontSize: '0.65rem', padding: '1px 8px', borderRadius: 99,
            background: '#1a3a1a', color: '#4ade80', fontWeight: 600,
          }}>
            Owner
          </span>
        </div>
      )}

      {/* Other grantees */}
      {otherGrants.length === 0 && !ownerGrant && (
        <p style={{ color: '#555', fontSize: '0.8rem', margin: '0 0 8px' }}>
          No one else has access yet.
        </p>
      )}
      {otherGrants.length === 0 && ownerGrant && (
        <p style={{ color: '#555', fontSize: '0.8rem', margin: '4px 0 8px' }}>
          No one else has access yet.
        </p>
      )}

      {otherGrants.map(grant => (
        <div key={grant.id} style={chipStyle(false)}>
          <span style={{ color: '#e5e5e5', fontSize: '0.8rem', flex: 1 }}>
            {grant.subject_id}
          </span>
          <select
            value={labelForAction(grant.action)}
            onChange={async e => {
              const newAction = LABEL_TO_ACTION[e.target.value] ?? grant.action
              try {
                await deleteConnectorGrant(workspaceId, connectorId, grant.id)
                const updated = await createConnectorGrant(workspaceId, connectorId, {
                  subject_type: grant.subject_type,
                  subject_id: grant.subject_id,
                  action: newAction,
                })
                setGrants(prev => prev.map(g => g.id === grant.id ? updated : g))
              } catch { /* silent */ }
            }}
            style={{
              background: '#1e1e1e', border: '1px solid #333', borderRadius: 4,
              color: '#ccc', fontSize: '0.75rem', padding: '2px 4px',
            }}
          >
            {Object.entries(ACTION_TO_LABEL).map(([action, label]) => {
              const level = ACTION_LEVEL[action] ?? 1
              const disabled = !isAdmin && level > myLevel
              return (
                <option key={action} value={label} disabled={disabled}>
                  {label}
                </option>
              )
            })}
          </select>
          <button
            aria-label="Remove"
            onClick={() => handleRemove(grant)}
            disabled={deletingId === grant.id}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#888', fontSize: '1rem', lineHeight: 1, padding: '0 2px',
            }}
          >
            ×
          </button>
        </div>
      ))}

      {/* Add person */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={addInput}
          onChange={e => setAddInput(e.target.value)}
          placeholder="Add a person (enter their email or ID)"
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          style={{
            flex: 1, minWidth: 160,
            background: '#1e1e1e', border: '1px solid #333', borderRadius: 6,
            color: '#e5e5e5', fontSize: '0.8rem', padding: '6px 10px', outline: 'none',
          }}
        />
        <select
          value={addRole}
          onChange={e => setAddRole(e.target.value)}
          style={{
            background: '#1e1e1e', border: '1px solid #333', borderRadius: 6,
            color: '#ccc', fontSize: '0.8rem', padding: '6px 8px',
          }}
        >
          <option value="Can view data">Can view data</option>
          <option value="Can view and edit data">Can view and edit data</option>
        </select>
        <button
          onClick={handleAdd}
          disabled={adding || !addInput.trim()}
          style={{
            padding: '6px 14px', background: '#2563eb', color: '#fff',
            border: 'none', borderRadius: 6, fontWeight: 600,
            fontSize: '0.8rem', cursor: 'pointer',
          }}
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>
      {addError && (
        <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '4px 0 0' }}>{addError}</p>
      )}

      {/* Admin toggle */}
      {isAdmin && (
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
          color: '#888', fontSize: '0.8rem', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={restrictReadOnly}
            onChange={e => setRestrictReadOnly(e.target.checked)}
            data-testid="restrict-toggle"
          />
          Restrict to read-only for everyone
        </label>
      )}
    </div>
  )
}
