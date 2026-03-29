'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ConnectorType } from '../../../lib/api'

type DbBrand = 'postgres' | 'mysql' | 'mssql'

const DB_TILES: Array<{ brand: DbBrand; icon: string }> = [
  { brand: 'postgres', icon: '🐘' },
  { brand: 'mysql', icon: '🐬' },
  { brand: 'mssql', icon: '🪟' },
]

const MAIN_TILES: Array<{ id: string; type: ConnectorType | null; icon: string }> = [
  { id: 'spreadsheet', type: 'csv', icon: '📊' },
  { id: 'database', type: null, icon: '🗄️' },
  { id: 'webService', type: 'rest', icon: '🔗' },
  { id: 'graphql', type: 'graphql', icon: '⚡' },
  { id: 'sharedTable', type: 'managed', icon: '📋' },
  { id: 'moreOptions', type: null, icon: '⋯' },
]

export function ConnectorTypePicker({
  onSelect,
  initialCategory,
}: {
  onSelect: (type: ConnectorType, dbBrand?: DbBrand) => void
  initialCategory?: 'files' | 'databases' | 'apis' | 'shared-tables'
}) {
  const t = useTranslations('connectors')
  const [showDbSub, setShowDbSub] = useState(initialCategory === 'databases')
  const visibleTiles = initialCategory === 'apis'
    ? MAIN_TILES.filter(tile => tile.id === 'webService' || tile.id === 'graphql')
    : MAIN_TILES

  const labels = {
    spreadsheet: t('typePicker.spreadsheet'),
    database: t('typePicker.database'),
    webService: t('typePicker.webService'),
    graphql: t('typePicker.graphql'),
    sharedTable: t('typePicker.sharedTable'),
    moreOptions: t('typePicker.moreOptions'),
    postgres: t('typePicker.postgres'),
    mysql: t('typePicker.mysql'),
    mssql: t('typePicker.mssql'),
    dbSubHeading: t('typePicker.dbSubHeading'),
    back: t('typePicker.back'),
  }

  if (showDbSub) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setShowDbSub(false)}
          style={backBtnStyle}
        >
          ← {labels.back}
        </button>
        <h3 style={subHeadStyle}>{labels.dbSubHeading}</h3>
        <div style={gridStyle}>
          {DB_TILES.map(tile => (
            <button
              key={tile.brand}
              type="button"
              data-tile={tile.brand}
              onClick={() => onSelect(tile.brand, tile.brand)}
              style={tileStyle}
              onMouseEnter={e =>
                ((e.currentTarget as HTMLButtonElement).style.borderColor = '#2563eb')
              }
              onMouseLeave={e =>
                ((e.currentTarget as HTMLButtonElement).style.borderColor =
                  'var(--color-border)')
              }
            >
              <span style={iconStyle}>{tile.icon}</span>
              <span style={labelStyle}>
                {labels[tile.brand]}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={gridStyle}>
      {visibleTiles.map(tile => {
        const isPlaceholder = tile.id === 'moreOptions'
        const label = labels[tile.id as keyof typeof labels] ?? tile.id
        return (
          <button
            key={tile.id}
            type="button"
            data-tile={tile.id}
            onClick={() => {
              if (tile.id === 'database') {
                setShowDbSub(true)
              } else if (tile.type) {
                onSelect(tile.type)
              }
            }}
            disabled={isPlaceholder}
            style={{
              ...tileStyle,
              opacity: isPlaceholder ? 0.4 : 1,
              cursor: isPlaceholder ? 'default' : 'pointer',
            }}
            onMouseEnter={e => {
              if (!isPlaceholder)
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#2563eb'
            }}
            onMouseLeave={e =>
              ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)')
            }
          >
            <span style={iconStyle}>{tile.icon}</span>
            <span style={labelStyle}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '0.75rem',
}

const tileStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '1.25rem 1rem',
  background: 'var(--color-surface-raised)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  cursor: 'pointer',
  textAlign: 'center' as const,
  transition: 'border-color 0.15s',
  minHeight: 96,
}

const iconStyle: React.CSSProperties = {
  fontSize: '1.5rem',
  lineHeight: 1,
}

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-sm)',
  color: 'var(--color-text)',
  fontWeight: 500,
  lineHeight: 1.3,
}

const subHeadStyle: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: 'var(--font-size-sm)',
  fontWeight: 600,
  color: 'var(--color-text-muted)',
}

const backBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-subtle)',
  fontSize: 'var(--font-size-sm)',
  padding: '0 0 0.75rem',
  display: 'block',
}
