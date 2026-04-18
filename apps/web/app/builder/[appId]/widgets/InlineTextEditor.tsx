'use client'

import React, { useState, useEffect, useRef } from 'react'
import { type AuraNode } from '@lima/aura-dsl'

interface InlineTextEditorProps {
  /** The AuraNode being edited */
  node: AuraNode
  /** The field on the node to edit: 'text' maps to node.text, 'style.X' maps to node.style.X */
  field: 'text' | `style.${string}`
  /** Current display value */
  value: string
  /** Whether empty is allowed (true for flow-driven widgets) */
  allowEmpty?: boolean
  /** Callback fires when user commits the edit (Enter or blur) */
  onCommit: (newValue: string) => void
  /** children — the normal display-mode render */
  children: React.ReactNode
}

export function InlineTextEditor({
  node,
  field: _field,
  value,
  allowEmpty = true,
  onCommit,
  children,
}: InlineTextEditorProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset when node changes (e.g. undo, AI edit, different widget selected)
  useEffect(() => {
    setEditing(false)
    setDraft(value)
  }, [node.id, value])

  function commit() {
    if (!allowEmpty && !draft.trim()) {
      cancel()
      return
    }
    onCommit(draft)
    setEditing(false)
  }

  function cancel() {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        style={{
          background: '#1a1a1a',
          border: '1px solid #3b82f6',
          borderRadius: 3,
          color: '#e5e5e5',
          fontSize: '0.75rem',
          padding: '2px 6px',
          width: '100%',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
    )
  }

  return (
    <div
      onDoubleClick={() => { setDraft(value); setEditing(true) }}
      title="Double-click to edit"
      style={{ cursor: 'text', outline: 'none' }}
    >
      {children}
    </div>
  )
}
