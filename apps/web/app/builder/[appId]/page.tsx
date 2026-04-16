'use client'

import React, { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { parseV2, serializeV2, createReactiveStore, type AuraDocumentV2, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { useAuth } from '../../../lib/auth'
import {
  getApp, patchApp, publishApp, deleteApp,
  listCompanyGroups, createPublication,
  listPublications, archivePublication, listPublicationAudiences,
  type App, type AppPublication, type CompanyGroup,
  type PublicationAudience, type PublicationCapability,
} from '../../../lib/api'
import { useDocumentHistory } from './hooks/useDocumentHistory'
import { useAutosave } from './hooks/useAutosave'
import { useAppSSE } from './hooks/useAppSSE'
import { processRunEvent } from './processRunEvent'
import { CanvasEditor } from './CanvasEditor'
import { ChatPanel } from './ChatPanel'
import { FlowCanvas } from './FlowCanvas'
import { Inspector } from './Inspector'
import { StepConfigPanel } from './StepConfigPanel'
import { LayersPanel } from './LayersPanel'
import { StepPalette } from './StepPalette'
import { VersionHistory } from './VersionHistory'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowEditor } from './WorkflowEditor'
import { SplitViewOverlay } from './SplitViewOverlay'
import { WorkflowOverlay } from './WorkflowOverlay'
import { FloatingWorkflowPanel } from './FloatingWorkflowPanel'
import { formatProductionIssues, getAppProductionIssues, getUserFacingProductionIssues } from '../../../lib/appValidation'
import { RouteGateShell } from '../../_components/RouteGateShell'

type PublicationAudienceSelection = PublicationCapability | ''

export type PrimaryEditorAction = 'add-widget' | 'preview' | 'publish'
export type PublishAudienceSelection = 'group' | 'company' | 'discover-only'
export type ToolShareTarget = { type: 'group' | 'company'; id?: string; capability: 'discover' | 'use' }

export default function AppEditorPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  const { workspace, company, user } = useAuth()
  const [app, setApp] = useState<App | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [showPublishDialog, setShowPublishDialog] = useState(false)
  const [publishGroups, setPublishGroups] = useState<CompanyGroup[]>([])
  const [publishGroupsLoading, setPublishGroupsLoading] = useState(false)
  const [publishAudienceSelections, setPublishAudienceSelections] = useState<Record<string, PublicationAudienceSelection>>({})
  const [showPublications, setShowPublications] = useState(false)
  const [publications, setPublications] = useState<AppPublication[]>([])
  const [pubLoading, setPubLoading] = useState(false)
  // 'inspector' | 'chat' — controls the right-hand panel
  const [rightPanel, setRightPanel] = useState<'inspector' | 'chat'>('inspector')
  const [showWorkflowModal, setShowWorkflowModal] = useState(false)
  const [canvasWorkflowId, setCanvasWorkflowId] = useState<string | null>(null)
  const [splitViewWorkflowId, setSplitViewWorkflowId] = useState<string | null>(null)
  const [floatingPanelWorkflowId, setFloatingPanelWorkflowId] = useState<string | null>(null)
  const [highlightedWidgetIds, setHighlightedWidgetIds] = useState<string[]>([])
  // nodeMetadata tracks which nodes were manually edited; persisted as JSONB
  const [nodeMetadata, setNodeMetadata] = useState<Record<string, { manuallyEdited: boolean }>>({})
  const [showAdvancedBuilderControls, setShowAdvancedBuilderControls] = useState(false)
  const [canvasView, setCanvasView] = useState<'layout' | 'flow'>('layout')
  const [showAppSettings, setShowAppSettings] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const history = useDocumentHistory()
  const reactiveStore = useMemo(() => createReactiveStore(), [])

  // SSE event pipeline — wires step_completed outputs to the reactive store
  const { lastEvent: sseLastEvent } = useAppSSE(workspace?.id ?? '', appId, !loading && !loadError)
  const docRef = useRef(history.doc)
  docRef.current = history.doc
  const [runErrorWidgetId, setRunErrorWidgetId] = useState<string | null>(null)
  const errorClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!sseLastEvent || sseLastEvent.type !== 'workflow_run_update') return
    const { triggerNodeId } = processRunEvent(sseLastEvent, docRef.current.edges, reactiveStore)
    if (triggerNodeId) {
      setRunErrorWidgetId(triggerNodeId)
      if (errorClearRef.current) clearTimeout(errorClearRef.current)
      errorClearRef.current = setTimeout(() => setRunErrorWidgetId(null), 5000)
    }
  }, [sseLastEvent]) // eslint-disable-line react-hooks/exhaustive-deps
  // docRef.current and reactiveStore are stable refs — intentionally omitted

  function hydrateLoadedApp(nextApp: App) {
    setApp(nextApp)
    setNodeMetadata(nextApp.node_metadata ?? {})

    if (!nextApp.dsl_source) {
      setLoadError('')
      history.reset({ nodes: [], edges: [] })
      return
    }

    try {
      history.reset(parseV2(nextApp.dsl_source))
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
      if (e.shiftKey && e.key === 'F')   { e.preventDefault(); setCanvasView(v => v === 'layout' ? 'flow' : 'layout') }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [history.undo, history.redo])

  // Add widget to canvas at a specific grid position (from palette drag-to-canvas)
  const handleDropWidget = useCallback((element: string, gridX: number, gridY: number) => {
    const meta = WIDGET_REGISTRY[element as WidgetType]
    const dw = meta?.defaultSize.w ?? 4
    const dh = meta?.defaultSize.h ?? 3
    const existingCount = history.doc.nodes.filter(n => n.element === element).length
    const newId = `${element}${existingCount + 1}`
    const newNode: AuraNode = {
      element,
      id: newId,
      parentId: 'root',
      style: {
        gridX: String(gridX),
        gridY: String(gridY),
        gridW: String(dw),
        gridH: String(dh),
      },
    }
    setLoadError('')
    history.set({ nodes: [...history.doc.nodes, newNode], edges: history.doc.edges })
    setSelectedId(newId)
    markManual([newId])
  }, [history, markManual])

  // Add widget to canvas
  const handleAddWidget = useCallback((element: string) => {
    const meta = WIDGET_REGISTRY[element as WidgetType]
    const dw = meta?.defaultSize.w ?? 4
    const dh = meta?.defaultSize.h ?? 3

    let maxBottom = 0
    for (const n of history.doc.nodes) {
      const s = n.style ?? {}
      const y = parseInt(s.gridY ?? '0', 10) || 0
      const h = parseInt(s.gridH ?? String(dh), 10) || dh
      maxBottom = Math.max(maxBottom, y + h)
    }

    const existingCount = history.doc.nodes.filter(n => n.element === element).length
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
    history.set({ nodes: [...history.doc.nodes, newNode], edges: history.doc.edges })
    setSelectedId(newId)
    markManual([newId])
  }, [history, markManual])

  // Delete widget
  const handleDeleteWidget = useCallback((id: string) => {
    setLoadError('')
    history.set({ nodes: history.doc.nodes.filter(n => n.id !== id), edges: history.doc.edges })
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
    history.set({ nodes: history.doc.nodes.map(n => n.id === updated.id ? updated : n), edges: history.doc.edges })
    markManual([updated.id])
  }, [history, markManual])

  // Canvas drag/resize changes — detect which nodes moved/resized and mark them
  const handleCanvasChange = useCallback((newWidgetNodes: AuraNode[]) => {
    const oldDoc = history.doc.nodes
    const changedIds: string[] = []
    for (const newNode of newWidgetNodes) {
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
    const stepAndGroupNodes = history.doc.nodes.filter(n => n.element.startsWith('step:') || n.element === 'flow:group')
    history.set({ nodes: [...newWidgetNodes, ...stepAndGroupNodes], edges: history.doc.edges })
  }, [history, markManual])

  // Apply a canvas starter template — loads its pre-built nodes and marks them all as manually edited
  const handleApplyTemplate = useCallback((nodes: AuraNode[]) => {
    setLoadError('')
    history.set({ nodes, edges: [] })
    markManual(nodes.map(n => n.id))
    setSelectedId(null)
  }, [history, markManual])

  const loadPublications = useCallback(async () => {
    if (!workspace) return
    setPubLoading(true)
    try {
      const res = await listPublications(workspace.id, appId)
      setPublications(res.publications ?? [])
    } catch { /* ignore */ }
    finally { setPubLoading(false) }
  }, [workspace, appId])

  // Open publish dialog — load groups + latest version
  const handleOpenPublishDialog = async () => {
    if (!workspace || !company || loadError || publishBlocked) {
      if (publishBlocked) setPublishError(publishBlockerMessage)
      return
    }
    setPublishError('')
    setShowPublishDialog(true)
    setPublishGroupsLoading(true)
    setPublishAudienceSelections({})
    try {
      const groupsRes = await listCompanyGroups(company.id)
      const groups = groupsRes.groups ?? []
      setPublishGroups(groups)
      setPublishAudienceSelections(groups.reduce<Record<string, PublicationAudienceSelection>>((next, group) => {
        next[group.id] = 'use'
        return next
      }, {}))
    } catch {
      // non-fatal: dialog still usable
    } finally {
      setPublishGroupsLoading(false)
    }
  }

  const latestActivePublicationId = publications.find(publication => publication.status === 'active')?.id
  const publishedAppHref = useMemo(() => {
    if (!workspace) return `/app/${appId}`

    const params = new URLSearchParams({ workspace: workspace.id })
    if (latestActivePublicationId) {
      params.set('publication', latestActivePublicationId)
    }

    return `/app/${appId}?${params.toString()}`
  }, [appId, latestActivePublicationId, workspace])

  // Confirm publish — call legacy publish + new publication API
  const handlePublish = async () => {
    if (!workspace || publishing || loadError || publishBlocked) {
      if (publishBlocked) setPublishError(publishBlockerMessage)
      return
    }
    setPublishing(true)
    setPublishError('')
    try {
      const source = serializeV2(history.doc)
      const audiences = Object.entries(publishAudienceSelections).reduce<PublicationAudience[]>((next, [groupId, capability]) => {
        if (capability === 'discover' || capability === 'use') {
          next.push({ group_id: groupId, capability })
        }
        return next
      }, [])

      await patchApp(workspace.id, appId, { dsl_source: source, dsl_edges: history.doc.edges })
      const version = await publishApp(workspace.id, appId)
      setApp(prev => prev ? { ...prev, status: 'published' } : prev)
      if (audiences.length > 0) {
        await createPublication(workspace.id, appId, {
          app_version_id: version.id,
          audiences,
        }).then(publication => {
          setPublications(prev => [publication, ...prev.filter(existing => existing.id !== publication.id)])
        }).catch(() => { /* non-blocking */ })
      }
      setShowPublishDialog(false)
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  const selectedNode = history.doc.nodes.find(n => n.id === selectedId) ?? null
  const publishIssues = useMemo(() => getAppProductionIssues(history.doc.nodes), [history.doc.nodes])
  const publishBlocked = publishIssues.length > 0
  const publishBlockerMessage = publishBlocked ? formatProductionIssues(publishIssues) : ''
  const userFacingBlockers = useMemo(() => getUserFacingProductionIssues(history.doc.nodes), [history.doc.nodes])
  const workflowTriggerTargets = history.doc.nodes
    .filter(node => node.id !== 'root')
    .map(node => {
      const fields = node.element === 'form'
        ? (node.style?.fields ?? node.with?.fields ?? '')
            .split(',')
            .map((f: string) => f.trim())
            .filter(Boolean)
        : undefined
      return {
        id: node.id,
        label: `${node.id} (${node.element})`,
        element: node.element,
        fields,
      }
    })

  if (loading) return <RouteGateShell title="Editor" message="Loading your tool…" />

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

        {/* Canvas view toggle: Layout | Flow */}
        <div style={{ display: 'flex', gap: 0 }}>
          {(['layout', 'flow'] as const).map(view => (
            <button
              key={view}
              onClick={() => setCanvasView(view)}
              title={view === 'layout' ? 'Layout View' : 'Flow View (Ctrl+Shift+F)'}
              style={{
                padding: '3px 10px',
                fontSize: '0.65rem',
                fontWeight: 500,
                background: canvasView === view ? '#161616' : 'transparent',
                border: '1px solid #1e1e1e',
                borderRadius: view === 'layout' ? '4px 0 0 4px' : '0 4px 4px 0',
                color: canvasView === view ? '#e5e5e5' : '#555',
                cursor: 'pointer',
                borderBottom: canvasView === view ? '2px solid #3b82f6' : '1px solid #1e1e1e',
              }}
            >
              {view === 'layout' ? '⊞ Layout' : '⟢ Flow'}
            </button>
          ))}
        </div>

        {/* Publications */}
        <button
          onClick={() => {
            setShowPublications(!showPublications)
            if (!showPublications && publications.length === 0) loadPublications()
          }}
          title="Publications"
          style={iconBtn(true)}
        >
          📋
        </button>

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
            href={publishedAppHref}
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
        {publishBlocked && userFacingBlockers.length > 0 && (
          <span style={{ fontSize: '0.7rem', color: '#f87171', maxWidth: 280 }}>
            {userFacingBlockers[0].message}
            {userFacingBlockers.length > 1 && ` (+${userFacingBlockers.length - 1} more)`}
          </span>
        )}

        {/* App settings dropdown */}
        <div style={{ position: 'relative' }} ref={settingsRef}>
          <button
            onClick={() => {
              if (!showAppSettings && app) {
                setEditName(app.name)
                setEditDesc(app.description ?? '')
                setArchiveConfirm(false)
              }
              setShowAppSettings(v => !v)
            }}
            title="App settings"
            style={iconBtn(true)}
          >
            ⋮
          </button>
          {showAppSettings && (
            <>
              <div onClick={() => setShowAppSettings(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
              <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 100, marginTop: 4, width: 280, background: '#111', border: '1px solid #2a2a2a', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: '0.65rem', color: '#888' }}>Name</label>
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onBlur={async () => {
                    if (workspace && app && editName.trim() && editName !== app.name) {
                      await patchApp(workspace.id, appId, { name: editName.trim() })
                      setApp(prev => prev ? { ...prev, name: editName.trim() } : prev)
                    }
                  }}
                  onKeyDown={async e => {
                    if (e.key === 'Enter' && workspace && app && editName.trim() && editName !== app.name) {
                      await patchApp(workspace.id, appId, { name: editName.trim() })
                      setApp(prev => prev ? { ...prev, name: editName.trim() } : prev)
                    }
                  }}
                  style={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', color: '#e5e5e5', fontSize: '0.75rem', outline: 'none' }}
                />
                <label style={{ fontSize: '0.65rem', color: '#888' }}>Description</label>
                <textarea
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  onBlur={async () => {
                    if (workspace && app && editDesc !== (app.description ?? '')) {
                      await patchApp(workspace.id, appId, { description: editDesc })
                      setApp(prev => prev ? { ...prev, description: editDesc } : prev)
                    }
                  }}
                  rows={2}
                  style={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', color: '#e5e5e5', fontSize: '0.75rem', outline: 'none', resize: 'vertical' }}
                />
                <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 0' }} />
                {!archiveConfirm ? (
                  <button
                    onClick={() => setArchiveConfirm(true)}
                    style={{ background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 4, padding: '4px 8px', color: '#f87171', fontSize: '0.7rem', cursor: 'pointer' }}
                  >
                    Archive app
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: '0.65rem', color: '#f87171' }}>Confirm?</span>
                    <button
                      onClick={async () => {
                        if (workspace) {
                          await deleteApp(workspace.id, appId)
                          router.push('/builder')
                        }
                      }}
                      style={{ background: '#7f1d1d', border: 'none', borderRadius: 4, padding: '4px 10px', color: '#fff', fontSize: '0.65rem', cursor: 'pointer' }}
                    >
                      Yes, archive
                    </button>
                    <button
                      onClick={() => setArchiveConfirm(false)}
                      style={{ background: 'transparent', border: '1px solid #333', borderRadius: 4, padding: '4px 10px', color: '#888', fontSize: '0.65rem', cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right-panel toggles */}
        <button
          onClick={() => setRightPanel('inspector')}
          title="Inspector"
          style={{ ...iconBtn(true), background: rightPanel === 'inspector' ? '#161616' : 'transparent', borderColor: rightPanel === 'inspector' ? '#333' : '#1e1e1e' }}
        >
          ⚙
        </button>
        <button
          onClick={() => { setShowAdvancedBuilderControls(true); setRightPanel('chat') }}
          title="AI Chat (preview)"
          style={{ ...iconBtn(true), background: rightPanel === 'chat' ? '#161616' : 'transparent', borderColor: rightPanel === 'chat' ? '#333' : '#1e1e1e', opacity: 0.5 }}
        >
          💬
        </button>
        <button
          onClick={() => setShowWorkflowModal(v => !v)}
          title="Workflows"
          style={{ ...iconBtn(true), background: showWorkflowModal ? '#161616' : 'transparent', borderColor: showWorkflowModal ? '#333' : '#1e1e1e' }}
        >
          ⚡
        </button>

        <button
          onClick={handleOpenPublishDialog}
          disabled={publishing || !!loadError || publishBlocked}
          style={{
            padding: '5px 14px',
            borderRadius: 4,
            fontSize: '0.75rem',
            fontWeight: 600,
            background: (publishing || publishBlocked || !!loadError) ? '#1e3a8a66' : '#1d4ed8',
            border: 'none',
            color: (publishing || publishBlocked || !!loadError) ? '#93c5fd66' : '#fff',
            cursor: (publishing || publishBlocked || !!loadError) ? 'default' : 'pointer',
          }}
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
      </header>

      {/* ── Publications panel ── */}
      {showPublications && (
        <PublicationsPanel
          publications={publications}
          loading={pubLoading}
          workspaceId={workspace?.id ?? ''}
          appId={appId}
          companyId={company?.id ?? ''}
          onRefresh={loadPublications}
          onArchive={async (pubId) => {
            if (!workspace) return
            await archivePublication(workspace.id, appId, pubId)
            setPublications(prev => prev.map(p => p.id === pubId ? { ...p, status: 'archived' } : p))
          }}
          onClose={() => setShowPublications(false)}
        />
      )}

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {canvasView === 'flow' ? (
          <StepPalette onAddWidget={handleAddWidget} />
        ) : (
          <LayersPanel
            doc={history.doc.nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAdd={handleAddWidget}
            onDelete={handleDeleteWidget}
            workspaceId={workspace?.id ?? ''}
          />
        )}
        {canvasView === 'flow' ? (
          <FlowCanvas
            doc={history.doc}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={d => history.set(d)}
            workspaceId={workspace?.id ?? ''}
            reactiveStore={reactiveStore}
            onAddWidget={handleAddWidget}
          />
        ) : (
          <CanvasEditor
            doc={history.doc.nodes.filter(n => !n.element.startsWith('step:') && n.element !== 'flow:group')}
            selectedId={selectedId}
            onChange={handleCanvasChange}
            onSelect={setSelectedId}
            onApplyTemplate={handleApplyTemplate}
            workspaceId={workspace?.id ?? ''}
            highlightedWidgetIds={[...highlightedWidgetIds, ...(runErrorWidgetId ? [runErrorWidgetId] : [])]}
            onDropWidget={handleDropWidget}
          />
        )}
        {/* Right panel: Inspector, Step Config, AI Chat, or Workflows */}
        {rightPanel === 'inspector' ? (
          selectedNode?.element.startsWith('step:') ? (
            <StepConfigPanel
              node={selectedNode}
              onUpdate={handleUpdateNode}
              onDelete={id => { handleDeleteWidget(id); setSelectedId(null) }}
              workspaceId={workspace?.id ?? ''}
            />
          ) : (
            <Inspector
              node={selectedNode}
              doc={history.doc}
              onUpdate={handleUpdateNode}
              onDelete={handleDeleteWidget}
              workspaceId={workspace?.id ?? ''}
              appId={appId}
              pageId={appId}
              onOpenCanvas={setCanvasWorkflowId}
              onOpenSplitView={setSplitViewWorkflowId}
              onSwitchToFlowView={() => setCanvasView('flow')}
            />
          )
        ) : rightPanel === 'chat' && workspace ? (
          <div style={{ width: 280, flexShrink: 0 }}>
            <ChatPanel
              workspaceId={workspace.id}
              appId={appId}
              onDSLUpdate={src => {
                try {
                  setLoadError('')
                  history.set(parseV2(src))
                } catch {
                  /* ignore invalid DSL */
                }
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Workflow modal */}
      {showWorkflowModal && (
        <div
          onClick={() => setShowWorkflowModal(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(760px, 95vw)', height: 'min(85vh, 800px)',
              background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 8,
              display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
            }}
          >
            <button
              onClick={() => setShowWorkflowModal(false)}
              title="Close"
              style={{
                position: 'absolute', top: 8, right: 10, zIndex: 1,
                background: 'transparent', border: 'none', color: '#555',
                fontSize: '1rem', cursor: 'pointer', lineHeight: 1, padding: '2px 6px',
              }}
            >
              ✕
            </button>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <WorkflowEditor appId={appId} triggerTargets={workflowTriggerTargets} onOpenCanvas={setCanvasWorkflowId} onOpenSplitView={setSplitViewWorkflowId} />
            </div>
          </div>
        </div>
      )}

      {/* Publish dialog */}
      {showPublishDialog && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#111', border: '1px solid #2a2a2a', borderRadius: 8,
            padding: '1.5rem', minWidth: 360, maxWidth: 480, color: '#e5e5e5',
          }}>
            <h2 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
              Publish &ldquo;{app?.name}&rdquo;
            </h2>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: '#888' }}>
              Choose who should be able to find and use this tool.
            </p>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.7rem', color: '#555', lineHeight: 1.5 }}>
              Discover lists the app for that group. Use grants launch access.
            </p>
            {publishBlocked && (
              <p style={{ margin: '0 0 0.75rem', fontSize: '0.72rem', color: '#fbbf24', lineHeight: 1.5 }}>
                {publishBlockerMessage}
              </p>
            )}
            {publishGroupsLoading ? (
              <p style={{ fontSize: '0.75rem', color: '#555' }}>Loading groups…</p>
            ) : publishGroups.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: '#555' }}>No groups found. The app will be published without audience targeting.</p>
            ) : (
              <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: '1rem', display: 'grid', gap: 8 }}>
                {publishGroups.map(g => (
                  <div key={g.id} style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 132px',
                    gap: 12,
                    alignItems: 'center',
                    padding: '6px 0',
                    borderBottom: '1px solid #1a1a1a',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: '0.8rem', color: '#e5e5e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.name}
                        </span>
                        {g.source_type === 'workspace_synthetic' && (
                          <span style={{ fontSize: '0.65rem', color: '#555' }}>(workspace)</span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.65rem', color: '#444', marginTop: 2 }}>
                        {g.slug}
                      </div>
                    </div>
                    <select
                      value={publishAudienceSelections[g.id] ?? ''}
                      onChange={e => {
                        setPublishAudienceSelections(prev => ({
                          ...prev,
                          [g.id]: e.target.value as PublicationAudienceSelection,
                        }))
                      }}
                      style={{
                        background: '#0a0a0a',
                        border: '1px solid #333',
                        borderRadius: 4,
                        color: '#e5e5e5',
                        fontSize: '0.72rem',
                        padding: '5px 8px',
                        outline: 'none',
                      }}
                    >
                      <option value="">Not included</option>
                      <option value="discover">Can find this tool</option>
                      <option value="use">Can use this tool</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
            {publishError && (
              <p style={{ fontSize: '0.7rem', color: '#f87171', marginBottom: '0.5rem' }}>{publishError}</p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowPublishDialog(false); setPublishError('') }}
                disabled={publishing}
                style={{
                  padding: '5px 14px', borderRadius: 4, fontSize: '0.75rem',
                  background: 'transparent', border: '1px solid #333', color: '#aaa', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handlePublish}
                disabled={publishing || publishBlocked}
                style={{
                  padding: '5px 14px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
                  background: (publishing || publishBlocked) ? '#1e3a8a66' : '#1d4ed8',
                  border: 'none', color: (publishing || publishBlocked) ? '#93c5fd66' : '#fff',
                  cursor: (publishing || publishBlocked) ? 'default' : 'pointer',
                }}
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Workflow canvas overlay */}
      {canvasWorkflowId && (
        <WorkflowCanvas
          workspaceId={workspace!.id}
          appId={appId}
          workflowId={canvasWorkflowId}
          triggerLabel="Workflow"
          onClose={() => setCanvasWorkflowId(null)}
          isAdmin={user?.role === 'workspace_admin'}
        />
      )}

      {/* Workflow overlay for page-bound workflow editing */}
      {splitViewWorkflowId && workspace && (
        <WorkflowOverlay
          workflowId={splitViewWorkflowId}
          workspaceId={workspace.id}
          appId={appId}
          pageId={appId}
          onClose={() => setSplitViewWorkflowId(null)}
          onPopOut={(wfId) => { setSplitViewWorkflowId(null); setFloatingPanelWorkflowId(wfId) }}
          pageDocument={history.doc.nodes}
          isAdmin={user?.role === 'workspace_admin'}
          onBindingWidgetsChange={setHighlightedWidgetIds}
        />
      )}

      {/* Floating panel for page-bound workflow editing (WF-33–WF-37) */}
      {floatingPanelWorkflowId && workspace && (
        <FloatingWorkflowPanel
          workflowId={floatingPanelWorkflowId}
          workspaceId={workspace.id}
          appId={appId}
          pageId={appId}
          pageDocument={history.doc.nodes}
          isAdmin={user?.role === 'workspace_admin'}
          onClose={() => setFloatingPanelWorkflowId(null)}
          onSnapBack={() => { setSplitViewWorkflowId(floatingPanelWorkflowId); setFloatingPanelWorkflowId(null) }}
          onBindingWidgetsChange={setHighlightedWidgetIds}
        />
      )}
    </div>
  )
}

function PublicationsPanel({ publications, loading, workspaceId, appId, companyId, onRefresh, onArchive, onClose }: {
  publications: AppPublication[]
  loading: boolean
  workspaceId: string
  appId: string
  companyId: string
  onRefresh: () => Promise<void>
  onArchive: (pubId: string) => Promise<void>
  onClose: () => void
}) {
  const [archiving, setArchiving] = useState<string | null>(null)
  const [groups, setGroups] = useState<CompanyGroup[]>([])
  const groupNamesById = groups.reduce<Record<string, string>>((next, group) => {
    next[group.id] = group.name
    return next
  }, {})

  useEffect(() => {
    let cancelled = false
    if (!companyId) return

    listCompanyGroups(companyId)
      .then(res => {
        if (cancelled) return
        setGroups(res.groups ?? [])
      })
      .catch(() => {
        if (!cancelled) {
          setGroups([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [companyId])

  return (
    <div style={{
      borderBottom: '1px solid #1a1a1a',
      background: '#0d0d0d',
      padding: '0.75rem 1rem',
      maxHeight: 300,
      overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#888' }}>Publications</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '0.75rem' }}>✕</button>
      </div>
      {loading ? (
        <p style={{ color: '#555', fontSize: '0.75rem' }}>Loading…</p>
      ) : publications.length === 0 ? (
        <p style={{ color: '#444', fontSize: '0.75rem' }}>No publications yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {publications.map(pub => (
            <PublicationRow
              key={pub.id}
              pub={pub}
              workspaceId={workspaceId}
              appId={appId}
              groups={groups}
              groupNamesById={groupNamesById}
              onRefresh={onRefresh}
              archiving={archiving === pub.id}
              onArchive={async () => {
                setArchiving(pub.id)
                try {
                  await onArchive(pub.id)
                } finally {
                  setArchiving(null)
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PublicationRow({ pub, workspaceId, appId, groups, groupNamesById, onRefresh, archiving, onArchive }: {
  pub: AppPublication
  workspaceId: string
  appId: string
  groups: CompanyGroup[]
  groupNamesById: Record<string, string>
  onRefresh: () => Promise<void>
  archiving: boolean
  onArchive: () => Promise<void>
}) {
  const [audiences, setAudiences] = useState<PublicationAudience[]>([])
  const [showAudiences, setShowAudiences] = useState(false)
  const [loadingAud, setLoadingAud] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editSelections, setEditSelections] = useState<Record<string, PublicationAudienceSelection>>({})
  const [archiveOriginal, setArchiveOriginal] = useState(pub.status === 'active')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')

  const loadAudiences = useCallback(async () => {
    setLoadingAud(true)
    try {
      const res = await listPublicationAudiences(workspaceId, appId, pub.id)
      const nextAudiences = res.audiences ?? []
      setAudiences(nextAudiences)
      return nextAudiences
    } catch {
      return []
    } finally { setLoadingAud(false) }
  }, [workspaceId, appId, pub.id])

  useEffect(() => {
    void loadAudiences()
  }, [loadAudiences])

  const statusColor = pub.status === 'active' ? '#4ade80' : '#555'
  const statusBg = pub.status === 'active' ? '#16653433' : '#1a1a1a'
  const discoverAudiences = audiences.filter(a => a.capability === 'discover')
  const useAudiences = audiences.filter(a => a.capability === 'use')

  const summarizeAudienceNames = (items: PublicationAudience[]) => {
    const names = items.map(a => groupNamesById[a.group_id] ?? `Group ${a.group_id.slice(0, 8)}...`)
    if (names.length <= 2) {
      return names.join(', ')
    }
    return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
  }

  const openEditor = async () => {
    const currentAudiences = audiences.length > 0 ? audiences : await loadAudiences()
    setEditSelections(currentAudiences.reduce<Record<string, PublicationAudienceSelection>>((next, audience) => {
      next[audience.group_id] = audience.capability
      return next
    }, groups.reduce<Record<string, PublicationAudienceSelection>>((next, group) => {
      next[group.id] = ''
      return next
    }, {})))
    setArchiveOriginal(pub.status === 'active')
    setEditError('')
    setEditorOpen(true)
  }

  const handleRepublish = async () => {
    setSavingEdit(true)
    setEditError('')
    try {
      const nextAudiences = Object.entries(editSelections).reduce<PublicationAudience[]>((next, [groupId, capability]) => {
        if (capability === 'discover' || capability === 'use') {
          next.push({ group_id: groupId, capability })
        }
        return next
      }, [])

      await createPublication(workspaceId, appId, {
        app_version_id: pub.app_version_id,
        audiences: nextAudiences,
      })

      let archiveError = ''
      if (archiveOriginal && pub.status === 'active') {
        try {
          await onArchive()
        } catch (e: unknown) {
          archiveError = e instanceof Error ? e.message : 'Failed to archive the previous publication'
        }
      }

      await onRefresh()

      if (archiveError) {
        setEditError(`Republished successfully, but the previous publication was not archived: ${archiveError}`)
        return
      }

      setEditorOpen(false)
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Failed to republish audiences')
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <div style={{ padding: '8px 10px', background: '#111', border: '1px solid #1e1e1e', borderRadius: 6, fontSize: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.6rem', padding: '2px 7px', borderRadius: 99, background: statusBg, color: statusColor }}>{pub.status}</span>
        <span style={{ color: '#888', fontFamily: 'monospace', fontSize: '0.65rem' }}>v:{pub.app_version_id.slice(0, 8)}</span>
        <span style={{ color: '#444', fontSize: '0.65rem', marginLeft: 'auto' }}>
          {new Date(pub.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
        {useAudiences.length > 0 && (
          <div style={{ color: '#ccc', fontSize: '0.68rem' }}>
            <span style={{ color: '#4ade80' }}>{publicationCapabilityLabel('use')}:</span>{' '}
            {summarizeAudienceNames(useAudiences)}
          </div>
        )}
        {discoverAudiences.length > 0 && (
          <div style={{ color: '#ccc', fontSize: '0.68rem' }}>
            <span style={{ color: '#93c5fd' }}>{publicationCapabilityLabel('discover')}:</span>{' '}
            {summarizeAudienceNames(discoverAudiences)}
          </div>
        )}
        {loadingAud && audiences.length === 0 && (
          <div style={{ color: '#555', fontSize: '0.68rem' }}>
            Loading audience summary…
          </div>
        )}
        {!loadingAud && audiences.length === 0 && (
          <div style={{ color: '#555', fontSize: '0.68rem' }}>
            No audience targeting is attached to this publication.
          </div>
        )}
      </div>
      {(discoverAudiences.length > 0 || useAudiences.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {discoverAudiences.length > 0 && (
            <span style={publicationCapabilityPill('discover')}>
              {publicationCapabilityLabel('discover')} x {discoverAudiences.length}
            </span>
          )}
          {useAudiences.length > 0 && (
            <span style={publicationCapabilityPill('use')}>
              {publicationCapabilityLabel('use')} x {useAudiences.length}
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          onClick={() => { setShowAudiences(!showAudiences); if (!showAudiences && audiences.length === 0) loadAudiences() }}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#888', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 8px' }}
        >
          {showAudiences ? 'Hide audiences' : 'Audiences'}
        </button>
        <button
          onClick={() => { void openEditor() }}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#93c5fd', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 8px' }}
        >
          Edit / republish
        </button>
        {pub.status === 'active' && (
          <button
            onClick={onArchive}
            disabled={archiving}
            style={{ background: 'none', border: '1px solid #2a1010', borderRadius: 4, color: archiving ? '#555' : '#ef4444', cursor: archiving ? 'default' : 'pointer', fontSize: '0.65rem', padding: '2px 8px' }}
          >
            {archiving ? 'Archiving…' : 'Revoke'}
          </button>
        )}
      </div>
      {showAudiences && (
        <div style={{ marginTop: 6, padding: '4px 8px', background: '#0d0d0d', borderRadius: 4 }}>
          {loadingAud ? (
            <span style={{ color: '#555', fontSize: '0.6rem' }}>Loading…</span>
          ) : audiences.length === 0 ? (
            <span style={{ color: '#444', fontSize: '0.6rem' }}>No audiences</span>
          ) : audiences.map(a => (
            <div
              key={`${a.group_id}-${a.capability}`}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0' }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ color: '#ccc', fontSize: '0.65rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {groupNamesById[a.group_id] ?? `Group ${a.group_id.slice(0, 8)}...`}
                </div>
                {!groupNamesById[a.group_id] && (
                  <div style={{ color: '#444', fontFamily: 'monospace', fontSize: '0.55rem' }}>
                    {a.group_id}
                  </div>
                )}
              </div>
              <span style={publicationCapabilityPill(a.capability)}>{publicationCapabilityLabel(a.capability)}</span>
            </div>
          ))}
        </div>
      )}
      {editorOpen && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#0d0d0d', border: '1px solid #1e1e1e', borderRadius: 6, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: '#ccc', fontSize: '0.68rem' }}>
              Republish version {pub.app_version_id.slice(0, 8)} with updated audiences.
            </span>
            <span style={{ color: '#555', fontSize: '0.65rem', lineHeight: 1.5 }}>
              Editing creates a new publication record. Archive the existing one after republishing if this should replace it.
            </span>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: pub.status === 'active' ? '#888' : '#555', fontSize: '0.68rem' }}>
            <input
              type="checkbox"
              checked={archiveOriginal}
              onChange={e => setArchiveOriginal(e.target.checked)}
              disabled={pub.status !== 'active'}
            />
            Archive this publication after the new one is created
          </label>

          {groups.length === 0 ? (
            <div style={{ color: '#555', fontSize: '0.68rem' }}>No company groups available for audience targeting.</div>
          ) : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {groups.map(group => (
                <div key={group.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 148px', gap: 10, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #151515' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: '#e5e5e5', fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</div>
                    <div style={{ color: '#555', fontSize: '0.6rem' }}>{group.slug}</div>
                  </div>
                  <select
                    value={editSelections[group.id] ?? ''}
                    onChange={e => setEditSelections(prev => ({
                      ...prev,
                      [group.id]: e.target.value as PublicationAudienceSelection,
                    }))}
                    style={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 4, color: '#e5e5e5', fontSize: '0.68rem', padding: '4px 8px' }}
                  >
                    <option value="">Not included</option>
                    <option value="discover">{publicationCapabilityLabel('discover')}</option>
                    <option value="use">{publicationCapabilityLabel('use')}</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          {editError && (
            <div style={{ color: '#f87171', fontSize: '0.68rem' }}>{editError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              onClick={() => setEditorOpen(false)}
              disabled={savingEdit}
              style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#888', cursor: savingEdit ? 'default' : 'pointer', fontSize: '0.65rem', padding: '2px 8px' }}
            >
              Cancel
            </button>
            <button
              onClick={() => { void handleRepublish() }}
              disabled={savingEdit}
              style={{ background: '#1d4ed8', border: 'none', borderRadius: 4, color: '#fff', cursor: savingEdit ? 'default' : 'pointer', fontSize: '0.65rem', padding: '2px 10px' }}
            >
              {savingEdit ? 'Republishing…' : 'Republish'}
            </button>
          </div>
        </div>
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

function publicationCapabilityPill(capability: PublicationCapability): React.CSSProperties {
  if (capability === 'use') {
    return {
      fontSize: '0.6rem',
      padding: '2px 7px',
      borderRadius: 99,
      background: '#16653433',
      color: '#4ade80',
    }
  }

  return {
    fontSize: '0.6rem',
    padding: '2px 7px',
    borderRadius: 99,
    background: '#1e3a8a33',
    color: '#93c5fd',
  }
}

function publicationCapabilityLabel(capability: PublicationCapability) {
  return capability === 'use' ? 'Can launch' : 'Listed only'
}

