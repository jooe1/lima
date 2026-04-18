'use client'

import React, { useState, useEffect } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { type Connector, listConnectors } from '../../../../lib/api'
import { ColumnEditor } from './ColumnEditor'

interface TableWidgetPreviewProps {
  node: AuraNode
  workspaceId: string
  /** The existing table preview to render below the column editor toggle */
  children: React.ReactNode
  onUpdate?: (node: AuraNode) => void
}

function extractConnectorColumns(connector: Connector | undefined): string[] {
  if (!connector?.schema_cache) return []
  const cache = connector.schema_cache as Record<string, unknown>
  // CSV / managed connectors: top-level columns array
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
  // SQL connectors: schema_cache.tables[].columns
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

export function TableWidgetPreview({ node, workspaceId, children, onUpdate }: TableWidgetPreviewProps) {
  const [editing, setEditing] = useState(false)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loadingSchema, setLoadingSchema] = useState(false)
  const [localConnectorId, setLocalConnectorId] = useState('')
  const [localColumnsStr, setLocalColumnsStr] = useState('')

  useEffect(() => { setEditing(false) }, [node.id])

  // Load connectors when editing opens so we can surface schema columns
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

  const columnsStr = node.style?.columns ?? node.with?.columns ?? ''
  const localConnector = connectors.find(c => c.id === localConnectorId)
  const localConnectorType = localConnector?.type ?? ''
  const isStructured = localConnectorType !== 'rest' && localConnectorType !== 'graphql'
  const schemaColumns = localConnectorId && isStructured ? extractConnectorColumns(localConnector) : []

  function openEditing() {
    setLocalConnectorId(node.with?.connector ?? '')
    setLocalColumnsStr(columnsStr)
    setEditing(true)
  }

  // When the connector dropdown changes, auto-populate all schema columns
  function handleConnectorChange(newId: string) {
    setLocalConnectorId(newId)
    if (newId) {
      const connector = connectors.find(c => c.id === newId)
      const cols = extractConnectorColumns(connector)
      setLocalColumnsStr(cols.length > 0 ? cols.join(', ') : '')
    } else {
      setLocalColumnsStr('')
    }
  }

  function handleSave(newColumnsStr: string) {
    if (!onUpdate) return
    const newWith: Record<string, string> = { ...(node.with ?? {}) }
    if (localConnectorId) {
      newWith.connector = localConnectorId
      if (localConnectorType) newWith.connectorType = localConnectorType
    } else {
      delete newWith.connector
      delete newWith.connectorType
    }
    onUpdate({
      ...node,
      manuallyEdited: true,
      with: newWith as AuraNode['with'],
      style: { ...(node.style ?? {}), columns: newColumnsStr },
    })
    setEditing(false)
  }

  if (editing) {
    return (
      <div
        data-interactive-preview="1"
        style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', overflow: 'auto' }}
      >
        {/* Connector selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
          <label style={{ fontSize: '0.6rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            Connector
          </label>
          <select
            value={localConnectorId}
            onChange={e => handleConnectorChange(e.target.value)}
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
          <div style={{ fontSize: '0.58rem', color: '#444', lineHeight: 1.4, flexShrink: 0 }}>
            REST / GraphQL connectors don't expose a schema — enter column names manually.
          </div>
        )}
        <ColumnEditor
          key={localConnectorId || '__none__'}
          columnsStr={localColumnsStr}
          sourceColumns={schemaColumns}
          noun="columns"
          onSave={handleSave}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

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
          ✎ columns
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
