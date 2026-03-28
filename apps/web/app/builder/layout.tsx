'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import BuilderSidebar from './BuilderSidebar'
import RouteGateShell from '../_components/RouteGateShell'

/**
 * Builder shell layout — wraps all /builder/* routes.
 * Redirects to /login if the user is not authenticated.
 */
export default function BuilderLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { token, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading && !token) router.replace('/login')
  }, [token, isLoading, router])

  if (isLoading) return <RouteGateShell title="Builder" message="Checking access…" />

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#0a0a0a', color: '#e5e5e5' }}>
      <a
        href="#builder-content"
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
          zIndex: 9999,
          background: 'var(--color-surface, #141414)',
          color: 'var(--color-text, #e5e5e5)',
          padding: '0.5rem 1rem',
          textDecoration: 'none',
          borderRadius: 4,
          fontSize: '0.875rem',
        }}
        onFocus={e => { e.currentTarget.style.left = '0.5rem'; e.currentTarget.style.top = '0.5rem'; e.currentTarget.style.width = 'auto'; e.currentTarget.style.height = 'auto' }}
        onBlur={e => { e.currentTarget.style.left = '-9999px'; e.currentTarget.style.width = '1px'; e.currentTarget.style.height = '1px' }}
      >
        Skip to content
      </a>
      <BuilderSidebar />
      <main id="builder-content" style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>{children}</main>
    </div>
  )
}
