import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ConnectorWizard } from './ConnectorWizard'

const mockCreateConnector = vi.fn()
const mockSetManagedTableColumns = vi.fn()
const mockGetConnector = vi.fn()

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('../../../lib/api', () => ({
  createConnector: (...args: unknown[]) => mockCreateConnector(...args),
  setManagedTableColumns: (...args: unknown[]) => mockSetManagedTableColumns(...args),
  getConnector: (...args: unknown[]) => mockGetConnector(...args),
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
})
