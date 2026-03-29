import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { ConnectorList } from './ConnectorList'
import type { Connector } from '../../../lib/api'

function makeConnector(partial: Partial<Connector> & { id: string; type: Connector['type'] }): Connector {
  return {
    workspace_id: 'ws-1',
    name: 'Test Connector',
    created_by: 'u-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    owner_scope: 'workspace',
    ...partial,
  }
}

describe('ConnectorList', () => {
  it('groups connectors by category: csv in Your Files, postgres in Databases', () => {
    const connectors = [
      makeConnector({ id: 'c1', type: 'csv', name: 'My CSV' }),
      makeConnector({ id: 'c2', type: 'postgres', name: 'My DB' }),
    ]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('Your Files')).toBeTruthy()
    expect(screen.getByText('Databases')).toBeTruthy()
    expect(screen.getByText('My CSV')).toBeTruthy()
    expect(screen.getByText('My DB')).toBeTruthy()
  })

  it('all four category headers are rendered', () => {
    render(<ConnectorList connectors={[]} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('Your Files')).toBeTruthy()
    expect(screen.getByText('Databases')).toBeTruthy()
    expect(screen.getByText('APIs & Web Services')).toBeTruthy()
    expect(screen.getByText('Shared Tables')).toBeTruthy()
  })

  it('empty categories show add-first link instead of connector rows', () => {
    render(<ConnectorList connectors={[]} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('＋ Add your first file')).toBeTruthy()
    expect(screen.getByText('＋ Add your first database')).toBeTruthy()
    expect(screen.getByText('＋ Add your first API')).toBeTruthy()
    expect(screen.getByText('＋ Add your first shared table')).toBeTruthy()
    expect(screen.queryAllByText('Manage')).toHaveLength(0)
  })

  it('category with connectors does not show add-first link for that category', () => {
    const connectors = [makeConnector({ id: 'c1', type: 'csv', name: 'My CSV' })]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.queryByText('＋ Add your first file')).toBeNull()
    // Other empty categories still show their links
    expect(screen.getByText('＋ Add your first database')).toBeTruthy()
    expect(screen.getByText('＋ Add your first API')).toBeTruthy()
    expect(screen.getByText('＋ Add your first shared table')).toBeTruthy()
  })

  it('status badge is "Connected" when schema_cached_at is within 7 days', () => {
    const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const connectors = [makeConnector({ id: 'c1', type: 'csv', name: 'Fresh CSV', schema_cached_at: recentDate })]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('status badge is "Not set up yet" when schema_cached_at is absent', () => {
    const connectors = [makeConnector({ id: 'c1', type: 'csv', name: 'No Schema CSV' })]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('Not set up yet')).toBeTruthy()
  })

  it('status badge is "Not set up yet" when schema_cached_at is older than 7 days', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const connectors = [makeConnector({ id: 'c1', type: 'postgres', name: 'Old DB', schema_cached_at: oldDate })]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('Not set up yet')).toBeTruthy()
  })

  it('clicking Manage button calls onManage with the connector', () => {
    const onManage = vi.fn()
    const connector = makeConnector({ id: 'c1', type: 'csv', name: 'Managed CSV' })
    render(<ConnectorList connectors={[connector]} onManage={onManage} onAdd={vi.fn()} />)
    fireEvent.click(screen.getByText('Manage'))
    expect(onManage).toHaveBeenCalledWith(connector)
  })

  it('clicking ＋ Add button in category header calls onAdd with the category', () => {
    const onAdd = vi.fn()
    const connector = makeConnector({ id: 'c1', type: 'csv', name: 'My CSV' })
    render(<ConnectorList connectors={[connector]} onManage={vi.fn()} onAdd={onAdd} />)
    fireEvent.click(screen.getByText('＋ Add'))
    expect(onAdd).toHaveBeenCalledWith('files')
  })

  it('clicking add-first link calls onAdd with the correct category', () => {
    const onAdd = vi.fn()
    render(<ConnectorList connectors={[]} onManage={vi.fn()} onAdd={onAdd} />)
    fireEvent.click(screen.getByText('＋ Add your first database'))
    expect(onAdd).toHaveBeenCalledWith('databases')
  })

  it('raw connector type codes are not rendered as visible text', () => {
    const connectors = [
      makeConnector({ id: 'c1', type: 'csv', name: 'My CSV' }),
      makeConnector({ id: 'c2', type: 'postgres', name: 'My DB' }),
      makeConnector({ id: 'c3', type: 'managed', name: 'My Table' }),
    ]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.queryAllByText('csv')).toHaveLength(0)
    expect(screen.queryAllByText('postgres')).toHaveLength(0)
    expect(screen.queryAllByText('managed')).toHaveLength(0)
  })

  it('mysql and mssql connectors appear in Databases group', () => {
    const connectors = [
      makeConnector({ id: 'c1', type: 'mysql', name: 'MySQL DB' }),
      makeConnector({ id: 'c2', type: 'mssql', name: 'SQL Server DB' }),
    ]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('MySQL DB')).toBeTruthy()
    expect(screen.getByText('SQL Server DB')).toBeTruthy()
  })

  it('graphql connector appears in APIs & Web Services group', () => {
    const connectors = [makeConnector({ id: 'c1', type: 'graphql', name: 'GraphQL API' })]
    render(<ConnectorList connectors={connectors} onManage={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText('GraphQL API')).toBeTruthy()
    expect(screen.queryByText('＋ Add your first API')).toBeNull()
  })
})
