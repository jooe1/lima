'use client'

import React, { useState } from 'react'
import { type AuraNode } from '@lima/aura-dsl'

// ── Public types ──────────────────────────────────────────────────────────────

export interface OutputPortDrag {
  widgetId: string
  widgetLabel: string
  portName: string
  portType: 'text' | 'number' | 'date' | 'boolean' | 'object'
  portKind: 'output'
}

export interface InputPortDrop {
  widgetId: string
  portName: string
  portKind: 'input'
  stepId: string
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface PortTrayProps {
  pageDocument: AuraNode[]
  onOutputPortDragStart?: (binding: OutputPortDrag) => void
  onInputPortDrop?: (drop: InputPortDrop) => void
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface OutputPort {
  portName: string
  portLabel: string
  portType: OutputPortDrag['portType']
}

interface InputPort {
  portName: string
  portLabel: string
}

interface WidgetCard {
  widgetId: string
  widgetLabel: string
  widgetType: string
  outputPorts: OutputPort[]
  inputPorts: InputPort[]
}

const WIDGET_ICONS: Record<string, string> = {
  form: '📋',
  button: '🔘',
  table: '📊',
  text_input: '✏',
  select: '🔽',
  notification: '🔔',
}

function getWidgetIcon(type: string): string {
  return WIDGET_ICONS[type] ?? '🟦'
}

function getOutputPorts(node: AuraNode, doc: AuraNode[]): OutputPort[] {
  switch (node.element) {
    case 'form': {
      // Form fields are stored in node.style.fields as a comma-separated string
      // (Inspector writes them via setPropValue which uses node.style as the fallback store)
      const fieldsStr = node.style?.fields ?? node.with?.fields ?? ''
      const fields = fieldsStr.split(',').map((f: string) => f.trim()).filter(Boolean)
      return fields.map(field => ({
        portName: field,
        portLabel: field,
        portType: 'text' as const,
      }))
    }
    case 'button':
      return [{ portName: 'clicked_at', portLabel: 'clicked at', portType: 'date' }]
    case 'table': {
      // If the table has named columns configured, expose each as its own port
      const colsStr = node.style?.columns ?? ''
      const cols = colsStr.split(',').map((c: string) => c.trim()).filter(Boolean)
      if (cols.length > 0) {
        return cols.map(col => ({
          portName: `selected_row.${col}`,
          portLabel: col,
          portType: 'text' as const,
        }))
      }
      // Fallback: single generic port for the whole selected row
      return [{ portName: 'selected_row', portLabel: 'selected row', portType: 'object' }]
    }
    case 'text_input':
      return [{ portName: 'value', portLabel: 'value', portType: 'text' }]
    case 'select':
      return [
        { portName: 'selected_value', portLabel: 'selected value', portType: 'text' },
        { portName: 'selected_label', portLabel: 'selected label', portType: 'text' },
      ]
    default:
      return []
  }
}

function getInputPorts(node: AuraNode): InputPort[] {
  switch (node.element) {
    case 'table':        return [{ portName: 'refresh',   portLabel: 'refresh' }]
    case 'text':         return [{ portName: 'set_value', portLabel: 'set value' }]
    case 'form':         return [{ portName: 'reset',     portLabel: 'reset' }]
    case 'notification': return [{ portName: 'show',      portLabel: 'show' }]
    default:             return []
  }
}

const TYPES_WITH_PORTS = new Set([
  'form', 'button', 'table', 'text_input', 'select', 'text', 'notification',
])

// ── Component ─────────────────────────────────────────────────────────────────

export default function PortTray({
  pageDocument,
  onOutputPortDragStart,
}: PortTrayProps) {
  const [expanded, setExpanded] = useState(true)

  const widgets: WidgetCard[] = pageDocument
    .filter(n => TYPES_WITH_PORTS.has(n.element))
    .map(n => ({
      widgetId: n.id,
      widgetLabel: n.text ?? n.id,
      widgetType: n.element,
      outputPorts: getOutputPorts(n, pageDocument),
      inputPorts: getInputPorts(n),
    }))
    .filter(w => w.outputPorts.length > 0 || w.inputPorts.length > 0)

  const handleDragStart = (
    e: React.DragEvent<HTMLSpanElement>,
    widget: WidgetCard,
    port: OutputPort,
  ) => {
    const drag: OutputPortDrag = {
      widgetId: widget.widgetId,
      widgetLabel: widget.widgetLabel,
      portName: port.portName,
      portType: port.portType,
      portKind: 'output',
    }
    e.dataTransfer.setData('application/x-port-binding', JSON.stringify(drag))
    e.dataTransfer.effectAllowed = 'copy'
    onOutputPortDragStart?.(drag)
  }

  return (
    <div
      style={{
        borderTop: '1px solid #1e1e1e',
        background: '#0a0a0a',
        flexShrink: 0,
        maxHeight: expanded ? 220 : 32,
        overflow: 'hidden',
        transition: 'max-height 0.2s',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '5px 10px',
          borderBottom: expanded ? '1px solid #1e1e1e' : 'none',
          flexShrink: 0,
          minHeight: 32,
        }}
      >
        <span style={{ fontSize: '0.6rem', color: '#444', fontWeight: 700, letterSpacing: '0.06em' }}>
          PAGE PORTS
        </span>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '0.65rem', padding: '0 2px',
          }}
          title={expanded ? 'Collapse port tray' : 'Expand port tray'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>

      {/* Widget cards */}
      {expanded && (
        <div
          style={{ overflowY: 'auto', flex: 1, padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}
        >
          {widgets.length === 0 && (
            <div style={{ fontSize: '0.63rem', color: '#333', padding: '4px 0' }}>
              No widgets with ports on this page.
            </div>
          )}
          {widgets.map(widget => (
            <div
              key={widget.widgetId}
              style={{
                background: '#101010',
                border: '1px solid #1e1e1e',
                borderRadius: 4,
                padding: '4px 7px',
              }}
            >
              {/* Widget title row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <span style={{ fontSize: '0.68rem' }}>{getWidgetIcon(widget.widgetType)}</span>
                <span style={{ fontSize: '0.63rem', color: '#aaa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {widget.widgetLabel}
                </span>
                <span style={{ fontSize: '0.53rem', color: '#3a3a3a', marginLeft: 'auto', flexShrink: 0 }}>
                  {widget.widgetType}
                </span>
              </div>

              {/* Output ports — blue, draggable */}
              {widget.outputPorts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: widget.inputPorts.length > 0 ? 3 : 0 }}>
                  {widget.outputPorts.map(port => (
                    <span
                      key={port.portName}
                      draggable
                      onDragStart={e => handleDragStart(e, widget, port)}
                      title={`Output: ${port.portName} (${port.portType}) — drag onto a workflow step`}
                      style={{
                        cursor: 'grab',
                        background: '#1e3a8a33',
                        border: '1px solid #1e3a8a88',
                        color: '#93c5fd',
                        borderRadius: 3,
                        padding: '1px 5px',
                        fontSize: '0.57rem',
                        whiteSpace: 'nowrap',
                        userSelect: 'none',
                      }}
                    >
                      ↑ {port.portLabel}
                    </span>
                  ))}
                </div>
              )}

              {/* Input ports — amber, informational */}
              {widget.inputPorts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {widget.inputPorts.map(port => (
                    <span
                      key={port.portName}
                      title={`Input: ${port.portName}`}
                      style={{
                        background: '#78350f33',
                        border: '1px solid #92400e88',
                        color: '#fbbf24',
                        borderRadius: 3,
                        padding: '1px 5px',
                        fontSize: '0.57rem',
                        whiteSpace: 'nowrap',
                        userSelect: 'none',
                      }}
                    >
                      ↓ {port.portLabel}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
