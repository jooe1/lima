'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'
import { getSSOLoginURL, getGoogleLoginURL, type Company } from '../../lib/api'

export default function LoginPage() {
  const router = useRouter()
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('dev')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isDev = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_LOGIN === 'true'
  const isGoogleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === 'true'
  const defaultCompanySlug = process.env.NEXT_PUBLIC_DEFAULT_COMPANY_SLUG || ''

  const [magicEmail, setMagicEmail] = useState('')
  const [magicSlug, setMagicSlug] = useState('')
  const [magicSent, setMagicSent] = useState(false)
  const [magicLoading, setMagicLoading] = useState(false)
  const [magicError, setMagicError] = useState('')

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault()
    setMagicError('')
    setMagicLoading(true)
    try {
      const { requestMagicLink } = await import('../../lib/api')
      await requestMagicLink(magicEmail, defaultCompanySlug || magicSlug || undefined)
      setMagicSent(true)
    } catch (err: unknown) {
      setMagicError(err instanceof Error ? err.message : 'Failed to send link')
    } finally {
      setMagicLoading(false)
    }
  }

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
    <main style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--color-bg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 380,
        padding: 'var(--space-10)',
        background: 'var(--color-surface)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
      }}>
        <h1 style={{
          fontSize: 'var(--font-size-xl)',
          fontWeight: 700,
          color: 'var(--color-text)',
          marginBottom: 'var(--space-1)',
        }}>Lima</h1>
        <p style={{
          color: 'var(--color-text-muted)',
          marginBottom: 'var(--space-8)',
          fontSize: 'var(--font-size-sm)',
        }}>
          Sign in to build and launch internal tools.
        </p>

        {/* Primary: SSO */}
        <a
          href={getSSOLoginURL()}
          style={{
            display: 'block',
            textAlign: 'center',
            padding: 'var(--space-3)',
            background: '#fff',
            color: '#000',
            borderRadius: 'var(--radius-md)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: 'var(--font-size-sm)',
            marginBottom: isGoogleEnabled ? 'var(--space-2)' : 'var(--space-6)',
          }}
        >
          Continue with SSO
        </a>

        {isGoogleEnabled && (
          <a
            href={getGoogleLoginURL()}
            style={{
              display: 'block',
              textAlign: 'center',
              padding: 'var(--space-3)',
              background: 'var(--color-surface-raised)',
              color: 'var(--color-text)',
              borderRadius: 'var(--radius-md)',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 'var(--font-size-sm)',
              border: '1px solid var(--color-border-muted)',
              marginBottom: 'var(--space-6)',
            }}
          >
            Continue with Google
          </a>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-6)' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--color-border-muted)' }} />
          <span style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)' }}>or continue with email</span>
          <div style={{ flex: 1, height: 1, background: 'var(--color-border-muted)' }} />
        </div>

        {/* Magic link form */}
        {magicSent ? (
          <div role="status" style={{
            textAlign: 'center',
            padding: 'var(--space-4)',
            color: 'var(--color-success)',
            fontSize: 'var(--font-size-sm)',
          }}>
            Check your inbox — we&#39;ve sent a login link to <strong>{magicEmail}</strong>.
          </div>
        ) : (
          <form onSubmit={handleMagicLink} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label htmlFor="magic-email" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', fontWeight: 500 }}>
                Email address
              </label>
              <input
                id="magic-email"
                type="email"
                required
                placeholder="you@company.com"
                value={magicEmail}
                onChange={e => setMagicEmail(e.target.value)}
                style={inputStyle}
              />
            </div>
            {!defaultCompanySlug && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <label htmlFor="magic-slug" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', fontWeight: 500 }}>
                  Company slug
                </label>
                <input
                  id="magic-slug"
                  type="text"
                  placeholder="e.g. acme"
                  value={magicSlug}
                  onChange={e => setMagicSlug(e.target.value)}
                  style={inputStyle}
                />
              </div>
            )}
            {magicError && (
              <p role="alert" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-xs)', margin: 0 }}>
                {magicError}
              </p>
            )}
            <button
              type="submit"
              disabled={magicLoading}
              style={{
                padding: 'var(--space-3)',
                background: magicLoading ? 'var(--color-surface-raised)' : 'var(--color-primary)',
                color: magicLoading ? 'var(--color-text-muted)' : '#fff',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontWeight: 600,
                fontSize: 'var(--font-size-sm)',
                cursor: magicLoading ? 'not-allowed' : 'pointer',
                width: '100%',
              }}
            >
              {magicLoading ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}

        {/* Dev login — visually isolated, only in development */}
        {isDev && (
          <div style={{ marginTop: 'var(--space-8)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
              <span style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)' }}>Developer access</span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
            </div>
            <form onSubmit={handleDevLogin} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <label htmlFor="dev-email" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 500 }}>
                  Email
                </label>
                <input
                  id="dev-email"
                  type="email"
                  required
                  placeholder="Email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  style={inputStyleMuted}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <label htmlFor="dev-name" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 500 }}>
                  Name (optional)
                </label>
                <input
                  id="dev-name"
                  type="text"
                  placeholder="Name (optional)"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  style={inputStyleMuted}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <label htmlFor="dev-company" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 500 }}>
                  Company slug
                </label>
                <input
                  id="dev-company"
                  type="text"
                  placeholder="Company slug"
                  value={company}
                  onChange={e => setCompany(e.target.value)}
                  style={inputStyleMuted}
                />
              </div>
              {error && (
                <p role="alert" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-xs)', margin: 0 }}>
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={loading}
                style={{
                  padding: 'var(--space-3)',
                  background: 'var(--color-surface-raised)',
                  color: loading ? 'var(--color-text-subtle)' : 'var(--color-text-muted)',
                  border: '1px solid var(--color-border-muted)',
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 600,
                  fontSize: 'var(--font-size-sm)',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  width: '100%',
                }}
              >
                {loading ? 'Signing in…' : 'Dev sign in'}
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  )
}

const inputStyle: React.CSSProperties = {
  padding: 'var(--space-3)',
  background: 'var(--color-surface-raised)',
  border: '1px solid var(--color-border-muted)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-text)',
  fontSize: 'var(--font-size-sm)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const inputStyleMuted: React.CSSProperties = {
  ...inputStyle,
  border: '1px solid var(--color-border)',
}
