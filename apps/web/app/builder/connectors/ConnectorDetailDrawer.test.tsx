import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { ConnectorDetailDrawer } from './ConnectorDetailDrawer'
import { useAuth } from '../../../lib/auth'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('../../../lib/auth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../../lib/api', () => ({
  testConnector: vi.fn().mockResolvedValue({ ok: true }),
  getManagedTableColumns: vi.fn().mockResolvedValue({ columns: [] }),
  listConnectorActions: vi.fn().mockResolvedValue({ actions: [] }),
  patchConnector: vi.fn().mockResolvedValue({}),
  runConnectorQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], row_count: 0 }),
  getConnectorSchema: vi.fn().mockResolvedValue({ schema: null }),
  deleteConnectorAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./ConnectorEducationCard', () => ({
  ConnectorEducationCard: () => <div data-testid="edu-card" />,
}))

vi.mock('./ManagedColumnBuilder', () => ({
  ManagedColumnBuilder: () => <div data-testid="col-builder" />,
  COL_TYPE_LABELS: {},
}))

vi.mock('./CredentialSteps', () => ({
  DatabaseStep: () => <div data-testid="db-step" />,
  RestStep: () => <div data-testid="rest-step" />,
  CsvStep: () => <div data-testid="csv-step" />,
  ManagedStep: () => <div data-testid="managed-step" />,
  GraphQLStep: () => <div data-testid="graphql-step" />,
}))

vi.mock('./ActionForm', () => ({
  ActionForm: () => <div data-testid="action-form" />,
}))

const connector = {
  id: 'c1',
  name: 'Test DB',
  type: 'postgres' as const,
  schema_cache: null,
  schema_cached_at: undefined,
  credentials: {},
  created_by: 'u1',
  created_at: '',
  updated_at: '',
  owner_scope: 'workspace',
}

const memberUser = {
  user: { role: 'member' as const, id: 'u1', email: '', name: '', language: 'en' as const },
  workspace: { id: 'ws1', company_id: 'c1', name: 'W' },
}

const adminUser = {
  user: { role: 'workspace_admin' as const, id: 'u1', email: '', name: '', language: 'en' as const },
  workspace: { id: 'ws1', company_id: 'c1', name: 'W' },
}

// Node 22 has a broken built-in localStorage; stub with a proper in-memory mock
function makeLocalStorageMock() {
  const store: Record<string, string> = {}
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
  }
}

beforeEach(() => {
  ;(useAuth as ReturnType<typeof vi.fn>).mockReturnValue(memberUser)
  vi.stubGlobal('localStorage', makeLocalStorageMock())
})

describe('ConnectorDetailDrawer', () => {
  it('renders children in sections 1 and 2 when isOpen=true', () => {
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    // Section 1 content: education card
    expect(screen.getByTestId('edu-card')).toBeTruthy()
    // Section 2 content: postgres with null schema shows noSchema message
    expect(screen.getByText('noSchema')).toBeTruthy()
  })

  it('sections 1 and 2 have aria-expanded="true" by default', () => {
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    const sectionBtns = Array.from(document.querySelectorAll('[aria-expanded]')) as HTMLElement[]
    expect(sectionBtns.length).toBeGreaterThanOrEqual(2)
    expect(sectionBtns[0].getAttribute('aria-expanded')).toBe('true')
    expect(sectionBtns[1].getAttribute('aria-expanded')).toBe('true')
  })

  it('sections 3, 4, and 5 have aria-expanded="false" by default', () => {
    ;(useAuth as ReturnType<typeof vi.fn>).mockReturnValue(adminUser)
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    const sectionBtns = Array.from(document.querySelectorAll('[aria-expanded]')) as HTMLElement[]
    // sections 3, 4, 5 are at index 2, 3, 4
    expect(sectionBtns[2].getAttribute('aria-expanded')).toBe('false')
    expect(sectionBtns[3].getAttribute('aria-expanded')).toBe('false')
    expect(sectionBtns[4].getAttribute('aria-expanded')).toBe('false')
  })

  it('section 5 "For developers" is NOT rendered when user is not admin', () => {
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    expect(screen.queryByTestId('section-developers')).toBeNull()
  })

  it('section 5 "For developers" IS rendered when user is admin', () => {
    ;(useAuth as ReturnType<typeof vi.fn>).mockReturnValue(adminUser)
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('section-developers')).toBeTruthy()
  })

  it('clicking the section 1 toggle button closes it (aria-expanded becomes false)', () => {
    render(
      <ConnectorDetailDrawer
        connector={connector}
        workspaceId="ws1"
        isOpen={true}
        onClose={vi.fn()}
        onConnectorChange={vi.fn()}
      />
    )
    const sectionBtns = Array.from(document.querySelectorAll('[aria-expanded]')) as HTMLElement[]
    const section1Btn = sectionBtns[0]
    expect(section1Btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(section1Btn)
    expect(section1Btn.getAttribute('aria-expanded')).toBe('false')
  })
})
