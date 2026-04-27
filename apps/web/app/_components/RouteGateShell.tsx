'use client'

import type { JSX } from 'react'

export function RouteGateShell(props: { title: string; message: string }): JSX.Element {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#e5e5e5',
      flexDirection: 'column',
      gap: '1rem',
    }}>
      <p style={{ color: '#888', fontSize: '0.875rem', margin: 0 }}>{props.message}</p>
    </div>
  )
}

export default RouteGateShell
