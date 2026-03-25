'use client'

import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode, WidgetSourceNodeData } from './types'

// Color accents per widget type
const WIDGET_ACCENT: Record<string, string> = {
  form:       '#0d9488', // teal
  table:      '#2563eb', // blue
  button:     '#7c3aed', // indigo
  text_input: '#059669', // green
  select:     '#d97706', // amber
}

const WIDGET_ICONS: Record<string, string> = {
  form:       '📋',
  table:      '📊',
  button:     '🔘',
  text_input: '✏️',
  select:     '🔽',
}

function getAccent(widgetType: string): string {
  return WIDGET_ACCENT[widgetType] ?? '#555'
}

function getIcon(widgetType: string): string {
  return WIDGET_ICONS[widgetType] ?? '🟦'
}

export function WidgetSourceNode({ data }: NodeProps<WFNode>) {
  const d = data as unknown as WidgetSourceNodeData
  const accent = getAccent(d.widgetType)

  return (
    <div
      style={{
        background: '#0c0c0c',
        borderTop: `1px solid ${accent}55`,
        borderRight: `1px solid ${accent}55`,
        borderBottom: `1px solid ${accent}55`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 6,
        padding: '8px 12px',
        minWidth: 140,
        maxWidth: 180,
        fontSize: '0.72rem',
        color: '#aaa',
      }}
    >
      {/* Widget label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
        <span style={{ fontSize: '0.9rem' }}>{getIcon(d.widgetType)}</span>
        <span style={{ fontWeight: 600, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.widgetLabel}
        </span>
      </div>
      <div style={{ fontSize: '0.58rem', color: '#444', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {d.widgetType}
      </div>

      {/* One source handle per output port */}
      {d.ports.map((port, i) => (
        <div
          key={port.portName}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 4,
            marginBottom: i < d.ports.length - 1 ? 3 : 0,
            paddingRight: 16,
            position: 'relative',
          }}
        >
          <span
            style={{
              fontSize: '0.58rem',
              color: accent,
              background: accent + '22',
              border: `1px solid ${accent}55`,
              borderRadius: 3,
              padding: '1px 5px',
              whiteSpace: 'nowrap',
            }}
          >
            {port.portLabel}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={port.portName}
            style={{
              background: accent,
              width: 8,
              height: 8,
              border: 'none',
              right: 0,
            }}
            title={`${port.portLabel} (${port.portType})`}
          />
        </div>
      ))}

      {d.ports.length === 0 && (
        <div style={{ fontSize: '0.6rem', color: '#333', fontStyle: 'italic' }}>no output ports</div>
      )}
    </div>
  )
}
