'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { getWorkflow } from '../../../lib/api'
import { WorkflowCanvas } from './WorkflowCanvas'

export interface FloatingWorkflowPanelProps {
  workflowId: string
  workspaceId: string
  appId: string
  pageId: string
  pageDocument: AuraNode[]
  isAdmin: boolean
  onClose: () => void
  onSnapBack: () => void
}

const DEFAULT_WIDTH  = 560
const DEFAULT_HEIGHT = 600
const MIN_WIDTH      = 320
const MIN_HEIGHT     = 300
const POS_KEY        = 'lima-wf-panel-pos'
const SIZE_KEY       = 'lima-wf-panel-size'

function readStorage<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const C = {
  bg:     '#060606',
  surface:'#0a0a0a',
  border: '#1e1e1e',
  text:   '#e5e5e5',
  muted:  '#555',
}

export function FloatingWorkflowPanel({
  workflowId,
  workspaceId,
  appId,
  pageId,
  isAdmin,
  onClose,
  onSnapBack,
}: FloatingWorkflowPanelProps) {
  // WF-35: load persisted position/size on mount
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 80, left: 0 })
  const [size, setSize]         = useState<{ width: number; height: number }>({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  const [collapsed, setCollapsed] = useState(false)  // WF-36
  const [wfName, setWfName]       = useState('')

  // Initialise from sessionStorage after mount (avoids SSR window access)
  useEffect(() => {
    const savedPos  = readStorage<{ top: number; left: number }>(POS_KEY)
    const savedSize = readStorage<{ width: number; height: number }>(SIZE_KEY)
    setPosition(savedPos  ?? { top: 80, left: Math.round(window.innerWidth * 0.6) })
    if (savedSize) setSize(savedSize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch workflow name for header
  useEffect(() => {
    if (!workspaceId || !appId || !workflowId) return
    let cancelled = false
    getWorkflow(workspaceId, appId, workflowId)
      .then(data => { if (!cancelled) setWfName(data.name) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId, appId, workflowId])

  // ── WF-33: drag by header ─────────────────────────────────────────────────
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; posTop: number; posLeft: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posTop: position.top,
      posLeft: position.left,
    }
    setDragging(true)
  }, [position])

  useEffect(() => {
    if (!dragging) return

    function onMouseMove(e: MouseEvent) {
      const start = dragStartRef.current
      if (!start) return
      setPosition({
        top:  start.posTop  + (e.clientY - start.mouseY),
        left: start.posLeft + (e.clientX - start.mouseX),
      })
    }

    function onMouseUp(e: MouseEvent) {
      const start = dragStartRef.current
      dragStartRef.current = null
      setDragging(false)
      if (!start) return
      const finalPos = {
        top:  start.posTop  + (e.clientY - start.mouseY),
        left: start.posLeft + (e.clientX - start.mouseX),
      }
      try { sessionStorage.setItem(POS_KEY, JSON.stringify(finalPos)) } catch { /* ignore */ }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup',   onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup',   onMouseUp)
    }
  }, [dragging])

  // ── WF-34: resize by bottom-right corner ─────────────────────────────────
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; width: number; height: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      width:  size.width,
      height: size.height,
    }
    setResizing(true)
  }, [size])

  useEffect(() => {
    if (!resizing) return

    function onMouseMove(e: MouseEvent) {
      const start = resizeStartRef.current
      if (!start) return
      setSize({
        width:  Math.max(MIN_WIDTH,  start.width  + (e.clientX - start.mouseX)),
        height: Math.max(MIN_HEIGHT, start.height + (e.clientY - start.mouseY)),
      })
    }

    function onMouseUp(e: MouseEvent) {
      const start = resizeStartRef.current
      resizeStartRef.current = null
      setResizing(false)
      if (!start) return
      const finalSize = {
        width:  Math.max(MIN_WIDTH,  start.width  + (e.clientX - start.mouseX)),
        height: Math.max(MIN_HEIGHT, start.height + (e.clientY - start.mouseY)),
      }
      try { sessionStorage.setItem(SIZE_KEY, JSON.stringify(finalSize)) } catch { /* ignore */ }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup',   onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup',   onMouseUp)
    }
  }, [resizing])

  // WF-35: save on close
  const handleClose = useCallback(() => {
    try {
      sessionStorage.setItem(POS_KEY,  JSON.stringify(position))
      sessionStorage.setItem(SIZE_KEY, JSON.stringify(size))
    } catch { /* ignore */ }
    onClose()
  }, [position, size, onClose])

  const btnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: '0.75rem',
    padding: '4px 7px',
    lineHeight: 1,
    flexShrink: 0,
  }

  return (
    <div
      style={{
        position: 'fixed',
        top:    position.top,
        left:   position.left,
        width:  size.width,
        height: collapsed ? 'auto' : size.height,
        zIndex: 50,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        overflow: 'hidden',
        cursor: dragging ? 'grabbing' : 'default',
      }}
    >
      {/* ── Header bar ── */}
      <div
        onMouseDown={handleHeaderMouseDown}
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 6px 0 10px',
          background: C.surface,
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
          flexShrink: 0,
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        {/* Drag-handle dots */}
        <span style={{ color: C.muted, fontSize: '0.8rem', flexShrink: 0, letterSpacing: '-1px' }}>⠿</span>

        {/* Workflow title */}
        <span
          style={{
            color: C.text,
            fontSize: '0.8rem',
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {wfName || workflowId}
        </span>

        {/* WF-36: collapse toggle */}
        <button
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
          onClick={() => setCollapsed(v => !v)}
          style={btnStyle}
        >
          {collapsed ? '▼' : '▲'}
        </button>

        {/* WF-37: snap back to split-view */}
        <button
          title="Snap back to split view"
          onClick={onSnapBack}
          style={{ ...btnStyle, fontSize: '0.8rem' }}
        >
          ⤡ Snap back
        </button>

        {/* Close */}
        <button
          title="Close"
          onClick={handleClose}
          style={{ ...btnStyle, fontSize: '0.9rem' }}
        >
          ✕
        </button>
      </div>

      {/* ── Body ── */}
      {!collapsed && (
        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            // Makes this div the containing block for WorkflowCanvas's position:fixed,
            // so the canvas fills only this panel rather than the full viewport.
            transform: 'translateZ(0)',
          }}
        >
          <WorkflowCanvas
            workspaceId={workspaceId}
            appId={appId}
            workflowId={workflowId}
            triggerLabel="Trigger"
            onClose={handleClose}
            isAdmin={isAdmin}
            pageId={pageId}
          />
        </div>
      )}

      {/* WF-34: resize handle (bottom-right corner) */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeMouseDown}
          title="Resize"
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 16,
            height: 16,
            cursor: 'se-resize',
            zIndex: 10,
            // Subtle visual indicator
            background: 'linear-gradient(135deg, transparent 50%, #333 50%)',
          }}
        />
      )}
    </div>
  )
}
