import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ActionForm, HTTP_METHOD_TILES } from './ActionForm'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const mockUpsertConnectorAction = vi.fn()

vi.mock('../../../lib/api', () => ({
  upsertConnectorAction: (...args: unknown[]) => mockUpsertConnectorAction(...args),
}))

const defaultProps = {
  connectorId: 'conn-1',
  workspaceId: 'ws-1',
  onSave: vi.fn(),
  onCancel: vi.fn(),
}

const mockAction = {
  id: 'act-1',
  connector_id: 'conn-1',
  action_key: 'test_action',
  action_label: 'Test action',
  resource_name: '',
  http_method: 'POST',
  path_template: '/test',
  input_fields: [],
  created_at: '',
  updated_at: '',
}

describe('ActionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsertConnectorAction.mockResolvedValue(mockAction)
  })

  // ---- HTTP_METHOD_TILES constant ------------------------------------------

  it('HTTP_METHOD_TILES maps "Fetch data" to "GET"', () => {
    expect(HTTP_METHOD_TILES['Fetch data']).toBe('GET')
  })

  it('HTTP_METHOD_TILES maps "Send data" to "POST"', () => {
    expect(HTTP_METHOD_TILES['Send data']).toBe('POST')
  })

  it('HTTP_METHOD_TILES maps "Update" to "PUT"', () => {
    expect(HTTP_METHOD_TILES['Update']).toBe('PUT')
  })

  it('HTTP_METHOD_TILES maps "Delete" to "DELETE"', () => {
    expect(HTTP_METHOD_TILES['Delete']).toBe('DELETE')
  })

  // ---- Method tile selection flows into submitted http_method ---------------

  it('clicking "Send data" tile submits http_method POST', async () => {
    render(<ActionForm {...defaultProps} />)

    fireEvent.change(screen.getByPlaceholderText('actionNamePlaceholder'), {
      target: { value: 'My action' },
    })
    fireEvent.click(screen.getByText('Send data'))

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(mockUpsertConnectorAction).toHaveBeenCalledWith(
        'ws-1',
        'conn-1',
        expect.objectContaining({ http_method: 'POST' }),
      )
    })
  })

  it('clicking "Fetch data" tile submits http_method GET', async () => {
    // Start with a different method selected by providing an action prop
    render(<ActionForm {...defaultProps} action={{ ...mockAction, http_method: 'POST' }} />)

    fireEvent.change(screen.getByPlaceholderText('actionNamePlaceholder'), {
      target: { value: 'My action' },
    })
    fireEvent.click(screen.getByText('Fetch data'))

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(mockUpsertConnectorAction).toHaveBeenCalledWith(
        'ws-1',
        'conn-1',
        expect.objectContaining({ http_method: 'GET' }),
      )
    })
  })

  it('clicking "Delete" tile submits http_method DELETE', async () => {
    render(<ActionForm {...defaultProps} />)

    fireEvent.change(screen.getByPlaceholderText('actionNamePlaceholder'), {
      target: { value: 'Remove item' },
    })
    fireEvent.click(screen.getByText('Delete'))

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(mockUpsertConnectorAction).toHaveBeenCalledWith(
        'ws-1',
        'conn-1',
        expect.objectContaining({ http_method: 'DELETE' }),
      )
    })
  })

  // ---- Advanced options toggle ---------------------------------------------

  it('"Advanced options" toggle reveals hidden fields', () => {
    render(<ActionForm {...defaultProps} />)

    // Advanced fields not in DOM initially
    expect(screen.queryByTestId('advanced-action-key')).toBeNull()
    expect(screen.queryByText('resourceName')).toBeNull()
    expect(screen.queryByText('inputFields')).toBeNull()

    // Click the toggle
    fireEvent.click(screen.getByText(/advancedOptions/))

    // Advanced fields now visible
    expect(screen.getByTestId('advanced-action-key')).toBeTruthy()
    expect(screen.getByText('resourceName')).toBeTruthy()
    expect(screen.getByText('inputFields')).toBeTruthy()
  })

  it('"Advanced options" toggle hides fields again when clicked twice', () => {
    render(<ActionForm {...defaultProps} />)

    fireEvent.click(screen.getByText(/advancedOptions/))
    expect(screen.getByTestId('advanced-action-key')).toBeTruthy()

    fireEvent.click(screen.getByText(/hideAdvanced/))
    expect(screen.queryByTestId('advanced-action-key')).toBeNull()
  })

  // ---- Rendering -----------------------------------------------------------

  it('shows "newTitle" when no action prop passed', () => {
    render(<ActionForm {...defaultProps} />)
    expect(screen.getByText('newTitle')).toBeTruthy()
  })

  it('shows "editTitle" when action prop is passed', () => {
    render(<ActionForm {...defaultProps} action={mockAction} />)
    expect(screen.getByText('editTitle')).toBeTruthy()
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(<ActionForm {...defaultProps} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
