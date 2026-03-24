import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function EndNode({ data }: NodeProps<WFNode>) {
  return (
    <div style={{
      background: '#111', border: '2px solid #333', borderRadius: 8,
      padding: '8px 14px', color: '#555', fontSize: '0.72rem', fontWeight: 600,
      minWidth: 80, textAlign: 'center',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#333' }} />
      ■ End
    </div>
  )
}
