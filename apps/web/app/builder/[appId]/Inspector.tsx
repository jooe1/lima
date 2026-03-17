'use client'

import React from 'react'
import { type AuraNode, type AuraDocument } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType, type PropDef } from '@lima/widget-catalog'
import { getGrid, CELL, COLS } from './CanvasEditor'

interface Props {
  node: AuraNode | null
  doc: AuraDocument
  onUpdate: (node: AuraNode) => void
  onDelete: (id: string) => void
}

/**
 * Map a widget prop name to the AuraNode field that stores it.
 * The DSL has dedicated clauses for text, value, and transform; everything
 * else goes into the style map as a pseudo-prop.
 */
function getPropValue(node: AuraNode, propName: string): string {
  if (propName === 'text' || propName === 'label' || propName === 'content') {
    return node.text ?? ''
  }
  if (propName === 'value' || propName === 'data') {
    return node.value ?? ''
  }
  if (propName === 'transform') {
    return node.transform ?? ''
  }
  return node.style?.[propName] ?? ''
}

function setPropValue(node: AuraNode, propName: string, value: string): AuraNode {
  // Any manual prop edit marks this node as manually edited (FR-22)
  const updated: AuraNode = { ...node, manuallyEdited: true }

  if (propName === 'text' || propName === 'label' || propName === 'content') {
    updated.text = value || undefined
    return updated
  }
  if (propName === 'value' || propName === 'data') {
    updated.value = value || undefined
    return updated
  }
  if (propName === 'transform') {
    updated.transform = value || undefined
    return updated
  }

  updated.style = { ...(node.style ?? {}), [propName]: value }
  if (!value) {
    const { [propName]: _removed, ...rest } = updated.style
    updated.style = rest
  }
  return updated
}

export function Inspector({ node, doc: _doc, onUpdate, onDelete }: Props) {
  if (!node) {
    return (
      <aside style={panelStyle}>
        <div style={{ padding: '1rem', color: '#2a2a2a', fontSize: '0.75rem', textAlign: 'center', marginTop: '3rem' }}>
          Select a widget to inspect
        </div>
      </aside>
    )
  }

  // Capture narrowed reference — function declarations are hoisted and TypeScript
  // conservatively treats them as possibly seeing the pre-guard value.
  const n: AuraNode = node

  const meta = WIDGET_REGISTRY[n.element as WidgetType]
  const g = getGrid(n)

  const handleGridChange = (field: 'gridX' | 'gridY' | 'gridW' | 'gridH', raw: string) => {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    let clamped = Math.max(0, v)
    if (field === 'gridW') clamped = Math.max(2, clamped)
    if (field === 'gridH') clamped = Math.max(1, clamped)
    if (field === 'gridX') clamped = Math.max(0, clamped)

    onUpdate({
      ...n,
      style: { ...(n.style ?? {}), [field]: String(clamped) },
    })
  }

  const handlePropChange = (propName: string, value: string) => {
    onUpdate(setPropValue(n, propName, value))
  }

  return (
    <aside style={panelStyle}>
      {/* Widget identity */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            fontSize: '0.6rem', padding: '2px 7px', borderRadius: 99,
            background: '#1e3a8a33', color: '#93c5fd', fontWeight: 500,
          }}>
            {meta?.displayName ?? n.element}
          </span>
          {n.manuallyEdited && (
            <span title="Manually edited — protected from AI rewrites" style={{
              fontSize: '0.55rem', padding: '2px 6px', borderRadius: 99,
              background: '#78350f33', color: '#fcd34d',
            }}>
              manual
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e5e5e5', fontFamily: 'monospace' }}>
          {n.id}
        </div>
        {meta?.description && (
          <div style={{ fontSize: '0.65rem', color: '#444', marginTop: 4 }}>{meta.description}</div>
        )}
      </div>

      {/* Layout section */}
      <Section title="Layout">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="X" value={String(g.x)} type="number"
            onChange={v => handleGridChange('gridX', v)} />
          <Field label="Y" value={String(g.y)} type="number"
            onChange={v => handleGridChange('gridY', v)} />
          <Field label={`W (${g.w * CELL}px)`} value={String(g.w)} type="number"
            onChange={v => handleGridChange('gridW', v)} />
          <Field label={`H (${g.h * CELL}px)`} value={String(g.h)} type="number"
            onChange={v => handleGridChange('gridH', v)} />
        </div>
      </Section>

      {/* Props section */}
      {meta && (
        <Section title="Props">
          {Object.entries(meta.propSchema).map(([propName, def]) => (
            <PropField
              key={propName}
              name={propName}
              def={def}
              value={getPropValue(n, propName)}
              onChange={v => handlePropChange(propName, v)}
            />
          ))}
        </Section>
      )}

      {/* Data binding (with clause) */}
      {n.with && Object.keys(n.with).length > 0 && (
        <Section title="Data binding">
          <div style={{ fontSize: '0.65rem', color: '#444', fontFamily: 'monospace', background: '#0d0d0d', borderRadius: 4, padding: 8 }}>
            {Object.entries(n.with).map(([k, v]) => (
              <div key={k}>{k}=&quot;{v}&quot;</div>
            ))}
          </div>
        </Section>
      )}

      {/* Danger zone */}
      <div style={{ padding: '0.75rem 1rem', marginTop: 'auto' }}>
        <button
          onClick={() => onDelete(n.id)}
          style={{
            width: '100%', padding: '6px 12px', borderRadius: 4, fontSize: '0.75rem',
            background: 'transparent', border: '1px solid #2a1010', color: '#ef4444',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a0a0a' }}
          onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'transparent' }}
        >
          Delete widget
        </button>
      </div>
    </aside>
  )
}

/* ---- Sub-components --------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid #1a1a1a' }}>
      <div style={{
        padding: '6px 1rem', fontSize: '0.6rem', fontWeight: 600,
        color: '#444', textTransform: 'uppercase', letterSpacing: '0.08em',
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
  label, value, type = 'text', onChange,
}: {
  label: string
  value: string
  type?: 'text' | 'number'
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  )
}

function PropField({ name, def, value, onChange }: {
  name: string
  def: PropDef
  value: string
  onChange: (v: string) => void
}) {
  const isBoolean = def.type === 'boolean'
  const isMono = def.type === 'expression' || def.type === 'action'

  return (
    <div>
      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
        {def.label}
        {def.required && <span style={{ color: '#ef4444', fontSize: '0.6rem' }}>*</span>}
      </label>
      {isBoolean ? (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          style={{ accentColor: '#3b82f6', marginTop: 2 }}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={def.default !== undefined ? String(def.default) : ''}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, fontFamily: isMono ? 'monospace' : 'inherit', fontSize: isMono ? '0.65rem' : '0.75rem' }}
        />
      )}
      {def.description && (
        <div style={{ fontSize: '0.6rem', color: '#333', marginTop: 3 }}>{def.description}</div>
      )}
    </div>
  )
}

/* ---- Styles ----------------------------------------------------------- */

const panelStyle: React.CSSProperties = {
  width: 260,
  flexShrink: 0,
  borderLeft: '1px solid #1a1a1a',
  background: '#0a0a0a',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.65rem',
  color: '#555',
  marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #222',
  borderRadius: 4,
  color: '#e5e5e5',
  padding: '4px 8px',
  fontSize: '0.75rem',
  boxSizing: 'border-box',
  outline: 'none',
}
