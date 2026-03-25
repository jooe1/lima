import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { WFNode } from './types'

export function NotificationNode({ data, selected }: NodeProps<WFNode>) {
  const border = selected ? '2px solid #34d399' : '1px solid #064e3b'
  return (
    <div style={{
      background: '#021a0f', border, borderRadius: 6,
      padding: '8px 12px', color: '#6ee7b7', fontSize: '0.72rem',
      minWidth: 140, textAlign: 'center',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#34d399' }} />
      <div style={{ fontWeight: 600 }}>🔔 Notification</div>
      <div style={{ color: '#64748b', marginTop: 2 }}>{data.label}</div>
      <div style={{ color: '#065f46', fontSize: '0.58rem', marginTop: 2, fontStyle: 'italic' }}>
        {String(data.config?.message ?? '').slice(0, 50) || 'No message set'}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#34d399' }} />
    </div>
  )
}
