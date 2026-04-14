'use client'

import React, { useState, useEffect } from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { listConnectors, type Connector } from '../../../lib/api'

interface Props {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
  onDelete: (id: string) => void
  workspaceId: string
}

// Shared style helpers
const panelStyle: React.CSSProperties = {
  width: 280,
  flexShrink: 0,
  borderLeft: '1px solid #1a1a1a',
  background: '#0d0d0d',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.65rem',
  color: '#555',
  marginBottom: 4,
  display: 'block',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #1e1e1e',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: '0.72rem',
  color: '#e5e5e5',
  boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 80,
  fontFamily: 'monospace',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid #1a1a1a' }}>
      <div style={{
        padding: '6px 1rem',
        fontSize: '0.6rem',
        fontWeight: 600,
        color: '#444',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        background: '#0c0c0c',
      }}>
        {title}
      </div>
      <div style={{ padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, type = 'text', placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'textarea'
  placeholder?: string
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {type === 'textarea' ? (
        <textarea
          style={textareaStyle}
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
        />
      ) : (
        <input
          style={inputStyle}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

// ---- Step type metadata ----------------------------------------------------

const STEP_META: Record<string, { icon: string; label: string; color: string }> = {
  'step:query':         { icon: '📋', label: 'Query',         color: '#3b82f6' },
  'step:mutation':      { icon: '✏️',  label: 'Mutation',     color: '#fb923c' },
  'step:condition':     { icon: '◆',  label: 'Condition',    color: '#facc15' },
  'step:approval_gate': { icon: '🔒', label: 'Approval Gate', color: '#a78bfa' },
  'step:notification':  { icon: '🔔', label: 'Notification', color: '#34d399' },
  'step:transform':     { icon: '{}', label: 'Transform',    color: '#e879f9' },
  'step:http':          { icon: '🌐', label: 'HTTP Request', color: '#38bdf8' },
}

// ---- Sub-editors per step type ---------------------------------------------

function SqlStepEditor({
  node, onUpdate, workspaceId,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
  workspaceId: string
}) {
  const [connectors, setConnectors] = useState<Connector[]>([])

  useEffect(() => {
    if (!workspaceId) return
    listConnectors(workspaceId).then(res => setConnectors(res.connectors ?? [])).catch(() => {})
  }, [workspaceId])

  const with_ = node.with ?? {}

  const set = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: {
        ...with_,
        ...(value ? { [key]: value } : {}),
        ...(value ? {} : Object.fromEntries(Object.entries(with_).filter(([k]) => k !== key))),
      },
    })
  }

  return (
    <>
      <div>
        <label style={labelStyle}>Connector</label>
        <select
          style={selectStyle}
          value={with_.connector ?? ''}
          onChange={e => set('connector', e.target.value)}
        >
          <option value="">Select a connector…</option>
          {connectors.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <Field
        label="SQL"
        type="textarea"
        value={String(with_.sql ?? '')}
        placeholder={node.element === 'step:query'
          ? 'SELECT * FROM table WHERE id = {{widget.port}}'
          : 'INSERT INTO table (col) VALUES ({{widget.port}})'}
        onChange={v => set('sql', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
        Use <code style={{ color: '#555' }}>{'{{widgetId.portName}}'}</code> to reference widget values.
      </div>
    </>
  )
}

function ConditionEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}

  const set = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: {
        ...with_,
        ...(value ? { [key]: value } : {}),
        ...(value ? {} : Object.fromEntries(Object.entries(with_).filter(([k]) => k !== key))),
      },
    })
  }

  return (
    <>
      <Field
        label="Expression"
        type="textarea"
        value={String(with_.expression ?? '')}
        placeholder="e.g. {{form1.values.status}} === 'active'"
        onChange={v => set('expression', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
        Must evaluate to a boolean. The <span style={{ color: '#4ade80' }}>true branch</span> fires when truthy, <span style={{ color: '#f87171' }}>false branch</span> otherwise.
      </div>
    </>
  )
}

function NotificationEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}

  const set = (key: string, value: string) => {
    onUpdate({
      ...node,
      with: {
        ...with_,
        ...(value ? { [key]: value } : {}),
        ...(value ? {} : Object.fromEntries(Object.entries(with_).filter(([k]) => k !== key))),
      },
    })
  }

  return (
    <>
      <Field
        label="Channel"
        value={String(with_.channel ?? '')}
        placeholder="#general"
        onChange={v => set('channel', v)}
      />
      <Field
        label="Message"
        type="textarea"
        value={String(with_.message ?? '')}
        placeholder="New submission from {{form1.values.name}}"
        onChange={v => set('message', v)}
      />
    </>
  )
}

function TransformEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}
  const set = (key: string, value: string) =>
    onUpdate({ ...node, with: { ...with_, [key]: value } })

  return (
    <>
      <Field
        label="Expression (JS)"
        type="textarea"
        value={String(with_.expression ?? '')}
        placeholder="e.g. ({ name: $input.firstName + ' ' + $input.lastName })"
        onChange={v => set('expression', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic', lineHeight: 1.5 }}>
        Use <code style={{ color: '#555' }}>$input</code> to access the node&apos;s input value.
        Return the reshaped object as a JS expression.
      </div>
    </>
  )
}

function HttpEditor({
  node, onUpdate,
}: {
  node: AuraNode
  onUpdate: (node: AuraNode) => void
}) {
  const with_ = node.with ?? {}
  const set = (key: string, value: string) =>
    onUpdate({ ...node, with: { ...with_, [key]: value } })

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8 }}>
        <div>
          <label style={labelStyle}>Method</label>
          <select
            style={selectStyle}
            value={String(with_.method ?? 'GET')}
            onChange={e => set('method', e.target.value)}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 0 }}>
          <Field
            label="URL"
            value={String(with_.url ?? '')}
            placeholder="https://api.example.com/endpoint"
            onChange={v => set('url', v)}
          />
        </div>
      </div>
      <Field
        label="Headers (JSON object)"
        type="textarea"
        value={String(with_.headers ?? '')}
        placeholder='{"Authorization": "Bearer {{token}}"}'
        onChange={v => set('headers', v)}
      />
      <Field
        label="Body (JSON)"
        type="textarea"
        value={String(with_.body ?? '')}
        placeholder='{"key": "{{widget.value}}"}'
        onChange={v => set('body', v)}
      />
      <div style={{ fontSize: '0.6rem', color: '#444', fontStyle: 'italic' }}>
        Use <code style={{ color: '#555' }}>{'{{widgetId.portName}}'}</code> for dynamic values.
      </div>
    </>
  )
}

// ---- Main component --------------------------------------------------------

export function StepConfigPanel({ node, onUpdate, onDelete, workspaceId }: Props) {
  const meta = STEP_META[node.element]

  const handleNameChange = (value: string) => {
    onUpdate({ ...node, text: value || undefined })
  }

  return (
    <aside style={panelStyle}>
      {/* Header */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: '1rem' }}>{meta?.icon ?? '⚙️'}</span>
          <span style={{
            fontSize: '0.6rem',
            padding: '2px 7px',
            borderRadius: 99,
            background: (meta?.color ?? '#555') + '22',
            color: meta?.color ?? '#aaa',
            fontWeight: 500,
          }}>
            {meta?.label ?? node.element}
          </span>
        </div>
        <div>
          <label style={labelStyle}>Step name</label>
          <input
            style={inputStyle}
            type="text"
            value={node.text ?? ''}
            placeholder={node.id}
            onChange={e => handleNameChange(e.target.value)}
          />
        </div>
        <div style={{ fontSize: '0.6rem', color: '#333', fontFamily: 'monospace', marginTop: 4 }}>
          {node.id}
        </div>
      </div>

      {/* Config section — per step type */}
      {(node.element === 'step:query' || node.element === 'step:mutation') && (
        <Section title="Configuration">
          <SqlStepEditor node={node} onUpdate={onUpdate} workspaceId={workspaceId} />
        </Section>
      )}

      {node.element === 'step:condition' && (
        <Section title="Configuration">
          <ConditionEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:approval_gate' && (
        <Section title="Configuration">
          <div style={{ fontSize: '0.7rem', color: '#666' }}>
            Approval Gate pauses execution and waits for a workspace admin to approve or reject.
            No additional configuration required.
          </div>
        </Section>
      )}

      {node.element === 'step:notification' && (
        <Section title="Configuration">
          <NotificationEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:transform' && (
        <Section title="Configuration">
          <TransformEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {node.element === 'step:http' && (
        <Section title="Configuration">
          <HttpEditor node={node} onUpdate={onUpdate} />
        </Section>
      )}

      {/* With map debug view */}
      {node.with && Object.keys(node.with).length > 0 && (
        <Section title="Raw config">
          <div style={{
            fontSize: '0.6rem', fontFamily: 'monospace', color: '#444',
            background: '#0d0d0d', borderRadius: 4, padding: 8, wordBreak: 'break-all',
          }}>
            {Object.entries(node.with).map(([k, v]) => (
              <div key={k}><span style={{ color: '#555' }}>{k}</span>=&quot;{v}&quot;</div>
            ))}
          </div>
        </Section>
      )}

      {/* Delete */}
      <div style={{ padding: '0.75rem 1rem', marginTop: 'auto' }}>
        <button
          onClick={() => onDelete(node.id)}
          style={{
            width: '100%',
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: '0.75rem',
            background: 'transparent',
            border: '1px solid #2a1010',
            color: '#ef4444',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a0a0a' }}
          onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'transparent' }}
        >
          Delete step
        </button>
      </div>
    </aside>
  )
}
