'use client'

export function ConnectorSetupHint({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-6)',
      marginBottom: 'var(--space-6)',
    }}>
      <h3 style={{
        fontSize: 'var(--font-size-base)',
        fontWeight: 600,
        color: 'var(--color-text)',
        marginBottom: 'var(--space-2)',
        marginTop: 0,
      }}>
        {title}
      </h3>
      <p style={{
        color: 'var(--color-text-muted)',
        fontSize: 'var(--font-size-sm)',
        marginBottom: actionLabel ? 'var(--space-4)' : 0,
        marginTop: 0,
      }}>
        {body}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            padding: 'var(--space-2) var(--space-4)',
            background: 'var(--color-primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
            fontSize: 'var(--font-size-sm)',
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

export default ConnectorSetupHint
