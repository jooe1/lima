'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../lib/auth'
import {
  listConnectors,
  type Connector, type ConnectorType,
} from '../../../lib/api'
import { ConnectorWizard } from './ConnectorWizard'
import { ConnectorDrawer } from './ConnectorDrawer'
import { ConnectorDetailDrawer } from './ConnectorDetailDrawer'
import { ConnectorTypePicker } from './ConnectorTypePicker'
import { ConnectorList, type ConnectorCategory } from './ConnectorList'

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ConnectorsPage() {
  const { workspace, user } = useAuth()
  const isAdmin = user?.role === 'workspace_admin'

  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Selection & panels
  const [selected, setSelected] = useState<Connector | null>(null)
  const [drawerState, setDrawerState] = useState<'closed' | 'type-picker' | 'wizard' | 'detail'>('closed')
  const [wizardType, setWizardType] = useState<ConnectorType | null>(null)
  const [wizardDbBrand, setWizardDbBrand] = useState<'postgres' | 'mysql' | 'mssql' | undefined>(undefined)

  const [pickerCategory, setPickerCategory] = useState<ConnectorCategory | undefined>(undefined)

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    setError('')
    listConnectors(workspace.id)
      .then(res => setConnectors(res.connectors ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load connectors'))
      .finally(() => setLoading(false))
  }, [workspace])

  useEffect(() => { load() }, [load])

  function handleManage(c: Connector) {
    setSelected(c)
    setDrawerState('detail')
  }

  function handleNew() {
    setPickerCategory(undefined)
    setSelected(null)
    setWizardType(null)
    setWizardDbBrand(undefined)
    setDrawerState('type-picker')
  }

  function handleAdd(category: ConnectorCategory) {
    setSelected(null)

    if (category === 'files') {
      setPickerCategory(undefined)
      setWizardType('csv')
      setWizardDbBrand(undefined)
      setDrawerState('wizard')
      return
    }

    if (category === 'shared-tables') {
      setPickerCategory(undefined)
      setWizardType('managed')
      setWizardDbBrand(undefined)
      setDrawerState('wizard')
      return
    }

    setPickerCategory(category)
    setWizardType(null)
    setWizardDbBrand(undefined)
    setDrawerState('type-picker')
  }

  function handleTypeSelected(type: ConnectorType, dbBrand?: 'postgres' | 'mysql' | 'mssql') {
    setWizardType(type)
    setWizardDbBrand(dbBrand)
    setDrawerState('wizard')
  }

  function handleDrawerClose() {
    setDrawerState('closed')
    setWizardType(null)
    setWizardDbBrand(undefined)
    setPickerCategory(undefined)
  }

  function handleWizardComplete(c: Connector) {
    handleSaved(c)
    setWizardType(null)
    setWizardDbBrand(undefined)
    setPickerCategory(undefined)

    if (c.type === 'managed') {
      setSelected(c)
      setDrawerState('detail')
      return
    }

    setDrawerState('closed')
  }

  function handleSaved(c: Connector) {
    setConnectors(prev => {
      const idx = prev.findIndex(x => x.id === c.id)
      if (idx >= 0) return prev.map(x => x.id === c.id ? c : x)
      return [...prev, c]
    })
    setSelected(c)
  }

  function getDrawerTitle() {
    if (drawerState === 'wizard') {
      if (wizardType === 'managed') return 'New shared table'
      if (wizardType === 'csv') return 'New file'
      if (wizardType === 'rest') return 'New REST connector'
      if (wizardType === 'graphql') return 'New GraphQL connector'
      if (wizardType === 'postgres' || wizardType === 'mysql' || wizardType === 'mssql') {
        return 'New database connector'
      }
    }

    if (drawerState === 'type-picker') {
      if (pickerCategory === 'apis') return 'Choose API type'
      if (pickerCategory === 'databases') return 'Choose database'
    }

    return 'New connector'
  }

  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Connectors</h1>
        <span style={{ color: '#555', fontSize: '0.75rem' }}>
          Manage data source connections for your workspace.
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={ghostBtn} title="Refresh">↻</button>
        {isAdmin && <button onClick={handleNew} style={primaryBtn}>New connector</button>}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0 0 1rem' }}>{error}</p>}

      {/* Drawer: new connector flow (type picker → wizard) */}
      <ConnectorDrawer
        isOpen={drawerState === 'type-picker' || drawerState === 'wizard'}
        onClose={handleDrawerClose}
        title={getDrawerTitle()}
      >
        {drawerState === 'type-picker' && (
          <ConnectorTypePicker onSelect={handleTypeSelected} initialCategory={pickerCategory} />
        )}
        {drawerState === 'wizard' && wizardType && workspace && (
          <ConnectorWizard
            connectorType={wizardType}
            dbBrand={wizardDbBrand}
            workspaceId={workspace.id}
            onComplete={handleWizardComplete}
            onBack={() => setDrawerState('type-picker')}
          />
        )}
      </ConnectorDrawer>

      {/* Connector list */}
      {loading ? (
        <p style={{ color: '#555', fontSize: '0.8rem' }}>Loading…</p>
      ) : (
        <ConnectorList
          connectors={connectors}
          onManage={handleManage}
          onAdd={handleAdd}
        />
      )}

      <ConnectorDetailDrawer
        connector={selected}
        workspaceId={workspace?.id ?? ''}
        isOpen={drawerState === 'detail'}
        onClose={() => { setDrawerState('closed'); setSelected(null) }}
        onConnectorChange={load}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '0.5rem 1rem', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #1e1e1e', borderRadius: 6,
  color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 12px',
}

const dangerBtn: React.CSSProperties = {
  padding: '4px 12px', background: '#7f1d1d', color: '#fca5a5',
  border: 'none', borderRadius: 6, fontWeight: 500, fontSize: '0.75rem', cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem', background: '#1e1e1e', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: '0.85rem', outline: 'none',
  boxSizing: 'border-box',
}

