'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ConnectorType } from '../../../lib/api'
import { FilesIcon, DatabasesIcon, ApisIcon, SharedTablesIcon } from './ConnectorIcons'
import styles from './connectors.module.css'

type DbBrand = 'postgres' | 'mysql' | 'mssql'

const DB_TILES: { brand: DbBrand; Icon: typeof DatabasesIcon }[] = [
  { brand: 'postgres', Icon: DatabasesIcon },
  { brand: 'mysql', Icon: DatabasesIcon },
  { brand: 'mssql', Icon: DatabasesIcon },
]

const MAIN_TILES: { id: string; type: ConnectorType | null; Icon: typeof FilesIcon | null }[] = [
  { id: 'spreadsheet', type: 'csv', Icon: FilesIcon },
  { id: 'database', type: null, Icon: DatabasesIcon },
  { id: 'webService', type: 'rest', Icon: ApisIcon },
  { id: 'graphql', type: 'graphql', Icon: ApisIcon },
  { id: 'sharedTable', type: 'managed', Icon: SharedTablesIcon },
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
              >
                <span className={styles.tileIcon}><Icon /></span>
                <span>{labels[tile.brand]}</span>
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
            style={isPlaceholder ? { opacity: 0.4, cursor: 'default' } : undefined}
          >
            <span className={styles.tileIcon}>
              {Icon ? <Icon /> : '⋯'}
            </span>
            <span>{label}</span>
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
