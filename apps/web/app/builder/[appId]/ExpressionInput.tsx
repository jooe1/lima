'use client'

/**
 * ExpressionInput — a value input that understands {{widgetId.portName}}
 * binding expressions (Approach 5).
 *
 * Behaviour:
 * - When the stored value is exactly `{{widgetId.portName}}`, renders a
 *   green binding chip instead of a text box.  An ✕ clears it back to text.
 * - When the slot has been wired via drag-to-wire (locked=true), renders a
 *   blue "Wired" read-only pill — deletion must happen on the canvas.
 * - Otherwise renders a plain text input.  Clicking the `@` button OR typing
 *   `@` opens a two-level picker: first pick the source widget by name, then
 *   pick one of its output ports.  The chosen ref is inserted at the cursor
 *   as `{{widgetId.portName}}`.
 */

import React, { useRef, useState } from 'react'
import { WIDGET_REGISTRY, type PortDef, type WidgetType } from '@lima/widget-catalog'
import { type AuraNode } from '@lima/aura-dsl'

// ---- Public types ----------------------------------------------------------

export interface AvailableWidget {
  id: string
  displayName: string
  element: string
  outputPorts: PortDef[]
}

/** Build the available-widget list from a doc's non-step, non-group nodes. */
export function buildAvailableWidgets(nodes: AuraNode[]): AvailableWidget[] {
  return nodes
    .filter(n => !n.element.startsWith('step:') && n.element !== 'flow:group')
    .map(n => {
      const meta = WIDGET_REGISTRY[n.element as WidgetType]
      const outputPorts = (meta?.ports ?? []).filter(p => p.direction === 'output')
      return {
        id: n.id,
        displayName: meta?.displayName ?? n.element,
        element: n.element,
        outputPorts,
      }
    })
    .filter(w => w.outputPorts.length > 0)
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  availableWidgets: AvailableWidget[]
  /** When true the slot is wired via a canvas drag edge — shows a blue pill,
   *  not editable here (delete the edge on the canvas to unwire). */
  locked?: boolean
  lockLabel?: string
  baseStyle?: React.CSSProperties
}

// ---- Helpers ---------------------------------------------------------------

/** Returns binding parts when value is a single {{widgetId.portName}} ref. */
function parseSingleBinding(value: string): { widgetId: string; port: string } | null {
  const m = value.match(/^\{\{([^.}]+)\.([^}]+)\}\}$/)
  return m ? { widgetId: m[1], port: m[2] } : null
}

// ---- Shared styles ---------------------------------------------------------

const BASE: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #1e1e1e',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: '0.72rem',
  color: '#e5e5e5',
  boxSizing: 'border-box',
}

// ---- Component -------------------------------------------------------------

export function ExpressionInput({
  value,
  onChange,
  placeholder,
  availableWidgets,
  locked,
  lockLabel,
  baseStyle,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState<'widget' | 'port'>('widget')
  const [selectedWidget, setSelectedWidget] = useState<AvailableWidget | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const merged: React.CSSProperties = { ...BASE, ...baseStyle }

  // ---- Drag-to-wire lock ---------------------------------------------------
  if (locked && lockLabel) {
    return (
      <div style={{
        ...merged,
        background: '#0a1520',
        border: '1px solid #1e3a5a',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: '#60a5fa',
        cursor: 'default',
      }}>
        <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>⚡</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {lockLabel}
        </span>
        <span style={{ fontSize: '0.55rem', color: '#3b82f6', opacity: 0.5, flexShrink: 0 }}>Wired</span>
      </div>
    )
  }

  // ---- Single-binding chip -------------------------------------------------
  const binding = parseSingleBinding(value)
  if (binding) {
    const w = availableWidgets.find(aw => aw.id === binding.widgetId)
    const chipLabel = w
      ? `${w.displayName} · ${binding.port}`
      : `${binding.widgetId} · ${binding.port}`
    return (
      <div style={{
        ...merged,
        background: '#0d1f0d',
        border: '1px solid #1a3a1a',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: '#4ade80',
        cursor: 'default',
      }}>
        <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>@</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chipLabel}
        </span>
        <button
          title="Clear binding"
          onClick={e => { e.stopPropagation(); onChange('') }}
          style={{
            background: 'none', border: 'none', color: '#555',
            cursor: 'pointer', padding: 0, fontSize: '0.7rem', lineHeight: 1, flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>
    )
  }

  // ---- Plain text input + @ picker ----------------------------------------
  const openPicker = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPickerStep('widget')
    setSelectedWidget(null)
    setPickerOpen(true)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '@') {
      // Don't open picker if user is typing normally — only open if the input
      // is empty or the @ is the first character typed.
      const input = e.currentTarget
      if (input.value === '' || input.selectionStart === 0) {
        e.preventDefault()
        setPickerStep('widget')
        setSelectedWidget(null)
        setPickerOpen(true)
      }
    }
  }

  const insertBinding = (widgetId: string, portName: string) => {
    const expression = `{{${widgetId}.${portName}}}`
    const input = inputRef.current
    if (input) {
      const start = input.selectionStart ?? value.length
      const end = input.selectionEnd ?? value.length
      onChange(value.slice(0, start) + expression + value.slice(end))
    } else {
      onChange(expression)
    }
    setPickerOpen(false)
    setSelectedWidget(null)
    inputRef.current?.focus()
  }

  return (
    <div style={{ position: 'relative', display: 'flex', gap: 3, alignItems: 'stretch' }}>
      {/* ---- text input -------------------------------------------------- */}
      <input
        ref={inputRef}
        style={{ ...merged, flex: 1, paddingRight: 4 }}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {/* ---- @ trigger button -------------------------------------------- */}
      <button
        title="Bind to a widget output port"
        onClick={openPicker}
        style={{
          background: '#0d0d0d',
          border: '1px solid #1e1e1e',
          borderRadius: 4,
          padding: '0 7px',
          fontSize: '0.65rem',
          color: pickerOpen ? '#3b82f6' : '#555',
          cursor: 'pointer',
          flexShrink: 0,
          fontWeight: 600,
        }}
      >
        @
      </button>

      {/* ---- picker popover ---------------------------------------------- */}
      {pickerOpen && (
        <>
          {/* invisible backdrop to close on outside click */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={() => setPickerOpen(false)}
          />
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 3,
            background: '#111',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            zIndex: 50,
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            minWidth: 220,
            maxHeight: 260,
            overflowY: 'auto',
          }}>
            {pickerStep === 'widget' ? (
              <>
                <div style={{
                  padding: '5px 10px',
                  fontSize: '0.58rem',
                  color: '#444',
                  borderBottom: '1px solid #1a1a1a',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}>
                  Pick a widget
                </div>
                {availableWidgets.length === 0 ? (
                  <div style={{ padding: '10px', fontSize: '0.65rem', color: '#444', fontStyle: 'italic' }}>
                    No widgets on canvas
                  </div>
                ) : availableWidgets.map(w => (
                  <button
                    key={w.id}
                    onClick={e => { e.stopPropagation(); setSelectedWidget(w); setPickerStep('port') }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '7px 10px', background: 'transparent', border: 'none',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1a1a1a' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <span style={{
                      fontSize: '0.55rem', color: '#3b82f6',
                      background: '#0a1628', borderRadius: 3,
                      padding: '1px 5px', fontFamily: 'monospace', flexShrink: 0,
                    }}>
                      {w.element}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: '#e5e5e5', flex: 1 }}>{w.displayName}</span>
                    <span style={{ fontSize: '0.6rem', color: '#444', fontFamily: 'monospace' }}>{w.id}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div style={{
                  padding: '5px 10px',
                  fontSize: '0.58rem',
                  color: '#444',
                  borderBottom: '1px solid #1a1a1a',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}>
                  <button
                    onClick={e => { e.stopPropagation(); setPickerStep('widget') }}
                    style={{
                      background: 'none', border: 'none', color: '#555',
                      cursor: 'pointer', fontSize: '0.65rem', padding: 0,
                    }}
                  >
                    ←
                  </button>
                  <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {selectedWidget?.displayName} ports
                  </span>
                </div>
                {!selectedWidget?.outputPorts.length ? (
                  <div style={{ padding: '10px', fontSize: '0.65rem', color: '#444', fontStyle: 'italic' }}>
                    No output ports
                  </div>
                ) : selectedWidget.outputPorts.map(port => (
                  <button
                    key={port.name}
                    onClick={e => { e.stopPropagation(); insertBinding(selectedWidget.id, port.name) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '7px 10px', background: 'transparent', border: 'none',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1a1a1a' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <span style={{ fontSize: '0.7rem', color: '#e5e5e5', flex: 1 }}>{port.name}</span>
                    {port.dynamic && (
                      <span style={{ fontSize: '0.55rem', color: '#f59e0b', flexShrink: 0 }}>dynamic</span>
                    )}
                    <span style={{
                      fontSize: '0.55rem', color: '#444', fontFamily: 'monospace',
                      maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {port.dataType}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
