'use client'

import { use, useEffect, useState } from 'react'
import { parse } from '@lima/aura-dsl'
import { useAuth } from '../../../lib/auth'
import { getPublishedApp, type AppVersion, ApiError } from '../../../lib/api'
import { RuntimeRenderer } from './RuntimeRenderer'

export default function RuntimeAppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const { workspace, token, isLoading: authLoading } = useAuth()

  const [version, setVersion] = useState<AppVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading) return
    if (!workspace) return

    let cancelled = false
    setLoading(true)
    setError(null)

    getPublishedApp(workspace.id, appId)
      .then(v => {
        if (!cancelled) setVersion(v)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 404) {
          setError('not_published')
        } else {
          setError('load_failed')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [authLoading, workspace, appId])

  // Redirect to login if not authenticated
  if (!authLoading && !token) {
    if (typeof window !== 'undefined') window.location.replace('/login')
    return null
  }

  if (authLoading || loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#555', fontSize: '0.875rem' }}>
        Loading…
      </div>
    )
  }

  if (error === 'not_published') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', gap: '0.75rem' }}>
        <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>This app is not published yet.</p>
        <p style={{ color: '#333', fontSize: '0.75rem', margin: 0 }}>An admin must publish the app before it can be used here.</p>
        <a href="/builder" style={{ marginTop: '0.5rem', color: '#1d4ed8', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to builder</a>
      </div>
    )
  }

  if (error || !version) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#f87171', fontSize: '0.875rem' }}>
        Failed to load app.
      </div>
    )
  }

  let doc: import('@lima/aura-dsl').AuraDocument = []
  try {
    doc = version.dsl_source ? parse(version.dsl_source) : []
  } catch {
    doc = []
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Runtime header */}
      <header style={{
        height: 48,
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        padding: '0 1.25rem',
        gap: 10,
        flexShrink: 0,
        background: '#0a0a0a',
      }}>
        <span style={{ color: '#e5e5e5', fontWeight: 600, fontSize: '0.875rem' }}>
          App
        </span>
        <span style={{
          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
          background: '#16653433', color: '#4ade80',
        }}>
          v{version.version_num}
        </span>
        <div style={{ flex: 1 }} />
        <a
          href={`/builder/${appId}`}
          style={{ color: '#555', fontSize: '0.75rem', textDecoration: 'none' }}
        >
          Open in builder →
        </a>
      </header>

      {/* Canvas */}
      <RuntimeRenderer doc={doc} workspaceId={workspace!.id} appId={appId} />
    </div>
  )
}

