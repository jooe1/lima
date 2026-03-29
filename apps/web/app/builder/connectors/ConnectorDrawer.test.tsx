import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { ConnectorDrawer } from './ConnectorDrawer'
import { ConnectorTypePicker } from './ConnectorTypePicker'

// Mock next-intl: t(key) returns the key itself so labels are predictable
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// ---------------------------------------------------------------------------
// ConnectorDrawer
// ---------------------------------------------------------------------------

describe('ConnectorDrawer', () => {
  it('renders children when open', () => {
    render(
      <ConnectorDrawer isOpen={true} onClose={() => {}}>
        <div>drawer-content</div>
      </ConnectorDrawer>,
    )
    expect(screen.getByText('drawer-content')).toBeTruthy()
  })

  it('applies translateX(0) transform when open', () => {
    const { container } = render(
      <ConnectorDrawer isOpen={true} onClose={() => {}}>
        <span />
      </ConnectorDrawer>,
    )
    const panel = container.querySelector('[role="dialog"]') as HTMLElement
    expect(panel.style.transform).toBe('translateX(0)')
  })

  it('applies translateX(100%) transform when closed', () => {
    const { container } = render(
      <ConnectorDrawer isOpen={false} onClose={() => {}}>
        <span />
      </ConnectorDrawer>,
    )
    const panel = container.querySelector('[role="dialog"]') as HTMLElement
    expect(panel.style.transform).toBe('translateX(100%)')
  })

  it('renders the title when provided', () => {
    render(
      <ConnectorDrawer isOpen={true} onClose={() => {}} title="New connector">
        <span />
      </ConnectorDrawer>,
    )
    expect(screen.getByText('New connector')).toBeTruthy()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <ConnectorDrawer isOpen={true} onClose={onClose}>
        <span />
      </ConnectorDrawer>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <ConnectorDrawer isOpen={true} onClose={onClose}>
        <span />
      </ConnectorDrawer>,
    )
    const backdrop = container.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// ConnectorTypePicker
// ---------------------------------------------------------------------------

describe('ConnectorTypePicker', () => {
  it('calls onSelect with csv when spreadsheet tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const tile = container.querySelector('[data-tile="spreadsheet"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('csv')
  })

  it('calls onSelect with rest when web service tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const tile = container.querySelector('[data-tile="webService"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('rest')
  })

  it('calls onSelect with graphql when graphql tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const tile = container.querySelector('[data-tile="graphql"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('graphql')
  })

  it('calls onSelect with managed when shared table tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const tile = container.querySelector('[data-tile="sharedTable"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('managed')
  })

  it('does not call onSelect when moreOptions placeholder is clicked (disabled)', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const tile = container.querySelector('[data-tile="moreOptions"]') as HTMLButtonElement
    expect(tile.disabled).toBe(true)
    fireEvent.click(tile)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows database sub-step when database tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConnectorTypePicker onSelect={onSelect} />)
    const dbTile = container.querySelector('[data-tile="database"]') as HTMLElement
    fireEvent.click(dbTile)
    expect(container.querySelector('[data-tile="postgres"]')).toBeTruthy()
    expect(container.querySelector('[data-tile="mysql"]')).toBeTruthy()
    expect(container.querySelector('[data-tile="mssql"]')).toBeTruthy()
  })

  it('calls onSelect with postgres/postgres when PostgreSQL sub-tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ConnectorTypePicker onSelect={onSelect} initialCategory="databases" />,
    )
    const tile = container.querySelector('[data-tile="postgres"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('postgres', 'postgres')
  })

  it('calls onSelect with mysql/mysql when MySQL sub-tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ConnectorTypePicker onSelect={onSelect} initialCategory="databases" />,
    )
    const tile = container.querySelector('[data-tile="mysql"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('mysql', 'mysql')
  })

  it('calls onSelect with mssql/mssql when SQL Server sub-tile is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ConnectorTypePicker onSelect={onSelect} initialCategory="databases" />,
    )
    const tile = container.querySelector('[data-tile="mssql"]') as HTMLElement
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith('mssql', 'mssql')
  })

  it('returns to main tiles when back button is clicked in db sub-step', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ConnectorTypePicker onSelect={onSelect} initialCategory="databases" />,
    )
    // Sub-step is showing; click back
    const backBtn = screen.getByRole('button', { name: /back/i })
    fireEvent.click(backBtn)
    // Main tiles should be visible again
    expect(container.querySelector('[data-tile="spreadsheet"]')).toBeTruthy()
    expect(container.querySelector('[data-tile="postgres"]')).toBeNull()
  })

  it('shows only API choices when launched from the API category', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ConnectorTypePicker onSelect={onSelect} initialCategory="apis" />,
    )

    expect(container.querySelector('[data-tile="webService"]')).toBeTruthy()
    expect(container.querySelector('[data-tile="graphql"]')).toBeTruthy()
    expect(container.querySelector('[data-tile="spreadsheet"]')).toBeNull()
    expect(container.querySelector('[data-tile="sharedTable"]')).toBeNull()
  })
})
