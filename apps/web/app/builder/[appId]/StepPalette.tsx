'use client'

import React, { useState } from 'react'
import {
  STEP_NODE_REGISTRY, type StepNodeType,
  WIDGET_REGISTRY, type WidgetType,
} from '@lima/widget-catalog'

const STEP_TYPES = Object.values(STEP_NODE_REGISTRY) as typeof STEP_NODE_REGISTRY[StepNodeType][]

const WIDGET_PALETTE_GROUPS: { label: string; types: WidgetType[] }[] = [
  { label: 'Data',    types: ['table', 'chart', 'kpi'] },
  { label: 'Input',   types: ['form', 'button', 'filter'] },
  { label: 'Layout',  types: ['container', 'tabs', 'modal'] },
  { label: 'Content', types: ['text', 'markdown'] },
]

interface Props {
  onAddWidget?: (element: string) => void
}

export function StepPalette({ onAddWidget }: Props) {
  const [open, setOpen] = useState(true)
  const [widgetsOpen, setWidgetsOpen] = useState(true)

  return (
    <div style={{
      width: 160,
      flexShrink: 0,
      background: '#0d0d0d',
      borderRight: '1px solid #1a1a1a',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Toggle header */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid #1a1a1a',
          padding: '8px 12px',
          color: '#888',
          fontSize: '0.65rem',
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
        Steps
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, overflowY: 'auto' }}>
          {STEP_TYPES.map(meta => (
            <div
              key={meta.type}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('application/reactflow/step', meta.type)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              style={{
                padding: '8px 10px',
                background: '#111',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                cursor: 'grab',
                userSelect: 'none',
              }}
              title={meta.description}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#e5e5e5', marginBottom: 2 }}>
                {meta.displayName}
              </div>
              <div style={{ fontSize: '0.55rem', color: '#555', lineHeight: 1.3 }}>
                {meta.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Widgets section (add to layout without switching views) ── */}
      <button
        onClick={() => setWidgetsOpen(v => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          borderTop: '1px solid #1a1a1a',
          borderBottom: '1px solid #1a1a1a',
          padding: '8px 12px',
          color: '#888',
          fontSize: '0.65rem',
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        <span style={{ opacity: 0.5 }}>{widgetsOpen ? '▾' : '▸'}</span>
        Widgets
      </button>

      {widgetsOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, overflowY: 'auto' }}>
          {WIDGET_PALETTE_GROUPS.map(group => (
            <div key={group.label}>
              <div style={{
                fontSize: '0.55rem',
                fontWeight: 700,
                color: '#444',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: 4,
                paddingLeft: 2,
              }}>
                {group.label}
              </div>
              {group.types.map(type => {
                const meta = WIDGET_REGISTRY[type]
                return (
                  <div
                    key={type}
                    draggable
                    onClick={() => onAddWidget?.(type)}
                    onDragStart={e => {
                      e.dataTransfer.setData('widget-type', type)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    title={`Add ${meta.displayName} widget to layout`}
                    style={{
                      padding: '6px 10px',
                      marginBottom: 2,
                      background: '#111',
                      border: '1px solid #2a2a2a',
                      borderRadius: 4,
                      cursor: 'grab',
                      userSelect: 'none',
                      color: '#e5e5e5',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                    }}
                  >
                    {meta.displayName}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
