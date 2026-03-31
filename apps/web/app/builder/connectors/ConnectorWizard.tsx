'use client'

import React, { useState } from 'react'
import { useTranslations } from 'next-intl'
import { createConnector, setManagedTableColumns, getConnector, upsertConnectorAction } from '../../../lib/api'
import type { ConnectorType, Connector } from '../../../lib/api'
import { ManagedColumnsEditor, type EditableManagedColumn } from './ManagedColumnBuilder'
import { DatabaseStep, RestStep, CsvStep, GraphQLStep } from './CredentialSteps'
import { ApiEndpointGuide } from './ApiEndpointGuide'

export function ConnectorWizard({
  connectorType,
  dbBrand,
  onComplete,
  onBack,
  workspaceId,
  children,
}: {
  connectorType: ConnectorType
  dbBrand?: 'postgres' | 'mysql' | 'mssql'
  onComplete: (connector: Connector, opts?: { multiAction?: boolean }) => void
  onBack: () => void
  workspaceId: string
  children?: React.ReactNode
}) {
  const t = useTranslations('connectors.wizard')
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [managedDraftColumns, setManagedDraftColumns] = useState<EditableManagedColumn[]>([
    { id: 'draft-1', name: '', col_type: 'text', nullable: true },
  ])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const effectiveType: ConnectorType = dbBrand ?? connectorType
  const isRestOrGraphql = effectiveType === 'rest' || effectiveType === 'graphql'
  const maxStep = effectiveType === 'managed' ? 2 : 3

  function handleCredChange(key: string, value: string) {
    setCredValues(prev => ({ ...prev, [key]: value }))
  }

  function handleManagedDraftColumnsChange(columns: EditableManagedColumn[]) {
    setManagedDraftColumns(columns)
  }

  function getManagedColumnsPayload() {
    return managedDraftColumns
      .map(col => ({
        name: col.name.trim(),
        col_type: col.col_type,
        nullable: col.nullable,
      }))
      .filter(col => col.name.length > 0)
  }

  async function handleFinish() {
    if (!name.trim()) {
      setErr(t('nameRequired'))
      return
    }
    setSaving(true)
    setErr('')
    try {
      // Strip UI-only fields (e.g. file_name for csv) from credentials sent to the API
      const { file_name: _fileName, ...apiCreds } = credValues
      void _fileName
      const connector = await createConnector(workspaceId, {
        name: name.trim(),
        type: effectiveType,
        credentials: apiCreds,
      })

      if (effectiveType === 'managed') {
        const initialColumns = getManagedColumnsPayload()
        if (initialColumns.length > 0) {
          await setManagedTableColumns(workspaceId, connector.id, initialColumns)
        }
        // Re-fetch so schema_cached_at is up-to-date before handing off to caller.
        const fresh = await getConnector(workspaceId, connector.id)
        onComplete(fresh)
        return
      }

      onComplete(connector)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function handleSingleEndpoint(label: string) {
    if (!name.trim()) {
      setErr(t('nameRequired'))
      return
    }
    setSaving(true)
    setErr('')
    try {
      const { file_name: _fn, ...apiCreds } = credValues
      void _fn
      const connector = await createConnector(workspaceId, {
        name: name.trim(),
        type: effectiveType,
        credentials: apiCreds,
      })
      const actionKey = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      const resourceName = connector.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      await upsertConnectorAction(workspaceId, connector.id, {
        action_key: actionKey,
        action_label: label,
        resource_name: resourceName,
        http_method: 'GET',
        path_template: '',
        input_fields: [],
      })
      onComplete(connector)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function handleMultiAction() {
    if (!name.trim()) {
      setErr(t('nameRequired'))
      return
    }
    setSaving(true)
    setErr('')
    try {
      const { file_name: _fn, ...apiCreds } = credValues
      void _fn
      const connector = await createConnector(workspaceId, {
        name: name.trim(),
        type: effectiveType,
        credentials: apiCreds,
      })
      onComplete(connector, { multiAction: true })
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function renderCredentials() {
    const props = { values: credValues, onChange: handleCredChange }
    switch (effectiveType) {
      case 'postgres':
      case 'mysql':
      case 'mssql':
        return <DatabaseStep {...props} />
      case 'rest':
        return <RestStep {...props} />
      case 'graphql':
        return <GraphQLStep {...props} />
      default:
        return null
    }
  }

  const stepLabels = effectiveType === 'managed'
    ? [t('step1.label'), t('managed.columnsLabel')]
    : [t('step1.label'), t('step2.label'), t('step3.label')]
  const canProceedStep1 = name.trim().length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Step progress bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: '1.5rem' }}>
        {stepLabels.map((label, i) => (
          <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ height: 3, borderRadius: 2, background: step >= i + 1 ? '#2563eb' : '#2a2a2a' }} />
            <span style={{ fontSize: '0.65rem', color: step === i + 1 ? '#e5e5e5' : '#555', textAlign: 'center' }}>
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* Step content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {step === 1 && (
          <div>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600, color: '#e5e5e5' }}>
              {t('step1.title')}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
                {t('fields.name.label')}
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('fields.name.placeholder')}
                  style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, color: '#e5e5e5', fontSize: '0.82rem', padding: '0.45rem 0.6rem', outline: 'none', boxSizing: 'border-box', width: '100%' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: '#888', fontSize: '0.78rem' }}>
                {t('fields.description.label')}
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('fields.description.placeholder')}
                  style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, color: '#e5e5e5', fontSize: '0.82rem', padding: '0.45rem 0.6rem', outline: 'none', boxSizing: 'border-box', width: '100%' }}
                />
              </label>
            </div>
          </div>
        )}

        {step === 2 && effectiveType !== 'managed' && (
          <div>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600, color: '#e5e5e5' }}>
              {t('step2.title')}
            </h3>
            {renderCredentials()}
          </div>
        )}

        {step === 2 && effectiveType === 'managed' && (
          <div>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600, color: '#e5e5e5' }}>
              {t('managed.columnsTitle')}
            </h3>
            <p style={{ color: '#888', fontSize: '0.85rem', lineHeight: 1.7, margin: '0 0 0.9rem' }}>
              {t('managed.columnsBody')}
            </p>
            <ManagedColumnsEditor
              columns={managedDraftColumns}
              onChange={handleManagedDraftColumnsChange}
            />
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600, color: '#e5e5e5' }}>
              {t('step3.title')}
            </h3>
            {isRestOrGraphql ? (
              saving ? (
                <p style={{ color: '#888', fontSize: '0.85rem', margin: 0 }}>{t('saving')}</p>
              ) : (
                <ApiEndpointGuide
                  onSingleEndpoint={handleSingleEndpoint}
                  onMultiAction={handleMultiAction}
                />
              )
            ) : (
              children ?? (
                <p style={{ color: '#888', fontSize: '0.85rem', lineHeight: 1.7, margin: 0 }}>
                  {t('step3.placeholder')}
                </p>
              )
            )}
          </div>
        )}
      </div>

      {err && <p style={{ color: '#f87171', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>{err}</p>}

      {/* Navigation */}
      <div style={{ display: 'flex', gap: 8, paddingTop: '1rem', marginTop: '0.5rem', borderTop: '1px solid #1a1a1a' }}>
        <button
          type="button"
          onClick={step === 1 ? onBack : () => setStep(s => (s - 1) as 1 | 2 | 3)}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 6, color: '#888', cursor: 'pointer', fontSize: '0.8rem', padding: '6px 14px' }}
        >
          {t('back')}
        </button>
        <div style={{ flex: 1 }} />
        {step < maxStep ? (
          <button
            type="button"
            disabled={step === 1 && !canProceedStep1}
            onClick={() => setStep(s => (s + 1) as 1 | 2 | 3)}
            style={{
              padding: '6px 16px',
              background: step === 1 && !canProceedStep1 ? '#1e3a8a66' : '#2563eb',
              color: step === 1 && !canProceedStep1 ? '#93c5fd66' : '#fff',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem',
              cursor: step === 1 && !canProceedStep1 ? 'default' : 'pointer',
            }}
          >
            {t('next')}
          </button>
        ) : isRestOrGraphql ? (
          saving ? <span style={{ color: '#888', fontSize: '0.8rem' }}>{t('saving')}</span> : null
        ) : (
          <button
            type="button"
            disabled={saving}
            onClick={handleFinish}
            style={{
              padding: '6px 16px',
              background: saving ? '#1e3a8a66' : '#2563eb',
              color: saving ? '#93c5fd66' : '#fff',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            {saving ? t('saving') : effectiveType === 'managed' ? t('managed.finish') : t('finish')}
          </button>
        )}
      </div>
    </div>
  )
}
