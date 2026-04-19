'use client'

import React, { useState, useEffect, useRef } from 'react'
import { type AuraNode } from '@lima/aura-dsl'

interface MarkdownWidgetPreviewProps {
  node: AuraNode
  onUpdate?: (node: AuraNode) => void
}

export function MarkdownWidgetPreview({ node, onUpdate }: MarkdownWidgetPreviewProps) {
  const content = node.text ?? node.style?.content ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Reset when node changes (undo, AI edit, different widget selected)
  useEffect(() => {
    setEditing(false)
    setDraft(content)
  }, [node.id, content])

  // Commit on outside mousedown (canvas may preventDefault which suppresses blur)
  useEffect(() => {
    if (!editing) return
    function handleOutsideMouseDown(e: MouseEvent) {
      if (textareaRef.current && !textareaRef.current.contains(e.target as Node)) {
        commit()
      }
    }
    document.addEventListener('mousedown', handleOutsideMouseDown, true)
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft])

  function commit() {
    if (onUpdate) {
      onUpdate({
        ...node,
        manuallyEdited: true,
        text: draft || undefined,
        style: { ...(node.style ?? {}), content: draft || undefined },
      })
    }
    setEditing(false)
  }

  function cancel() {
    setDraft(content)
    setEditing(false)
  }

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
          // Allow Enter for newlines — Shift+Enter is not needed
        }}
        style={{
          width: '100%',
          height: '100%',
          background: '#1a1a1a',
          border: '1px solid #3b82f6',
          borderRadius: 3,
          color: '#e5e5e5',
          fontSize: '0.72rem',
          fontFamily: 'monospace',
          lineHeight: 1.5,
          padding: '4px 6px',
          boxSizing: 'border-box',
          outline: 'none',
          resize: 'none',
          display: 'block',
        }}
      />
    )
  }

  return (
    <div
      onDoubleClick={() => { setDraft(content); setEditing(true) }}
      title="Double-click to edit"
      style={{
        width: '100%',
        height: '100%',
        color: content ? '#555' : '#333',
        fontSize: '0.65rem',
        fontFamily: 'monospace',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.5,
        cursor: 'text',
        fontStyle: content ? 'normal' : 'italic',
      }}
    >
      {content || 'Double-click to set markdown…'}
    </div>
  )
}
