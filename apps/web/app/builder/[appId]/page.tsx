'use client'

import React, { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { parse, serialize, type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { useAuth } from '../../../lib/auth'
import { getApp, patchApp, publishApp, type App } from '../../../lib/api'
import { useDocumentHistory } from './hooks/useDocumentHistory'
import { useAutosave } from './hooks/useAutosave'
import { CanvasEditor } from './CanvasEditor'
import { ChatPanel } from './ChatPanel'
import { Inspector } from './Inspector'
import { LayersPanel } from './LayersPanel'
import { VersionHistory } from './VersionHistory'
import { WorkflowEditor } from './WorkflowEditor'

export default function AppEditorPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const { workspace } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  // 'inspector' | 'chat' | 'workflows' — controls the right-hand panel
  const [rightPanel, setRightPanel] = useState<'inspector' | 'chat' | 'workflows'>('inspector')

  const history = useDocumentHistory()

  // Load app and seed history
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    setLoading(true)
    getApp(workspace.id, appId)
      .then(a => {
        if (cancelled) return
        setApp(a)
        try {
          history.reset(a.dsl_source ? parse(a.dsl_source) : [])
        } catch {
          history.reset([])
        }
      })
      .catch(() => { if (!cancelled) history.reset([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspace, appId]) // eslint-disable-line react-hooks/exhaustive-deps
  // (history.reset is stable — omitting to avoid loop)

  // Autosave — only fires once workspace + app are loaded
  const saveFn = useCallback(
    async (source: string) => {
      if (!workspace) return
      await patchApp(workspace.id, appId, { dsl_source: source })
    },
    [workspace, appId],
  )
  const { saving, savedAt } = useAutosave(history.doc, app ? saveFn : undefined)

  // Keyboard shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo() }
      if (e.key === 'z' && e.shiftKey)  { e.preventDefault(); history.redo() }
      if (e.key === 'y')                 { e.preventDefault(); history.redo() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [history.undo, history.redo])

  // Add widget to canvas
  const handleAddWidget = useCallback((element: string) => {
    const meta = WIDGET_REGISTRY[element as WidgetType]
    const dw = meta?.defaultSize.w ?? 4
    const dh = meta?.defaultSize.h ?? 3

    let maxBottom = 0
    for (const n of history.doc) {
      const s = n.style ?? {}
      const y = parseInt(s.gridY ?? '0', 10) || 0
      const h = parseInt(s.gridH ?? String(dh), 10) || dh
      maxBottom = Math.max(maxBottom, y + h)
    }

    const existingCount = history.doc.filter(n => n.element === element).length
    const newId = `${element}${existingCount + 1}`

    const newNode: AuraNode = {
      element,
      id: newId,
      parentId: 'root',
      style: {
        gridX: '0',
        gridY: String(maxBottom),
        gridW: String(dw),
        gridH: String(dh),
      },
    }
    history.set([...history.doc, newNode])
    setSelectedId(newId)
  }, [history])

  // Delete widget
  const handleDeleteWidget = useCallback((id: string) => {
    history.set(history.doc.filter(n => n.id !== id))
    if (selectedId === id) setSelectedId(null)
  }, [history, selectedId])

  // Update node props (from inspector)
  const handleUpdateNode = useCallback((updated: AuraNode) => {
    history.set(history.doc.map(n => n.id === updated.id ? updated : n))
  }, [history])

  // Canvas drag/resize changes
  const handleCanvasChange = useCallback((newDoc: AuraDocument) => {
    history.set(newDoc)
  }, [history])

  // Publish
  const handlePublish = async () => {
    if (!workspace || publishing) return
    setPublishing(true)
    setPublishError('')
    try {
      // Flush any pending autosave first
      const source = serialize(history.doc)
      await patchApp(workspace.id, appId, { dsl_source: source })
      await publishApp(workspace.id, appId)
      setApp(prev => prev ? { ...prev, status: 'published' } : prev)
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  const selectedNode = history.doc.find(n => n.id === selectedId) ?? null

  if (loading) return null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>

      {/* ── Header ── */}
      <header style={{
        height: 48,
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        padding: '0 1rem',
        gap: 10,
        flexShrink: 0,
        background: '#0a0a0a',
      }}>
        {/* App name + status */}
        <span style={{ fontWeight: 600, color: '#e5e5e5', fontSize: '0.875rem' }}>
          {app?.name ?? appId}
        </span>
        {app && (
          <span style={{
            fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99, flexShrink: 0,
            background: app.status === 'published' ? '#16653433' : '#854d0e33',
            color: app.status === 'published' ? '#4ade80' : '#fbbf24',
          }}>
            {app.status}
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Undo / Redo */}
        <button
          onClick={() => history.undo()}
          disabled={!history.canUndo}
          title="Undo (Ctrl+Z)"
          style={iconBtn(history.canUndo)}
        >
          ↩
        </button>
        <button
          onClick={() => history.redo()}
          disabled={!history.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          style={iconBtn(history.canRedo)}
        >
          ↪
        </button>

        {/* Save indicator */}
        <span style={{ fontSize: '0.65rem', color: '#333', minWidth: 60, textAlign: 'right' }}>
          {saving
            ? 'Saving…'
            : savedAt
              ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''}
        </span>

        {/* Version history */}
        <button
          onClick={() => setShowVersionHistory(true)}
          title="Version history"
          style={iconBtn(true)}
        >
          ⏱
        </button>

        {/* Preview link — only available once published */}
        {app?.status === 'published' && (
          <Link
            href={`/app/${appId}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open published app"
            style={{
              ...iconBtn(true),
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ↗
          </Link>
        )}

        {/* Publish */}
        {publishError && (
          <span style={{ fontSize: '0.65rem', color: '#f87171' }}>{publishError}</span>
        )}

        {/* Right-panel toggles */}
        <button
          onClick={() => setRightPanel('inspector')}
          title="Inspector"
          style={{ ...iconBtn(true), background: rightPanel === 'inspector' ? '#161616' : 'transparent', borderColor: rightPanel === 'inspector' ? '#333' : '#1e1e1e' }}
        >
          ⚙
        </button>
        <button
          onClick={() => setRightPanel('chat')}
          title="AI Chat"
          style={{ ...iconBtn(true), background: rightPanel === 'chat' ? '#161616' : 'transparent', borderColor: rightPanel === 'chat' ? '#333' : '#1e1e1e' }}
        >
          💬
        </button>
        <button
          onClick={() => setRightPanel('workflows')}
          title="Workflows"
          style={{ ...iconBtn(true), background: rightPanel === 'workflows' ? '#161616' : 'transparent', borderColor: rightPanel === 'workflows' ? '#333' : '#1e1e1e' }}
        >
          ⚡
        </button>

        <button
          onClick={handlePublish}
          disabled={publishing}
          style={{
            padding: '5px 14px',
            borderRadius: 4,
            fontSize: '0.75rem',
            fontWeight: 600,
            background: publishing ? '#1e3a8a66' : '#1d4ed8',
            border: 'none',
            color: publishing ? '#93c5fd66' : '#fff',
            cursor: publishing ? 'default' : 'pointer',
          }}
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
      </header>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <LayersPanel
          doc={history.doc}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAddWidget}
          onDelete={handleDeleteWidget}
        />
        <CanvasEditor
          doc={history.doc}
          selectedId={selectedId}
          onChange={handleCanvasChange}
          onSelect={setSelectedId}
        />
        {/* Right panel: Inspector, AI Chat, or Workflows */}
        {rightPanel === 'inspector' ? (
          <Inspector
            node={selectedNode}
            doc={history.doc}
            onUpdate={handleUpdateNode}
            onDelete={handleDeleteWidget}
          />
        ) : rightPanel === 'chat' && workspace ? (
          <div style={{ width: 280, flexShrink: 0 }}>
            <ChatPanel
              workspaceId={workspace.id}
              appId={appId}
              onDSLUpdate={src => {
                try { history.set(parse(src)) } catch { /* ignore invalid DSL */ }
              }}
            />
          </div>
        ) : rightPanel === 'workflows' ? (
          <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #1a1a1a', overflow: 'hidden' }}>
            <WorkflowEditor appId={appId} />
          </div>
        ) : null}
      </div>

      {/* Version history drawer */}
      {showVersionHistory && workspace && (
        <VersionHistory
          workspaceId={workspace.id}
          appId={appId}
          currentStatus={app?.status ?? 'draft'}
          onRollback={() => {
            // Reload the app so the DSL is refreshed after rollback
            getApp(workspace.id, appId).then(a => {
              setApp(a)
              try { history.reset(a.dsl_source ? parse(a.dsl_source) : []) } catch { history.reset([]) }
            }).catch(() => {})
          }}
          onClose={() => setShowVersionHistory(false)}
        />
      )}
    </div>
  )
}

function iconBtn(enabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
    color: enabled ? '#888' : '#2a2a2a',
    cursor: enabled ? 'pointer' : 'default',
    width: 28,
    height: 28,
    fontSize: '0.85rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}

