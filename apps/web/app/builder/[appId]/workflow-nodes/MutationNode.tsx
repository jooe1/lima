import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function MutationNode({ data, selected }: NodeProps<WFNode>) {
  const border = selected ? '2px solid #fb923c' : '1px solid #7c2d12'
  const ring = data.aiGenerated && !data.reviewed ? '0 0 0 2px #fbbf24' : undefined
  return (
    <div style={{
      background: '#1c0a02', border, borderRadius: 6,
      padding: '8px 12px', color: '#fdba74', fontSize: '0.72rem',
      minWidth: 140, boxShadow: ring,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#fb923c' }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>✏ Mutation</div>
      <div style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{data.label}</div>
      {data.aiGenerated && !data.reviewed && (
        <div style={{ fontSize: '0.6rem', marginTop: 4, color: '#fbbf24' }}>⚠ needs review</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#fb923c' }} />
    </div>
  )
}
