'use client'

import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../../../../lib/api'

export interface AppSSEEvent {
  type: string
  data: Record<string, unknown>
}

/**
 * Subscribes to the app event stream via fetch + ReadableStream so we can
 * send an Authorization header (EventSource does not support custom headers).
 *
 * Reconnect backoff: 100ms * 2^attempt, capped at 30_000ms.
 * On HTTP 401/403 or after 3 consecutive auth failures: stops retrying.
 * When `enabled` is false the hook is dormant — no fetch initiated.
 */
export function useAppSSE(
  workspaceId: string,
  appId: string,
  enabled: boolean,
  token: string | null,
): { connected: boolean; lastEvent: AppSSEEvent | null } {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<AppSSEEvent | null>(null)

  // Stable refs so the effect closure doesn't capture stale values
  const attemptRef = useRef(0)
  const authFailRef = useRef(0)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled || !workspaceId || !appId) return
    if (!token) return

    let isCurrent = true
    const ac = new AbortController()

    async function connect(): Promise<void> {
      if (!isCurrent) return

      try {
        const url = `${API_BASE}/v1/workspaces/${workspaceId}/apps/${appId}/events`
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        })

        if (res.status === 401 || res.status === 403) {
          authFailRef.current++
          if (authFailRef.current >= 3) {
            console.warn('[useAppSSE] auth error — stopping retries')
            return
          }
          scheduleReconnect()
          return
        }

        if (!res.ok || !res.body) {
          scheduleReconnect()
          return
        }

        // Reset auth failure counter on a good connection
        authFailRef.current = 0

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!isCurrent) return

          buf += decoder.decode(value, { stream: true })
          const blocks = buf.split('\n\n')
          buf = blocks.pop() ?? ''

          for (const block of blocks) {
            if (!block.trim()) continue
            const lines = block.split('\n')
            let evtType = 'message'
            let dataStr = ''
            for (const line of lines) {
              if (line.startsWith('event:')) evtType = line.slice(6).trim()
              else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
            }
            if (dataStr) {
              try {
                const parsed = JSON.parse(dataStr) as Record<string, unknown>
                if (isCurrent) {
                  setConnected(true)
                  attemptRef.current = 0 // reset backoff on first successful event
                  setLastEvent({ type: evtType, data: parsed })
                }
              } catch {
                // malformed data line — skip
              }
            }
          }
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return
      }

      if (isCurrent) {
        setConnected(false)
        scheduleReconnect()
      }
    }

    function scheduleReconnect(): void {
      if (!isCurrent) return
      const delay = Math.min(100 * Math.pow(2, attemptRef.current), 30_000)
      attemptRef.current++
      reconnectRef.current = setTimeout(() => { void connect() }, delay)
    }

    void connect()

    return () => {
      isCurrent = false
      ac.abort()
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      setConnected(false)
    }
  }, [enabled, workspaceId, appId, token])

  return { connected, lastEvent }
}
