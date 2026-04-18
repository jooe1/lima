'use client'

import React, { useState } from 'react'

interface ColumnEditorProps {
  /** Current comma-separated columns string (from node.style?.columns or node.with?.columns) */
  columnsStr: string
  /** Available columns from schema (optional — used to show a suggestion dropdown) */
  sourceColumns?: string[]
  /** Display label: e.g. "columns" or "chart series" */
  noun?: string
  onSave: (newColumnsStr: string) => void
  onCancel: () => void
}

function parseColumns(str: string): string[] {
  return str.split(',').map(c => c.trim()).filter(c => c.length > 0)
}

function formatColumns(cols: string[]): string {
  return cols.join(', ')
}

function getDuplicates(cols: string[]): string[] {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const c of cols) {
    if (seen.has(c)) { if (!dupes.includes(c)) dupes.push(c) }
    else seen.add(c)
  }
  return dupes
}

export function ColumnEditor({ columnsStr, sourceColumns = [], noun = 'columns', onSave, onCancel }: ColumnEditorProps) {
  const [columns, setColumns] = useState<string[]>(() => parseColumns(columnsStr))
  const [newCol, setNewCol] = useState('')
  const [addError, setAddError] = useState('')

  const duplicates = getDuplicates(columns)

  function handleAdd() {
    const trimmed = newCol.trim()
    if (!trimmed) { setAddError('Column name cannot be empty.'); return }
    setColumns(prev => [...prev, trimmed])
    setNewCol('')
    setAddError('')
  }

  function handleRemove(index: number) {
    setColumns(prev => prev.filter((_, i) => i !== index))
  }

  function handleSave() {
    onSave(formatColumns(columns))
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
        Edit {noun}
      </div>

      {duplicates.length > 0 && (
        <div style={{ fontSize: '0.62rem', color: '#fbbf24', background: '#1a1500', borderRadius: 3, padding: '4px 8px' }}>
          ⚠ Duplicate {noun}: {duplicates.join(', ')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {columns.length === 0 && (
          <div style={{ fontSize: '0.65rem', color: '#444', padding: '8px 0', textAlign: 'center' }}>
            No {noun} yet — add one below.
          </div>
        )}
        {columns.map((c, i) => {
          const isDupe = duplicates.includes(c)
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: isDupe ? '#1a1200' : '#111',
              border: `1px solid ${isDupe ? '#78350f' : '#1e1e1e'}`,
              borderRadius: 3,
              padding: '4px 8px',
            }}>
              <span style={{ flex: 1, fontSize: '0.72rem', color: isDupe ? '#fcd34d' : '#d4d4d4', fontFamily: 'monospace' }}>{c}</span>
              <button onClick={() => handleRemove(i)} style={btnStyle('danger')}>×</button>
            </div>
          )
        })}
      </div>

      {/* Add column row — show dropdown if sourceColumns available, else free text */}
      <div style={{ display: 'flex', gap: 6 }}>
        {sourceColumns.length > 0 ? (
          <select
            value={newCol}
            onChange={e => { setNewCol(e.target.value); setAddError('') }}
            style={{ ...inputStyle, flex: 1, appearance: 'auto' }}
          >
            <option value="">— pick column —</option>
            {sourceColumns.filter(sc => !columns.includes(sc)).map(sc => (
              <option key={sc} value={sc}>{sc}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={newCol}
            onChange={e => { setNewCol(e.target.value); setAddError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
            placeholder={`new ${noun.replace(/s$/, '')} name`}
            style={{ ...inputStyle, flex: 1 }}
          />
        )}
        <button onClick={handleAdd} style={btnStyle('ghost')}>+ Add</button>
      </div>
      {addError && <div style={{ fontSize: '0.62rem', color: '#f87171' }}>{addError}</div>}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={handleSave} style={{ ...btnStyle('primary'), flex: 1 }}>Save</button>
        <button onClick={onCancel} style={{ ...btnStyle('ghost'), flex: 1 }}>Cancel</button>
      </div>
    </div>
  )
}
