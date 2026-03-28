'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import RouteGateShell from '../_components/RouteGateShell'

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { token, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading && !token) router.replace('/login')
  }, [token, isLoading, router])

  if (isLoading) return <RouteGateShell title="Tools" message="Checking access…" />

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#e5e5e5' }}>
      <header style={{
        height: 48,
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        alignItems: 'center',
        padding: '0 1.5rem',
        gap: 16,
      }}>
        <span style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>Lima</span>
        <span style={{ color: '#555', fontSize: '0.8rem' }}>Tools</span>
      </header>
      <main>{children}</main>
    </div>
  )
}
