import React from 'react'

interface RouteStateScreenProps {
  title: string
  body: string
  actionHref?: string
  actionLabel?: string
}

export function RouteStateScreen({ title, body, actionHref, actionLabel }: RouteStateScreenProps): React.JSX.Element {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--color-bg, #0a0a0a)',
      padding: '2rem',
      textAlign: 'center',
    }}>
      <div style={{ maxWidth: 440 }}>
        <h1 style={{
          color: 'var(--color-text, #e5e5e5)',
          fontSize: '1.1rem',
          fontWeight: 600,
          margin: '0 0 0.75rem 0',
        }}>
          {title}
        </h1>
        <p style={{
          color: 'var(--color-text-muted, #888)',
          fontSize: '0.875rem',
          lineHeight: 1.6,
          margin: 0,
        }}>
          {body}
        </p>
        {actionHref && actionLabel && (
          <a
            href={actionHref}
            style={{
              display: 'inline-block',
              marginTop: '1.25rem',
              color: 'var(--color-primary, #2563eb)',
              fontSize: '0.875rem',
              textDecoration: 'none',
            }}
          >
            {actionLabel}
          </a>
        )}
      </div>
    </div>
  )
}
