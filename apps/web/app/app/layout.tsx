'use client'

/**
 * Runtime shell layout — wraps all /app/* routes.
 * Deliberately minimal: no builder sidebar, just the app content.
 * Auth redirect is handled per-page.
 */
export default function RuntimeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#0a0a0a', color: '#e5e5e5', display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  )
}
