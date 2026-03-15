'use client'

import React, { useState } from 'react'
import { type AuraDocument } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, listWidgets, type WidgetType } from '@lima/widget-catalog'

interface Props {
  doc: AuraDocument
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (element: string) => void
  onDelete: (id: string) => void
}

// Minimal unicode stand-ins for each widget type
const WIDGET_ICONS: Record<string, string> = {
  table: '⊞',
  form: '◫',
  text: 'T',
  button: '▣',
  chart: '▦',
  kpi: '#',
  filter: '⧉',
  container: '⬚',
  modal: '◱',
  tabs: '⊓',
  markdown: '≡',
}

export function LayersPanel({ doc, selectedId, onSelect, onAdd, onDelete }: Props) {
  const [showAdd, setShowAdd] = useState(false)
  const allWidgets = listWidgets()

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

      {/* Add widget palette */}
      {showAdd && (
        <div style={{
          borderBottom: '1px solid #1a1a1a',
          padding: '0.5rem 0.75rem',
          background: '#0c0c0c',
        }}>
          <div style={{ fontSize: '0.6rem', color: '#444', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Add widget
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
            {allWidgets.map(meta => (
              <button
                key={meta.type}
                onClick={() => {
                  onAdd(meta.type)
                  setShowAdd(false)
                }}
                title={meta.description}
                style={{
                  background: '#111',
                  border: '1px solid #222',
                  borderRadius: 4,
                  padding: '6px 4px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 3,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#3b82f6' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#222' }}
              >
                <span style={{ fontSize: '0.9rem', color: '#666' }}>{WIDGET_ICONS[meta.type] ?? '?'}</span>
                <span style={{ fontSize: '0.55rem', color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%', textOverflow: 'ellipsis' }}>
                  {meta.displayName}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Layers list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {doc.length === 0 ? (
          <div style={{ padding: '1rem 0.75rem', fontSize: '0.7rem', color: '#2a2a2a', textAlign: 'center' }}>
            No widgets yet
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {doc.map(node => {
              const meta = WIDGET_REGISTRY[node.element as WidgetType]
              const isSelected = node.id === selectedId
              return (
                <li
                  key={node.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 0.75rem',
                    cursor: 'pointer',
                    background: isSelected ? '#1e3a8a22' : 'transparent',
                    borderLeft: `2px solid ${isSelected ? '#3b82f6' : 'transparent'}`,
                  }}
                  onClick={() => onSelect(node.id)}
                  onMouseEnter={e => {
                    if (!isSelected) (e.currentTarget as HTMLLIElement).style.background = '#111'
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) (e.currentTarget as HTMLLIElement).style.background = 'transparent'
                  }}
                >
                  <span style={{ fontSize: '0.7rem', color: '#444', width: 14, flexShrink: 0, textAlign: 'center' }}>
                    {WIDGET_ICONS[node.element] ?? '?'}
                  </span>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: '0.7rem', color: isSelected ? '#93c5fd' : '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                      {node.id}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: '#333' }}>
                      {meta?.displayName ?? node.element}
                      {node.manuallyEdited && <span title="Manually edited" style={{ color: '#854d0e', marginLeft: 4 }}>✎</span>}
                    </div>
                  </div>
                  {/* Delete button — shown on hover/selection */}
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
              )
            })}
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
