'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '../../../lib/auth'
import { getCompany, type Company } from '../../../lib/api'

function CallbackInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { signIn } = useAuth()
  const [error, setError] = useState('')

  useEffect(() => {
    const token = params.get('token')
    if (!token) {
      setError('No token received.')
      return
    }

    let companyId: string
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      companyId = payload.company_id
      if (!companyId) throw new Error('missing company_id')
    } catch {
      setError('Invalid token received.')
      return
    }

    localStorage.setItem('lima_token', token)

    getCompany(companyId)
      .then((company: Company) => signIn(token, company))
      .then(() => router.replace('/builder'))
      .catch(() => {
        const minimal: Company = { id: companyId, name: '', slug: '', created_at: '', updated_at: '' }
        return signIn(token, minimal).then(() => router.replace('/builder'))
      })
  }, [params, signIn, router])

  if (error) {
    return (
      <div style={{ textAlign: 'center' }}>
        <p role="alert" style={{ color: 'var(--color-error)', marginBottom: 'var(--space-2)' }}>{error}</p>
        <a href="/login" style={{ color: 'var(--color-info)', fontSize: 'var(--font-size-sm)' }}>Back to login</a>
      </div>
    )
  }

  return <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>Completing sign in…</p>
}

export default function AuthCallbackPage() {
  return (
    <main style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--color-bg)',
    }}>
      <Suspense fallback={<p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>Loading…</p>}>
        <CallbackInner />
      </Suspense>
    </main>
  )
}
