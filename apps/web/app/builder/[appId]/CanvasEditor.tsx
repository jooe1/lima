'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import { type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'
import { WidgetRenderer } from './widgets/WidgetRenderer'

export const CELL = 40   // pixels per grid unit
export const COLS = 24   // number of grid columns
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

interface Props {
  doc: AuraDocument
  selectedId: string | null
  onChange: (doc: AuraDocument) => void
  onSelect: (id: string | null) => void
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

export function CanvasEditor({ doc, selectedId, onChange, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  // Stable refs so event handlers (attached once) always see current values
  const docRef = useRef<AuraDocument>(doc)
  const onChangeRef = useRef(onChange)
  const onSelectRef = useRef(onSelect)
  const selectedIdRef = useRef(selectedId)
  docRef.current = doc
  onChangeRef.current = onChange
  onSelectRef.current = onSelect
  selectedIdRef.current = selectedId

  // Canvas content height — enough to show all widgets + breathing room
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
      const drag = dragRef.current
      const container = containerRef.current
      if (!drag || !container) return

      const pt = getCanvasPoint(e)
      const dx = pt.x - drag.startMouseX
      const dy = pt.y - drag.startMouseY

      let newX = drag.snapX, newY = drag.snapY
      let newW = drag.snapW, newH = drag.snapH

      if (drag.type === 'move') {
        newX = Math.max(0, Math.min(COLS - drag.origGridW, Math.round((drag.origGridX * CELL + dx) / CELL)))
        newY = Math.max(0, Math.round((drag.origGridY * CELL + dy) / CELL))
      } else {
        newW = Math.max(MIN_W, Math.min(COLS - drag.origGridX, Math.round((drag.origGridW * CELL + dx) / CELL)))
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
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        background: '#080808',
        position: 'relative',
      }}
      onClick={e => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg === '1') {
          onSelect(null)
        }
      }}
    >
      {/* Canvas content — fixed width, grows vertically */}
      <div
        data-canvas-bg="1"
        style={{
          position: 'relative',
          width: COLS * CELL,
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
                boxShadow: isSelected ? '0 0 0 2px #3b82f620' : 'none',
                zIndex: isSelected ? 10 : 1,
              }}
              onMouseDown={e => handleWidgetMouseDown(e, node.id, 'move')}
              onClick={e => { e.stopPropagation(); onSelect(node.id) }}
            >
              <WidgetRenderer node={node} selected={isSelected} />

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

        {/* Empty state */}
        {doc.length === 0 && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ textAlign: 'center', color: '#2a2a2a' }}>
              <div style={{ fontSize: '0.85rem', marginBottom: 6 }}>Canvas is empty</div>
              <div style={{ fontSize: '0.7rem' }}>Add widgets from the panel on the left</div>
            </div>
          </div>
        )}
      </div>

      {/* Minimap — scaled thumbnail of all widgets in bottom-right corner */}
      {doc.length > 0 && (
        <MinimapOverlay doc={doc} canvasHeight={canvasHeight} selectedId={selectedId} />
      )}
    </div>
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
