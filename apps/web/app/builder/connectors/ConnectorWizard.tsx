'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { createConnector, setManagedTableColumns, getConnector, upsertConnectorAction, sendConnectorChatMessage, seedManagedTableFromCSV } from '../../../lib/api'
import type { ConnectorType, Connector } from '../../../lib/api'
import type { ConnectorChatResponse } from '@lima/sdk-connectors'
import { ManagedColumnsEditor, type EditableManagedColumn } from './ManagedColumnBuilder'
import { DatabaseStep, RestStep, CsvStep, GraphQLStep } from './CredentialSteps'

/** Infer a managed-table col_type from a sample of string values from a CSV column. */
function inferColType(samples: string[]): string {
  const nonEmpty = samples.map(s => s.trim()).filter(Boolean)
  if (nonEmpty.length === 0) return 'text'
  if (nonEmpty.every(s => /^-?\d+$/.test(s))) return 'int4'
  if (nonEmpty.every(s => /^-?\d+(\.\d+)?$/.test(s))) return 'float8'
  if (nonEmpty.every(s => /^(true|false|yes|no|1|0)$/i.test(s))) return 'bool'
  if (nonEmpty.every(s => !Number.isNaN(Date.parse(s)) && /\d{4}|\d{2}\/\d{2}/.test(s))) return 'date'
  return 'text'
}

/** Parse CSV header row and up to `maxDataRows` data rows from raw text. */
function parseCsvColumns(
  text: string,
  maxDataRows = 10,
): EditableManagedColumn[] {
  const lines = text.split(/\r?\n/)
  if (lines.length === 0) return []

  // Simple CSV header parse: split on comma, strip surrounding quotes
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''))
  const dataLines = lines.slice(1, 1 + maxDataRows).filter(l => l.trim().length > 0)

  return headers
    .map((name, i) => {
      const samples = dataLines.map(line => {
        const fields = line.split(',')
        return (fields[i] ?? '').trim().replace(/^["']|["']$/g, '')
      })
      return {
        id: `csv-import-${i}`,
        name,
        col_type: inferColType(samples),
        nullable: true,
        col_order: i,
      }
    })
    .filter(col => col.name.length > 0)
}
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
  const [csvImportError, setCsvImportError] = useState('')
  const [csvSeedFile, setCsvSeedFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // AI chat state (REST only)
  const [useAiWizard, setUseAiWizard] = useState<boolean | null>(null)
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [chatDoneConnector, setChatDoneConnector] = useState<Connector | null>(null)
  const [chatDoneAuthType, setChatDoneAuthType] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (typeof chatEndRef.current?.scrollIntoView === 'function') {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  const resetAiWizard = useCallback(() => {
    setUseAiWizard(null)
    setChatMessages([])
    setChatInput('')
    setChatLoading(false)
    setChatError(null)
    setConversationId(null)
    setChatDoneConnector(null)
    setChatDoneAuthType(null)
  }, [])

  const handleChatSend = useCallback(async (overrideMsg?: string) => {
    const msg = (overrideMsg ?? chatInput).trim()
    if (!msg || chatLoading) return
    setChatInput('')
    setChatError(null)
    setChatMessages(prev => [...prev, { role: 'user', content: msg }])
    setChatLoading(true)
    try {
      const res: ConnectorChatResponse = await sendConnectorChatMessage(
        workspaceId,
        msg,
        conversationId ?? undefined,
        // Pass the wizard name only on the very first turn so the AI uses it
        conversationId === null ? (name.trim() || undefined) : undefined,
      )
      setConversationId(res.conversationId)
      setChatMessages(prev => [...prev, { role: 'assistant', content: res.message }])
      if (res.done && res.connectorId) {
        // Connector created — fetch it but keep the panel open so the user
        // can read the AI summary and click Continue when ready.
        const connector = await getConnector(workspaceId, res.connectorId)
        setChatDoneConnector(connector)
        setChatDoneAuthType(res.authType ?? null)
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Request failed'
      setChatError(errMsg)
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errMsg}` }])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, conversationId, workspaceId, name])

  const effectiveType: ConnectorType = dbBrand ?? connectorType
  const isRestOrGraphql = effectiveType === 'rest' || effectiveType === 'graphql'
  const maxStep = effectiveType === 'managed' ? 2 : 3

  function handleCredChange(key: string, value: string) {
    setCredValues(prev => ({ ...prev, [key]: value }))
  }

  function handleManagedDraftColumnsChange(columns: EditableManagedColumn[]) {
    setManagedDraftColumns(columns)
  }

  function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    setCsvImportError('')
    const file = e.target.files?.[0]
    if (!file) return
    // Reset the input value so the same file can be re-selected after clearing
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result
      if (typeof text !== 'string') return
      const cols = parseCsvColumns(text)
      if (cols.length === 0) {
        setCsvImportError('No columns found. Make sure the file has a header row.')
        return
      }
      setManagedDraftColumns(cols)
      // Keep the File so handleFinish can seed the rows after creating the table
      setCsvSeedFile(file)
    }
    reader.onerror = () => setCsvImportError('Could not read the file.')
    reader.readAsText(file)
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
        // If the user imported columns from a CSV, seed the row data as well so
        // they don't end up with a schema but an empty table.
        if (csvSeedFile) {
          await seedManagedTableFromCSV(workspaceId, connector.id, csvSeedFile)
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

            {/* AI / Manual toggle for REST connectors */}
            {effectiveType === 'rest' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
                <button
                  type="button"
                  onClick={() => { setUseAiWizard(true) }}
                  style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', background: useAiWizard === true ? '#2563eb' : 'transparent', color: useAiWizard === true ? '#fff' : '#888', border: useAiWizard === true ? 'none' : '1px solid #333' }}
                >
                  Set up with AI
                </button>
                <button
                  type="button"
                  onClick={() => setUseAiWizard(false)}
                  style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', background: useAiWizard === false ? '#2563eb' : 'transparent', color: useAiWizard === false ? '#fff' : '#888', border: useAiWizard === false ? 'none' : '1px solid #333' }}
                >
                  Manual setup
                </button>
              </div>
            )}

            {/* AI chat panel (REST only) */}
            {effectiveType === 'rest' && useAiWizard === true && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', height: 320 }}>
                {/* Message list */}
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.25rem 0' }}>
                  {chatMessages.length === 0 && (
                    <p style={{ color: '#555', fontSize: '0.75rem', margin: 0 }}>
                      Tell the AI the URL of your API documentation and it will set up the connector for you.
                    </p>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div
                      key={i}
                      style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%',
                        background: msg.role === 'user' ? '#2563eb' : '#1e1e1e',
                        color: '#e5e5e5',
                        borderRadius: 8,
                        padding: '0.4rem 0.65rem',
                        fontSize: '0.78rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {msg.content}
                    </div>
                  ))}
                  {chatLoading && (
                    <div style={{ alignSelf: 'flex-start', color: '#555', fontSize: '0.75rem' }}>Thinking…</div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                {/* Input row */}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleChatSend() } }}
                    placeholder="Type a message…"
                    disabled={chatLoading}
                    style={{ flex: 1, background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, color: '#e5e5e5', fontSize: '0.8rem', padding: '0.4rem 0.6rem', outline: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => { void handleChatSend() }}
                    disabled={!chatInput.trim() || chatLoading}
                    style={{ padding: '0.4rem 0.9rem', background: chatInput.trim() && !chatLoading ? '#2563eb' : '#1e3a8a66', color: chatInput.trim() && !chatLoading ? '#fff' : '#93c5fd66', border: 'none', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600, cursor: chatInput.trim() && !chatLoading ? 'pointer' : 'default' }}
                  >
                    Send
                  </button>
                </div>
                {chatError && <p style={{ color: '#f87171', fontSize: '0.72rem', margin: 0 }}>{chatError}</p>}
                {/* After the connector is created: quick-reply chip + Continue button */}
                {chatDoneConnector && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(chatDoneAuthType === 'bearer' || chatDoneAuthType === 'api_key') && (
                      <button
                        type="button"
                        disabled={chatLoading}
                        onClick={() => { void handleChatSend('Where can I find my API key for this service?') }}
                        style={{ padding: '3px 10px', borderRadius: 12, fontSize: '0.72rem', cursor: chatLoading ? 'default' : 'pointer', background: 'transparent', color: '#93c5fd', border: '1px solid #1e40af' }}
                      >
                        Where can I find my API key?
                      </button>
                    )}
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      onClick={() => onComplete(chatDoneConnector)}
                      style={{ padding: '5px 14px', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none' }}
                    >
                      Continue →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Manual credentials (non-REST, or REST in manual mode) */}
            {(effectiveType !== 'rest' || useAiWizard === false) && renderCredentials()}
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
            {/* CSV import */}
            <label
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                border: '1px dashed #333', borderRadius: 6, padding: '0.55rem 0.75rem',
                cursor: 'pointer', color: '#60a5fa', fontSize: '0.78rem', marginBottom: '0.75rem',
                background: 'transparent',
              }}
            >
              <span style={{ fontSize: '0.9rem', lineHeight: 1 }}>⬆</span>
              {t('managed.importFromCsv')}
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={handleCsvImport}
              />
            </label>
            {csvImportError && (
              <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '-0.5rem 0 0.75rem' }}>
                {csvImportError}
              </p>
            )}
            <p style={{ color: '#555', fontSize: '0.72rem', margin: '0 0 0.75rem' }}>
              {t('managed.importCsvHelp')}
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
          onClick={step === 1 ? onBack : () => { if (step === 2) resetAiWizard(); setStep(s => (s - 1) as 1 | 2 | 3) }}
          style={{ background: 'none', border: '1px solid #1e1e1e', borderRadius: 6, color: '#888', cursor: 'pointer', fontSize: '0.8rem', padding: '6px 14px' }}
        >
          {t('back')}
        </button>
        <div style={{ flex: 1 }} />
        {step < maxStep && !(step === 2 && effectiveType === 'rest' && useAiWizard !== false) ? (
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
