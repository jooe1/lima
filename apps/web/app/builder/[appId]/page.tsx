'use client'

import { use, useEffect, useState } from 'react'
import { useAuth } from '../../../lib/auth'
import { getApp, type App } from '../../../lib/api'

/**
 * Canvas editor for a specific app draft.
 * Phase 2 will render the infinite canvas, chat panel, and inspector.
 */
export default function AppEditorPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const { workspace } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!workspace) return
    getApp(workspace.id, appId)
      .then(setApp)
      .catch(() => setApp(null))
      .finally(() => setLoading(false))
  }, [workspace, appId])

  if (loading) return null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* App header bar */}
      <header style={{
        height: 48, borderBottom: '1px solid #1f1f1f', display: 'flex',
        alignItems: 'center', padding: '0 1.25rem', gap: 12, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, color: '#e5e5e5', fontSize: '0.9rem' }}>
          {app?.name ?? appId}
        </span>
        {app && (
          <span style={{
            fontSize: '0.7rem', padding: '2px 8px', borderRadius: 99,
            background: app.status === 'published' ? '#16653433' : '#854d0e33',
            color: app.status === 'published' ? '#4ade80' : '#fbbf24',
          }}>
            {app.status}
          </span>
        )}
      </header>

      {/* Canvas placeholder — Phase 2 */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '0.9rem', marginBottom: 8 }}>Canvas — Phase 2</p>
          <p style={{ fontSize: '0.75rem', color: '#2a2a2a' }}>
            DSL source: {app?.dsl_source ? `${app.dsl_source.length} chars` : 'empty'}
          </p>
        </div>
      </div>
    </div>
  )
}

