'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ConnectorType } from '../../../lib/api'
import { FilesIcon, DatabasesIcon, ApisIcon } from './ConnectorIcons'
import styles from './connectors.module.css'

type DbBrand = 'postgres' | 'mysql' | 'mssql'

const TILE_ACCENT: Partial<Record<string, string>> = {
  spreadsheet: 'var(--accent-files)',
  database: 'var(--accent-databases)',
  webService: 'var(--accent-apis)',
  graphql: 'var(--accent-apis)',
  sharedTable: 'var(--accent-shared-tables)',
  postgres: 'var(--accent-databases)',
  mysql: 'var(--accent-databases)',
  mssql: 'var(--accent-databases)',
}

const DB_TILES: { brand: DbBrand; Icon: typeof DatabasesIcon }[] = [
  { brand: 'postgres', Icon: DatabasesIcon },
  { brand: 'mysql', Icon: DatabasesIcon },
  { brand: 'mssql', Icon: DatabasesIcon },
]

const MAIN_TILES: { id: string; type: ConnectorType | null; Icon: typeof FilesIcon | null }[] = [
  { id: 'spreadsheet', type: 'managed', Icon: FilesIcon },
  { id: 'database', type: null, Icon: DatabasesIcon },
  { id: 'webService', type: 'rest', Icon: ApisIcon },
  { id: 'graphql', type: 'graphql', Icon: ApisIcon },
  { id: 'moreOptions', type: null, Icon: null },
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
          className={styles.typePickerBack}
        >
          ← {labels.back}
        </button>
        <h3 className={styles.typePickerSubHead}>{labels.dbSubHeading}</h3>
        <div style={gridStyle}>
          {DB_TILES.map(tile => {
            const Icon = tile.Icon
            return (
              <button
                key={tile.brand}
                type="button"
                data-tile={tile.brand}
                onClick={() => onSelect(tile.brand, tile.brand)}
                className={styles.typePickerTile}
                style={{ '--tile-accent': TILE_ACCENT[tile.brand] } as React.CSSProperties}
              >
                <span className={styles.tileIcon}><Icon /></span>
                <span className={styles.tileLabel}>{labels[tile.brand]}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={gridStyle}>
      {visibleTiles.map(tile => {
        const isPlaceholder = tile.id === 'moreOptions'
        const label = labels[tile.id as keyof typeof labels] ?? tile.id
        const Icon = tile.Icon
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
            className={styles.typePickerTile}
            style={{
              ...(isPlaceholder ? { opacity: 0.4, cursor: 'default' } : {}),
              '--tile-accent': TILE_ACCENT[tile.id] ?? 'var(--color-primary)',
            } as React.CSSProperties}
          >
            <span className={styles.tileIcon}>
              {Icon ? <Icon /> : '⋯'}
            </span>
            <span className={styles.tileLabel}>{label}</span>
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
