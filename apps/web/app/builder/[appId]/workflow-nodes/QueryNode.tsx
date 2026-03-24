import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function QueryNode({ data, selected }: NodeProps<WFNode>) {
  const border = selected ? '2px solid #60a5fa' : '1px solid #1e3a8a'
  const ring = data.aiGenerated && !data.reviewed ? '0 0 0 2px #fbbf24' : undefined
  return (
    <div style={{
      background: '#0c1a2e', border, borderRadius: 6,
      padding: '8px 12px', color: '#93c5fd', fontSize: '0.72rem',
      minWidth: 140, boxShadow: ring,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#3b82f6' }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>🔍 Query</div>
      <div style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{data.label}</div>
      {data.aiGenerated && !data.reviewed && (
        <div style={{ fontSize: '0.6rem', marginTop: 4, color: '#fbbf24' }}>⚠ needs review</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#3b82f6' }} />
    </div>
  )
}
