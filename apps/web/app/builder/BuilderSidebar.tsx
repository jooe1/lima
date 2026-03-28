'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'

// Navigation contract: primary items kept stable for later builder commits.
const PRIMARY_NAV: Array<{ href: string; label: string; matchPrefix?: boolean }> = [
  { href: '/builder', label: 'Apps' },
  { href: '/builder/connectors', label: 'Connectors' },
]

const SECONDARY_NAV: Array<{ href: string; label: string; matchPrefix?: boolean }> = [
  { href: '/builder/approvals', label: 'Approvals' },
  { href: '/builder/admin', label: 'Admin', matchPrefix: true },
  { href: '/builder/settings', label: 'AI Settings' },
]

export default function BuilderSidebar() {
  const { user, company, workspace, workspaces, selectWorkspace, signOut } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  function handleSignOut() {
    signOut()
    router.push('/login')
  }

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
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text)' }}>Lima</span>
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
            Workspace
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
        {PRIMARY_NAV.map(({ href, label, matchPrefix }) => (
          <NavItem key={href} href={href} active={isActive(href, matchPrefix)} label={label} />
        ))}
      </nav>

      {/* Secondary nav */}
      <div style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-2) 0', marginTop: 'auto' }}>
        <p style={{ padding: '0 var(--space-4)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', marginBottom: 'var(--space-1)' }}>
          More
        </p>
        {SECONDARY_NAV.map(({ href, label, matchPrefix }) => (
          <NavItem key={href} href={href} active={isActive(href, matchPrefix)} label={label} muted />
        ))}
      </div>

      {/* User */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--color-border)' }}>
        <p style={{ color: 'var(--color-text-subtle)', fontSize: 'var(--font-size-xs)', margin: '0 0 var(--space-2)' }}>
          {user?.email ?? user?.id?.slice(0, 8) + '…'}
        </p>
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
          Sign out
        </button>
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

