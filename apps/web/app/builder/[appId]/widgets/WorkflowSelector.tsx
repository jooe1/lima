'use client'

import React, { useEffect, useState } from 'react'
import { listWorkflows, type Workflow } from '../../../../lib/api'

interface WorkflowSelectorProps {
  workspaceId: string
  appId: string
  triggerType: 'form_submit' | 'button_click'
  value: string | undefined
  onChange: (workflowId: string | undefined) => void
}

export function WorkflowSelector({ workspaceId, appId, triggerType, value, onChange }: WorkflowSelectorProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!workspaceId || !appId) return
    let cancelled = false
    setLoading(true)
    listWorkflows(workspaceId, appId)
      .then(res => {
        if (!cancelled) {
          setWorkflows(
            (res.workflows ?? []).filter(
              w => w.trigger_type === triggerType && w.status !== 'archived',
            ),
          )
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load workflows')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [workspaceId, appId, triggerType])

  const selected = workflows.find(w => w.id === value)

  const handleSelect = (id: string | undefined) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <div>
      {/* Trigger button */}
      <button
        onClick={() => !loading && setOpen(true)}
        disabled={loading}
        style={{
          width: '100%',
          background: '#111',
          border: '1px solid #222',
          borderRadius: 4,
          color: loading ? '#555' : '#e5e5e5',
          padding: '4px 8px',
          fontSize: '0.75rem',
          textAlign: 'left',
          cursor: loading ? 'default' : 'pointer',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? 'Loading…' : (selected ? selected.name : '— none —')}
        </span>
        <span style={{ fontSize: '0.6rem', color: '#555', flexShrink: 0 }}>▾</span>
      </button>

      {error && (
        <div style={{ fontSize: '0.6rem', color: '#ef4444', marginTop: 3 }}>{error}</div>
      )}
      {selected && (
        <div style={{ fontSize: '0.6rem', color: '#666', marginTop: 4, lineHeight: 1.4 }}>
          End users need a &apos;mutate&apos; grant on the connector to trigger this workflow.
        </div>
      )}
      {!loading && !error && workflows.length === 0 && (
        <div style={{ fontSize: '0.6rem', color: '#444', marginTop: 3 }}>
          No {triggerType === 'form_submit' ? 'form submit' : 'button click'} workflows found.
          Open the Workflows panel (⚡) to create one.
        </div>
      )}

      {/* Picker modal */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(420px, 95vw)', maxHeight: '70vh',
              background: '#111', border: '1px solid #2a2a2a', borderRadius: 8,
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderBottom: '1px solid #1e1e1e', flexShrink: 0,
            }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e5e5e5' }}>
                Select Workflow
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'transparent', border: 'none', color: '#555',
                  fontSize: '1rem', cursor: 'pointer', lineHeight: 1, padding: '2px 4px',
                }}
              >
                ✕
              </button>
            </div>

            {/* List */}
            <div style={{ overflowY: 'auto', padding: '6px 0' }}>
              {/* None option */}
              <button
                onClick={() => handleSelect(undefined)}
                style={{
                  width: '100%', textAlign: 'left', background: !value ? '#1e1e1e' : 'transparent',
                  border: 'none', borderBottom: '1px solid #1a1a1a',
                  padding: '8px 14px', cursor: 'pointer', color: '#888', fontSize: '0.75rem',
                }}
              >
                — none —
              </button>

              {workflows.map(w => (
                <button
                  key={w.id}
                  onClick={() => handleSelect(w.id)}
                  style={{
                    width: '100%', textAlign: 'left',
                    background: value === w.id ? '#1e3a8a33' : 'transparent',
                    border: 'none', borderBottom: '1px solid #1a1a1a',
                    padding: '8px 14px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  }}
                >
                  <span style={{
                    color: '#e5e5e5', fontSize: '0.75rem',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {w.name}
                  </span>
                  {w.requires_approval && (
                    <span style={{
                      fontSize: '0.6rem', padding: '1px 6px', borderRadius: 99, flexShrink: 0,
                      background: '#78350f33', color: '#fcd34d',
                    }}>
                      needs approval
                    </span>
                  )}
                </button>
              ))}

              {workflows.length === 0 && (
                <div style={{ padding: '12px 14px', fontSize: '0.72rem', color: '#444' }}>
                  No {triggerType === 'form_submit' ? 'form submit' : 'button click'} workflows found.
                  Open the Workflows panel (⚡) to create one.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
