'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { WidgetRenderer } from './widgets/WidgetRenderer'
import { DashboardFilterProvider } from '../../../lib/dashboardFilters'
import { TemplateGallery } from './TemplateGallery'

export const CELL = 40   // pixels per grid unit
// COLS is no longer a hard cap — the canvas expands to fit content.
// Used only as a soft reference for input validation in the Inspector.
export const COLS = 120
const MIN_W = 2
const MIN_H = 1

interface DragState {
  nodeId: string
  type: 'move' | 'resize'
  startMouseX: number
  startMouseY: number
  origGridX: number
  origGridY: number
  origGridW: number
  origGridH: number
  // mutable snap values updated during move
  snapX: number
  snapY: number
  snapW: number
  snapH: number
}

interface PanState {
  startMouseX: number
  startMouseY: number
  startScrollLeft: number
  startScrollTop: number
}

interface Props {
  doc: AuraDocument
  selectedId: string | null
  onChange: (doc: AuraDocument) => void
  onSelect: (id: string | null) => void
  onApplyTemplate: (nodes: AuraNode[]) => void
  workspaceId: string
  highlightedWidgetIds?: string[]
  onDropWidget?: (element: string, gridX: number, gridY: number) => void
}

export function getGrid(node: AuraNode, fallback = { w: 4, h: 3 }) {
  const s = node.style ?? {}
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  const defW = meta?.defaultSize.w ?? fallback.w
  const defH = meta?.defaultSize.h ?? fallback.h
  return {
    x: Math.max(0, parseInt(s.gridX ?? '0', 10) || 0),
    y: Math.max(0, parseInt(s.gridY ?? '0', 10) || 0),
    w: Math.max(MIN_W, parseInt(s.gridW ?? String(defW), 10) || defW),
    h: Math.max(MIN_H, parseInt(s.gridH ?? String(defH), 10) || defH),
  }
}

export function CanvasEditor({ doc, selectedId, onChange, onSelect, onApplyTemplate, workspaceId, highlightedWidgetIds, onDropWidget }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const [isPanning, setIsPanning] = React.useState(false)

  // Gallery state: show when canvas is empty, re-show if user clears all widgets
  const [showGallery, setShowGallery] = useState(doc.length === 0)
  const prevDocLenRef = useRef(doc.length)
  useEffect(() => {
    const prev = prevDocLenRef.current
    prevDocLenRef.current = doc.length
    if (prev > 0 && doc.length === 0) {
      setShowGallery(true)
    }
  }, [doc.length])

  function handleTemplateSelect(nodes: AuraNode[]) {
    setShowGallery(false)
    if (nodes.length > 0) onApplyTemplate(nodes)
  }

  // Stable refs so event handlers (attached once) always see current values
  const docRef = useRef<AuraDocument>(doc)
  const onChangeRef = useRef(onChange)
  const onSelectRef = useRef(onSelect)
  const selectedIdRef = useRef(selectedId)
  docRef.current = doc
  onChangeRef.current = onChange
  onSelectRef.current = onSelect
  selectedIdRef.current = selectedId

  // Canvas content dimensions — grows to fit all widgets with breathing room
  const canvasWidth = React.useMemo(() => {
    let maxRight = 24
    for (const n of doc) {
      const g = getGrid(n)
      maxRight = Math.max(maxRight, g.x + g.w)
    }
    return maxRight * CELL + 240
  }, [doc])

  const canvasHeight = React.useMemo(() => {
    let maxBottom = 15
    for (const n of doc) {
      const g = getGrid(n)
      maxBottom = Math.max(maxBottom, g.y + g.h)
    }
    return maxBottom * CELL + 240
  }, [doc])

  // Document-level mouse handlers for drag (attached once on mount)
  useEffect(() => {
    function getCanvasPoint(e: MouseEvent) {
      const container = containerRef.current
      if (!container) return { x: 0, y: 0 }
      const rect = container.getBoundingClientRect()
      return {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top + container.scrollTop,
      }
    }

    function handleMouseMove(e: MouseEvent) {
      // Pan gesture
      const pan = panRef.current
      if (pan) {
        const container = containerRef.current
        if (container) {
          container.scrollLeft = pan.startScrollLeft - (e.clientX - pan.startMouseX)
          container.scrollTop  = pan.startScrollTop  - (e.clientY - pan.startMouseY)
        }
        return
      }

      const drag = dragRef.current
      const container = containerRef.current
      if (!drag || !container) return

      const pt = getCanvasPoint(e)
      const dx = pt.x - drag.startMouseX
      const dy = pt.y - drag.startMouseY

      let newX = drag.snapX, newY = drag.snapY
      let newW = drag.snapW, newH = drag.snapH

      if (drag.type === 'move') {
        newX = Math.max(0, Math.round((drag.origGridX * CELL + dx) / CELL))
        newY = Math.max(0, Math.round((drag.origGridY * CELL + dy) / CELL))
      } else {
        newW = Math.max(MIN_W, Math.round((drag.origGridW * CELL + dx) / CELL))
        newH = Math.max(MIN_H, Math.round((drag.origGridH * CELL + dy) / CELL))
      }

      drag.snapX = newX
      drag.snapY = newY
      drag.snapW = newW
      drag.snapH = newH

      // Directly update DOM for smooth 60fps dragging (avoid React render loop)
      const el = container.querySelector(`[data-widget-id="${drag.nodeId}"]`) as HTMLElement | null
      if (el) {
        el.style.left = `${newX * CELL}px`
        el.style.top = `${newY * CELL}px`
        el.style.width = `${newW * CELL}px`
        el.style.height = `${newH * CELL}px`
      }
    }

    function handleMouseUp() {
      // End pan gesture
      if (panRef.current) {
        panRef.current = null
        setIsPanning(false)
        return
      }

      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null

      const newDoc = docRef.current.map(node => {
        if (node.id !== drag.nodeId) return node
        return {
          ...node,
          style: {
            ...(node.style ?? {}),
            gridX: String(drag.snapX),
            gridY: String(drag.snapY),
            gridW: String(drag.snapW),
            gridH: String(drag.snapH),
          },
        }
      })
      onChangeRef.current(newDoc)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Keyboard delete for selected widget
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const id = selectedIdRef.current
      if (!id) return
      // Don't delete when focus is in an input (inspector editing)
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        onChangeRef.current(docRef.current.filter(n => n.id !== id))
        onSelectRef.current(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleWidgetMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string, type: 'move' | 'resize') => {
      e.preventDefault()
      e.stopPropagation()

      const node = docRef.current.find(n => n.id === nodeId)
      if (!node) return

      const g = getGrid(node)
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const pt = {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top + container.scrollTop,
      }

      dragRef.current = {
        nodeId,
        type,
        startMouseX: pt.x,
        startMouseY: pt.y,
        origGridX: g.x,
        origGridY: g.y,
        origGridW: g.w,
        origGridH: g.h,
        snapX: g.x,
        snapY: g.y,
        snapW: g.w,
        snapH: g.h,
      }

      onSelectRef.current(nodeId)
    },
    [],
  )

  return (
    <DashboardFilterProvider>
      {/* Non-scrolling wrapper — position anchor for the minimap overlay */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
      <div
        ref={containerRef}
        className="canvas-scroll-container"
        style={{
          width: '100%',
          height: '100%',
          overflow: 'auto',
          background: '#080808',
          cursor: isPanning ? 'grabbing' : 'default',
          // Hide native scrollbars — panning replaces them
          scrollbarWidth: 'none',
        }}
        onMouseDown={e => {
          // Middle-mouse anywhere, or left-mouse on the background (not a widget)
          const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg === '1'
          if (e.button === 1 || (e.button === 0 && isBackground)) {
            e.preventDefault()
            const container = containerRef.current
            if (!container) return
            panRef.current = {
              startMouseX: e.clientX,
              startMouseY: e.clientY,
              startScrollLeft: container.scrollLeft,
              startScrollTop: container.scrollTop,
            }
            setIsPanning(true)
          }
        }}
        onClick={e => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg === '1') {
            onSelect(null)
          }
        }}
      >
        {/* Canvas content — expands to fit widgets */}
        <div
          data-canvas-bg="1"
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={e => {
            e.preventDefault()
            const element = e.dataTransfer.getData('widget-type')
            if (!element || !onDropWidget) return
            const rect = e.currentTarget.getBoundingClientRect()
            const gridX = Math.max(0, Math.floor((e.clientX - rect.left) / CELL))
            const gridY = Math.max(0, Math.floor((e.clientY - rect.top) / CELL))
            onDropWidget(element, gridX, gridY)
          }}
          style={{
            position: 'relative',
            width: canvasWidth,
            minHeight: canvasHeight,
            backgroundImage: 'radial-gradient(circle, #1a1a1a 1px, transparent 1px)',
            backgroundSize: `${CELL}px ${CELL}px`,
            backgroundPosition: '0 0',
            margin: '0 auto',
          }}
        >
          {doc.map(node => {
            const g = getGrid(node)
            const isSelected = selectedId === node.id
            const isHighlighted = highlightedWidgetIds?.includes(node.id) ?? false

            return (
              <div
                key={node.id}
                data-widget-id={node.id}
                style={{
                  position: 'absolute',
                  left: g.x * CELL,
                  top: g.y * CELL,
                  width: g.w * CELL,
                  height: g.h * CELL,
                  background: '#111',
                  border: `1px solid ${isSelected ? '#3b82f6' : '#1e1e1e'}`,
                  borderRadius: 4,
                  overflow: 'hidden',
                  cursor: 'grab',
                  boxShadow: isSelected
                    ? '0 0 0 2px #3b82f620'
                    : isHighlighted
                      ? '0 0 0 2px #3b82f6, 0 0 16px 4px #3b82f644'
                      : 'none',
                  outline: 'none',
                  transition: 'box-shadow 0.2s ease',
                  zIndex: isSelected ? 10 : isHighlighted ? 5 : 1,
                }}
                onMouseDown={e => {
                  const target = e.target as HTMLElement
                  if (target.closest('[data-interactive-preview="1"]')) return
                  handleWidgetMouseDown(e, node.id, 'move')
                }}
                onClick={e => { e.stopPropagation(); onSelect(node.id) }}
              >
                <WidgetRenderer node={node} selected={isSelected} workspaceId={workspaceId} />

                {/* Resize handle — bottom-right corner */}
                {isSelected && (
                  <div
                    title="Drag to resize"
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      right: 0,
                      width: 14,
                      height: 14,
                      cursor: 'se-resize',
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'flex-end',
                      padding: 2,
                    }}
                    onMouseDown={e => {
                      e.stopPropagation()
                      handleWidgetMouseDown(e, node.id, 'resize')
                    }}
                  >
                    {/* resize grip dots */}
                    <svg width="8" height="8" fill="#3b82f6" opacity={0.7}>
                      <circle cx="6" cy="6" r="1.2" />
                      <circle cx="3" cy="6" r="1.2" />
                      <circle cx="6" cy="3" r="1.2" />
                    </svg>
                  </div>
                )}
              </div>
            )
          })}

          {/* Empty state — template gallery or muted hint */}
          {doc.length === 0 && (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              {showGallery ? (
                <TemplateGallery onSelect={handleTemplateSelect} />
              ) : (
                <div style={{ textAlign: 'center', color: '#2a2a2a', pointerEvents: 'none' }}>
                  <div style={{ fontSize: '0.85rem', marginBottom: 6 }}>Canvas is empty</div>
                  <div style={{ fontSize: '0.7rem' }}>Add widgets from the panel on the left</div>
                </div>
              )}
            </div>
          )}
        </div>

      </div>

        {/* Minimap — anchored to the non-scrolling wrapper, always visible in bottom-right */}
        {doc.length > 0 && (
          <MinimapOverlay doc={doc} canvasHeight={canvasHeight} selectedId={selectedId} />
        )}
      </div>
    </DashboardFilterProvider>
  )
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

interface MinimapProps {
  doc: AuraDocument
  canvasHeight: number
  selectedId: string | null
}

const MINIMAP_W = 140
const MINIMAP_H = 88

function MinimapOverlay({ doc, canvasHeight, selectedId }: MinimapProps) {
  const canvasW = COLS * CELL
  const scaleX = MINIMAP_W / canvasW
  const scaleY = MINIMAP_H / canvasHeight

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 14,
        right: 14,
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: '#0c0c0c',
        border: '1px solid #1e1e1e',
        borderRadius: 4,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 20,
      }}
      aria-hidden="true"
    >
      <svg width={MINIMAP_W} height={MINIMAP_H} style={{ display: 'block' }}>
        {doc.map(node => {
          const g = getGrid(node)
          const x = g.x * CELL * scaleX
          const y = g.y * CELL * scaleY
          const w = Math.max(2, g.w * CELL * scaleX)
          const h = Math.max(1, g.h * CELL * scaleY)
          const isSelected = node.id === selectedId
          return (
            <rect
              key={node.id}
              x={x}
              y={y}
              width={w}
              height={h}
              rx={1}
              fill={isSelected ? '#3b82f6' : '#1e3a5f'}
              stroke={isSelected ? '#60a5fa' : '#2a4a6a'}
              strokeWidth={0.5}
              opacity={0.9}
            />
          )
        })}
      </svg>
    </div>
  )
}
