'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { parse } from '@lima/aura-dsl'
import { useAuth } from '../../../lib/auth'
import { getPublishedApp, type AppVersion, ApiError } from '../../../lib/api'
import { RuntimeRenderer } from './RuntimeRenderer'

export default function RuntimeAppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const searchParams = useSearchParams()
  const requestedWorkspaceId = searchParams.get('workspace')
  const requestedPublicationId = searchParams.get('publication') ?? undefined
  const { workspace, workspaces, selectWorkspace, token, isLoading: authLoading } = useAuth()

  const [version, setVersion] = useState<AppVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const activeWorkspace = useMemo(() => {
    if (requestedWorkspaceId) {
      return workspaces.find(candidate => candidate.id === requestedWorkspaceId)
        ?? (workspace?.id === requestedWorkspaceId ? workspace : null)
    }

    return workspace
  }, [requestedWorkspaceId, workspace, workspaces])

  const activeWorkspaceId = activeWorkspace?.id ?? ''

  useEffect(() => {
    if (authLoading || !requestedWorkspaceId || !activeWorkspace) return
    if (workspace?.id === activeWorkspace.id) return

    selectWorkspace(activeWorkspace)
  }, [activeWorkspace, authLoading, requestedWorkspaceId, selectWorkspace, workspace])

  useEffect(() => {
    if (authLoading) return
    if (!activeWorkspaceId) {
      setVersion(null)
      setError('workspace_unavailable')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setVersion(null)

    getPublishedApp(activeWorkspaceId, appId, requestedPublicationId ? { publicationId: requestedPublicationId } : undefined)
      .then(v => {
        if (!cancelled) setVersion(v)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError) {
          if (e.status === 403) {
            setError('access_denied')
            return
          }
          if (e.status === 404) {
            setError('not_published')
            return
          }
        }
        setError('load_failed')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [activeWorkspaceId, appId, authLoading, requestedPublicationId])

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

  if (error === 'workspace_unavailable') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', gap: '0.75rem' }}>
        <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>The workspace for this app is not available in your session.</p>
        <p style={{ color: '#333', fontSize: '0.75rem', margin: 0 }}>Open the app from Your Tools so Lima can select the correct workspace automatically.</p>
        <a href="/tools" style={{ marginTop: '0.5rem', color: '#1d4ed8', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to tools</a>
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

  if (error === 'access_denied') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', gap: '0.75rem' }}>
        <p style={{ color: '#555', fontSize: '0.875rem', margin: 0 }}>This app is listed for discovery only.</p>
        <p style={{ color: '#333', fontSize: '0.75rem', margin: 0 }}>Your publication access does not include launch permission.</p>
        <a href="/tools" style={{ marginTop: '0.5rem', color: '#1d4ed8', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to tools</a>
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
      <RuntimeRenderer doc={doc} workspaceId={activeWorkspaceId} appId={appId} />
    </div>
  )
}

