'use client'

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import {
  getMyAISettings,
  putMyAISettings,
  type AIProvider,
  type UpdateUserAISettingsInput,
  type UserAISettings,
} from '../../../lib/api'

const modelSuggestions: Record<AIProvider, string[]> = {
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-5'],
  github_copilot: ['gpt-4.1', 'gpt-5', 'claude-sonnet-4.5', 'claude-haiku-4.5'],
}

export default function AISettingsPage() {
  const [settings, setSettings] = useState<UserAISettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const [provider, setProvider] = useState<AIProvider>('openai')
  const [model, setModel] = useState('gpt-4.1')
  const [openAIBaseURL, setOpenAIBaseURL] = useState('https://api.openai.com/v1')
  const [secret, setSecret] = useState('')
  const [clearStoredSecret, setClearStoredSecret] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await getMyAISettings()
        if (cancelled) return
        setSettings(result)
        if (result.configured) {
          setProvider(result.provider ?? 'openai')
          setModel(result.model ?? 'gpt-4.1')
          setOpenAIBaseURL(result.openai_base_url ?? 'https://api.openai.com/v1')
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load AI settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const secretLabel = provider === 'github_copilot' ? 'GitHub token' : 'API key'
  const secretHint =
    provider === 'github_copilot'
      ? 'Use a gho_, ghu_, or github_pat_ token tied to the user who should consume Copilot.'
      : 'Optional for local or unauthenticated OpenAI-compatible endpoints.'

  const suggestions = useMemo(() => modelSuggestions[provider], [provider])

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setSaved('')

    const payload: UpdateUserAISettingsInput = {
      provider,
      model: model.trim(),
      clear_stored_secret: clearStoredSecret,
    }
    if (provider === 'openai') {
      payload.openai_base_url = openAIBaseURL.trim() || 'https://api.openai.com/v1'
      if (secret.trim()) payload.api_key = secret.trim()
    } else if (secret.trim()) {
      payload.github_token = secret.trim()
    }

    try {
      const updated = await putMyAISettings(payload)
      setSettings(updated)
      setSaved('Saved')
      setSecret('')
      setClearStoredSecret(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save AI settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={pageStyle}>
        <p style={mutedStyle}>Loading...</p>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: '1.25rem', color: '#fff' }}>AI settings</h2>
        <p style={{ ...mutedStyle, marginTop: 8 }}>
          These settings are saved per user. Generation jobs use your provider and model selection,
          not a workspace-global default.
        </p>
      </div>

      <form onSubmit={handleSave} style={cardStyle}>
        <label style={labelStyle}>
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as AIProvider)}
            style={inputStyle}
          >
            <option value="openai">OpenAI-compatible endpoint</option>
            <option value="github_copilot">GitHub Copilot SDK</option>
          </select>
        </label>

        <label style={labelStyle}>
          Model
          <input
            list="ai-model-suggestions"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Enter a model name"
            style={inputStyle}
          />
          <datalist id="ai-model-suggestions">
            {suggestions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>

        {provider === 'openai' && (
          <label style={labelStyle}>
            Base URL
            <input
              value={openAIBaseURL}
              onChange={(event) => setOpenAIBaseURL(event.target.value)}
              placeholder="https://api.openai.com/v1"
              style={inputStyle}
            />
          </label>
        )}

        <label style={labelStyle}>
          {secretLabel}
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={provider === 'github_copilot' ? 'gho_xxx' : 'sk-...'}
            style={inputStyle}
          />
          <span style={helpStyle}>{secretHint}</span>
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={clearStoredSecret}
            onChange={(event) => setClearStoredSecret(event.target.checked)}
          />
          Clear stored secret on save
        </label>

        <div
          style={{
            padding: '10px 12px',
            background: '#111',
            border: '1px solid #1f1f1f',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: '0.8rem', color: '#e5e5e5' }}>Current status</div>
          <div style={{ ...mutedStyle, marginTop: 4 }}>
            Provider: {settings?.configured ? settings.provider : 'not configured'}
          </div>
          <div style={mutedStyle}>
            Model: {settings?.configured ? settings.model : 'not configured'}
          </div>
          <div style={mutedStyle}>
            Stored secret: {settings?.has_secret ? (settings.masked_secret_id ?? 'yes') : 'none'}
          </div>
        </div>

        {error && <div style={errorStyle}>{error}</div>}
        {saved && <div style={successStyle}>{saved}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" disabled={saving} style={buttonStyle}>
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  )
}

const pageStyle: CSSProperties = {
  padding: '2rem',
  maxWidth: 760,
}

const cardStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  padding: '1.5rem',
  background: '#141414',
  border: '1px solid #222',
  borderRadius: 12,
}

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  color: '#d4d4d4',
  fontSize: '0.85rem',
}

const inputStyle: CSSProperties = {
  padding: '0.65rem 0.75rem',
  background: '#1e1e1e',
  border: '1px solid #333',
  borderRadius: 8,
  color: '#fff',
  fontSize: '0.875rem',
  outline: 'none',
  boxSizing: 'border-box',
}

const buttonStyle: CSSProperties = {
  padding: '0.6rem 1rem',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
}

const mutedStyle: CSSProperties = {
  color: '#666',
  fontSize: '0.8rem',
}

const helpStyle: CSSProperties = {
  color: '#666',
  fontSize: '0.75rem',
}

const errorStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  background: '#7f1d1d22',
  border: '1px solid #7f1d1d',
  color: '#f87171',
  fontSize: '0.8rem',
}

const successStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  background: '#14532d22',
  border: '1px solid #14532d',
  color: '#4ade80',
  fontSize: '0.8rem',
}
