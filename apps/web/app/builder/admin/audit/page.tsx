'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../../lib/auth'
import { listAuditEvents, exportAuditEventsCSV, type AuditEvent } from '../../../../lib/api'

function defaultSince() {
  return new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
}

export default function AuditPage() {
  const { workspace } = useAuth()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [limit, setLimit] = useState(50)
  const [since, setSince] = useState(defaultSince)
  const [until, setUntil] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    setError('')
    listAuditEvents(workspace.id, limit)
      .then(res => setEvents(res.events))
      .catch(() => setError('Failed to load audit events'))
      .finally(() => setLoading(false))
  }, [workspace, limit])

  useEffect(() => { load() }, [load])

  const handleExport = async () => {
    if (!workspace) return
    setExporting(true)
    try {
      const blob = await exportAuditEventsCSV(workspace.id, since, until || undefined)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-${workspace.id.slice(0, 8)}-${since}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `${date} ${time}`
  }

  const truncate = (s: string | undefined, len = 12) =>
    s ? (s.length > len ? s.slice(0, len) + '…' : s) : '—'

  const btnStyle: React.CSSProperties = {
    background: 'none', border: '1px solid #1e1e1e', borderRadius: 4,
    color: '#555', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 10px',
  }

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Audit Log</h1>
        <span style={{ color: '#555', fontSize: '0.75rem' }}>
          View workspace activity and export records.
        </span>
      </div>

      {/* Controls row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid #1e1e1e', paddingBottom: '0.75rem', flexWrap: 'wrap' }}>
        <label style={{ color: '#555', fontSize: '0.75rem' }}>
          Since
          <input
            type="date"
            value={since}
            onChange={e => setSince(e.target.value)}
            style={{ marginLeft: 4, background: '#0d0d0d', border: '1px solid #333', borderRadius: 4, color: '#e5e5e5', fontSize: '0.75rem', padding: '3px 6px' }}
          />
        </label>
        <label style={{ color: '#555', fontSize: '0.75rem' }}>
          Until
          <input
            type="date"
            value={until}
            onChange={e => setUntil(e.target.value)}
            style={{ marginLeft: 4, background: '#0d0d0d', border: '1px solid #333', borderRadius: 4, color: '#e5e5e5', fontSize: '0.75rem', padding: '3px 6px' }}
          />
        </label>
        <button onClick={handleExport} disabled={exporting} style={{ ...btnStyle, color: exporting ? '#333' : '#555' }}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={btnStyle}>Refresh</button>
      </div>

      {error && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : events.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid #1a1a1a', borderRadius: 8 }}>
          <p style={{ color: '#444', fontSize: '0.875rem', margin: 0 }}>No audit events found.</p>
        </div>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1e1e1e' }}>
                {['Timestamp', 'Event Type', 'Actor', 'Resource Type', 'Resource ID'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: '#555', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map(ev => (
                <tr key={ev.id} style={{ borderBottom: '1px solid #111' }}>
                  <td style={{ padding: '6px 8px', color: '#888', whiteSpace: 'nowrap' }}>{fmtTime(ev.created_at)}</td>
                  <td style={{ padding: '6px 8px', color: '#ccc', fontFamily: 'monospace' }}>{ev.event_type}</td>
                  <td style={{ padding: '6px 8px', color: '#888', fontFamily: 'monospace' }}>{truncate(ev.actor_id, 12)}</td>
                  <td style={{ padding: '6px 8px', color: '#888' }}>{ev.resource_type ?? '—'}</td>
                  <td style={{ padding: '6px 8px', color: '#888', fontFamily: 'monospace' }}>{truncate(ev.resource_id, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button
              onClick={() => setLimit(prev => prev + 50)}
              style={btnStyle}
            >
              Load more
            </button>
          </div>
        </>
      )}
    </div>
  )
}
