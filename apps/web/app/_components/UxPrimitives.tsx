'use client'
import React from 'react'

// SurfaceCard — general-purpose card container
export function SurfaceCard({ title, children }: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-6)',
    }}>
      {title && (
        <h2 style={{
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
          color: 'var(--color-text)',
          marginBottom: 'var(--space-4)',
        }}>{title}</h2>
      )}
      {children}
    </div>
  )
}

// InlineAlert — status messaging
type AlertTone = 'info' | 'success' | 'warning' | 'error'
const toneColors: Record<AlertTone, string> = {
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
}
export function InlineAlert({ tone, message }: { tone: AlertTone; message: string }): React.JSX.Element {
  return (
    <div role="alert" style={{
      padding: 'var(--space-3) var(--space-4)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-surface-raised)',
      border: `1px solid ${toneColors[tone]}`,
      color: toneColors[tone],
      fontSize: 'var(--font-size-sm)',
    }}>
      {message}
    </div>
  )
}

// PrimaryButton — main call-to-action button
export function PrimaryButton({ children, disabled, onClick, type = 'button' }: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit' | 'reset'
}): React.JSX.Element {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        background: disabled ? 'var(--color-surface-raised)' : 'var(--color-primary)',
        color: disabled ? 'var(--color-text-muted)' : '#fff',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        fontWeight: 600,
        fontSize: 'var(--font-size-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: '100%',
        transition: 'background 0.15s',
      }}
    >
      {children}
    </button>
  )
}

// FormField — labeled input wrapper
export function FormField({ label, children, id }: {
  label: string
  id: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <label htmlFor={id} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', fontWeight: 500 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// EmptyState — zero-data placeholder
export function EmptyState({ title, body }: { title: string; body?: string }): React.JSX.Element {
  return (
    <div style={{
      textAlign: 'center',
      padding: 'var(--space-10) var(--space-6)',
      color: 'var(--color-text-muted)',
    }}>
      <p style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 'var(--space-2)' }}>{title}</p>
      {body && <p style={{ fontSize: 'var(--font-size-sm)' }}>{body}</p>}
    </div>
  )
}
