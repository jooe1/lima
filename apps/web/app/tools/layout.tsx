'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '../../lib/auth'
import { patchUserLanguage } from '../../lib/api'
import RouteGateShell from '../_components/RouteGateShell'

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { token, isLoading, user, setLanguage } = useAuth()
  const t = useTranslations('nav')

  useEffect(() => {
    if (!isLoading && !token) router.replace('/login')
  }, [token, isLoading, router])

  async function handleLocaleChange(lang: 'en' | 'de') {
    document.cookie = `NEXT_LOCALE=${lang};path=/;max-age=31536000`
    setLanguage(lang)
    await patchUserLanguage(lang)
    router.refresh()
  }

  const locale = user?.language ?? 'en'

  if (isLoading) return <RouteGateShell title={t('tools')} message="Checking access…" />

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
        <span style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>{t('brand')}</span>
        <span style={{ color: '#555', fontSize: '0.8rem' }}>{t('tools')}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          {(['en', 'de'] as const).map(lang => (
            <button
              key={lang}
              onClick={() => { void handleLocaleChange(lang) }}
              style={{
                background: locale === lang ? '#1a1a1a' : 'none',
                border: `1px solid ${locale === lang ? '#333' : 'transparent'}`,
                color: locale === lang ? '#e5e5e5' : '#555',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: '0.75rem',
                cursor: 'pointer',
                fontWeight: locale === lang ? 600 : 400,
              }}
            >
              {lang.toUpperCase()}
            </button>
          ))}
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
