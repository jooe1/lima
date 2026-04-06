import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ConnectorWizard } from './ConnectorWizard'

const mockCreateConnector = vi.fn()
const mockSetManagedTableColumns = vi.fn()
const mockGetConnector = vi.fn()
const mockUpsertConnectorAction = vi.fn()
const mockSendConnectorChatMessage = vi.fn()

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('../../../lib/api', () => ({
  createConnector: (...args: unknown[]) => mockCreateConnector(...args),
  setManagedTableColumns: (...args: unknown[]) => mockSetManagedTableColumns(...args),
  getConnector: (...args: unknown[]) => mockGetConnector(...args),
  upsertConnectorAction: (...args: unknown[]) => mockUpsertConnectorAction(...args),
  sendConnectorChatMessage: (...args: unknown[]) => mockSendConnectorChatMessage(...args),
}))

// ---- Mock FileReader for CSV preview tests --------------------------------

class MockFileReader {
  onload: ((ev: { target: { result: string } }) => void) | null = null
  result: string | null = null

  readAsText(_file: Blob) {
    const content = 'Name,Age\nAlice,30\nBob,25\nCarol,27\nDan,35\nEve,29\nFrank,40'
    queueMicrotask(() => {
      this.result = content
      this.onload?.({ target: { result: content } })
    })
  }
}

// ---- Default props --------------------------------------------------------

const defaultProps = {
  connectorType: 'postgres' as const,
  workspaceId: 'ws-1',
  onComplete: vi.fn(),
  onBack: vi.fn(),
}

describe('ConnectorWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateConnector.mockImplementation(async (_workspaceId: string, data: { name: string; type: string }) => ({
      id: 'c-1',
      workspace_id: 'ws-1',
      name: data.name,
      type: data.type,
      created_by: 'u-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      owner_scope: 'workspace',
    }))
    mockSetManagedTableColumns.mockResolvedValue({ columns: [] })
    mockGetConnector.mockImplementation(async (_workspaceId: string, _id: string) => ({
      id: 'c-1',
      workspace_id: 'ws-1',
      name: 'Leads',
      type: 'managed',
      created_by: 'u-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      owner_scope: 'workspace',
    }))
    mockUpsertConnectorAction.mockResolvedValue({ action: {} })
    mockSendConnectorChatMessage.mockResolvedValue({
      conversationId: 'conv-1',
      message: 'Hello! Please share your API docs URL.',
      done: false,
    })
  })

  // ---- Step 1 --------------------------------------------------------------

  it('starts on step 1 and shows name/description inputs', () => {
    render(<ConnectorWizard {...defaultProps} />)
    expect(screen.getByText('step1.title')).toBeTruthy()
    expect(screen.getByPlaceholderText('fields.name.placeholder')).toBeTruthy()
    expect(screen.getByPlaceholderText('fields.description.placeholder')).toBeTruthy()
  })

  it('Next button is disabled when name is empty on step 1', () => {
    render(<ConnectorWizard {...defaultProps} />)
    expect((screen.getByText('next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onBack when Back is clicked on step 1', () => {
    const onBack = vi.fn()
    render(<ConnectorWizard {...defaultProps} onBack={onBack} />)
    fireEvent.click(screen.getByText('back'))
    expect(onBack).toHaveBeenCalledOnce()
  })

  // ---- Step navigation -----------------------------------------------------

  it('navigates from step 1 to step 2 when name is filled and Next is clicked', () => {
    render(<ConnectorWizard {...defaultProps} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My DB' } })
    fireEvent.click(screen.getByText('next'))
    expect(screen.getByText('step2.title')).toBeTruthy()
  })

  it('navigates back from step 2 to step 1', () => {
    render(<ConnectorWizard {...defaultProps} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My DB' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('back'))
    expect(screen.getByText('step1.title')).toBeTruthy()
  })

  it('navigates forward through all 3 steps', () => {
    render(<ConnectorWizard {...defaultProps} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My DB' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('next'))
    expect(screen.getByText('step3.title')).toBeTruthy()
  })

  // ---- Value persistence ---------------------------------------------------

  it('preserves name and description when navigating back from step 2', () => {
    render(<ConnectorWizard {...defaultProps} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'Production DB' } })
    fireEvent.change(screen.getByPlaceholderText('fields.description.placeholder'), { target: { value: 'Main database' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('back'))
    expect((screen.getByPlaceholderText('fields.name.placeholder') as HTMLInputElement).value).toBe('Production DB')
    expect((screen.getByPlaceholderText('fields.description.placeholder') as HTMLInputElement).value).toBe('Main database')
  })

  // ---- Step 3 extensibility ------------------------------------------------

  it('shows default placeholder on step 3 when no children passed', () => {
    render(<ConnectorWizard {...defaultProps} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'DB' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('next'))
    expect(screen.getByText('step3.placeholder')).toBeTruthy()
  })

  it('renders custom step3 content via children prop', () => {
    render(
      <ConnectorWizard {...defaultProps}>
        <div>custom-step3-slot</div>
      </ConnectorWizard>,
    )
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'DB' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('next'))
    expect(screen.getByText('custom-step3-slot')).toBeTruthy()
  })

  it('lets shared tables define initial columns before finish and saves them', async () => {
    const onComplete = vi.fn()
    render(<ConnectorWizard {...defaultProps} connectorType="managed" onComplete={onComplete} />)

    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'Leads' } })
    fireEvent.click(screen.getByText('next'))

    expect(screen.getByText('managed.columnsTitle')).toBeTruthy()
    const initialInput = screen.getByPlaceholderText('Column name') as HTMLInputElement
    fireEvent.change(initialInput, { target: { value: 'Email' } })
    expect(screen.getByDisplayValue('Email')).toBeTruthy()

    fireEvent.click(screen.getByText('Add a column'))
    const columnInputs = screen.getAllByPlaceholderText('Column name') as HTMLInputElement[]
    fireEvent.change(columnInputs[1], { target: { value: 'Company' } })

    fireEvent.click(screen.getByText('managed.finish'))

    await waitFor(() => expect(mockCreateConnector).toHaveBeenCalledOnce())
    expect(mockSetManagedTableColumns).toHaveBeenCalledWith(
      'ws-1',
      'c-1',
      [
        { name: 'Email', col_type: 'text', nullable: true },
        { name: 'Company', col_type: 'text', nullable: true },
      ],
    )
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ type: 'managed', name: 'Leads' }))
  })

  // ---- REST AI chat panel --------------------------------------------------

  it('shows Set up with AI and Manual setup toggles for REST on step 2', () => {
    render(<ConnectorWizard {...defaultProps} connectorType="rest" />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My API' } })
    fireEvent.click(screen.getByText('next'))
    expect(screen.getByText('Set up with AI')).toBeTruthy()
    expect(screen.getByText('Manual setup')).toBeTruthy()
  })

  it('shows chat panel when Set up with AI is clicked', () => {
    render(<ConnectorWizard {...defaultProps} connectorType="rest" />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My API' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('Set up with AI'))
    expect(screen.getByPlaceholderText('Type a message…')).toBeTruthy()
    expect(screen.getByText('Send')).toBeTruthy()
  })

  it('does not show chat panel when Manual setup is clicked', () => {
    render(<ConnectorWizard {...defaultProps} connectorType="rest" />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My API' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('Manual setup'))
    expect(screen.queryByPlaceholderText('Type a message…')).toBeNull()
  })

  it('sends user message and displays AI reply', async () => {
    render(<ConnectorWizard {...defaultProps} connectorType="rest" />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'My API' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('Set up with AI'))

    const input = screen.getByPlaceholderText('Type a message…')
    fireEvent.change(input, { target: { value: 'https://docs.example.com' } })
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(mockSendConnectorChatMessage).toHaveBeenCalledOnce())
    expect(mockSendConnectorChatMessage).toHaveBeenCalledWith('ws-1', 'https://docs.example.com', undefined, 'My API')

    await waitFor(() => expect(screen.getByText('Hello! Please share your API docs URL.')).toBeTruthy())
  })

  it('calls onComplete when AI signals done', async () => {
    const onComplete = vi.fn()
    const connectorStub = { id: 'c-ai', workspace_id: 'ws-1', name: 'Stripe', type: 'rest', created_by: 'u-1', created_at: '', updated_at: '', owner_scope: 'workspace' }
    mockSendConnectorChatMessage.mockResolvedValue({
      conversationId: 'conv-1',
      message: 'Done! Connector created.',
      done: true,
      connectorId: 'c-ai',
    })
    mockGetConnector.mockResolvedValue(connectorStub)

    render(<ConnectorWizard {...defaultProps} connectorType="rest" onComplete={onComplete} />)
    fireEvent.change(screen.getByPlaceholderText('fields.name.placeholder'), { target: { value: 'Stripe' } })
    fireEvent.click(screen.getByText('next'))
    fireEvent.click(screen.getByText('Set up with AI'))

    const input = screen.getByPlaceholderText('Type a message…')
    fireEvent.change(input, { target: { value: 'https://stripe.com/docs/api' } })
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(mockGetConnector).toHaveBeenCalledWith('ws-1', 'c-ai'))
    // Panel stays open until the user explicitly clicks Continue
    expect(onComplete).not.toHaveBeenCalled()
    const continueBtn = await screen.findByRole('button', { name: 'Continue →' })
    fireEvent.click(continueBtn)
    expect(onComplete).toHaveBeenCalledWith(connectorStub)
  })
})
