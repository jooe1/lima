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

  return (
    <div>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value || undefined)}
        disabled={loading}
        style={{
          width: '100%',
          background: '#111',
          border: '1px solid #222',
          borderRadius: 4,
          color: loading ? '#555' : '#e5e5e5',
          padding: '4px 8px',
          fontSize: '0.75rem',
          boxSizing: 'border-box',
          outline: 'none',
          appearance: 'auto',
        }}
      >
        <option value="">— none —</option>
        {workflows.map(w => (
          <option key={w.id} value={w.id}>
            {w.name}{w.requires_approval ? ' (needs approval)' : ''}
          </option>
        ))}
      </select>

      {error && (
        <div style={{ fontSize: '0.6rem', color: '#ef4444', marginTop: 3 }}>{error}</div>
      )}
      {loading && (
        <div style={{ fontSize: '0.6rem', color: '#555', marginTop: 3 }}>Loading workflows…</div>
      )}
      {selected && (
        <div style={{ fontSize: '0.6rem', color: '#666', marginTop: 4, lineHeight: 1.4 }}>
          End users need a &apos;mutate&apos; grant on the connector to trigger this workflow.
        </div>
      )}
      {!loading && !error && workflows.length === 0 && (
        <div style={{ fontSize: '0.6rem', color: '#444', marginTop: 3 }}>
          No {triggerType === 'form_submit' ? 'form submit' : 'button click'} workflows found.
          Create one in the Workflows panel.
        </div>
      )}
    </div>
  )
}
