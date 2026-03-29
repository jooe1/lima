'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '../../lib/auth'
import { patchUserLanguage } from '../../lib/api'

// Navigation contract: primary items kept stable for later builder commits.
const PRIMARY_NAV: Array<{ href: string; labelKey: string; matchPrefix?: boolean }> = [
  { href: '/builder', labelKey: 'apps' },
  { href: '/builder/connectors', labelKey: 'connectors' },
]

const SECONDARY_NAV: Array<{ href: string; labelKey: string; matchPrefix?: boolean }> = [
  { href: '/builder/approvals', labelKey: 'approvals' },
  { href: '/builder/admin', labelKey: 'admin', matchPrefix: true },
  { href: '/builder/settings', labelKey: 'aiSettings' },
]

export default function BuilderSidebar() {
  const { user, company, workspace, workspaces, selectWorkspace, signOut, setLanguage } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const t = useTranslations('nav')

  function handleSignOut() {
    signOut()
    router.push('/login')
  }

  async function handleLocaleChange(lang: 'en' | 'de') {
    document.cookie = `NEXT_LOCALE=${lang};path=/;max-age=31536000`
    setLanguage(lang)
    await patchUserLanguage(lang)
    router.refresh()
  }

  const locale = user?.language ?? 'en'

  function isActive(href: string, matchPrefix?: boolean) {
    if (matchPrefix) return pathname.startsWith(href)
    return pathname === href
  }

  return (
    <aside style={{
      width: 220,
      borderRight: '1px solid var(--color-border)',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      padding: 'var(--space-4) 0',
    }}>
      {/* Branding */}
      <div style={{ padding: '0 var(--space-4) var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text)' }}>{t('brand')}</span>
        {company && (
          <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: 'var(--space-1) 0 0' }}>
            {company.name || company.slug}
          </p>
        )}
      </div>

      {/* Workspace */}
      {workspaces.length > 1 ? (
        <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
          <label htmlFor="ws-select" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', display: 'block', marginBottom: 'var(--space-1)' }}>
            {t('workspace')}
          </label>
          <select
            id="ws-select"
            value={workspace?.id ?? ''}
            onChange={(e) => {
              const ws = workspaces.find((w) => w.id === e.target.value)
              if (ws) selectWorkspace(ws)
            }}
            style={{
              width: '100%',
              background: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border-muted)',
              color: 'var(--color-text)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--space-1) var(--space-2)',
              fontSize: 'var(--font-size-xs)',
            }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>
      ) : workspace ? (
        <div style={{ padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
          <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: 0 }}>{workspace.name}</p>
        </div>
      ) : null}

      {/* Primary nav */}
      <nav aria-label="Main navigation" style={{ padding: 'var(--space-2) 0' }}>
        {PRIMARY_NAV.map(({ href, labelKey, matchPrefix }) => (
          <NavItem key={href} href={href} active={isActive(href, matchPrefix)} label={t(labelKey)} />
        ))}
      </nav>

      {/* Secondary nav */}
      <div style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-2) 0', marginTop: 'auto' }}>
        <p style={{ padding: '0 var(--space-4)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', marginBottom: 'var(--space-1)' }}>
          {t('more')}
        </p>
        {SECONDARY_NAV.map(({ href, labelKey, matchPrefix }) => (
          <NavItem key={href} href={href} active={isActive(href, matchPrefix)} label={t(labelKey)} muted />
        ))}
      </div>

      {/* User + language toggle */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--color-border)' }}>
        <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: '0 0 var(--space-2)' }}>
          {user?.email ?? (user?.id?.slice(0, 8) + '…')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            onClick={handleSignOut}
            style={{
              background: 'none',
              border: '1px solid var(--color-border-muted)',
              color: 'var(--color-text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--space-1) var(--space-3)',
              fontSize: 'var(--font-size-xs)',
              cursor: 'pointer',
            }}
          >
            {t('signOut')}
          </button>
          <div style={{ display: 'flex', gap: 2 }}>
            {(['en', 'de'] as const).map(lang => (
              <button
                key={lang}
                onClick={() => { void handleLocaleChange(lang) }}
                style={{
                  background: locale === lang ? 'var(--color-surface-raised)' : 'none',
                  border: `1px solid ${locale === lang ? 'var(--color-border-muted)' : 'transparent'}`,
                  color: locale === lang ? 'var(--color-text)' : 'var(--color-text-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px',
                  fontSize: 'var(--font-size-xs)',
                  cursor: 'pointer',
                  fontWeight: locale === lang ? 600 : 400,
                }}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}

function NavItem({ href, active, label, muted }: { href: string; active: boolean; label: string; muted?: boolean }) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: 'var(--space-2) var(--space-4)',
        color: active ? 'var(--color-text)' : muted ? 'var(--color-text-subtle)' : 'var(--color-text-muted)',
        background: active ? 'var(--color-surface-raised)' : 'transparent',
        textDecoration: 'none',
        fontSize: muted ? 'var(--font-size-xs)' : 'var(--font-size-sm)',
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
    </Link>
  )
}

