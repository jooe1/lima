'use client'

import React from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { InlineTextEditor } from './InlineTextEditor'

interface TextWidgetPreviewProps {
  node: AuraNode
  onUpdate?: (node: AuraNode) => void
}

export function TextWidgetPreview({ node, onUpdate }: TextWidgetPreviewProps) {
  const content = node.text ?? node.value ?? ''
  const variant = node.style?.variant ?? 'body'
  const fz = variant === 'heading1' ? '1.1rem' : variant === 'heading2' ? '0.9rem' : variant === 'caption' ? '0.6rem' : '0.75rem'
  const fw = variant === 'heading1' || variant === 'heading2' ? 600 : 400

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
      value={content}
      allowEmpty={true}
      onCommit={handleCommit}
    >
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        color: content ? '#aaa' : '#333',
        fontSize: fz,
        fontWeight: fw,
        overflow: 'hidden',
        fontStyle: content ? 'normal' : 'italic',
      }}>
        {content || 'Double-click to set text…'}
      </div>
    </InlineTextEditor>
  )
}
