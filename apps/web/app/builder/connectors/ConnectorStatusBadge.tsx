import type { JSX } from 'react'
import styles from './connectors.module.css'

export function getConnectorStatus(connector: { schema_cached_at: string | null | undefined }): {
  tier: 'fresh' | 'stale' | 'unconfigured'
  label: string
} {
  if (!connector.schema_cached_at) {
    return { tier: 'unconfigured', label: 'Not set up yet' }
  }

  const diffMs = Date.now() - new Date(connector.schema_cached_at).getTime()
  const hours = Math.floor(diffMs / 3600000)
  const days = Math.floor(diffMs / 86400000)

  if (days > 7) {
    return { tier: 'unconfigured', label: 'Not set up yet' }
  }
  if (days >= 1) {
    return { tier: 'stale', label: `Synced ${days} days ago` }
  }
  return { tier: 'fresh', label: `Synced ${hours}h ago` }
}

export function ConnectorStatusBadge({
  connector,
}: {
  connector: { schema_cached_at: string | null | undefined }
}): JSX.Element {
  const { tier, label } = getConnectorStatus(connector)

  const cls =
    tier === 'fresh'
      ? styles.badgeFresh
      : tier === 'stale'
        ? styles.badgeStale
        : styles.badgeUnconfigured

  return (
    <span className={cls}>
      <span className={styles.badgeDot} />
      {label}
    </span>
  )
}
