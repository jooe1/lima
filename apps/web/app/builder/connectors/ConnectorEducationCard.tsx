'use client'

import { useState } from 'react'
import { type Connector } from '../../../lib/api'

type CardContent = {
  body: string
  ctaLabel: string
}

const CARD_CONTENT: Record<string, CardContent> = {
  csv: {
    body: 'Your file is ready. Try using it in an app to display or filter the data.',
    ctaLabel: 'Use in an app',
  },
  postgres: {
    body: 'Your database is connected. Check that everything works, then browse your tables.',
    ctaLabel: 'Test the connection',
  },
  mysql: {
    body: 'Your database is connected. Check that everything works, then browse your tables.',
    ctaLabel: 'Test the connection',
  },
  mssql: {
    body: 'Your database is connected. Check that everything works, then browse your tables.',
    ctaLabel: 'Test the connection',
  },
  rest: {
    body: 'Your API is connected. Add actions to let your apps call it.',
    ctaLabel: 'Add an action',
  },
  graphql: {
    body: 'Your API is connected. Add actions to let your apps call it.',
    ctaLabel: 'Add an action',
  },
  managed: {
    body: 'Your shared table is ready. Add columns to define what data it stores.',
    ctaLabel: 'Add a column',
  },
}

export function ConnectorEducationCard({
  connector,
  onDismiss,
  onCTA,
}: {
  connector: Connector
  onDismiss: () => void
  onCTA?: () => void
}) {
  const storageKey = `lima_edu_dismissed_${connector.id}`
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(storageKey) === 'true'
  })

  if (dismissed) return null

  const content = CARD_CONTENT[connector.type]
  if (!content) return null

  function handleDismiss() {
    localStorage.setItem(storageKey, 'true')
    setDismissed(true)
    onDismiss()
  }

  return (
    <div style={{
      background: '#0a1628',
      border: '1px solid #1e3a5f',
      borderRadius: 10,
      padding: '1rem 1.25rem',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ flex: 1 }}>
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#e5e5e5' }}>
          {content.body}
        </p>
        {onCTA && (
          <button
            onClick={onCTA}
            style={{
              fontSize: '0.8rem', padding: '4px 12px',
              background: '#2563eb', color: '#fff',
              border: 'none', borderRadius: 6,
              cursor: 'pointer', fontWeight: 500,
            }}
          >
            {content.ctaLabel}
          </button>
        )}
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#555', fontSize: '1rem', padding: '4px',
        }}
      >
        ✕
      </button>
    </div>
  )
}
