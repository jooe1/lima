'use client'

import React, { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function MutationNode({ data, selected }: NodeProps<WFNode>) {
  const [isDragOver, setIsDragOver] = useState(false)

  const border = selected
    ? '2px solid #fb923c'
    : isDragOver
    ? '2px solid #34d399'
    : '1px solid #7c2d12'
  const ring = data.aiGenerated && !data.reviewed ? '0 0 0 2px #fbbf24' : undefined

  const inputBindings = data.inputBindings as
    | Record<string, { widgetId: string; portName: string; widgetLabel: string }>
    | undefined

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('application/x-port-binding')) {
      e.preventDefault()
      setIsDragOver(true)
    }
  }

  const handleDragLeave = () => setIsDragOver(false)

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const raw = e.dataTransfer.getData('application/x-port-binding')
    if (!raw) return
    try {
      const portDrag = JSON.parse(raw)
      if (data.stepId && data.onBindingDropped) {
        data.onBindingDropped({ portDrag, stepId: data.stepId })
      }
    } catch {
      // ignore malformed drag data
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        background: isDragOver ? '#1c2a1e' : '#1c0a02',
        borderTop: border, borderRight: border, borderBottom: border,
        borderLeft: '3px solid #fb923c',
        borderRadius: 6,
        padding: '8px 12px', color: '#fdba74', fontSize: '0.72rem',
        minWidth: 140, boxShadow: ring,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#fb923c' }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>💾 Write Data</div>
      <div style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{data.label}</div>
      <div style={{ color: '#334155', fontSize: '0.58rem', marginTop: 2, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
        {(() => {
          const op = data.config?.operation ? String(data.config.operation) : 'insert'
          const table = data.config?.table ? String(data.config.table) : ''
          const isManaged = !table && data.config?.connector_id
          const hasMappings = Array.isArray(data.config?.field_mapping) && (data.config.field_mapping as unknown[]).length > 0
          if (!table && !isManaged) return 'Not configured'
          const label = table || 'managed table'
          if (isManaged && !hasMappings && op === 'insert') return 'Add row (no fields mapped)'
          if (op === 'update') return `Updates ${label}`
          if (op === 'delete') return `Deletes from ${label}`
          return `Adds row to ${label}`
        })()}
      </div>
      {data.aiGenerated && !data.reviewed && (
        <div style={{ fontSize: '0.6rem', marginTop: 4, color: '#fbbf24' }}>⚠ needs review</div>
      )}
      {inputBindings && Object.keys(inputBindings).length > 0 && (
        <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {Object.entries(inputBindings).map(([key, b]) => (
            <span
              key={key}
              style={{
                background: '#7c2d1244',
                border: '1px solid #7c2d1288',
                color: '#fdba74',
                borderRadius: 3,
                padding: '1px 4px',
                fontSize: '0.55rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {b.widgetLabel} → {b.portName}
              <button
                onClick={() => data.onBindingRemoved?.({ key, stepId: data.stepId! })}
                style={{
                  background: 'none', border: 'none', color: '#64748b',
                  cursor: 'pointer', padding: 0, fontSize: '0.55rem', lineHeight: 1,
                }}
                title="Remove binding"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#fb923c' }} />
    </div>
  )
}
