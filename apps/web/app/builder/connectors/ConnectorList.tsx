'use client'

import type { Connector, ConnectorType } from '../../../lib/api'

export type ConnectorCategory = 'files' | 'databases' | 'apis' | 'shared-tables'

const CATEGORY_TYPES: Record<ConnectorCategory, ConnectorType[]> = {
  'files': ['csv'],
  'databases': ['postgres', 'mysql', 'mssql'],
  'apis': ['rest', 'graphql'],
  'shared-tables': ['managed'],
}

const CATEGORY_ORDER: ConnectorCategory[] = ['files', 'databases', 'apis', 'shared-tables']

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  'files': 'Your Files',
  'databases': 'Databases',
  'apis': 'APIs & Web Services',
  'shared-tables': 'Shared Tables',
}

const ADD_FIRST_LABELS: Record<ConnectorCategory, string> = {
  'files': '＋ Add your first file',
  'databases': '＋ Add your first database',
  'apis': '＋ Add your first API',
  'shared-tables': '＋ Add your first shared table',
}

const ADD_LABELS: Record<ConnectorCategory, string> = {
  'files': '＋ Add file',
  'databases': '＋ Add database',
  'apis': '＋ Add API',
  'shared-tables': '＋ Add table',
}

function isConnected(connector: Connector): boolean {
  if (!connector.schema_cached_at) return false
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  return new Date(connector.schema_cached_at).getTime() >= cutoff
}

// ---- Category icons (inline SVG) ----

function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="1" width="9" height="13" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11 1l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="4" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4" y1="9.5" x2="9" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function DatabasesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 4v4c0 1.1 2.24 2 5 2s5-.9 5-2V4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 8v4c0 1.1 2.24 2 5 2s5-.9 5-2V8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function ApisIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2c-2 2-2 8 0 12M8 2c2 2 2 8 0 12" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function SharedTablesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="1" y1="5.5" x2="15" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="1.2" />
      <line x1="5.5" y1="5.5" x2="5.5" y2="15" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

const CATEGORY_ICONS = {
  'files': FilesIcon,
  'databases': DatabasesIcon,
  'apis': ApisIcon,
  'shared-tables': SharedTablesIcon,
}

// ---- Component ----

export function ConnectorList({
  connectors,
  onManage,
  onAdd,
}: {
  connectors: Connector[]
  onManage: (connector: Connector) => void
  onAdd: (category: ConnectorCategory) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {CATEGORY_ORDER.map(category => {
        const types = CATEGORY_TYPES[category]
        const categoryConnectors = connectors.filter(c => types.includes(c.type))
        const Icon = CATEGORY_ICONS[category]
        const label = CATEGORY_LABELS[category]

        return (
          <div key={category}>
            {/* Category header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginBottom: 8, paddingBottom: 6,
              borderBottom: '1px solid #1e1e1e',
            }}>
              <span style={{ color: '#6b7280', display: 'flex', alignItems: 'center' }}>
                <Icon />
              </span>
              <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#d1d5db' }}>{label}</span>
              {categoryConnectors.length > 0 && (
                <span style={{
                  fontSize: '0.65rem', padding: '1px 6px', borderRadius: 99,
                  background: '#1f2937', color: '#9ca3af',
                }}>
                  {categoryConnectors.length}
                </span>
              )}
              <div style={{ flex: 1 }} />
              {categoryConnectors.length > 0 && (
                <button
                  type="button"
                  onClick={() => onAdd(category)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: '#3b82f6', fontSize: '0.75rem', padding: '2px 6px',
                  }}
                >
                  {ADD_LABELS[category]}
                </button>
              )}
            </div>

            {/* Empty state or connector rows */}
            {categoryConnectors.length === 0 ? (
              <button
                type="button"
                onClick={() => onAdd(category)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#3b82f6', fontSize: '0.8rem', padding: '4px 0',
                  textDecoration: 'underline',
                }}
              >
                {ADD_FIRST_LABELS[category]}
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {categoryConnectors.map(connector => {
                  const connected = isConnected(connector)
                  return (
                    <div
                      key={connector.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px', borderRadius: 6,
                        background: '#111', border: '1px solid #1e1e1e',
                      }}
                    >
                      <span style={{ color: '#6b7280', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                        <Icon />
                      </span>
                      <span style={{
                        fontWeight: 500, fontSize: '0.85rem', color: '#e5e5e5',
                        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {connector.name}
                      </span>
                      <span style={{
                        fontSize: '0.65rem', padding: '2px 8px', borderRadius: 99,
                        background: connected ? '#14532d' : '#1f2937',
                        color: connected ? '#4ade80' : '#6b7280',
                        flexShrink: 0,
                      }}>
                        {connected ? 'Connected' : 'Not set up yet'}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#555', flexShrink: 0 }}>
                        {connector.owner_scope}
                      </span>
                      <button
                        type="button"
                        onClick={() => onManage(connector)}
                        style={{
                          background: 'none', border: '1px solid #333', cursor: 'pointer',
                          color: '#9ca3af', fontSize: '0.75rem', padding: '3px 10px',
                          borderRadius: 4, flexShrink: 0,
                        }}
                      >
                        Manage
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
