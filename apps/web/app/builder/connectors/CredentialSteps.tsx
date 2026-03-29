'use client'

import React, { useState } from 'react'
import { useTranslations } from 'next-intl'

export type CredentialStepProps = {
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}

// ---- Shared micro-styles ---------------------------------------------------

const inputBase: React.CSSProperties = {
  background: '#1e1e1e',
  border: '1px solid #333',
  borderRadius: 6,
  color: '#e5e5e5',
  fontSize: '0.82rem',
  padding: '0.45rem 0.6rem',
  width: '100%',
  boxSizing: 'border-box',
  outline: 'none',
}

const labelBase: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  color: '#888',
  fontSize: '0.78rem',
}

const fieldGroup: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
}

// ---- Tooltip ---------------------------------------------------------------

function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 4 }}>
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        aria-label="What's this?"
        style={{
          background: 'none', border: '1px solid #444', borderRadius: '50%',
          width: 15, height: 15, fontSize: '0.58rem', cursor: 'help',
          color: '#666', lineHeight: 1, padding: 0, verticalAlign: 'middle',
        }}
      >
        ?
      </button>
      {show && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', bottom: 'calc(100% + 4px)', left: '50%',
            transform: 'translateX(-50%)', background: '#1a1a1a', border: '1px solid #333',
            borderRadius: 6, padding: '0.4rem 0.65rem', fontSize: '0.72rem', color: '#bbb',
            whiteSpace: 'normal', zIndex: 100, width: 200, pointerEvents: 'none', lineHeight: 1.5,
          }}
        >
          {text}
        </div>
      )}
    </span>
  )
}

// ---- Auth tiles + conditional credential fields ----------------------------

type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'token'
const MAIN_AUTH_IDS: AuthType[] = ['none', 'bearer', 'api_key', 'basic']

function AuthTiles({
  selectedAuth, onSelect, labels,
}: {
  selectedAuth: string
  onSelect: (a: AuthType) => void
  labels: Record<AuthType, string>
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
      {MAIN_AUTH_IDS.map(id => (
        <button
          key={id}
          type="button"
          data-auth-type={id}
          onClick={() => onSelect(id)}
          style={{
            background: selectedAuth === id ? 'rgba(37,99,235,0.15)' : '#1a1a1a',
            border: `1px solid ${selectedAuth === id ? '#2563eb' : '#333'}`,
            borderRadius: 8, padding: '0.55rem 0.5rem',
            color: selectedAuth === id ? '#93c5fd' : '#ccc',
            fontSize: '0.78rem', cursor: 'pointer', textAlign: 'center',
            fontWeight: selectedAuth === id ? 600 : 400, transition: 'all 0.12s',
          }}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  )
}

function AuthCredentialFields({
  authType, values, onChange,
}: { authType: AuthType; values: Record<string, string>; onChange: (k: string, v: string) => void }) {
  const t = useTranslations('connectors.wizard')
  if (authType === 'bearer') {
    return (
      <label style={labelBase}>
        {t('fields.bearerToken.label')}
        <input type="password" value={values.token ?? ''} onChange={e => onChange('token', e.target.value)} placeholder="eyJ..." style={inputBase} />
      </label>
    )
  }
  if (authType === 'api_key') {
    return (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.apiKey.label')}
          <input type="password" value={values.api_key ?? ''} onChange={e => onChange('api_key', e.target.value)} placeholder="sk-..." style={inputBase} />
        </label>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.apiKeyHeader.label')}
          <input type="text" value={values.api_key_header ?? ''} onChange={e => onChange('api_key_header', e.target.value)} placeholder="X-API-Key" style={inputBase} />
        </label>
      </div>
    )
  }
  if (authType === 'basic') {
    return (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.basicUser.label')}
          <input type="text" value={values.username ?? ''} onChange={e => onChange('username', e.target.value)} placeholder="admin" style={inputBase} />
        </label>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.basicPass.label')}
          <input type="password" value={values.password ?? ''} onChange={e => onChange('password', e.target.value)} placeholder="••••••••" style={inputBase} />
        </label>
      </div>
    )
  }
  if (authType === 'token') {
    return (
      <label style={labelBase}>
        {t('fields.mocoToken.label')}
        <input type="password" value={values.token ?? ''} onChange={e => onChange('token', e.target.value)} placeholder="••••••••" style={inputBase} />
      </label>
    )
  }
  return null
}

// AuthSection is shared between RestStep and GraphQLStep.
function AuthSection({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  const [showMoco, setShowMoco] = useState(false)
  const authType = (values.auth_type as AuthType | undefined) ?? 'none'
  const authLabels: Record<AuthType, string> = {
    none: t('auth.noAuth'),
    bearer: t('auth.bearer'),
    api_key: t('auth.apiKey'),
    basic: t('auth.basic'),
    token: t('auth.moco'),
  }
  return (
    <>
      <AuthTiles selectedAuth={authType} onSelect={a => onChange('auth_type', a)} labels={authLabels} />
      <AuthCredentialFields authType={authType} values={values} onChange={onChange} />
      <div>
        <button
          type="button"
          onClick={() => setShowMoco(v => !v)}
          style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.72rem', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {showMoco ? t('auth.lessOptions') : t('auth.moreOptions')}
        </button>
        {showMoco && (
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              data-auth-type="token"
              onClick={() => onChange('auth_type', 'token')}
              style={{
                background: authType === 'token' ? 'rgba(37,99,235,0.15)' : '#1a1a1a',
                border: `1px solid ${authType === 'token' ? '#2563eb' : '#333'}`,
                borderRadius: 8, padding: '0.55rem 0.75rem',
                color: authType === 'token' ? '#93c5fd' : '#ccc',
                fontSize: '0.78rem', cursor: 'pointer', width: '100%', textAlign: 'center',
              }}
            >
              {t('auth.moco')}
            </button>
            {authType === 'token' && (
              <div style={{ marginTop: '0.5rem' }}>
                <AuthCredentialFields authType="token" values={values} onChange={onChange} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ---- DatabaseStep ----------------------------------------------------------

export function DatabaseStep({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  return (
    <div style={fieldGroup}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <label style={{ ...labelBase, flex: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center' }}>
            {t('fields.host.label')} <Tooltip text={t('fields.host.tooltip')} />
          </span>
          <input type="text" value={values.host ?? ''} onChange={e => onChange('host', e.target.value)} placeholder="db.example.com" style={inputBase} />
        </label>
        <label style={{ ...labelBase, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center' }}>
            {t('fields.port.label')} <Tooltip text={t('fields.port.tooltip')} />
          </span>
          <input type="text" value={values.port ?? ''} onChange={e => onChange('port', e.target.value)} placeholder="5432" style={inputBase} />
        </label>
      </div>
      <label style={labelBase}>
        <span style={{ display: 'flex', alignItems: 'center' }}>
          {t('fields.database.label')} <Tooltip text={t('fields.database.tooltip')} />
        </span>
        <input type="text" value={values.database ?? ''} onChange={e => onChange('database', e.target.value)} placeholder="mydb" style={inputBase} />
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.username.label')}
          <input type="text" value={values.username ?? ''} onChange={e => onChange('username', e.target.value)} placeholder="postgres" style={inputBase} />
        </label>
        <label style={{ ...labelBase, flex: 1 }}>
          {t('fields.password.label')}
          <input type="password" value={values.password ?? ''} onChange={e => onChange('password', e.target.value)} placeholder="••••••••" style={inputBase} />
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#888', fontSize: '0.78rem' }}>
        <input type="checkbox" checked={values.ssl === 'true'} onChange={e => onChange('ssl', e.target.checked ? 'true' : 'false')} />
        {t('fields.ssl.label')}
      </label>
    </div>
  )
}

// ---- RestStep --------------------------------------------------------------

export function RestStep({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  return (
    <div style={fieldGroup}>
      <label style={labelBase}>
        {t('fields.baseUrl.label')}
        <input type="url" value={values.base_url ?? ''} onChange={e => onChange('base_url', e.target.value)} placeholder="https://api.example.com" style={inputBase} />
      </label>
      <AuthSection values={values} onChange={onChange} />
    </div>
  )
}

// ---- GraphQLStep -----------------------------------------------------------

export function GraphQLStep({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  return (
    <div style={fieldGroup}>
      <label style={labelBase}>
        {t('fields.endpoint.label')}
        <input type="url" value={values.endpoint ?? ''} onChange={e => onChange('endpoint', e.target.value)} placeholder="https://api.example.com/graphql" style={inputBase} />
      </label>
      <AuthSection values={values} onChange={onChange} />
    </div>
  )
}

// ---- CsvStep ---------------------------------------------------------------

export function CsvStep({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  const [headers, setHeaders] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<string[][]>([])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    onChange('file_name', file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const lines = text.split('\n').filter(l => l.trim())
      const parsed = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')))
      if (parsed.length > 0) {
        setHeaders(parsed[0])
        setPreviewRows(parsed.slice(1, 6))
      }
    }
    reader.readAsText(file)
  }

  return (
    <div style={fieldGroup}>
      <label style={labelBase}>
        {t('csv.uploadLabel')}
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          style={{ ...inputBase, padding: '0.3rem', cursor: 'pointer' }}
          data-testid="csv-file-input"
        />
      </label>
      {headers.length > 0 ? (
        <div>
          <p style={{ color: '#666', fontSize: '0.72rem', margin: '0 0 0.5rem' }}>{t('csv.preview')}</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.72rem' }}>
              <thead>
                <tr>
                  {headers.map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: '#666', borderBottom: '1px solid #1e1e1e', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #111' }}>
                    {row.map((cell, j) => <td key={j} style={{ padding: '4px 8px', color: '#ccc' }}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p style={{ color: '#555', fontSize: '0.72rem', margin: 0 }}>{t('csv.noPreview')}</p>
      )}
    </div>
  )
}

// ---- ManagedStep -----------------------------------------------------------

export function ManagedStep({ values, onChange }: CredentialStepProps) {
  const t = useTranslations('connectors.wizard')
  return (
    <div style={fieldGroup}>
      <p style={{ color: '#666', fontSize: '0.8rem', margin: 0, lineHeight: 1.6 }}>{t('managed.hint')}</p>
      <label style={labelBase}>
        {t('managed.addColumn')}
        <input
          type="text"
          value={values.first_column ?? ''}
          onChange={e => onChange('first_column', e.target.value)}
          placeholder={t('managed.addColumnPlaceholder')}
          style={inputBase}
        />
      </label>
      <p style={{ color: '#666', fontSize: '0.78rem', margin: 0, lineHeight: 1.6 }}>{t('managed.addColumnHelp')}</p>
    </div>
  )
}
