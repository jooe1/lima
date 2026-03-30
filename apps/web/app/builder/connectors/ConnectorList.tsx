'use client'

import React from 'react'
import type { Connector, ConnectorType } from '../../../lib/api'
import styles from './connectors.module.css'
import { CATEGORY_ICONS, CATEGORY_ACCENT } from './ConnectorIcons'
import { ConnectorStatusBadge } from './ConnectorStatusBadge'

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

const EMPTY_DESC: Record<ConnectorCategory, string> = {
  files: 'Upload CSV data files',
  databases: 'Connect Postgres, MySQL, or SQL Server',
  apis: 'Connect REST or GraphQL web services',
  'shared-tables': 'Create managed shared data tables',
}

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
    <div>
      {CATEGORY_ORDER.map(category => {
        const types = CATEGORY_TYPES[category]
        const categoryConnectors = connectors.filter(c => types.includes(c.type))

        return (
          <div key={category}>
            {/* Section header */}
            <div
              className={styles.sectionHeader}
              style={{ '--cat-accent': CATEGORY_ACCENT[category] } as React.CSSProperties}
            >
              <span className={styles.categoryLabel}>{CATEGORY_LABELS[category]}</span>
              <span className={styles.countBadge}>{categoryConnectors.length}</span>
              <button className={styles.addBtn} onClick={() => onAdd(category)}>＋ Add</button>
            </div>

            {/* Empty state or card grid */}
            {categoryConnectors.length === 0 ? (
              <div
                className={styles.emptyCard}
                style={{ '--cat-accent': CATEGORY_ACCENT[category] } as React.CSSProperties}
              >
                <div className={styles.emptyIcon}>
                  {React.createElement(CATEGORY_ICONS[category])}
                </div>
                <span className={styles.emptyDesc}>{EMPTY_DESC[category]}</span>
                <button className={styles.emptyCta} onClick={() => onAdd(category)}>Add {CATEGORY_LABELS[category]}</button>
              </div>
            ) : (
              <div className={styles.cardGrid}>
                {categoryConnectors.map(connector => (
                  <div
                    key={connector.id}
                    className={styles.card}
                    style={{ '--cat-accent': CATEGORY_ACCENT[category] } as React.CSSProperties}
                  >
                    <div className={styles.cardIconWell}>
                      {React.createElement(CATEGORY_ICONS[category])}
                    </div>
                    <span className={styles.cardName}>{connector.name}</span>
                    <span className={styles.typeChip}>{connector.type}</span>
                    <ConnectorStatusBadge connector={{ schema_cached_at: connector.schema_cached_at }} />
                    <button className={styles.manageBtn} onClick={() => onManage(connector)}>Manage</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
