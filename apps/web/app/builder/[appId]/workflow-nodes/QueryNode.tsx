'use client'

import React, { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function QueryNode({ data, selected }: NodeProps<WFNode>) {
  const [isDragOver, setIsDragOver] = useState(false)

  const border = selected
    ? '2px solid #60a5fa'
    : isDragOver
    ? '2px solid #34d399'
    : '1px solid #1e3a8a'
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
        background: isDragOver ? '#0c2a1e' : '#0c1a2e',
        border, borderRadius: 6,
        padding: '8px 12px', color: '#93c5fd', fontSize: '0.72rem',
        minWidth: 140, boxShadow: ring,
        transition: 'background 0.15s, border 0.15s',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#3b82f6' }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>🔍 Query</div>
      <div style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{data.label}</div>
      {data.aiGenerated && !data.reviewed && (
        <div style={{ fontSize: '0.6rem', marginTop: 4, color: '#fbbf24' }}>⚠ needs review</div>
      )}
      {inputBindings && Object.keys(inputBindings).length > 0 && (
        <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {Object.entries(inputBindings).map(([key, b]) => (
            <span
              key={key}
              style={{
                background: '#1e3a8a44',
                border: '1px solid #1e3a8a88',
                color: '#93c5fd',
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
      <Handle type="source" position={Position.Bottom} style={{ background: '#3b82f6' }} />
    </div>
  )
}
