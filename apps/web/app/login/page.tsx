'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import { getSSOLoginURL, type Company } from '../../lib/api'

export default function LoginPage() {
  const router = useRouter()
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('dev')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isDev = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_LOGIN === 'true'

  async function handleDevLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { devLogin } = await import('../../lib/api')
      const res = await devLogin(email, name || email, company)
      await signIn(res.token, res.company as Company)
      router.push('/builder')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a' }}>
      <div style={{ width: 360, padding: '2.5rem', background: '#141414', borderRadius: 12, border: '1px solid #222' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fff', marginBottom: '0.25rem' }}>Lima</h1>
        <p style={{ color: '#666', marginBottom: '2rem', fontSize: '0.875rem' }}>AI-first internal tools platform</p>

        {/* SSO login */}
        <a
          href={getSSOLoginURL()}
          style={{
            display: 'block', textAlign: 'center', padding: '0.75rem',
            background: '#fff', color: '#000', borderRadius: 8,
            textDecoration: 'none', fontWeight: 600, fontSize: '0.875rem',
            marginBottom: '1.5rem',
          }}
        >
          Continue with SSO
        </a>

        {/* Dev login — only shown in development */}
        {isDev && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1.5rem' }}>
              <div style={{ flex: 1, height: 1, background: '#333' }} />
              <span style={{ color: '#555', fontSize: '0.75rem' }}>dev login</span>
              <div style={{ flex: 1, height: 1, background: '#333' }} />
            </div>
            <form onSubmit={handleDevLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="email" required placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)}
                style={inputStyle}
              />
              <input
                type="text" placeholder="Name (optional)"
                value={name} onChange={e => setName(e.target.value)}
                style={inputStyle}
              />
              <input
                type="text" placeholder="Company slug"
                value={company} onChange={e => setCompany(e.target.value)}
                style={inputStyle}
              />
              {error && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
              <button
                type="submit" disabled={loading}
                style={{
                  padding: '0.75rem', background: '#2563eb', color: '#fff',
                  border: 'none', borderRadius: 8, fontWeight: 600,
                  fontSize: '0.875rem', cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.7 : 1,
                }}
              >
                {loading ? 'Signing in…' : 'Dev sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '0.625rem 0.75rem', background: '#1e1e1e', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: '0.875rem', outline: 'none', width: '100%',
  boxSizing: 'border-box',
}
