'use client'

import React, { useState, useEffect, useRef } from 'react'
import { marked } from 'marked'
import { type AuraNode } from '@lima/aura-dsl'

interface MarkdownWidgetPreviewProps {
  node: AuraNode
  onUpdate?: (node: AuraNode) => void
}

export function MarkdownWidgetPreview({ node, onUpdate }: MarkdownWidgetPreviewProps) {
  const content = node.text ?? node.style?.content ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const [renderedHtml, setRenderedHtml] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Re-render markdown whenever content changes
  useEffect(() => {
    if (!content) { setRenderedHtml(''); return }
    const result = marked.parse(content)
    if (typeof result === 'string') {
      setRenderedHtml(result)
    } else {
      result.then(setRenderedHtml)
    }
  }, [content])

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
        style: { ...(node.style ?? {}), ...(draft ? { content: draft } : {}) },
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
        data-interactive-preview="1"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        style={{
          width: '100%',
          height: '100%',
          background: '#111',
          border: '1px solid #3b82f6',
          borderRadius: 3,
          color: '#e5e5e5',
          fontSize: '0.78rem',
          fontFamily: 'monospace',
          lineHeight: 1.6,
          padding: '6px 8px',
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
        overflow: 'auto',
        cursor: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {renderedHtml ? (
        <div
          className="md-preview"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      ) : (
        <span style={{ color: '#333', fontSize: '0.65rem', fontStyle: 'italic' }}>
          Double-click to set markdown…
        </span>
      )}
    </div>
  )
}
