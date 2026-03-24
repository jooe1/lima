import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function ApprovalGateNode({ data, selected }: NodeProps<WFNode>) {
  const border = selected ? '2px solid #a78bfa' : '1px solid #4c1d95'
  return (
    <div style={{
      background: '#0d0a1e', border, borderRadius: 6,
      padding: '8px 12px', color: '#c4b5fd', fontSize: '0.72rem',
      minWidth: 140, textAlign: 'center',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#a78bfa' }} />
      <div style={{ fontWeight: 600 }}>✅ Approval Gate</div>
      <div style={{ color: '#64748b', marginTop: 2 }}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#a78bfa' }} />
    </div>
  )
}
