import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function ConditionNode({ data, selected }: NodeProps<WFNode>) {
  const border = selected ? '2px solid #facc15' : '1px solid #78350f'
  return (
    <div style={{ position: 'relative', width: 120, height: 60 }}>
      {/* Diamond shape via CSS transform */}
      <div style={{
        position: 'absolute', inset: 0,
        background: '#1c1202', border, borderRadius: 4,
        transform: 'rotate(45deg)',
        transformOrigin: 'center',
      }} />
      <div style={{
        position: 'relative', zIndex: 1, width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.68rem', color: '#fcd34d', fontWeight: 600, textAlign: 'center', padding: '0 10px',
      }}>
        {data.label}
      </div>
      <Handle type="target" position={Position.Top} style={{ background: '#facc15', top: 0 }} />
      {/* true branch — bottom */}
      <Handle type="source" position={Position.Bottom} id="true" style={{ background: '#4ade80', bottom: 0 }} />
      {/* false branch — right */}
      <Handle type="source" position={Position.Right} id="false" style={{ background: '#f87171', right: 0 }} />
    </div>
  )
}
