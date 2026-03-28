'use client'

import { RouteStateScreen } from './_components/RouteStateScreen'

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
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
          Something went wrong
        </h1>
        <p style={{
          color: 'var(--color-text-muted, #888)',
          fontSize: '0.875rem',
          lineHeight: 1.6,
          margin: '0 0 1.25rem 0',
        }}>
          An unexpected error occurred. You can try refreshing the page or returning to the home screen.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={reset}
            style={{
              background: 'var(--color-primary, #2563eb)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '0.5rem 1.25rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <a
            href="/"
            style={{
              color: 'var(--color-text-muted, #888)',
              fontSize: '0.875rem',
              textDecoration: 'none',
              padding: '0.5rem 0',
            }}
          >
            Go to home
          </a>
        </div>
      </div>
    </div>
  )
}
