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
        <p style={{ color: '#f87171' }}>{error}</p>
        <a href="/login" style={{ color: '#60a5fa', marginTop: 8, display: 'inline-block' }}>Back to login</a>
      </div>
    )
  }

  return <p style={{ color: '#666' }}>Completing sign in…</p>
}

export default function AuthCallbackPage() {
  return (
    <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <Suspense fallback={<p style={{ color: '#666' }}>Loading…</p>}>
        <CallbackInner />
      </Suspense>
    </main>
  )
}
