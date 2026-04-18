'use client'

import React, { useState } from 'react'
import { parseFormFields, validateFormFields, formatFormFields } from '../../../../lib/formValidation'

interface FormFieldEditorProps {
  fieldsStr: string
  onSave: (newFieldsStr: string) => void
  onCancel: () => void
}

export function FormFieldEditor({ fieldsStr, onSave, onCancel }: FormFieldEditorProps) {
  const [fields, setFields] = useState<string[]>(() => parseFormFields(fieldsStr))
  const [newFieldName, setNewFieldName] = useState('')
  const [addError, setAddError] = useState('')

  const { duplicates } = validateFormFields(fields)

  function handleAdd() {
    const trimmed = newFieldName.trim()
    if (!trimmed) {
      setAddError('Field name cannot be empty.')
      return
    }
    // Warn but allow if duplicate
    setFields(prev => [...prev, trimmed])
    setNewFieldName('')
    setAddError('')
  }

  function handleRemove(index: number) {
    setFields(prev => prev.filter((_, i) => i !== index))
  }

  function handleSave() {
    onSave(formatFormFields(fields))
  }

  const inputStyle: React.CSSProperties = {
    background: '#161616',
    border: '1px solid #222',
    borderRadius: 3,
    color: '#e5e5e5',
    fontSize: '0.72rem',
    padding: '4px 8px',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none',
  }

  const btnStyle = (variant: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
    background: variant === 'primary' ? '#1d4ed8' : 'transparent',
    border: variant === 'danger' ? '1px solid #2a1010' : variant === 'ghost' ? '1px solid #1e3a8a' : 'none',
    borderRadius: 3,
    color: variant === 'primary' ? '#c7d9ff' : variant === 'danger' ? '#ef4444' : '#60a5fa',
    cursor: 'pointer',
    fontSize: '0.68rem',
    padding: variant === 'primary' ? '4px 12px' : '3px 8px',
  })

  return (
    <div data-interactive-preview="1" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '0.6rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
        Edit fields
      </div>

      {/* Duplicate warning */}
      {duplicates.length > 0 && (
        <div style={{ fontSize: '0.62rem', color: '#fbbf24', background: '#1a1500', borderRadius: 3, padding: '4px 8px' }}>
          ⚠ Duplicate fields: {duplicates.join(', ')}
        </div>
      )}

      {/* Field list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {fields.length === 0 && (
          <div style={{ fontSize: '0.65rem', color: '#444', padding: '8px 0', textAlign: 'center' }}>
            No fields yet — add one below.
          </div>
        )}
        {fields.map((f, i) => {
          const isDuplicate = duplicates.includes(f)
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: isDuplicate ? '#1a1200' : '#111',
              border: `1px solid ${isDuplicate ? '#78350f' : '#1e1e1e'}`,
              borderRadius: 3,
              padding: '4px 8px',
            }}>
              <span style={{ flex: 1, fontSize: '0.72rem', color: isDuplicate ? '#fcd34d' : '#d4d4d4', fontFamily: 'monospace' }}>
                {f}
              </span>
              <button onClick={() => handleRemove(i)} style={btnStyle('danger')}>×</button>
            </div>
          )
        })}
      </div>

      {/* Add field row */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={newFieldName}
          onChange={e => { setNewFieldName(e.target.value); setAddError('') }}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          placeholder="new field name"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={handleAdd} style={btnStyle('ghost')}>+ Add</button>
      </div>
      {addError && (
        <div style={{ fontSize: '0.62rem', color: '#f87171' }}>{addError}</div>
      )}

      {/* Save / Cancel */}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={handleSave} style={{ ...btnStyle('primary'), flex: 1 }}>Save</button>
        <button onClick={onCancel} style={{ ...btnStyle('ghost'), flex: 1 }}>Cancel</button>
      </div>
    </div>
  )
}
