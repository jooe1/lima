import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ConnectorSharingPanel } from './ConnectorSharingPanel'
import { useAuth } from '../../../lib/auth'

vi.mock('../../../lib/auth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../../lib/api', () => ({
  listConnectorGrants: vi.fn().mockResolvedValue({
    grants: [
      {
        id: 'g1', subject_id: 'u1', subject_type: 'user', action: 'manage', effect: 'allow',
        created_by: 'u1', resource_id: 'c1', resource_kind: 'connector', company_id: 'co1', created_at: '',
      },
      {
        id: 'g2', subject_id: 'u2', subject_type: 'user', action: 'query', effect: 'allow',
        created_by: 'u1', resource_id: 'c1', resource_kind: 'connector', company_id: 'co1', created_at: '',
      },
    ],
  }),
  createConnectorGrant: vi.fn().mockResolvedValue({
    id: 'g3', subject_id: 'u3', action: 'query', subject_type: 'user', effect: 'allow',
    created_by: 'u1', resource_id: 'c1', resource_kind: 'connector', company_id: 'co1', created_at: '',
  }),
  deleteConnectorGrant: vi.fn().mockResolvedValue(undefined),
}))

import { listConnectorGrants, createConnectorGrant, deleteConnectorGrant } from '../../../lib/api'

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} })
  ;(useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
    user: { id: 'u1', role: 'workspace_admin', email: '', name: '', language: 'en' },
    workspace: { id: 'ws1', company_id: 'co1', name: 'W' },
  })
})

const defaultProps = { connectorId: 'c1', workspaceId: 'ws1' }

describe('ConnectorSharingPanel', () => {
  it('shows loading state while fetching', () => {
    // make the promise never resolve during this render
    ;(listConnectorGrants as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}))
    render(<ConnectorSharingPanel {...defaultProps} />)
    expect(screen.getByText('Loading access list\u2026')).toBeDefined()
  })

  it('shows grantee chips after load', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByText('u1')).toBeDefined()
      expect(screen.getByText('u2')).toBeDefined()
    })
  })

  it('renders "Can view data" label for action: query grant', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => {
      const selects = screen.getAllByRole('combobox')
      // Find the select for u2 (query action) — the non-owner chip select
      const hasViewData = selects.some(s => (s as HTMLSelectElement).value === 'Can view data')
      expect(hasViewData).toBe(true)
    })
  })

  it('renders "Can view and edit data" label for action: mutate grant', async () => {
    ;(listConnectorGrants as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      grants: [
        {
          id: 'g1', subject_id: 'u1', subject_type: 'user', action: 'manage', effect: 'allow',
          created_by: 'u1', resource_id: 'c1', resource_kind: 'connector', company_id: 'co1', created_at: '',
        },
        {
          id: 'g2', subject_id: 'u2', subject_type: 'user', action: 'mutate', effect: 'allow',
          created_by: 'u1', resource_id: 'c1', resource_kind: 'connector', company_id: 'co1', created_at: '',
        },
      ],
    })
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => {
      const selects = screen.getAllByRole('combobox')
      const hasEditData = selects.some(s => (s as HTMLSelectElement).value === 'Can view and edit data')
      expect(hasEditData).toBe(true)
    })
  })

  it('remove button calls deleteConnectorGrant and removes chip', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => expect(screen.getByText('u2')).toBeDefined())

    const removeBtn = screen.getByRole('button', { name: 'Remove' })
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(deleteConnectorGrant).toHaveBeenCalledWith('ws1', 'c1', 'g2')
      expect(screen.queryByText('u2')).toBeNull()
    })
  })

  it('"Add a person" form submits createConnectorGrant with correct args', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())

    const input = screen.getByPlaceholderText('Add a person (enter their email or ID)')
    fireEvent.change(input, { target: { value: 'new@example.com' } })

    const addBtn = screen.getByRole('button', { name: 'Add' })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(createConnectorGrant).toHaveBeenCalledWith('ws1', 'c1', {
        subject_type: 'user',
        subject_id: 'new@example.com',
        action: 'query',
      })
    })
  })

  it('owner chip has no remove button', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())

    // There should be exactly one remove button (for u2, not u1 the owner)
    const removeBtns = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeBtns).toHaveLength(1)

    // The owner chip shows "Owner" label
    expect(screen.getByText('Owner')).toBeDefined()
  })

  it('admin toggle renders for admin user', async () => {
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())
    expect(screen.getByText('Restrict to read-only for everyone')).toBeDefined()
  })

  it('admin toggle does NOT render for member user', async () => {
    ;(useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { id: 'u2', role: 'member', email: '', name: '', language: 'en' },
      workspace: { id: 'ws1', company_id: 'co1', name: 'W' },
    })
    render(<ConnectorSharingPanel {...defaultProps} />)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())
    expect(screen.queryByText('Restrict to read-only for everyone')).toBeNull()
  })
})
