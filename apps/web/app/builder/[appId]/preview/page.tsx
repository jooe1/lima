'use client'

import { use, useEffect, useState } from 'react'
import { type AuraDocument, type AuraEdge } from '@lima/aura-dsl'
import { useAuth } from '../../../../lib/auth'
import { previewDraftApp, listConnectors, type App, type Connector, ApiError } from '../../../../lib/api'
import { RuntimeRenderer } from '../../../app/[appId]/RuntimeRenderer'
import { normalizeAssistantDSL } from '../assistantDSL'

export default function DraftPreviewPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const { workspace, token, isLoading: authLoading } = useAuth()

  const [app, setApp] = useState<App | null>(null)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading) return
    if (!workspace) return

    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      previewDraftApp(workspace.id, appId),
      listConnectors(workspace.id).catch(() => ({ connectors: [] as Connector[] })),
    ])
      .then(([a, connectorResult]) => {
        if (cancelled) return
        setApp(a)
        setConnectors(connectorResult.connectors ?? [])
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 403) {
          setError('forbidden')
        } else if (e instanceof ApiError && e.status === 404) {
          setError('not_found')
        } else {
          setError('load_failed')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [authLoading, workspace, appId])

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

  if (error === 'forbidden') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', gap: '0.75rem' }}>
        <p style={{ color: '#f87171', fontSize: '0.875rem', margin: 0 }}>You do not have permission to preview this draft.</p>
        <a href="/builder" style={{ marginTop: '0.5rem', color: '#1d4ed8', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to builder</a>
      </div>
    )
  }

  if (error || !app) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#f87171', fontSize: '0.875rem' }}>
        Failed to load draft.
      </div>
    )
  }

  let doc: AuraDocument = []
  let edges: AuraEdge[] = []
  try {
    if (app.dsl_source) {
      const normalized = normalizeAssistantDSL(app.dsl_source, app.dsl_edges, { connectors })
      doc = normalized.document.nodes
      edges = normalized.edges
    }
  } catch {
    doc = []
    edges = []
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
          {app.name}
        </span>
        <span style={{
          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
          background: '#854d0e33', color: '#fbbf24',
        }}>
          draft preview
        </span>
        <div style={{ flex: 1 }} />
        <a
          href={`/builder/${appId}`}
          style={{ color: '#555', fontSize: '0.75rem', textDecoration: 'none' }}
        >
          ← Back to editor
        </a>
      </header>
      <RuntimeRenderer doc={doc} edges={edges} workspaceId={workspace!.id} appId={appId} />
    </div>
  )
}
