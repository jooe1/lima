import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { ConnectorEducationCard } from './ConnectorEducationCard'
import type { Connector } from '../../../lib/api'

function makeConnector(type: Connector['type']): Connector {
  return {
    id: 'c-1',
    workspace_id: 'ws-1',
    name: 'Test Connector',
    type,
    created_by: 'u-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    owner_scope: 'workspace',
  }
}

// Provide a working in-memory localStorage (Node 22 built-in is broken without --localstorage-file)
function makeLocalStorageMock() {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
}

describe('ConnectorEducationCard', () => {
  let lsMock: ReturnType<typeof makeLocalStorageMock>

  beforeEach(() => {
    lsMock = makeLocalStorageMock()
    vi.stubGlobal('localStorage', lsMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders csv body text and CTA "Use in an app"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('csv')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Use in an app')).toBeTruthy()
    expect(screen.getByText(/Your file is ready/)).toBeTruthy()
  })

  it('renders postgres CTA "Test the connection"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('postgres')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Test the connection')).toBeTruthy()
  })

  it('renders mysql CTA "Test the connection"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('mysql')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Test the connection')).toBeTruthy()
  })

  it('renders mssql CTA "Test the connection"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('mssql')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Test the connection')).toBeTruthy()
  })

  it('renders rest CTA "Add an action"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('rest')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Add an action')).toBeTruthy()
  })

  it('renders graphql CTA "Add an action"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('graphql')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Add an action')).toBeTruthy()
  })

  it('renders managed CTA "Add a column"', () => {
    render(
      <ConnectorEducationCard
        connector={makeConnector('managed')}
        onDismiss={vi.fn()}
        onCTA={vi.fn()}
      />,
    )
    expect(screen.getByText('Add a column')).toBeTruthy()
  })

  it('hides card when localStorage dismissed key is set on mount', () => {
    localStorage.setItem('lima_edu_dismissed_c-1', 'true')
    const { container } = render(
      <ConnectorEducationCard connector={makeConnector('csv')} onDismiss={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('writes localStorage key and calls onDismiss when dismiss button clicked', () => {
    const onDismiss = vi.fn()
    render(
      <ConnectorEducationCard connector={makeConnector('csv')} onDismiss={onDismiss} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(localStorage.getItem('lima_edu_dismissed_c-1')).toBe('true')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('card disappears after dismiss click', () => {
    const { container } = render(
      <ConnectorEducationCard connector={makeConnector('csv')} onDismiss={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(container.firstChild).toBeNull()
  })

  it('does not render onCTA button when onCTA prop is omitted', () => {
    render(
      <ConnectorEducationCard connector={makeConnector('csv')} onDismiss={vi.fn()} />,
    )
    expect(screen.queryByText('Use in an app')).toBeNull()
  })
})
