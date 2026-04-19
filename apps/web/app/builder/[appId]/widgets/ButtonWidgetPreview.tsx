'use client'

import React from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { InlineTextEditor } from './InlineTextEditor'

interface ButtonWidgetPreviewProps {
  node: AuraNode
  onUpdate?: (node: AuraNode) => void
}

export function ButtonWidgetPreview({ node, onUpdate }: ButtonWidgetPreviewProps) {
  const variant = node.style?.variant ?? 'primary'
  const bg = variant === 'danger' ? '#450a0a' : variant === 'secondary' ? '#1a1a1a' : '#1e3a8a'
  const color = variant === 'danger' ? '#fca5a5' : variant === 'secondary' ? '#aaa' : '#bfdbfe'
  const border = variant === 'secondary' ? '1px solid #333' : 'none'
  const label = node.text ?? ''

  function handleCommit(newValue: string) {
    if (!onUpdate) return
    onUpdate({
      ...node,
      manuallyEdited: true,
      text: newValue || undefined,
    })
  }

  return (
    <InlineTextEditor
      node={node}
      field="text"
      value={label}
      allowEmpty={true}
      onCommit={handleCommit}
    >
      <div style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        border,
        borderRadius: 4,
        padding: '4px 14px',
        color,
        fontSize: '0.75rem',
        fontStyle: label ? 'normal' : 'italic',
        opacity: label ? 1 : 0.6,
        boxSizing: 'border-box',
      }}>
        {label || 'Double-click to set label…'}
      </div>
    </InlineTextEditor>
  )
}
