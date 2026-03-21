'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '../../lib/auth'

export default function BuilderSidebar() {
  const { user, company, workspace, workspaces, selectWorkspace, signOut } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  function handleSignOut() {
    signOut()
    router.push('/login')
  }

  return (
    <aside
      style={{
        width: 220,
        borderRight: '1px solid #1f1f1f',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '1rem 0',
      }}
    >
      {/* Branding */}
      <div style={{ padding: '0 1rem 1rem', borderBottom: '1px solid #1f1f1f' }}>
        <span style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>Lima</span>
        {company && (
          <p style={{ color: '#555', fontSize: '0.75rem', margin: '0.25rem 0 0' }}>
            {company.name || company.slug}
          </p>
        )}
      </div>

      {/* Workspace selector */}
      {workspaces.length > 1 && (
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f1f1f' }}>
          <select
            value={workspace?.id ?? ''}
            onChange={(e) => {
              const ws = workspaces.find((w) => w.id === e.target.value)
              if (ws) selectWorkspace(ws)
            }}
            style={{
              width: '100%',
              background: '#1a1a1a',
              border: '1px solid #333',
              color: '#ccc',
              borderRadius: 6,
              padding: '0.4rem 0.5rem',
              fontSize: '0.8rem',
            }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {workspace && workspaces.length <= 1 && (
        <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid #1f1f1f' }}>
          <p style={{ color: '#555', fontSize: '0.75rem', margin: 0 }}>{workspace.name}</p>
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.5rem 0' }}>
        <NavItem href="/builder" active={pathname === '/builder'} label="Apps" />
        <NavItem
          href="/builder/connectors"
          active={pathname === '/builder/connectors'}
          label="Connectors"
        />
        <NavItem
          href="/builder/approvals"
          active={pathname === '/builder/approvals'}
          label="Approvals"
        />
        <NavItem
          href="/builder/admin"
          active={pathname.startsWith('/builder/admin')}
          label="Admin"
        />
        <NavItem
          href="/builder/settings"
          active={pathname === '/builder/settings'}
          label="AI Settings"
        />
      </nav>

      {/* User */}
      <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #1f1f1f' }}>
        <p style={{ color: '#555', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>
          {user?.id?.slice(0, 8)}…
        </p>
        <button
          onClick={handleSignOut}
          style={{
            background: 'none',
            border: '1px solid #333',
            color: '#888',
            borderRadius: 6,
            padding: '0.3rem 0.75rem',
            fontSize: '0.75rem',
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}

function NavItem({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: '0.5rem 1rem',
        color: active ? '#fff' : '#666',
        background: active ? '#1f1f1f' : 'transparent',
        textDecoration: 'none',
        fontSize: '0.875rem',
      }}
    >
      {label}
    </Link>
  )
}
