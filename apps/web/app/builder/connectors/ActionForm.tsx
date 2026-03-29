'use client'

import React, { useState } from 'react'
import { useTranslations } from 'next-intl'
import { upsertConnectorAction } from '../../../lib/api'
import type { ActionDefinition, ActionDefinitionInput, ActionFieldType } from '../../../lib/api'

export const HTTP_METHOD_TILES: Record<string, string> = {
  'Fetch data': 'GET',
  'Send data': 'POST',
  'Update': 'PUT',
  'Delete': 'DELETE',
}

const FIELD_TYPES: ActionFieldType[] = ['text', 'email', 'number', 'boolean', 'date', 'enum', 'textarea']

type FieldDraft = {
  key: string
  label: string
  field_type: ActionFieldType
  required: boolean
  enum_values: string
}

function emptyField(): FieldDraft {
  return { key: '', label: '', field_type: 'text', required: false, enum_values: '' }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

export function ActionForm({
  action,
  connectorId,
  workspaceId,
  onSave,
  onCancel,
}: {
  action?: ActionDefinition
  connectorId: string
  workspaceId: string
  onSave: (action: ActionDefinition) => void
  onCancel: () => void
}) {
  const t = useTranslations('connectors.actionForm')

  const [actionLabel, setActionLabel] = useState(action?.action_label ?? '')
  const [pathTemplate, setPathTemplate] = useState(action?.path_template ?? '')
  const [method, setMethod] = useState(action?.http_method ?? 'GET')

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [actionKey, setActionKey] = useState(action?.action_key ?? '')
  const [resourceName, setResourceName] = useState(action?.resource_name ?? '')
  const [fields, setFields] = useState<FieldDraft[]>(
    action?.input_fields?.length
      ? action.input_fields.map(f => ({
          key: f.key, label: f.label, field_type: f.field_type,
          required: f.required, enum_values: f.enum_values?.join(', ') ?? '',
        }))
      : [emptyField()]
  )

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function updateField(i: number, patch: Partial<FieldDraft>) {
    setFields(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    const key = actionKey.trim() || slugify(actionLabel)
    const input: ActionDefinitionInput = {
      action_key: key,
      action_label: actionLabel.trim(),
      resource_name: resourceName.trim(),
      http_method: method,
      path_template: pathTemplate.trim(),
      input_fields: fields.filter(f => f.key.trim()).map(f => ({
        key: f.key.trim(),
        label: f.label.trim(),
        field_type: f.field_type,
        required: f.required,
        enum_values: f.enum_values ? f.enum_values.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      })),
    }
    try {
      const saved = await upsertConnectorAction(workspaceId, connectorId, input)
      onSave(saved)
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const is: React.CSSProperties = {
    padding: '0.45rem 0.6rem', background: '#1e1e1e', border: '1px solid #333',
    borderRadius: 6, color: '#e5e5e5', fontSize: '0.82rem', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h4 style={{ margin: 0, color: '#ccc', fontSize: '0.85rem' }}>
        {action ? t('editTitle') : t('newTitle')}
      </h4>

      {/* Action label */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
        {t('actionName')}
        <input
          autoFocus
          type="text"
          value={actionLabel}
          onChange={e => setActionLabel(e.target.value)}
          placeholder={t('actionNamePlaceholder')}
          required
          style={{ ...is, width: '100%' }}
        />
      </label>

      {/* Path template */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
        {t('urlPath')}
        <input
          type="text"
          value={pathTemplate}
          onChange={e => setPathTemplate(e.target.value)}
          placeholder={t('urlPathPlaceholder')}
          style={{ ...is, width: '100%' }}
        />
      </label>

      {/* HTTP method intent tiles */}
      <div>
        <p style={{ color: '#888', fontSize: '0.78rem', margin: '0 0 0.4rem' }}>{t('httpMethod')}</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(HTTP_METHOD_TILES).map(([tileLabel, value]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMethod(value)}
              style={{
                padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer',
                background: method === value ? '#2563eb' : '#111',
                color: method === value ? '#fff' : '#888',
                border: `1px solid ${method === value ? '#2563eb' : '#333'}`,
              }}
            >
              {tileLabel}
            </button>
          ))}
        </div>
      </div>

      {/* Advanced options toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        style={{ background: 'none', border: 'none', color: '#555', fontSize: '0.75rem', cursor: 'pointer', textAlign: 'left', padding: 0 }}
      >
        {showAdvanced ? t('hideAdvanced') : t('advancedOptions')} {showAdvanced ? '▲' : '▼'}
      </button>

      {showAdvanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '0.75rem', background: '#0d0d0d', borderRadius: 8, border: '1px solid #1e1e1e' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
            {t('actionKey')} <span style={{ color: '#555' }}>({t('actionKeyHint')})</span>
            <input
              data-testid="advanced-action-key"
              type="text"
              value={actionKey}
              onChange={e => setActionKey(e.target.value)}
              placeholder={slugify(actionLabel) || 'e.g. get_customer'}
              style={{ ...is, width: '100%' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
            {t('resourceName')}
            <input
              type="text"
              value={resourceName}
              onChange={e => setResourceName(e.target.value)}
              placeholder="e.g. Contacts"
              style={{ ...is, width: '100%' }}
            />
          </label>

          {/* Input fields */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ color: '#888', fontSize: '0.75rem', flex: 1 }}>{t('inputFields')}</span>
              <button
                type="button"
                onClick={() => setFields(prev => [...prev, emptyField()])}
                style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 6, color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '4px 12px' }}
              >
                {t('addField')}
              </button>
            </div>
            {fields.map((f, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input style={is} placeholder={t('fieldKey')} value={f.key} onChange={e => updateField(i, { key: e.target.value })} />
                <input style={is} placeholder={t('fieldLabel')} value={f.label} onChange={e => updateField(i, { label: e.target.value })} />
                <select style={is} value={f.field_type} onChange={e => updateField(i, { field_type: e.target.value as ActionFieldType })}>
                  {FIELD_TYPES.map(ft => <option key={ft} value={ft}>{ft}</option>)}
                </select>
                <label style={{ color: '#777', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={f.required} onChange={e => updateField(i, { required: e.target.checked })} />
                  req
                </label>
                <button
                  type="button"
                  onClick={() => setFields(prev => prev.filter((_, j) => j !== i))}
                  style={{ padding: '3px 8px', background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 6, fontWeight: 500, fontSize: '0.7rem', cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {saveError && <p style={{ color: '#f87171', fontSize: '0.75rem', margin: 0 }}>{saveError}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          disabled={saving || !actionLabel.trim()}
          style={{
            padding: '0.5rem 1rem',
            background: saving || !actionLabel.trim() ? '#1e3a8a66' : '#2563eb',
            color: saving || !actionLabel.trim() ? '#93c5fd66' : '#fff',
            border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.8rem',
            cursor: saving || !actionLabel.trim() ? 'default' : 'pointer',
          }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 6, color: '#888', cursor: 'pointer', fontSize: '0.8rem', padding: '6px 14px' }}
        >
          {t('cancel')}
        </button>
      </div>
    </form>
  )
}
