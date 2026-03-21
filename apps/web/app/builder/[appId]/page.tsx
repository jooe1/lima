'use client'

import React, { use, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { parse, serialize, type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { useAuth } from '../../../lib/auth'
import {
  getApp, patchApp, publishApp, deleteApp,
  listCompanyGroups, createPublication,
  listPublications, archivePublication, listPublicationAudiences,
  type App, type AppPublication, type CompanyGroup,
} from '../../../lib/api'
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
  const { workspace, company } = useAuth()
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
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [showPublications, setShowPublications] = useState(false)
  const [publications, setPublications] = useState<AppPublication[]>([])
  const [pubLoading, setPubLoading] = useState(false)
  // 'inspector' | 'chat' | 'workflows' — controls the right-hand panel
  const [rightPanel, setRightPanel] = useState<'inspector' | 'chat' | 'workflows'>('inspector')
  // nodeMetadata tracks which nodes were manually edited; persisted as JSONB
  const [nodeMetadata, setNodeMetadata] = useState<Record<string, { manuallyEdited: boolean }>>({})
  const [showAppSettings, setShowAppSettings] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

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

  const loadPublications = async () => {
    if (!workspace) return
    setPubLoading(true)
    try {
      const res = await listPublications(workspace.id, appId)
      setPublications(res.publications ?? [])
    } catch { /* ignore */ }
    finally { setPubLoading(false) }
  }

  // Open publish dialog — load groups + latest version
  const handleOpenPublishDialog = async () => {
    if (!workspace || !company || loadError) return
    setPublishError('')
    setShowPublishDialog(true)
    setPublishGroupsLoading(true)
    try {
      const groupsRes = await listCompanyGroups(company.id)
      const groups = groupsRes.groups ?? []
      setPublishGroups(groups)
      setSelectedGroupIds(new Set(groups.map(g => g.id)))
    } catch {
      // non-fatal: dialog still usable
    } finally {
      setPublishGroupsLoading(false)
    }
  }

  // Confirm publish — call legacy publish + new publication API
  const handlePublish = async () => {
    if (!workspace || publishing || loadError) return
    setPublishing(true)
    setPublishError('')
    try {
      const source = serialize(history.doc)
      await patchApp(workspace.id, appId, { dsl_source: source })
      const version = await publishApp(workspace.id, appId)
      setApp(prev => prev ? { ...prev, status: 'published' } : prev)
      // Also create a publication record if groups are selected
      if (selectedGroupIds.size > 0) {
        await createPublication(workspace.id, appId, {
          app_version_id: version.id,
          audiences: [...selectedGroupIds].map(gid => ({ group_id: gid, capability: 'use' })),
        }).catch(() => { /* non-blocking */ })
      }
      setShowPublishDialog(false)
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
          onClick={handleOpenPublishDialog}
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

      {/* ── Publications panel ── */}
      {showPublications && (
        <PublicationsPanel
          publications={publications}
          loading={pubLoading}
          workspaceId={workspace?.id ?? ''}
          appId={appId}
          companyId={company?.id ?? ''}
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
            workspaceId={workspace?.id ?? ''}
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
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.75rem', color: '#888' }}>
              Select the groups that can discover and use this app.
            </p>
            {publishGroupsLoading ? (
              <p style={{ fontSize: '0.75rem', color: '#555' }}>Loading groups…</p>
            ) : publishGroups.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: '#555' }}>No groups found. The app will be published without audience targeting.</p>
            ) : (
              <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: '1rem' }}>
                {publishGroups.map(g => (
                  <label key={g.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 0', fontSize: '0.8rem', cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedGroupIds.has(g.id)}
                      onChange={e => {
                        setSelectedGroupIds(prev => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(g.id); else next.delete(g.id)
                          return next
                        })
                      }}
                    />
                    <span>{g.name}</span>
                    {g.source_type === 'workspace_synthetic' && (
                      <span style={{ fontSize: '0.65rem', color: '#555' }}>(workspace)</span>
                    )}
                  </label>
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
                disabled={publishing}
                style={{
                  padding: '5px 14px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
                  background: publishing ? '#1e3a8a66' : '#1d4ed8',
                  border: 'none', color: publishing ? '#93c5fd66' : '#fff',
                  cursor: publishing ? 'default' : 'pointer',
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
    </div>
  )
}

function PublicationsPanel({ publications, loading, workspaceId, appId, companyId, onArchive, onClose }: {
  publications: AppPublication[]
  loading: boolean
  workspaceId: string
  appId: string
  companyId: string
  onArchive: (pubId: string) => Promise<void>
  onClose: () => void
}) {
  const [archiving, setArchiving] = useState<string | null>(null)

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
              archiving={archiving === pub.id}
              onArchive={async () => {
                setArchiving(pub.id)
                await onArchive(pub.id)
                setArchiving(null)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PublicationRow({ pub, workspaceId, appId, archiving, onArchive }: {
  pub: AppPublication
  workspaceId: string
  appId: string
  archiving: boolean
  onArchive: () => Promise<void>
}) {
  const [audiences, setAudiences] = useState<{ group_id: string; capability: string }[]>([])
  const [showAudiences, setShowAudiences] = useState(false)
  const [loadingAud, setLoadingAud] = useState(false)

  const loadAudiences = async () => {
    setLoadingAud(true)
    try {
      const res = await listPublicationAudiences(workspaceId, appId, pub.id)
      setAudiences(res.audiences ?? [])
    } catch { /* ignore */ }
    finally { setLoadingAud(false) }
  }

  const statusColor = pub.status === 'active' ? '#4ade80' : '#555'
  const statusBg = pub.status === 'active' ? '#16653433' : '#1a1a1a'

  return (
    <div style={{ padding: '8px 10px', background: '#111', border: '1px solid #1e1e1e', borderRadius: 6, fontSize: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.6rem', padding: '2px 7px', borderRadius: 99, background: statusBg, color: statusColor }}>{pub.status}</span>
        <span style={{ color: '#888', fontFamily: 'monospace', fontSize: '0.65rem' }}>v:{pub.app_version_id.slice(0, 8)}</span>
        <span style={{ color: '#444', fontSize: '0.65rem', marginLeft: 'auto' }}>
          {new Date(pub.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          onClick={() => { setShowAudiences(!showAudiences); if (!showAudiences && audiences.length === 0) loadAudiences() }}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 4, color: '#888', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 8px' }}
        >
          {showAudiences ? 'Hide audiences' : 'Audiences'}
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
            <div key={a.group_id} style={{ color: '#888', fontSize: '0.6rem' }}>
              Group {a.group_id.slice(0, 8)}… ({a.capability})
            </div>
          ))}
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

