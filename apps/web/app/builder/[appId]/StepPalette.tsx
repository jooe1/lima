'use client'

import React, { useState } from 'react'
import { STEP_NODE_REGISTRY, type StepNodeType } from '@lima/widget-catalog'

const STEP_TYPES = Object.values(STEP_NODE_REGISTRY) as typeof STEP_NODE_REGISTRY[StepNodeType][]

export function StepPalette() {
  const [open, setOpen] = useState(true)

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
    </div>
  )
}
