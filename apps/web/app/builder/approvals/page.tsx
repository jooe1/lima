'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '../../../lib/auth'
import { listApprovals, approveAction, rejectAction, type Approval } from '../../../lib/api'

type ApprovalFilter = 'all' | 'pending' | 'approved' | 'rejected'

function parseApprovalFilter(value: string | null): ApprovalFilter | null {
  if (value === 'all' || value === 'pending' || value === 'approved' || value === 'rejected') {
    return value
  }

  return null
}

export default function ApprovalsPage() {
  const searchParams = useSearchParams()
  const linkedApprovalId = searchParams.get('approval') ?? ''
  const requestedFilter = parseApprovalFilter(searchParams.get('filter'))
  const { workspace, user } = useAuth()
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ApprovalFilter>(() => requestedFilter ?? (linkedApprovalId ? 'all' : 'pending'))
  const [error, setError] = useState('')

  const isAdmin = user?.role === 'workspace_admin'

  useEffect(() => {
    const nextFilter = requestedFilter ?? (linkedApprovalId ? 'all' : 'pending')
    setFilter(prev => prev === nextFilter ? prev : nextFilter)
  }, [requestedFilter, linkedApprovalId])

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    setError('')
    listApprovals(workspace.id, filter === 'all' ? undefined : filter)
      .then(res => setApprovals(res.approvals))
      .catch(() => setError('Failed to load approvals'))
      .finally(() => setLoading(false))
  }, [workspace, filter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!linkedApprovalId || loading) return
    const element = document.getElementById(`approval-${linkedApprovalId}`)
    element?.scrollIntoView({ block: 'center' })
  }, [linkedApprovalId, loading, approvals])

  async function handleApprove(id: string) {
    if (!workspace) return
    try {
      const updated = await approveAction(workspace.id, id)
      setApprovals(prev => prev.map(a => a.id === id ? updated : a))
    } catch {
      setError('Failed to approve')
    }
  }

  async function handleReject(id: string, reason: string) {
    if (!workspace) return
    try {
      const updated = await rejectAction(workspace.id, id, reason || undefined)
      setApprovals(prev => prev.map(a => a.id === id ? updated : a))
    } catch {
      setError('Failed to reject')
    }
  }

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Write Approvals</h1>
        <span style={{ color: '#555', fontSize: '0.75rem' }}>
          Review and approve or reject write operations requested by end users.
        </span>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: '1.25rem', borderBottom: '1px solid #1e1e1e', paddingBottom: '0.75rem' }}>
        {(['pending', 'approved', 'rejected', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? '#1a1a1a' : 'none',
              border: filter === f ? '1px solid #333' : '1px solid transparent',
              borderRadius: 4,
              color: filter === f ? '#e5e5e5' : '#555',
              cursor: 'pointer',
              fontSize: '0.75rem',
              padding: '4px 12px',
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={load}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#555', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 10px' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>
      )}

      {linkedApprovalId && !error && (
        <p style={{ color: '#93c5fd', fontSize: '0.75rem', margin: '0 0 1rem' }}>
          Showing the approval linked from a workflow run.
        </p>
      )}

      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : approvals.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1a1a1a', borderRadius: 8 }}>
          <p style={{ color: '#444', fontSize: '0.875rem', margin: 0 }}>
            {filter === 'pending' ? 'No pending approvals.' : `No ${filter} approvals.`}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {approvals.map(a => (
            <ApprovalRow
              key={a.id}
              approval={a}
              highlighted={a.id === linkedApprovalId}
              isAdmin={isAdmin}
              onApprove={() => handleApprove(a.id)}
              onReject={(reason) => handleReject(a.id, reason)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface RowProps {
  approval: Approval
  highlighted: boolean
  isAdmin: boolean
  onApprove: () => void
  onReject: (reason: string) => void
}

function ApprovalRow({ approval, highlighted, isAdmin, onApprove, onReject }: RowProps) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const statusColor =
    approval.status === 'pending' ? '#fbbf24'
    : approval.status === 'approved' ? '#4ade80'
    : '#f87171'

  const statusBg =
    approval.status === 'pending' ? '#854d0e33'
    : approval.status === 'approved' ? '#16653433'
    : '#450a0a33'

  async function doApprove() {
    setBusy(true)
    await onApprove()
    setBusy(false)
  }

  async function doReject() {
    setBusy(true)
    await onReject(reason)
    setBusy(false)
    setRejecting(false)
    setReason('')
  }

  const createdAt = new Date(approval.created_at)
  const dateStr = createdAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timeStr = createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div id={`approval-${approval.id}`} style={{
      border: highlighted ? '1px solid #2563eb' : '1px solid #1e1e1e',
      borderRadius: 6,
      background: highlighted ? '#0f172a55' : '#0d0d0d',
      boxShadow: highlighted ? '0 0 0 1px #1d4ed833' : 'none',
      padding: '0.75rem 1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
              background: statusBg, color: statusColor,
            }}>
              {approval.status}
            </span>
            {approval.app_id && (
              <span style={{ color: '#555', fontSize: '0.7rem', fontFamily: 'monospace' }}>
                app:{approval.app_id.slice(0, 8)}
              </span>
            )}
            <span style={{ color: '#333', fontSize: '0.7rem', marginLeft: 'auto' }}>
              {dateStr} at {timeStr}
            </span>
            {highlighted && (
              <span style={{ color: '#93c5fd', fontSize: '0.65rem' }}>Linked run</span>
            )}
          </div>
          <p style={{ margin: '0 0 0.25rem', color: '#ccc', fontSize: '0.8rem' }}>{approval.description}</p>
          <p style={{ margin: 0, color: '#444', fontSize: '0.7rem' }}>
            Requested by {approval.requested_by.slice(0, 8)}…
          </p>
          {approval.rejection_reason && (
            <p style={{ margin: '0.25rem 0 0', color: '#f87171', fontSize: '0.7rem' }}>
              Reason: {approval.rejection_reason}
            </p>
          )}
        </div>

        {/* Action buttons — admin only, pending only */}
        {isAdmin && approval.status === 'pending' && !rejecting && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              onClick={doApprove}
              disabled={busy}
              style={{
                background: '#166534', border: 'none', borderRadius: 4,
                color: busy ? '#166534' : '#4ade80', cursor: busy ? 'default' : 'pointer',
                fontSize: '0.75rem', fontWeight: 500, padding: '4px 12px',
              }}
            >
              Approve
            </button>
            <button
              onClick={() => setRejecting(true)}
              disabled={busy}
              style={{
                background: 'none', border: '1px solid #333', borderRadius: 4,
                color: busy ? '#333' : '#888', cursor: busy ? 'default' : 'pointer',
                fontSize: '0.75rem', padding: '4px 12px',
              }}
            >
              Reject
            </button>
          </div>
        )}
      </div>

      {/* Reject reason input */}
      {rejecting && (
        <div style={{ marginTop: '0.75rem', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (optional)"
            autoFocus
            style={{
              flex: 1, background: '#141414', border: '1px solid #2a2a2a',
              borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem', padding: '0.35rem 0.5rem',
            }}
          />
          <button
            onClick={doReject}
            disabled={busy}
            style={{
              background: '#7f1d1d', border: 'none', borderRadius: 4,
              color: '#fca5a5', cursor: busy ? 'default' : 'pointer',
              fontSize: '0.75rem', fontWeight: 500, padding: '4px 12px',
            }}
          >
            {busy ? 'Rejecting…' : 'Confirm reject'}
          </button>
          <button
            onClick={() => { setRejecting(false); setReason('') }}
            style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#555', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 10px' }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
