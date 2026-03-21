'use client'

import Link from 'next/link'

export default function AdminPage() {
  return (
    <div style={{ padding: '1.5rem', color: '#e5e5e5' }}>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1rem', fontWeight: 600 }}>Administration</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <AdminLink href="/builder/admin/audit" label="Audit Log" description="View workspace activity and export CSV" />
        <AdminLink href="/builder/admin/groups" label="Groups" description="Manage company groups and memberships" />
        <AdminLink href="/builder/admin/members" label="Members" description="View workspace members" />
        <AdminLink href="/builder/admin/resources" label="Resources" description="Manage shared company resources and grants" />
      </div>
    </div>
  )
}

function AdminLink({ href, label, description }: { href: string; label: string; description: string }) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: '1rem 1.25rem',
        background: '#111',
        border: '1px solid #1f1f1f',
        borderRadius: 8,
        textDecoration: 'none',
        color: '#e5e5e5',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#555', fontSize: '0.75rem' }}>{description}</div>
    </Link>
  )
}
