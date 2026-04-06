'use client'

import React, { useState } from 'react'
import { CANVAS_TEMPLATES, type CanvasTemplate } from './canvasTemplates'
import type { AuraNode } from '@lima/aura-dsl'

interface Props {
  onSelect: (nodes: AuraNode[]) => void
}

export function TemplateGallery({ onSelect }: Props) {
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#555', fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
          Start with a template
        </div>
        <div style={{ color: '#2e2e2e', fontSize: '0.65rem' }}>
          or add widgets from the panel on the left
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 200px)',
          gap: 12,
        }}
      >
        {CANVAS_TEMPLATES.map(tpl => (
          <TemplateCard
            key={tpl.id}
            tpl={tpl}
            isHovered={hovered === tpl.id}
            onMouseEnter={() => setHovered(tpl.id)}
            onMouseLeave={() => setHovered(null)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

interface CardProps {
  tpl: CanvasTemplate
  isHovered: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onSelect: (nodes: AuraNode[]) => void
}

function TemplateCard({ tpl, isHovered, onMouseEnter, onMouseLeave, onSelect }: CardProps) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={() => onSelect(tpl.nodes)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
        padding: '14px 16px',
        background: isHovered ? '#141414' : '#0e0e0e',
        border: `1px solid ${isHovered ? tpl.accentColor : '#1e1e1e'}`,
        borderRadius: 6,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'border-color 0.15s, background 0.15s',
        boxShadow: isHovered ? `0 0 0 1px ${tpl.accentColor}22` : 'none',
      }}
    >
      {/* Icon strip */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: `${tpl.accentColor}22`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1rem',
          border: `1px solid ${tpl.accentColor}44`,
          flexShrink: 0,
        }}
        aria-hidden="true"
      >
        {tpl.icon}
      </div>

      {/* Text */}
      <div>
        <div
          style={{
            color: isHovered ? '#e5e7eb' : '#9ca3af',
            fontSize: '0.75rem',
            fontWeight: 600,
            marginBottom: 3,
            transition: 'color 0.15s',
          }}
        >
          {tpl.name}
        </div>
        <div
          style={{
            color: '#4b5563',
            fontSize: '0.65rem',
            lineHeight: 1.5,
          }}
        >
          {tpl.description}
        </div>
      </div>
    </button>
  )
}
