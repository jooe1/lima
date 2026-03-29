import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ManagedColumnBuilder, COL_TYPE_LABELS } from './ManagedColumnBuilder'
import type { ManagedTableColumn } from '../../../lib/api'

const mockSetManagedTableColumns = vi.fn()

vi.mock('../../../lib/api', () => ({
  setManagedTableColumns: (...args: unknown[]) => mockSetManagedTableColumns(...args),
}))

function makeCol(partial: Partial<ManagedTableColumn> & { id: string }): ManagedTableColumn {
  return {
    name: 'email',
    col_type: 'text',
    nullable: true,
    col_order: 0,
    ...partial,
  }
}

const defaultProps = {
  connectorId: 'conn-1',
  workspaceId: 'ws-1',
  onColumnsChange: vi.fn(),
}

describe('ManagedColumnBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetManagedTableColumns.mockResolvedValue({ columns: [] })
  })

  it('renders existing column names', () => {
    const cols = [makeCol({ id: 'c1', name: 'email', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} />)
    expect(screen.getByDisplayValue('email')).toBeTruthy()
  })

  it('"Add a column" button appends a blank row', () => {
    render(<ManagedColumnBuilder {...defaultProps} columns={[]} />)
    expect(screen.queryAllByPlaceholderText('Column name')).toHaveLength(0)
    fireEvent.click(screen.getByText('Add a column'))
    expect(screen.getAllByPlaceholderText('Column name')).toHaveLength(1)
  })

  it('multiple clicks on "Add a column" append multiple rows', () => {
    render(<ManagedColumnBuilder {...defaultProps} columns={[]} />)
    fireEvent.click(screen.getByText('Add a column'))
    fireEvent.click(screen.getByText('Add a column'))
    expect(screen.getAllByPlaceholderText('Column name')).toHaveLength(2)
  })

  it('shows plain type labels in the type select (not raw col_type)', () => {
    const cols = [makeCol({ id: 'c1', name: 'age', col_type: 'int4', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} />)
    // "Number" label should be visible; raw "int4" should not appear as option text
    expect(screen.getAllByText('Number').length).toBeGreaterThan(0)
  })

  it('renders "Text", "Yes/No", "Date", "File" type labels', () => {
    const cols = [makeCol({ id: 'c1', name: 'col', col_type: 'text', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} />)
    expect(screen.getByText('Text')).toBeTruthy()
    expect(screen.getByText('Yes/No')).toBeTruthy()
    expect(screen.getAllByText('Date').length).toBeGreaterThanOrEqual(2) // date + timestamp both map to Date
    expect(screen.getByText('File')).toBeTruthy()
  })

  it('blur on name input calls save API', async () => {
    const cols = [makeCol({ id: 'c1', name: 'email', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} />)
    const input = screen.getByDisplayValue('email')
    fireEvent.change(input, { target: { value: 'username' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetManagedTableColumns).toHaveBeenCalledOnce())
    expect(mockSetManagedTableColumns).toHaveBeenCalledWith(
      'ws-1',
      'conn-1',
      expect.arrayContaining([expect.objectContaining({ name: 'username', col_type: 'text' })]),
    )
  })

  it('changing type calls save API immediately', async () => {
    const cols = [makeCol({ id: 'c1', name: 'count', col_type: 'text', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} />)
    const select = screen.getAllByRole('combobox')[0]
    fireEvent.change(select, { target: { value: 'int4' } })
    await waitFor(() => expect(mockSetManagedTableColumns).toHaveBeenCalledOnce())
    expect(mockSetManagedTableColumns).toHaveBeenCalledWith(
      'ws-1',
      'conn-1',
      expect.arrayContaining([expect.objectContaining({ col_type: 'int4' })]),
    )
  })

  it('onColumnsChange is called after successful save', async () => {
    const onColumnsChange = vi.fn()
    const cols = [makeCol({ id: 'c1', name: 'email', col_order: 0 })]
    render(<ManagedColumnBuilder {...defaultProps} columns={cols} onColumnsChange={onColumnsChange} />)
    fireEvent.blur(screen.getByDisplayValue('email'))
    await waitFor(() => expect(onColumnsChange).toHaveBeenCalledOnce())
  })

  // ---- COL_TYPE_LABELS constant -------------------------------------------

  it('COL_TYPE_LABELS exports correct mappings', () => {
    expect(COL_TYPE_LABELS['text']).toBe('Text')
    expect(COL_TYPE_LABELS['int4']).toBe('Number')
    expect(COL_TYPE_LABELS['float8']).toBe('Number')
    expect(COL_TYPE_LABELS['bool']).toBe('Yes/No')
    expect(COL_TYPE_LABELS['date']).toBe('Date')
    expect(COL_TYPE_LABELS['timestamp']).toBe('Date')
    expect(COL_TYPE_LABELS['bytea']).toBe('File')
  })
})
