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
      <BuilderSidebar />
      <main style={{ flex: 1, overflow: 'auto' }}>{children}</main>
    </div>
  )
}
