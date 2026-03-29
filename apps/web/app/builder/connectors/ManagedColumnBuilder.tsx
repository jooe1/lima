'use client'

import { useState, type DragEvent } from 'react'
import { setManagedTableColumns, type ManagedTableColumn } from '../../../lib/api'

export const COL_TYPE_LABELS: Record<string, string> = {
  'text': 'Text',
  'int4': 'Number',
  'float8': 'Number',
  'bool': 'Yes/No',
  'date': 'Date',
  'timestamp': 'Date',
  'bytea': 'File',
}

export function ManagedColumnBuilder({
  connectorId,
  workspaceId,
  columns: initialColumns,
  onColumnsChange,
}: {
  connectorId: string
  workspaceId: string
  columns: ManagedTableColumn[]
  onColumnsChange: () => void
}) {
  const [cols, setCols] = useState<ManagedTableColumn[]>(initialColumns)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(colsToSave: ManagedTableColumn[]) {
    setSaving(true)
    try {
      await setManagedTableColumns(
        workspaceId,
        connectorId,
        colsToSave.map(c => ({ name: c.name, col_type: c.col_type, nullable: c.nullable })),
      )
      onColumnsChange()
    } catch {
      // optimistic — swallow error
    } finally {
      setSaving(false)
    }
  }

  function handleAddColumn() {
    const newCol: ManagedTableColumn = {
      id: `draft-${Date.now()}`,
      name: '',
      col_type: 'text',
      nullable: true,
      col_order: cols.length,
    }
    setCols(prev => [...prev, newCol])
  }

  function handleNameChange(id: string, name: string) {
    setCols(prev => prev.map(c => c.id === id ? { ...c, name } : c))
  }

  function handleTypeChange(id: string, col_type: string) {
    const updated = cols.map(c => c.id === id ? { ...c, col_type } : c)
    setCols(updated)
    save(updated)
  }

  function handleNameBlur() {
    save(cols)
  }

  function handleDragStart(idx: number) {
    setDragIdx(idx)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, idx: number) {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const reordered = [...cols]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(idx, 0, moved)
    setDragIdx(idx)
    setCols(reordered)
  }

  function handleDrop() {
    if (dragIdx === null) return
    setDragIdx(null)
    save(cols)
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {cols.map((col, idx) => (
          <div
            key={col.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={e => handleDragOver(e, idx)}
            onDrop={handleDrop}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: '#111', borderRadius: 6, padding: '6px 10px',
              cursor: 'grab',
            }}
          >
            <span style={{ color: '#555', fontSize: '0.75rem', userSelect: 'none' }}>⠿</span>
            <input
              value={col.name}
              onChange={e => handleNameChange(col.id, e.target.value)}
              onBlur={handleNameBlur}
              placeholder="Column name"
              style={{
                flex: 1, background: '#1a1a1a', border: '1px solid #2a2a2a',
                borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem',
                padding: '4px 8px',
              }}
            />
            <select
              value={col.col_type}
              onChange={e => handleTypeChange(col.id, e.target.value)}
              style={{
                background: '#1a1a1a', border: '1px solid #2a2a2a',
                borderRadius: 4, color: '#e5e5e5', fontSize: '0.8rem',
                padding: '4px 6px',
              }}
            >
              {Object.entries(COL_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <button
        onClick={handleAddColumn}
        style={{
          fontSize: '0.8rem', color: '#60a5fa', background: 'none',
          border: '1px dashed #1e3a5f', borderRadius: 6,
          padding: '5px 12px', cursor: 'pointer', width: '100%',
        }}
      >
        Add a column
      </button>
      {saving && (
        <span style={{ fontSize: '0.7rem', color: '#555', marginLeft: 8 }}>Saving…</span>
      )}
    </div>
  )
}
