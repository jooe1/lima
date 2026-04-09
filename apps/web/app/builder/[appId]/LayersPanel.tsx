'use client'

import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Table2, BarChart2, TrendingUp,
  ClipboardList, MousePointerClick, Filter,
  Frame, Layers, PanelTop,
  Type, FileCode,
} from 'lucide-react'
import { type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, listWidgets, type WidgetType } from '@lima/widget-catalog'
import { isProductionReadyWidget } from '../../../lib/appValidation'
import { WidgetRenderer } from './widgets/WidgetRenderer'
import { DashboardFilterProvider } from '../../../lib/dashboardFilters'

interface Props {
  doc: AuraDocument
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (element: string) => void
  onDelete: (id: string) => void
  workspaceId: string
}

function useSearch(doc: AuraDocument, query: string) {
  if (!query.trim()) return doc
  const q = query.toLowerCase()
  return doc.filter(n => n.id.toLowerCase().includes(q) || n.element.toLowerCase().includes(q))
}

type IconComponent = React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>

const WIDGET_ICON_MAP: Record<string, IconComponent> = {
  table:     Table2,
  chart:     BarChart2,
  kpi:       TrendingUp,
  form:      ClipboardList,
  button:    MousePointerClick,
  filter:    Filter,
  container: Frame,
  tabs:      Layers,
  modal:     PanelTop,
  text:      Type,
  markdown:  FileCode,
}

// Grouped palette sections
const PALETTE_GROUPS: { label: string; types: WidgetType[] }[] = [
  { label: 'Data',    types: ['table', 'chart', 'kpi'] },
  { label: 'Input',   types: ['form', 'button', 'filter'] },
  { label: 'Layout',  types: ['container', 'tabs', 'modal'] },
  { label: 'Content', types: ['text', 'markdown'] },
]

// ---- Tree helpers ----------------------------------------------------------

const CONTAINER_ELEMENTS = new Set(['container', 'tabs'])

/** Build a Map<parentId, children[]> from a flat document. */
function buildChildMap(doc: AuraDocument): Map<string, AuraNode[]> {
  const m = new Map<string, AuraNode[]>()
  for (const node of doc) {
    const siblings = m.get(node.parentId)
    if (siblings) {
      siblings.push(node)
    } else {
      m.set(node.parentId, [node])
    }
  }
  return m
}

// ---- LayerRow component ----------------------------------------------------

// Natural dimensions of the WidgetRenderer thumbnail before scaling.
const THUMB_NATURAL_W = 440
const THUMB_NATURAL_H = 280
const THUMB_SCALE = 0.2
const THUMB_W = Math.round(THUMB_NATURAL_W * THUMB_SCALE)  // 88
const THUMB_H = Math.round(THUMB_NATURAL_H * THUMB_SCALE)  // 56

interface LayerRowProps {
  node: AuraNode
  depth: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onDelete: (id: string) => void
  workspaceId: string
  childMap: Map<string, AuraNode[]>
}

function LayerRow({ node, depth, selectedId, onSelect, onDelete, workspaceId, childMap }: LayerRowProps) {
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  const isSelected = node.id === selectedId
  const isUnsupported = !isProductionReadyWidget(node.element)
  const [showTooltip, setShowTooltip] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const rowRef = useRef<HTMLLIElement>(null)

  const childNodes = CONTAINER_ELEMENTS.has(node.element)
    ? (childMap.get(node.id) ?? [])
    : []

  function handleMouseEnter() {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect()
      setTooltipPos({ x: rect.right + 6, y: rect.top })
    }
    setShowTooltip(true)
  }

  function handleMouseLeave() {
    setShowTooltip(false)
  }

  return (
    <>
      <li
        ref={rowRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: `5px 0.75rem 5px ${0.75 + depth * 1.1}rem`,
          cursor: 'pointer',
          background: isSelected ? '#1e3a8a22' : 'transparent',
          borderLeft: `2px solid ${isSelected ? '#3b82f6' : 'transparent'}`,
        }}
        onClick={() => onSelect(node.id)}
        onMouseEnter={(e) => {
          if (!isSelected) (e.currentTarget as HTMLLIElement).style.background = '#111'
          handleMouseEnter()
        }}
        onMouseLeave={(e) => {
          if (!isSelected) (e.currentTarget as HTMLLIElement).style.background = 'transparent'
          handleMouseLeave()
        }}
      >
        {/* Tree guide line for nested nodes */}
        {depth > 0 && (
          <span style={{
            position: 'absolute',
            left: `calc(${0.75 + (depth - 1) * 1.1}rem + 7px)`,
            width: 1,
            top: 0,
            bottom: 0,
            background: '#1e1e1e',
            pointerEvents: 'none',
          }} />
        )}
        <span style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {WIDGET_ICON_MAP[node.element]
            ? React.createElement(WIDGET_ICON_MAP[node.element], { size: 11, strokeWidth: 1.5, color: depth > 0 ? '#333' : '#444' })
            : <span style={{ fontSize: '0.7rem', color: '#444' }}>?</span>
          }
        </span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontSize: '0.7rem', color: isSelected ? '#93c5fd' : '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
            {node.id}
          </div>
          <div style={{ fontSize: '0.6rem', color: '#333' }}>
            {meta?.displayName ?? node.element}
            {node.manuallyEdited && <span title="Manually edited" style={{ color: '#854d0e', marginLeft: 4 }}>✎</span>}
            {isUnsupported && <span title="Blocked from production publish" style={{ color: '#f87171', marginLeft: 4 }}>unsupported</span>}
          </div>
        </div>
        {isSelected && (
          <button
            title="Delete widget"
            onClick={e => { e.stopPropagation(); onDelete(node.id) }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              fontSize: '0.75rem',
              padding: '2px 4px',
              borderRadius: 3,
              flexShrink: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#555' }}
          >
            ×
          </button>
        )}
      </li>

      {/* Hover thumbnail popover */}
      {showTooltip && createPortal(
        <div style={{
          position: 'fixed',
          left: tooltipPos.x,
          top: tooltipPos.y,
          zIndex: 9999,
          width: THUMB_W,
          height: THUMB_H,
          overflow: 'hidden',
          border: '1px solid #2a2a2a',
          borderRadius: 4,
          background: '#111',
          pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        }}>
          <div style={{
            width: THUMB_NATURAL_W,
            height: THUMB_NATURAL_H,
            transform: `scale(${THUMB_SCALE})`,
            transformOrigin: 'top left',
          }}>
            <DashboardFilterProvider>
              <WidgetRenderer node={node} selected={false} workspaceId={workspaceId} />
            </DashboardFilterProvider>
          </div>
        </div>,
        document.body,
      )}

      {/* Recursively render children of container/tabs */}
      {childNodes.map(child => (
        <LayerRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={onDelete}
          workspaceId={workspaceId}
          childMap={childMap}
        />
      ))}
    </>
  )
}

export function LayersPanel({ doc, selectedId, onSelect, onAdd, onDelete, workspaceId }: Props) {
  const [showAdd, setShowAdd] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const readyTypes = new Set(listWidgets().filter(meta => isProductionReadyWidget(meta.type)).map(m => m.type))
  const filteredDoc = useSearch(doc, searchQuery)
  // childMap is built from the full doc so tree structure is always available.
  const childMap = buildChildMap(doc)
  // Root nodes: those whose parentId is 'root' (or not in the doc as an id).
  const docIds = new Set(doc.map(n => n.id))
  const rootNodes = searchQuery.trim()
    ? filteredDoc  // flat filtered list when searching
    : doc.filter(n => !docIds.has(n.parentId))

  return (
    <aside style={panelStyle}>
      {/* Header */}
      <div style={{
        padding: '0.6rem 0.75rem',
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Layers
        </span>
        <button
          onClick={() => setShowAdd(v => !v)}
          title="Add widget"
          style={{
            background: showAdd ? '#1e3a8a' : 'transparent',
            border: '1px solid #2a2a2a',
            borderRadius: 4,
            color: '#aaa',
            fontSize: '0.8rem',
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          +
        </button>
      </div>

      {/* Layer search */}
      <div style={{ padding: '0.4rem 0.75rem', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <input
          type="text"
          placeholder="Search widgets…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#111',
            border: '1px solid #1e1e1e',
            borderRadius: 4,
            color: '#888',
            fontSize: '0.65rem',
            outline: 'none',
            padding: '3px 7px',
          }}
        />
      </div>

      {/* Add widget palette — grouped, stays open, tiles are draggable */}
      {showAdd && (
        <div style={{
          borderBottom: '1px solid #1a1a1a',
          padding: '0.5rem 0.5rem 0.75rem',
          background: '#0c0c0c',
          overflowY: 'auto',
          maxHeight: 300,
        }}>
          {PALETTE_GROUPS.map(group => {
            const items = group.types
              .map(t => WIDGET_REGISTRY[t])
              .filter(meta => meta && readyTypes.has(meta.type))
            if (items.length === 0) return null
            return (
              <div key={group.label} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: '0.55rem', color: '#3b3b3b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5, paddingLeft: 2 }}>
                  {group.label}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                  {items.map(meta => {
                    const Icon = WIDGET_ICON_MAP[meta.type]
                    return (
                      <button
                        key={meta.type}
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData('widget-type', meta.type)
                          e.dataTransfer.effectAllowed = 'copy'
                        }}
                        onClick={() => onAdd(meta.type)}
                        title={`${meta.description} — drag to place`}
                        style={{
                          background: '#111',
                          border: '1px solid #222',
                          borderRadius: 4,
                          padding: '7px 4px 5px',
                          cursor: 'grab',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 4,
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#3b82f6' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#222' }}
                      >
                        {Icon
                          ? <Icon size={14} strokeWidth={1.5} color="#666" />
                          : <span style={{ fontSize: '0.75rem', color: '#666', lineHeight: 1 }}>?</span>
                        }
                        <span style={{ fontSize: '0.55rem', color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%', textOverflow: 'ellipsis' }}>
                          {meta.displayName}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Layers list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {doc.length === 0 ? (
          <div style={{ padding: '1rem 0.75rem', fontSize: '0.7rem', color: '#2a2a2a', textAlign: 'center' }}>
            No widgets yet
          </div>
        ) : filteredDoc.length === 0 ? (
          <div style={{ padding: '1rem 0.75rem', fontSize: '0.7rem', color: '#2a2a2a', textAlign: 'center' }}>
            No matches
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
            {rootNodes.map(node => (
              <LayerRow
                key={node.id}
                node={node}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
                workspaceId={workspaceId}
                childMap={searchQuery.trim() ? new Map() : childMap}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Footer: widget count */}
      <div style={{
        padding: '0.5rem 0.75rem',
        borderTop: '1px solid #1a1a1a',
        fontSize: '0.6rem',
        color: '#2a2a2a',
        flexShrink: 0,
      }}>
        {doc.length} widget{doc.length !== 1 ? 's' : ''}
      </div>
    </aside>
  )
}

const panelStyle: React.CSSProperties = {
  width: 200,
  flexShrink: 0,
  borderRight: '1px solid #1a1a1a',
  background: '#0a0a0a',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'hidden',
}
