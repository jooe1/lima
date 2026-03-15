'use client'

import { useEffect, useState } from 'react'
import { listAppVersions, rollbackApp, type AppVersion } from '../../../lib/api'

interface Props {
  workspaceId: string
  appId: string
  currentStatus: string
  onRollback: () => void
  onClose: () => void
}

export function VersionHistory({ workspaceId, appId, currentStatus, onRollback, onClose }: Props) {
  const [versions, setVersions] = useState<AppVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [rollingBack, setRollingBack] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    listAppVersions(workspaceId, appId)
      .then(res => setVersions(res.versions))
      .catch(() => setError('Failed to load version history'))
      .finally(() => setLoading(false))
  }, [workspaceId, appId])

  async function handleRollback(versionNum: number) {
    if (rollingBack != null) return
    setRollingBack(versionNum)
    setError('')
    try {
      await rollbackApp(workspaceId, appId, versionNum)
      onRollback()
      onClose()
    } catch {
      setError(`Failed to roll back to v${versionNum}`)
      setRollingBack(null)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: 340,
          height: '100vh',
          background: '#0d0d0d',
          borderLeft: '1px solid #1e1e1e',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.875rem 1rem', borderBottom: '1px solid #1e1e1e', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#e5e5e5' }}>Version History</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: 4 }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0.75rem' }}>
          {loading && (
            <p style={{ color: '#555', fontSize: '0.8rem', textAlign: 'center', padding: '2rem 0' }}>Loading…</p>
          )}
          {!loading && versions.length === 0 && (
            <p style={{ color: '#444', fontSize: '0.8rem', textAlign: 'center', padding: '2rem 0' }}>
              No published versions yet.
            </p>
          )}
          {error && (
            <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0 0 0.75rem' }}>{error}</p>
          )}
          {versions.map(v => (
            <VersionRow
              key={v.id}
              version={v}
              isLatest={v.version_num === versions[0]?.version_num}
              onRollback={handleRollback}
              rollingBack={rollingBack}
            />
          ))}
        </div>

        {/* Footer note */}
        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #1e1e1e', flexShrink: 0 }}>
          <p style={{ margin: 0, color: '#444', fontSize: '0.7rem', lineHeight: 1.4 }}>
            Rolling back restores the draft to the selected version. The app must be re-published by an admin before end users see the change.
          </p>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  version: AppVersion
  isLatest: boolean
  onRollback: (v: number) => void
  rollingBack: number | null
}

function VersionRow({ version, isLatest, onRollback, rollingBack }: RowProps) {
  const date = new Date(version.published_at)
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const busy = rollingBack != null

  return (
    <div style={{
      borderRadius: 6,
      border: '1px solid #1e1e1e',
      padding: '0.625rem 0.75rem',
      marginBottom: '0.5rem',
      background: '#0f0f0f',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#e5e5e5' }}>v{version.version_num}</span>
        {isLatest && (
          <span style={{
            fontSize: '0.6rem', padding: '1px 6px', borderRadius: 99,
            background: '#16653433', color: '#4ade80',
          }}>latest</span>
        )}
      </div>
      <p style={{ margin: '0 0 0.5rem', color: '#666', fontSize: '0.7rem' }}>
        {dateStr} at {timeStr}
      </p>
      <p style={{ margin: '0 0 0.5rem', color: '#444', fontSize: '0.7rem', fontFamily: 'monospace' }}>
        by {version.published_by.slice(0, 8)}…
      </p>
      {!isLatest && (
        <button
          onClick={() => onRollback(version.version_num)}
          disabled={busy}
          style={{
            background: 'none', border: '1px solid #333', borderRadius: 4,
            color: busy ? '#333' : '#888', cursor: busy ? 'default' : 'pointer',
            fontSize: '0.7rem', padding: '3px 10px',
          }}
        >
          {rollingBack === version.version_num ? 'Rolling back…' : 'Restore this version'}
        </button>
      )}
    </div>
  )
}
