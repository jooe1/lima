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
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  // 'inspector' | 'chat' | 'workflows' — controls the right-hand panel
  const [rightPanel, setRightPanel] = useState<'inspector' | 'chat' | 'workflows'>('inspector')
  // nodeMetadata tracks which nodes were manually edited; persisted as JSONB
  const [nodeMetadata, setNodeMetadata] = useState<Record<string, { manuallyEdited: boolean }>>({})

  const history = useDocumentHistory()

  function hydrateLoadedApp(nextApp: App) {
    setApp(nextApp)
    setNodeMetadata(nextApp.node_metadata ?? {})

    if (!nextApp.dsl_source) {
      setLoadError('')
      history.reset([])
      return
    }

    try {
      history.reset(parse(nextApp.dsl_source))
      setLoadError('')
    } catch (error: unknown) {
      console.error(`Failed to parse saved DSL for app ${nextApp.id}`, error)
      setLoadError(error instanceof Error ? `Failed to load saved DSL: ${error.message}` : 'Failed to load saved DSL')
    }
  }

  // Load app and seed history
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    getApp(workspace.id, appId)
      .then(a => {
        if (cancelled) return
        hydrateLoadedApp(a)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : 'Failed to load app')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspace, appId]) // eslint-disable-line react-hooks/exhaustive-deps
  // (history.reset is stable — omitting to avoid loop)

  // Helper: mark a set of node IDs as manually edited in local metadata state
  const markManual = useCallback((ids: string[]) => {
    setNodeMetadata(prev => {
      const next = { ...prev }
      for (const id of ids) next[id] = { manuallyEdited: true }
      return next
    })
  }, [])

  // Autosave — only fires once workspace + app are loaded
  const saveFn = useCallback(
    async (source: string, meta: Record<string, { manuallyEdited: boolean }>) => {
      if (!workspace) return
      await patchApp(workspace.id, appId, { dsl_source: source, node_metadata: meta })
    },
    [workspace, appId],
  )
  const { saving, savedAt } = useAutosave(history.doc, nodeMetadata, app && loadError === '' ? saveFn : undefined)

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
    setLoadError('')
    history.set([...history.doc, newNode])
    setSelectedId(newId)
    markManual([newId])
  }, [history, markManual])

  // Delete widget
  const handleDeleteWidget = useCallback((id: string) => {
    setLoadError('')
    history.set(history.doc.filter(n => n.id !== id))
    if (selectedId === id) setSelectedId(null)
    setNodeMetadata(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [history, selectedId])

  // Update node props (from inspector)
  const handleUpdateNode = useCallback((updated: AuraNode) => {
    setLoadError('')
    history.set(history.doc.map(n => n.id === updated.id ? updated : n))
    markManual([updated.id])
  }, [history, markManual])

  // Canvas drag/resize changes — detect which nodes moved/resized and mark them
  const handleCanvasChange = useCallback((newDoc: AuraDocument) => {
    const oldDoc = history.doc
    const changedIds: string[] = []
    for (const newNode of newDoc) {
      const oldNode = oldDoc.find(n => n.id === newNode.id)
      if (
        !oldNode ||
        oldNode.style?.gridX !== newNode.style?.gridX ||
        oldNode.style?.gridY !== newNode.style?.gridY ||
        oldNode.style?.gridW !== newNode.style?.gridW ||
        oldNode.style?.gridH !== newNode.style?.gridH
      ) {
        changedIds.push(newNode.id)
      }
    }
    setLoadError('')
    if (changedIds.length > 0) markManual(changedIds)
    history.set(newDoc)
  }, [history, markManual])

  // Publish
  const handlePublish = async () => {
    if (!workspace || publishing || loadError) return
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

        {/* Draft preview — always available to builders; opens current DSL */}
        <Link
          href={`/builder/${appId}/preview`}
          target="_blank"
          rel="noopener noreferrer"
          title="Preview draft"
          style={{
            ...iconBtn(true),
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ⊙
        </Link>

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
        {loadError && (
          <span style={{ fontSize: '0.65rem', color: '#f87171' }}>{loadError}</span>
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
          disabled={publishing || !!loadError}
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
                try {
                  setLoadError('')
                  history.set(parse(src))
                } catch {
                  /* ignore invalid DSL */
                }
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
            // Reload the app so the DSL and node_metadata are refreshed after rollback
            getApp(workspace.id, appId).then(a => {
              hydrateLoadedApp(a)
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

