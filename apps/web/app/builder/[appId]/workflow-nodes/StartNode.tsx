import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function StartNode({ data }: NodeProps<WFNode>) {
  return (
    <div style={{
      background: '#1e3a8a', border: '2px solid #3b82f6', borderRadius: 8,
      padding: '8px 14px', color: '#bfdbfe', fontSize: '0.72rem', fontWeight: 600,
      minWidth: 120, textAlign: 'center',
    }}>
      ▶ {data.label}
      <Handle type="source" position={Position.Bottom} style={{ background: '#3b82f6' }} />
    </div>
  )
}
