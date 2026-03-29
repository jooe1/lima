'use client'

import React, { useState } from 'react'
import { useTranslations } from 'next-intl'

export function ApiEndpointGuide({
  onSingleEndpoint,
  onMultiAction,
}: {
  onSingleEndpoint: (label: string) => void
  onMultiAction: () => void
}) {
  const t = useTranslations('connectors.apiGuide')
  const [showLabelInput, setShowLabelInput] = useState(false)
  const [label, setLabel] = useState('')

  function handleConfirm() {
    const trimmed = label.trim()
    if (!trimmed) return
    onSingleEndpoint(trimmed)
  }

  if (showLabelInput) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <p style={{ color: '#888', fontSize: '0.82rem', margin: 0 }}>{t('actionLabelPrompt')}</p>
        <input
          autoFocus
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConfirm()}
          placeholder={t('actionLabelPlaceholder')}
          style={{
            background: '#1e1e1e', border: '1px solid #333', borderRadius: 6,
            color: '#e5e5e5', fontSize: '0.82rem', padding: '0.45rem 0.6rem',
            outline: 'none', boxSizing: 'border-box', width: '100%',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={!label.trim()}
            onClick={handleConfirm}
            style={{
              padding: '6px 16px',
              background: label.trim() ? '#2563eb' : '#1e3a8a66',
              color: label.trim() ? '#fff' : '#93c5fd66',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem',
              cursor: label.trim() ? 'pointer' : 'default',
            }}
          >
            {t('confirm')}
          </button>
          <button
            type="button"
            onClick={() => setShowLabelInput(false)}
            style={{
              background: 'none', border: '1px solid #1e1e1e', borderRadius: 6,
              color: '#888', cursor: 'pointer', fontSize: '0.8rem', padding: '6px 14px',
            }}
          >
            {t('back')}
          </button>
        </div>
      </div>
    )
  }

  const tileStyle: React.CSSProperties = {
    textAlign: 'left', padding: '1rem', background: '#111', border: '1px solid #1f1f1f',
    borderRadius: 10, cursor: 'pointer', color: '#e5e5e5', width: '100%',
    transition: 'border-color 0.15s',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <button
        type="button"
        onClick={() => setShowLabelInput(true)}
        style={tileStyle}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#2563eb' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#1f1f1f' }}
      >
        <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>{t('singleEndpoint')}</div>
        <div style={{ fontSize: '0.78rem', color: '#888' }}>{t('singleEndpointDesc')}</div>
      </button>
      <button
        type="button"
        onClick={onMultiAction}
        style={tileStyle}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#2563eb' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#1f1f1f' }}
      >
        <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>{t('multiAction')}</div>
        <div style={{ fontSize: '0.78rem', color: '#888' }}>{t('multiActionDesc')}</div>
      </button>
    </div>
  )
}
