'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { parse } from '@lima/aura-dsl'
import { useAuth } from '../../../lib/auth'
import { getPublishedApp, type AppVersion, ApiError } from '../../../lib/api'
import { RuntimeRenderer } from './RuntimeRenderer'

function BlockedScreen({ title, body, ctaHref, ctaLabel }: { title: string; body: string; ctaHref: string; ctaLabel: string }) {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg, #0a0a0a)', gap: '1rem', padding: '2rem', textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--color-text, #e5e5e5)', fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>{title}</h1>
      <p style={{ color: 'var(--color-text-muted, #888)', fontSize: '0.875rem', margin: 0, lineHeight: 1.6 }}>{body}</p>
      <a href={ctaHref} style={{ marginTop: '0.5rem', color: 'var(--color-primary, #2563eb)', fontSize: '0.875rem', textDecoration: 'none' }}>{ctaLabel}</a>
    </div>
  )
}

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
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg, #0a0a0a)', color: 'var(--color-text-muted, #555)', fontSize: '0.875rem' }}>
        Loading your tool…
      </div>
    )
  }

  if (error === 'workspace_unavailable') {
    return (
      <BlockedScreen
        title="Can't load this tool right now"
        body="The team workspace this tool belongs to isn't available in your current session. Try opening it from your tools page, which should automatically connect the right workspace."
        ctaHref="/tools"
        ctaLabel="Go to Your Tools"
      />
    )
  }

  if (error === 'not_published') {
    return (
      <BlockedScreen
        title="This tool isn't live yet"
        body="The tool hasn't been published to a live audience. If you're the builder, publish it first from the editor."
        ctaHref="/tools"
        ctaLabel="Back to Tools"
      />
    )
  }

  if (error === 'access_denied') {
    return (
      <BlockedScreen
        title="You can see this tool, but can't open it yet"
        body="Your access to this tool lets you know it exists, but doesn't include permission to open it. Contact your team administrator to request access."
        ctaHref="/tools"
        ctaLabel="Back to Your Tools"
      />
    )
  }

  if (error || !version) {
    return (
      <BlockedScreen
        title="Something went wrong loading this tool"
        body="We couldn't load the tool this time. Try refreshing the page. If the problem persists, contact your team."
        ctaHref="/tools"
        ctaLabel="Back to Your Tools"
      />
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
        <span style={{ color: 'var(--color-text, #e5e5e5)', fontWeight: 600, fontSize: '0.875rem' }}>
          Tool
        </span>
        <span style={{
          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
          background: '#16653433', color: '#4ade80',
        }}>
          v{version.version_num}
        </span>
        <div style={{ flex: 1 }} />
      </header>

      {/* Canvas */}
      <RuntimeRenderer doc={doc} workspaceId={activeWorkspaceId} appId={appId} />
    </div>
  )
}

