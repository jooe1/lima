'use client'

import React, { useState, useEffect } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { parseFormFields } from '../../../../lib/formValidation'
import { FormFieldEditor } from './FormFieldEditor'

interface FormWidgetPreviewProps {
  node: AuraNode
  onUpdate: (newFieldsStr: string) => void
}

export function FormWidgetPreview({ node, onUpdate }: FormWidgetPreviewProps) {
  const [editing, setEditing] = useState(false)

  // Reset when a different widget is selected
  useEffect(() => { setEditing(false) }, [node.id])

  const fieldsStr = node.style?.fields ?? node.with?.fields ?? ''
  const fields = parseFormFields(fieldsStr)

  if (editing) {
    return (
      <FormFieldEditor
        fieldsStr={fieldsStr}
        onSave={(newStr) => {
          onUpdate(newStr)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div>
      {fields.length === 0 ? (
        <div style={{
          border: '1px dashed #1e3a8a',
          borderRadius: 4,
          padding: '10px 8px',
          marginBottom: 8,
          textAlign: 'center',
          color: '#3b82f6',
          fontSize: '0.65rem',
          cursor: 'pointer',
        }}
          onClick={() => setEditing(true)}
        >
          + Click to add fields
        </div>
      ) : (
        <>
          {fields.map(f => (
            <div key={f} style={{ marginBottom: 8 }}>
              <div style={{ color: '#555', fontSize: '0.6rem', marginBottom: 2 }}>{f}</div>
              <div style={{ height: 20, background: '#161616', borderRadius: 3, border: '1px solid #222' }} />
            </div>
          ))}
        </>
      )}

      {/* Submit button + edit fields toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <div style={{ display: 'inline-block', background: '#1d4ed8', borderRadius: 3, padding: '3px 12px', color: '#c7d9ff', fontSize: '0.65rem' }}>
          {node.text ?? node.style?.submitLabel ?? 'Submit'}
        </div>
        {fields.length > 0 && (
          <button
            onClick={() => setEditing(true)}
            style={{
              background: 'transparent',
              border: '1px solid #1e3a8a',
              borderRadius: 3,
              color: '#60a5fa',
              cursor: 'pointer',
              fontSize: '0.6rem',
              padding: '2px 7px',
            }}
          >
            ✎ fields
          </button>
        )}
      </div>
    </div>
  )
}
