'use client'

import React from 'react'

export function ConnectorDrawer({
  isOpen,
  onClose,
  children,
  title,
}: {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          zIndex: 40,
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
          transition: 'opacity 0.22s ease',
        }}
      />

      {/* Slide-in panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Drawer'}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100%',
          width: 'min(440px, 100vw)',
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.45)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {title ? (
            <span
              style={{
                flex: 1,
                fontWeight: 600,
                fontSize: 'var(--font-size-base)',
                color: 'var(--color-text)',
              }}
            >
              {title}
            </span>
          ) : (
            <div style={{ flex: 1 }} />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-subtle)',
              fontSize: '1.1rem',
              lineHeight: 1,
              padding: '4px 6px',
              borderRadius: 4,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '1.25rem',
          }}
        >
          {children}
        </div>
      </div>
    </>
  )
}
