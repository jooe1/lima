'use client'

import React, { useState, useEffect } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { type Connector, listConnectors } from '../../../../lib/api'

interface ChartWidgetPreviewProps {
  node: AuraNode
  workspaceId: string
  children: React.ReactNode
  onUpdate?: (node: AuraNode) => void
}

function extractConnectorColumns(connector: Connector | undefined): string[] {
  if (!connector?.schema_cache) return []
  const cache = connector.schema_cache as Record<string, unknown>
  const flat = cache.columns
  if (Array.isArray(flat)) {
    return flat.flatMap(c => {
      if (typeof c === 'string') return [c]
      if (c && typeof c === 'object' && 'name' in c) {
        const n = (c as { name: unknown }).name
        return typeof n === 'string' && n.trim() ? [n] : []
      }
      return []
    })
  }
  const tables = cache.tables
  if (Array.isArray(tables)) {
    return tables.flatMap(t => {
      if (!t || typeof t !== 'object') return []
      const cols = (t as { columns?: unknown }).columns
      if (!Array.isArray(cols)) return []
      return cols.flatMap(c => {
        if (typeof c === 'string') return [c]
        if (c && typeof c === 'object' && 'name' in c) {
          const n = (c as { name: unknown }).name
          return typeof n === 'string' && n.trim() ? [n] : []
        }
        return []
      })
    })
  }
  return []
}

export function ChartWidgetPreview({ node, workspaceId, children, onUpdate }: ChartWidgetPreviewProps) {
  const [editing, setEditing] = useState(false)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loadingSchema, setLoadingSchema] = useState(false)
  const [localConnectorId, setLocalConnectorId] = useState('')
  const [localLabelCol, setLocalLabelCol] = useState('')
  const [localValueCol, setLocalValueCol] = useState('')

  useEffect(() => { setEditing(false) }, [node.id])

  // Load connectors when editing opens
  useEffect(() => {
    if (!editing || !workspaceId) return
    let cancelled = false
    setLoadingSchema(true)
    listConnectors(workspaceId)
      .then(res => { if (!cancelled) setConnectors(res.connectors ?? []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingSchema(false) })
    return () => { cancelled = true }
  }, [editing, workspaceId])

  const localConnector = connectors.find(c => c.id === localConnectorId)
  const localConnectorType = localConnector?.type ?? ''
  const isStructured = localConnectorType !== 'rest' && localConnectorType !== 'graphql'
  const schemaColumns = localConnectorId && isStructured ? extractConnectorColumns(localConnector) : []

  function openEditing() {
    setLocalConnectorId(node.with?.connector ?? '')
    setLocalLabelCol(node.with?.labelCol ?? node.style?.labelCol ?? '')
    setLocalValueCol(node.with?.valueCol ?? node.style?.valueCol ?? '')
    setEditing(true)
  }

  function handleSave() {
    if (!onUpdate) return
    const newWith: Record<string, string> = { ...(node.with ?? {}) }
    if (localConnectorId) {
      newWith.connector = localConnectorId
      if (localConnectorType) newWith.connectorType = localConnectorType
    } else {
      delete newWith.connector
      delete newWith.connectorType
    }
    newWith.labelCol = localLabelCol.trim()
    newWith.valueCol = localValueCol.trim()
    onUpdate({
      ...node,
      manuallyEdited: true,
      with: newWith as AuraNode['with'],
    })
    setEditing(false)
  }

  const inputStyle: React.CSSProperties = {
    background: '#161616',
    border: '1px solid #222',
    borderRadius: 3,
    color: '#e5e5e5',
    fontSize: '0.72rem',
    padding: '4px 8px',
    flex: 1,
    outline: 'none',
    minWidth: 0,
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'auto' as React.CSSProperties['appearance'],
  }

  const btnStyle = (variant: 'primary' | 'ghost'): React.CSSProperties => ({
    background: variant === 'primary' ? '#1d4ed8' : 'transparent',
    border: variant === 'ghost' ? '1px solid #1e3a8a' : 'none',
    borderRadius: 3,
    color: variant === 'primary' ? '#c7d9ff' : '#60a5fa',
    cursor: 'pointer',
    fontSize: '0.68rem',
    padding: variant === 'primary' ? '4px 12px' : '3px 8px',
  })

  if (editing) {
    return (
      <div
        data-interactive-preview="1"
        style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflow: 'auto' }}
      >
        <div style={{ fontSize: '0.6rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Chart data
        </div>

        {/* Connector selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: '0.62rem', color: '#888' }}>Connector</label>
          <select
            value={localConnectorId}
            onChange={e => setLocalConnectorId(e.target.value)}
            disabled={loadingSchema}
            style={{
              background: '#161616',
              border: '1px solid #222',
              borderRadius: 3,
              color: '#e5e5e5',
              fontSize: '0.72rem',
              padding: '4px 8px',
              width: '100%',
              outline: 'none',
              opacity: loadingSchema ? 0.5 : 1,
            }}
          >
            <option value="">— no connector —</option>
            {connectors.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
            ))}
          </select>
        </div>
        {localConnectorId && !isStructured && (
          <div style={{ fontSize: '0.58rem', color: '#444', lineHeight: 1.4 }}>
            REST / GraphQL connectors don't expose a schema — type column names manually.
          </div>
        )}

        {/* Label column (x-axis) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: '0.62rem', color: '#888' }}>Label column (x-axis / categories)</label>
          {schemaColumns.length > 0 ? (
            <select value={localLabelCol} onChange={e => setLocalLabelCol(e.target.value)} style={selectStyle}>
              <option value="">— pick column —</option>
              {schemaColumns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={localLabelCol}
              onChange={e => setLocalLabelCol(e.target.value)}
              placeholder="e.g. category"
              style={inputStyle}
            />
          )}
        </div>

        {/* Value column (y-axis) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: '0.62rem', color: '#888' }}>Value column (y-axis / numbers)</label>
          {schemaColumns.length > 0 ? (
            <select value={localValueCol} onChange={e => setLocalValueCol(e.target.value)} style={selectStyle}>
              <option value="">— pick column —</option>
              {schemaColumns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={localValueCol}
              onChange={e => setLocalValueCol(e.target.value)}
              placeholder="e.g. revenue"
              style={inputStyle}
            />
          )}
        </div>

        {/* Save / Cancel */}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={handleSave} style={btnStyle('primary')}>Save</button>
          <button onClick={() => setEditing(false)} style={btnStyle('ghost')}>Cancel</button>
        </div>
      </div>
    )
  }

  const currentLabelCol = node.with?.labelCol ?? node.style?.labelCol ?? ''
  const currentValueCol = node.with?.valueCol ?? node.style?.valueCol ?? ''

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
        <button
          onClick={openEditing}
          style={{
            background: 'transparent',
            border: '1px solid #1e3a8a',
            borderRadius: 3,
            color: '#60a5fa',
            cursor: 'pointer',
            fontSize: '0.58rem',
            padding: '2px 6px',
          }}
        >
          {currentLabelCol || currentValueCol
            ? `✎ ${currentLabelCol || '?'} / ${currentValueCol || '?'}`
            : '✎ configure'}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
