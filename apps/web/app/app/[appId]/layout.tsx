/**
 * Runtime shell — completely separate from the builder (FR-20).
 * Published apps are served here. Unpublished drafts are blocked.
 */
export default function RuntimeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Slim top bar: app name + user menu */}
      <header style={{ height: 48, borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', padding: '0 1rem' }}>
        <span style={{ color: '#888', fontSize: '0.875rem' }}>Runtime shell — Phase 5</span>
      </header>
      <main style={{ flex: 1, overflow: 'auto' }}>{children}</main>
    </div>
  )
}
