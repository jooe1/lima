import type { JSX } from 'react'
import type { ConnectorCategory } from './ConnectorList'
import type { ConnectorType } from '../../../lib/api'

export function FilesIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="1" width="9" height="13" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11 1l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="4" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4" y1="9.5" x2="9" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function DatabasesIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 4v4c0 1.1 2.24 2 5 2s5-.9 5-2V4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 8v4c0 1.1 2.24 2 5 2s5-.9 5-2V8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export function ApisIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2c-2 2-2 8 0 12M8 2c2 2 2 8 0 12" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function SharedTablesIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="1" y1="5.5" x2="15" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="1.2" />
      <line x1="5.5" y1="5.5" x2="5.5" y2="15" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export const CATEGORY_ICONS: Record<ConnectorCategory, () => JSX.Element> = {
  'files': FilesIcon,
  'databases': DatabasesIcon,
  'apis': ApisIcon,
  'shared-tables': SharedTablesIcon,
}

export const CATEGORY_ACCENT: Record<ConnectorCategory, string> = {
  'files': 'var(--accent-files)',
  'databases': 'var(--accent-databases)',
  'apis': 'var(--accent-apis)',
  'shared-tables': 'var(--accent-shared-tables)',
}

export const TYPE_TO_CATEGORY: Partial<Record<ConnectorType, ConnectorCategory>> = {
  'postgres': 'databases',
  'mysql': 'databases',
  'mssql': 'databases',
  'rest': 'apis',
  'graphql': 'apis',
  'csv': 'files',
  'managed': 'shared-tables',
}
