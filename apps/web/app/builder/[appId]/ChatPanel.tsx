'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { parseV2, type AuraEdge } from '@lima/aura-dsl'
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
  onDSLUpdate: (newSource: string, newEdges?: AuraEdge[]) => void
}

export function ChatPanel({ workspaceId, appId, onDSLUpdate }: Props) {
  const [thread, setThread] = useState<ConversationThread | null>(null)
  const [threads, setThreads] = useState<ConversationThread[]>([])
  const [threadListOpen, setThreadListOpen] = useState(false)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [input, setInput] = useState('')
  const [forceOverwrite, setForceOverwrite] = useState(false)
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  // Tracks message IDs whose DSL patches were successfully parsed and applied.
  const [appliedPatchIds, setAppliedPatchIds] = useState<ReadonlySet<string>>(new Set())
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

        const newlyApplied: string[] = []
        for (const msg of newMsgs) {
          if (msg.role === 'assistant' && msg.dsl_patch?.new_source) {
            try {
              const parsed = parseV2(msg.dsl_patch.new_source) // validate before applying
              console.info('[ChatPanel] applying polled DSL patch', {
                messageId: msg.id,
                sourceBytes: msg.dsl_patch.new_source.length,
                parsedNodes: parsed.nodes.length,
                parsedEdges: parsed.edges.length,
                incomingEdges: msg.dsl_patch.new_edges?.length ?? 0,
              })
              onDSLUpdate(msg.dsl_patch.new_source, msg.dsl_patch.new_edges)
              newlyApplied.push(msg.id)
            } catch (err) {
              console.warn('[ChatPanel] DSL patch parse error — patch ignored', err, {
                messageId: msg.id,
                dslPreview: msg.dsl_patch.new_source.slice(0, 400),
              })
            }
          }
        }
        if (newlyApplied.length > 0) {
          setAppliedPatchIds(prev => {
            const next = new Set(prev)
            newlyApplied.forEach(id => next.add(id))
            return next
          })
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
        const { threads: fetched } = await listThreads(workspaceId, appId)
        if (cancelled) return
        setThreads(fetched)
        if (fetched.length > 0) {
          setThread(fetched[0])
          const { messages: msgs } = await listMessages(workspaceId, appId, fetched[0].id)
          if (!cancelled) {
            setMessages(msgs)
            if (msgs.length > 0) {
              lastMsgIdRef.current = msgs[msgs.length - 1].id
              // Apply the latest DSL patch so the canvas reflects prior generations
              // when the chat panel mounts after a generation has already completed.
              for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i]
                if (msg.role === 'assistant' && msg.dsl_patch?.new_source) {
                  try {
                    const parsed = parseV2(msg.dsl_patch.new_source)
                    console.info('[ChatPanel] applying initial DSL patch', {
                      messageId: msg.id,
                      sourceBytes: msg.dsl_patch.new_source.length,
                      parsedNodes: parsed.nodes.length,
                      parsedEdges: parsed.edges.length,
                      incomingEdges: msg.dsl_patch.new_edges?.length ?? 0,
                    })
                    onDSLUpdate(msg.dsl_patch.new_source, msg.dsl_patch.new_edges)
                  } catch (err) {
                    console.warn('[ChatPanel] initial DSL patch parse error — patch ignored', err, {
                      messageId: msg.id,
                      dslPreview: msg.dsl_patch.new_source.slice(0, 400),
                    })
                  }
                  break // only apply the most recent patch
                }
              }
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
  const sendMessage = async (
    rawContent: string,
    options?: { forceOverwrite?: boolean; clearInput?: boolean },
  ) => {
    const content = rawContent.trim()
    if (!content || sending || generating) return

    const shouldForceOverwrite = options?.forceOverwrite ?? false
    const shouldClearInput = options?.clearInput ?? false

    setSending(true)
    setError('')
    if (shouldClearInput) {
      setInput('')
    }

    try {
      const t = await ensureThread()
      const { message, queued, queue_error } = await postMessage(workspaceId, appId, t.id, content, {
        forceOverwrite: shouldForceOverwrite,
      })

      // Optimistically add the user message.
      setMessages(prev => [...prev, message])
      lastMsgIdRef.current = message.id

      if (shouldForceOverwrite) {
        setForceOverwrite(false)
      }

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

  const handleSend = () => {
    void sendMessage(input, { forceOverwrite, clearInput: true })
  }

  const lastUserPrompt = [...messages].reverse().find(message => message.role === 'user')?.content ?? ''

  const handleRetryWithOverwrite = () => {
    if (!lastUserPrompt) return
    void sendMessage(lastUserPrompt, { forceOverwrite: true })
  }

  const switchThread = useCallback(async (t: ConversationThread) => {
    stopPolling()
    setThread(t)
    setMessages([])
    setGenerating(false)
    setError('')
    setAppliedPatchIds(new Set())
    lastMsgIdRef.current = null
    try {
      const { messages: msgs } = await listMessages(workspaceId, appId, t.id)
      setMessages(msgs)
      if (msgs.length > 0) lastMsgIdRef.current = msgs[msgs.length - 1].id
    } catch {
      // ignore
    }
  }, [workspaceId, appId])

  const handleNewThread = useCallback(async () => {
    try {
      const t = await createThread(workspaceId, appId)
      setThreads(prev => [t, ...prev])
      await switchThread(t)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create thread')
    }
  }, [workspaceId, appId, switchThread])

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
      <div style={{ padding: '0.5rem 0.75rem', background: '#0f0f0f', borderBottom: '1px solid #1a1a1a', fontSize: '0.65rem', color: '#555', textAlign: 'center' }}>
        AI-assisted building · preview feature
      </div>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: threadListOpen ? 'none' : '1px solid #1a1a1a',
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
        <button
          onClick={() => setThreadListOpen(o => !o)}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: '1px solid #1a1a1a',
            borderRadius: 4,
            color: '#555',
            fontSize: '0.6rem',
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          {threads.length} thread{threads.length !== 1 ? 's' : ''}
        </button>
      </div>

      {/* Thread list strip */}
      {threadListOpen && (
        <div style={{
          padding: '6px 14px',
          borderBottom: '1px solid #1a1a1a',
          flexShrink: 0,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          alignItems: 'center',
        }}>
          <button
            onClick={handleNewThread}
            style={{
              background: '#1d4ed8',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.6rem',
              fontWeight: 600,
              padding: '3px 8px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            + New
          </button>
          {threads.map(t => (
            <button
              key={t.id}
              onClick={() => switchThread(t)}
              style={{
                background: t.id === thread?.id ? '#1a1a1a' : 'none',
                border: t.id === thread?.id ? '1px solid #333' : '1px solid #1a1a1a',
                borderRadius: 4,
                color: t.id === thread?.id ? '#e5e5e5' : '#555',
                fontSize: '0.6rem',
                padding: '3px 6px',
                cursor: 'pointer',
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </button>
          ))}
        </div>
      )}

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
            {msg.role === 'assistant' && appliedPatchIds.has(msg.id) && (
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
              minWidth: 84,
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
            {sending ? 'Sending…' : forceOverwrite ? 'Overwrite' : 'Send'}
          </button>
        </div>
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: forceOverwrite ? '#fcd34d' : '#555',
            fontSize: '0.65rem',
            cursor: (sending || generating) ? 'default' : 'pointer',
          }}>
            <input
              type="checkbox"
              checked={forceOverwrite}
              onChange={e => setForceOverwrite(e.target.checked)}
              disabled={sending || generating}
            />
            Overwrite manually protected nodes for this send
          </label>
          {forceOverwrite && (
            <div style={{ color: '#444', fontSize: '0.6rem', lineHeight: 1.4 }}>
              This bypasses the builder protection on manually edited nodes for the next request only.
            </div>
          )}
          {lastUserPrompt && (
            <button
              onClick={handleRetryWithOverwrite}
              disabled={sending || generating}
              style={{
                justifySelf: 'start',
                background: 'none',
                border: '1px solid #1f2937',
                borderRadius: 4,
                color: (sending || generating) ? '#374151' : '#93c5fd',
                cursor: (sending || generating) ? 'default' : 'pointer',
                fontSize: '0.65rem',
                padding: '3px 8px',
              }}
            >
              Retry last with overwrite
            </button>
          )}
          <div style={{ fontSize: '0.6rem', color: '#2a2a2a' }}>
            Shift+Enter for newline
          </div>
        </div>
      </div>
    </div>
  )
}
