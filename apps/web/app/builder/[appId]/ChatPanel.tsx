'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { parse } from '@lima/aura-dsl'
import {
  type ConversationThread,
  type ThreadMessage,
  createThread,
  listMessages,
  listThreads,
  postMessage,
} from '../../../lib/api'

const POLL_INTERVAL_MS = 2500

interface Props {
  workspaceId: string
  appId: string
  /** Called when the assistant returns a new DSL to apply to the canvas. */
  onDSLUpdate: (newSource: string) => void
}

export function ChatPanel({ workspaceId, appId, onDSLUpdate }: Props) {
  const [thread, setThread] = useState<ConversationThread | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastMsgIdRef = useRef<string | null>(null)

  // -- Thread bootstrap ---------------------------------------------------
  const ensureThread = useCallback(async (): Promise<ConversationThread> => {
    if (thread) return thread
    const { threads } = await listThreads(workspaceId, appId)
    if (threads.length > 0) {
      setThread(threads[0])
      return threads[0]
    }
    const newThread = await createThread(workspaceId, appId)
    setThread(newThread)
    return newThread
  }, [thread, workspaceId, appId])

  // -- Poll for new messages ---------------------------------------------
  const fetchMessages = useCallback(async (t: ConversationThread) => {
    try {
      const { messages: fetched } = await listMessages(workspaceId, appId, t.id)
      setMessages(fetched)

      // Detect a new assistant message with a DSL patch.
      const lastFetchedId = fetched.length > 0 ? fetched[fetched.length - 1].id : null
      if (lastFetchedId && lastFetchedId !== lastMsgIdRef.current) {
        const newMsgs = lastMsgIdRef.current
          ? fetched.filter(m => m.created_at > (fetched.find(x => x.id === lastMsgIdRef.current)?.created_at ?? ''))
          : fetched

        for (const msg of newMsgs) {
          if (msg.role === 'assistant' && msg.dsl_patch?.new_source) {
            try {
              parse(msg.dsl_patch.new_source) // validate before applying
              onDSLUpdate(msg.dsl_patch.new_source)
            } catch {
              // DSL parse error — ignore this patch
            }
          }
        }
        lastMsgIdRef.current = lastFetchedId
      }
    } catch {
      // Silently ignore poll errors; the UI is not broken.
    }
  }, [workspaceId, appId, onDSLUpdate])

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const startPolling = useCallback((t: ConversationThread) => {
    stopPolling()
    pollRef.current = setInterval(() => fetchMessages(t), POLL_INTERVAL_MS)
  }, [fetchMessages])

  // Stop polling when a new assistant message arrives.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'assistant' && generating) {
      setGenerating(false)
      stopPolling()
    }
  }, [messages, generating])

  // Initial load.
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const { threads } = await listThreads(workspaceId, appId)
        if (cancelled) return
        if (threads.length > 0) {
          setThread(threads[0])
          const { messages: msgs } = await listMessages(workspaceId, appId, threads[0].id)
          if (!cancelled) {
            setMessages(msgs)
            if (msgs.length > 0) {
              lastMsgIdRef.current = msgs[msgs.length - 1].id
            }
          }
        }
      } catch {
        // Not fatal — user can still start a new thread.
      }
    }
    init()
    return () => { cancelled = true }
  }, [workspaceId, appId])

  // Scroll to bottom when messages change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Cleanup poll on unmount.
  useEffect(() => () => stopPolling(), [])

  // -- Send message -------------------------------------------------------
  const handleSend = async () => {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    setError('')
    setInput('')

    try {
      const t = await ensureThread()
      const { message, queued, queue_error } = await postMessage(workspaceId, appId, t.id, content)

      // Optimistically add the user message.
      setMessages(prev => [...prev, message])
      lastMsgIdRef.current = message.id

      if (queued) {
        setGenerating(true)
        startPolling(t)
      } else if (queue_error) {
        setError('Generation unavailable: ' + queue_error)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // -- Render -------------------------------------------------------------
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#0d0d0d',
      borderLeft: '1px solid #1a1a1a',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #1a1a1a',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: '#888',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        AI Assistant
        {generating && (
          <span style={{ color: '#60a5fa', fontSize: '0.65rem', fontWeight: 400 }}>
            generating…
          </span>
        )}
      </div>

      {/* Message list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ color: '#444', fontSize: '0.75rem', textAlign: 'center', marginTop: 40 }}>
            Describe the app you want to build.<br />
            <span style={{ color: '#333', fontSize: '0.65rem' }}>
              e.g. "Create a user management table with name, email, and role"
            </span>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
            }}
          >
            <div style={{
              padding: '8px 12px',
              borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: msg.role === 'user' ? '#1d4ed8' : '#1a1a1a',
              color: '#e5e5e5',
              fontSize: '0.75rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {msg.content}
            </div>
            {msg.role === 'assistant' && msg.dsl_patch?.new_source && (
              <div style={{ fontSize: '0.6rem', color: '#333', marginTop: 3, paddingLeft: 2 }}>
                canvas updated
              </div>
            )}
          </div>
        ))}

        {generating && (
          <div style={{ alignSelf: 'flex-start' }}>
            <div style={{
              padding: '8px 12px',
              borderRadius: '12px 12px 12px 2px',
              background: '#1a1a1a',
              color: '#555',
              fontSize: '0.75rem',
            }}>
              <span style={{ letterSpacing: 2 }}>···</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <div style={{
          margin: '0 14px',
          padding: '6px 10px',
          background: '#7f1d1d22',
          border: '1px solid #7f1d1d',
          borderRadius: 4,
          color: '#f87171',
          fontSize: '0.7rem',
          flexShrink: 0,
        }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '10px 14px', flexShrink: 0, borderTop: '1px solid #1a1a1a' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a change… (Enter to send)"
            rows={3}
            disabled={sending || generating}
            style={{
              flex: 1,
              background: '#111',
              border: '1px solid #222',
              borderRadius: 6,
              color: '#e5e5e5',
              fontSize: '0.75rem',
              padding: '8px 10px',
              resize: 'none',
              outline: 'none',
              lineHeight: 1.5,
              opacity: (sending || generating) ? 0.5 : 1,
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending || generating}
            style={{
              alignSelf: 'flex-end',
              padding: '8px 14px',
              borderRadius: 6,
              background: (!input.trim() || sending || generating) ? '#1e3a8a44' : '#1d4ed8',
              color: (!input.trim() || sending || generating) ? '#4b6eb5' : '#fff',
              border: 'none',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: (!input.trim() || sending || generating) ? 'default' : 'pointer',
              flexShrink: 0,
            }}
          >
            {sending ? '…' : '↑'}
          </button>
        </div>
        <div style={{ marginTop: 4, fontSize: '0.6rem', color: '#2a2a2a' }}>
          Shift+Enter for newline
        </div>
      </div>
    </div>
  )
}
