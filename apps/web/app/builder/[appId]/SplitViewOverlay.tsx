'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import {
  getWorkflow,
  activateWorkflow,
  patchWorkflow,
  type WorkflowWithSteps,
} from '../../../lib/api'
import { WorkflowCanvas } from './WorkflowCanvas'
import PortTray from './PortTray'

export interface SplitViewOverlayProps {
  workflowId: string
  workspaceId: string
  appId: string
  pageId: string
  onClose: () => void
  onPopOut: (workflowId: string) => void
  pageDocument: AuraNode[]
  isAdmin: boolean
}

// Pill colors — mirrors WorkflowEditor
function statusPillStyle(status: string): React.CSSProperties {
  const map: Record<string, [string, string]> = {
    draft:    ['#854d0e33', '#fbbf24'],
    active:   ['#16653433', '#4ade80'],
    archived: ['#1a1a1a',   '#555'],
    orphaned: ['#78350f55', '#fb923c'],
  }
  const [bg, color] = map[status] ?? ['#1a1a1a', '#aaa']
  return {
    background: bg,
    color,
    fontSize: '0.6rem',
    padding: '2px 8px',
    borderRadius: 99,
    flexShrink: 0,
  }
}

const C = {
  bg:       '#060606',
  surface:  '#0a0a0a',
  border:   '#1e1e1e',
  text:     '#e5e5e5',
  muted:    '#555',
  accent:   '#1d4ed8',
  accentFg: '#bfdbfe',
}

const btnStyle = (primary = false): React.CSSProperties => ({
  background: primary ? C.accent : '#1a1a1a',
  color:      primary ? C.accentFg : '#aaa',
  border:     primary ? 'none' : `1px solid ${C.border}`,
  borderRadius: 4,
  padding: '5px 14px',
  fontSize: '0.72rem',
  cursor: 'pointer',
  flexShrink: 0,
})

export function SplitViewOverlay({
  workflowId,
  workspaceId,
  appId,
  pageId,
  onClose,
  onPopOut,
  pageDocument,
  isAdmin,
}: SplitViewOverlayProps) {
  const [wf, setWf] = useState<WorkflowWithSteps | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [activating, setActivating] = useState(false)
  const [splitPercent, setSplitPercent] = useState(40)
  const bodyRef = useRef<HTMLDivElement>(null)
  const splitStartRef = useRef<{ startX: number; startPercent: number } | null>(null)

  // Fetch workflow for header state
  useEffect(() => {
    if (!workspaceId || !appId || !workflowId) return
    let cancelled = false
    getWorkflow(workspaceId, appId, workflowId)
      .then(data => {
        if (cancelled) return
        setWf(data)
        setName(data.name)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load workflow')
      })
    return () => { cancelled = true }
  }, [workspaceId, appId, workflowId])

  // Rename on blur
  const handleRename = useCallback(async () => {
    if (!wf || name === wf.name) return
    try {
      const updated = await patchWorkflow(workspaceId, appId, workflowId, { name })
      setWf(prev => prev ? { ...prev, ...updated } : null)
    } catch {
      setName(wf.name)
    }
  }, [wf, name, workspaceId, appId, workflowId])

  // Activate
  const handleActivate = useCallback(async () => {
    if (!wf) return
    setActivating(true)
    setError('')
    try {
      const updated = await activateWorkflow(workspaceId, appId, workflowId)
      setWf(prev => prev ? { ...prev, ...updated } : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to activate')
    } finally {
      setActivating(false)
    }
  }, [wf, workspaceId, appId, workflowId])

  // Draggable divider
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    splitStartRef.current = { startX: e.clientX, startPercent: splitPercent }

    function onMouseMove(ev: MouseEvent) {
      const body = bodyRef.current
      const start = splitStartRef.current
      if (!body || !start) return
      const bodyWidth = body.getBoundingClientRect().width
      if (bodyWidth === 0) return
      const dx = ev.clientX - start.startX
      const newPercent = Math.min(75, Math.max(20, start.startPercent + (dx / bodyWidth) * 100))
      setSplitPercent(newPercent)
    }

    function onMouseUp() {
      splitStartRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitPercent])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1001,
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        transition: 'all 0.2s',
      }}
    >
      {/* ── Header bar ── */}
      <div
        style={{
          height: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
          background: C.surface,
        }}
      >
        <button
          style={{
            background: 'none',
            border: 'none',
            color: '#aaa',
            cursor: 'pointer',
            fontSize: '0.8rem',
            padding: '4px 8px',
          }}
          onClick={onClose}
        >
          ← Back
        </button>

        <div style={{ width: 1, height: 20, background: C.border }} />

        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={e => { if (e.key === 'Enter') handleRename() }}
          style={{
            background: 'none',
            border: 'none',
            color: C.text,
            fontSize: '0.9rem',
            fontWeight: 600,
            outline: 'none',
            flex: 1,
            minWidth: 0,
          }}
        />

        {wf && (
          <span style={statusPillStyle(wf.status)}>{wf.status}</span>
        )}

        {error && (
          <span
            style={{
              fontSize: '0.65rem',
              color: '#fca5a5',
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {error}
          </span>
        )}

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <button style={{ ...btnStyle(), display: 'none' }} onClick={() => { /* Generate with AI — hidden until feature is ready */ }}>
            ✦ Generate with AI
          </button>

          {isAdmin && wf?.status === 'draft' && (
            <button
              style={btnStyle(true)}
              onClick={handleActivate}
              disabled={activating}
            >
              {activating ? 'Activating…' : 'Activate'}
            </button>
          )}

          <button
            style={{ ...btnStyle(), fontSize: '1rem', padding: '3px 10px' }}
            title="Pop out to floating panel"
            onClick={() => onPopOut(workflowId)}
          >
            ⤢
          </button>
        </div>
      </div>

      {/* ── Body: left pane | divider | right pane ── */}
      <div
        ref={bodyRef}
        style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}
      >
        {/* Left pane: ghosted page preview + port tray */}
        <div
          style={{
            width: `${splitPercent}%`,
            display: 'flex',
            flexDirection: 'column',
            borderRight: `1px solid ${C.border}`,
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {/* Page preview area (ghosted, read-only) */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: 0.5,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#080808',
                color: C.muted,
                fontSize: '0.75rem',
              }}
            >
              Page preview — {pageId}
            </div>
          </div>

          {/* Port tray */}
          <PortTray pageDocument={pageDocument} />
        </div>

        {/* Draggable divider */}
        <div
          onMouseDown={handleDividerMouseDown}
          style={{
            width: 4,
            cursor: 'col-resize',
            background: C.border,
            flexShrink: 0,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLDivElement).style.background = '#3b82f6'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLDivElement).style.background = C.border
          }}
        />

        {/* Right pane: WorkflowCanvas contained via CSS transform */}
        {/*
          `transform: translateZ(0)` makes this div the containing block for
          the WorkflowCanvas's `position: fixed` element, so the canvas fills
          only this pane rather than the full viewport.
        */}
        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            transform: 'translateZ(0)',
          }}
        >
          <WorkflowCanvas
            workspaceId={workspaceId}
            appId={appId}
            workflowId={workflowId}
            triggerLabel="Trigger"
            onClose={onClose}
            isAdmin={isAdmin}
            pageId={pageId}
          />
        </div>
      </div>
    </div>
  )
}
