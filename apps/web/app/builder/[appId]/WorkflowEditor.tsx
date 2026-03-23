'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  type Workflow,
  type WorkflowWithSteps,
  type WorkflowStep,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStepType,
  type WorkflowTrigger,
  type WorkflowStepInput,
  type Connector,
  type ManagedTableColumn,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  deleteWorkflow,
  activateWorkflow,
  archiveWorkflow,
  triggerWorkflow,
  listWorkflowRuns,
  putWorkflowSteps,
  reviewStep,
  patchWorkflow,
  listConnectors,
  getManagedTableColumns,
  ApiError,
} from '../../../lib/api'
import { useAuth } from '../../../lib/auth'

// ---- colour palette (matches the dark builder theme) -----------------------
const C = {
  bg:       '#0a0a0a',
  surface:  '#111',
  border:   '#1e1e1e',
  text:     '#e5e5e5',
  muted:    '#555',
  accent:   '#1d4ed8',
  accentFg: '#bfdbfe',
  danger:   '#450a0a',
  dangerFg: '#fca5a5',
  green:    '#4ade80',
  yellow:   '#fbbf24',
  amber:    '#92400e',
}

const pill = (status: string): React.CSSProperties => {
  const map: Record<string, [string, string]> = {
    draft:             ['#854d0e33', '#fbbf24'],
    active:            ['#16653433', '#4ade80'],
    archived:          ['#1a1a1a',   '#555'],
    pending:           ['#1e3a8a33', '#93c5fd'],
    running:           ['#1e3a8a33', '#6ee7b7'],
    awaiting_approval: ['#92400e33', '#fcd34d'],
    completed:         ['#16653433', '#4ade80'],
    failed:            ['#450a0a33', '#fca5a5'],
    cancelled:         ['#1a1a1a',   '#555'],
  }
  const [bg, color] = map[status] ?? ['#1a1a1a', '#aaa']
  return { background: bg, color, fontSize: '0.6rem', padding: '2px 7px', borderRadius: 99 }
}

const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: danger ? C.danger : primary ? C.accent : '#1a1a1a',
  color:      danger ? C.dangerFg : primary ? C.accentFg : '#aaa',
  border:     primary || danger ? 'none' : `1px solid ${C.border}`,
  borderRadius: 4,
  padding: '4px 12px',
  fontSize: '0.72rem',
  cursor: 'pointer',
  flexShrink: 0,
})

const TRIGGER_LABELS: Record<WorkflowTrigger, string> = {
  manual:       'Manual',
  form_submit:  'Form Submit',
  button_click: 'Button Click',
  schedule:     'Schedule',
  webhook:      'Webhook',
}

const STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  query:         'Query',
  mutation:      'Mutation',
  condition:     'Condition',
  approval_gate: 'Approval Gate',
  notification:  'Notification',
}

const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = ['pending', 'running', 'awaiting_approval']

const SCHEDULE_PRESETS = [
  { label: 'Hourly', cron: '0 * * * *', description: 'At minute 0 every hour' },
  { label: 'Daily 09:00', cron: '0 9 * * *', description: 'Every day at 09:00' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5', description: 'Monday through Friday at 09:00' },
  { label: 'Mondays 09:00', cron: '0 9 * * 1', description: 'Every Monday at 09:00' },
]

interface WorkflowTriggerTarget {
  id: string
  label: string
  element: string
  fields?: string[]  // populated for form widgets only
}

interface Props {
  appId: string
  triggerTargets?: WorkflowTriggerTarget[]
}

function getStringConfigValue(config: Record<string, unknown>, key: string) {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function getTriggerConfigDraft(triggerType: WorkflowTrigger, source: Record<string, unknown> | null) {
  const cfg = source ?? {}
  switch (triggerType) {
    case 'schedule':
      return { cron: getStringConfigValue(cfg, 'cron') }
    case 'webhook':
      return { secret_token_hash: getStringConfigValue(cfg, 'secret_token_hash') }
    case 'form_submit':
    case 'button_click':
      return { widget_id: getStringConfigValue(cfg, 'widget_id') }
    case 'manual':
    default:
      return {}
  }
}

function buildTriggerConfig(triggerType: WorkflowTrigger, source: Record<string, unknown>) {
  const nextConfig: Record<string, unknown> = {}

  const assignIfPresent = (key: string) => {
    const value = getStringConfigValue(source, key).trim()
    if (value) nextConfig[key] = value
  }

  switch (triggerType) {
    case 'schedule':
      assignIfPresent('cron')
      break
    case 'webhook':
      assignIfPresent('secret_token_hash')
      break
    case 'form_submit':
    case 'button_click':
      assignIfPresent('widget_id')
      break
    case 'manual':
    default:
      break
  }

  return nextConfig
}

function getTriggerTargetsForType(triggerType: WorkflowTrigger, triggerTargets: WorkflowTriggerTarget[]) {
  switch (triggerType) {
    case 'form_submit':
      return triggerTargets.filter(target => target.element === 'form')
    case 'button_click':
      return triggerTargets.filter(target => target.element === 'button')
    default:
      return triggerTargets
  }
}

function createWebhookSecret() {
  return `whsec_${crypto.randomUUID().replace(/-/g, '')}`
}

function getDefaultTriggerConfigDraft(
  triggerType: WorkflowTrigger,
  source: Record<string, unknown>,
  triggerTargets: WorkflowTriggerTarget[],
) {
  const currentDraft = getTriggerConfigDraft(triggerType, source)

  switch (triggerType) {
    case 'schedule':
      return {
        cron: getStringConfigValue(currentDraft, 'cron') || SCHEDULE_PRESETS[0].cron,
      }
    case 'webhook':
      return {
        secret_token_hash: getStringConfigValue(currentDraft, 'secret_token_hash') || createWebhookSecret(),
      }
    case 'form_submit':
    case 'button_click': {
      const validTargets = getTriggerTargetsForType(triggerType, triggerTargets)
      const currentWidgetId = getStringConfigValue(currentDraft, 'widget_id')
      return {
        widget_id: validTargets.some(target => target.id === currentWidgetId)
          ? currentWidgetId
          : validTargets[0]?.id || '',
      }
    }
    case 'manual':
    default:
      return {}
  }
}

function validateCronExpression(cron: string) {
  const trimmed = cron.trim()
  if (!trimmed) {
    return 'Choose or enter a cron expression.'
  }

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return 'Use five cron fields: minute hour day-of-month month day-of-week.'
  }

  const allowedTokenPattern = /^[0-9*/,-]+$/
  const invalidField = fields.find(field => !allowedTokenPattern.test(field))
  if (invalidField) {
    return `Cron field "${invalidField}" contains unsupported characters.`
  }

  return undefined
}

function validateTriggerConfig(
  triggerType: WorkflowTrigger,
  source: Record<string, unknown>,
  triggerTargets: WorkflowTriggerTarget[],
) {
  switch (triggerType) {
    case 'schedule': {
      const cronError = validateCronExpression(getStringConfigValue(source, 'cron'))
      return cronError ? [cronError] : []
    }
    case 'webhook': {
      const secret = getStringConfigValue(source, 'secret_token_hash').trim()
      if (!secret) {
        return ['Generate or enter a shared secret for webhook authentication.']
      }
      if (secret.includes(' ')) {
        return ['Webhook secrets cannot contain spaces.']
      }
      if (secret.length < 8) {
        return ['Webhook secrets should be at least 8 characters long.']
      }
      return []
    }
    case 'form_submit':
    case 'button_click': {
      const validTargets = getTriggerTargetsForType(triggerType, triggerTargets)
      const widgetId = getStringConfigValue(source, 'widget_id').trim()
      if (!widgetId) {
        return [`Choose a ${triggerType === 'form_submit' ? 'form' : 'button'} widget.`]
      }
      if (!validTargets.some(target => target.id === widgetId)) {
        return [`The selected ${triggerType === 'form_submit' ? 'form' : 'button'} widget is missing from the canvas.`]
      }
      return []
    }
    case 'manual':
    default:
      return []
  }
}

function getTriggerHelperText(triggerType: WorkflowTrigger) {
  switch (triggerType) {
    case 'schedule':
      return 'Five-field cron format: minute hour day-of-month month day-of-week.'
    case 'webhook':
      return 'Use a strong shared secret so inbound webhook authentication has a value to validate against.'
    case 'form_submit':
      return 'Choose the form widget that should emit this trigger. Removing the widget breaks the link.'
    case 'button_click':
      return 'Choose the button widget that should emit this trigger. Removing the widget breaks the link.'
    case 'manual':
    default:
      return 'Manual workflows run from the builder and can accept JSON input from the Run drawer.'
  }
}

// ============================================================================
// WorkflowEditor
// ============================================================================
export function WorkflowEditor({ appId, triggerTargets = [] }: Props) {
  const { workspace, user } = useAuth()
  const isAdmin   = user?.role === 'workspace_admin'
  const isBuilder = user?.role === 'app_builder' || isAdmin

  const [workflows, setWorkflows]     = useState<Workflow[]>([])
  const [selected, setSelected]       = useState<WorkflowWithSteps | null>(null)
  const [runs, setRuns]               = useState<WorkflowRun[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [creating, setCreating]       = useState(false)
  const [newName, setNewName]         = useState('')
  const [actionErr, setActionErr]     = useState('')

  // Load workflow list
  const reload = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const res = await listWorkflows(workspace.id, appId)
      setWorkflows(res.workflows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows')
    } finally {
      setLoading(false)
    }
  }, [workspace, appId])

  useEffect(() => { reload() }, [reload])

  // Load detail + runs when selection changes
  const selectWorkflow = useCallback(async (wf: Workflow) => {
    if (!workspace) return
    setActionErr('')
    try {
      const [detail, runsRes] = await Promise.all([
        getWorkflow(workspace.id, appId, wf.id),
        listWorkflowRuns(workspace.id, appId, wf.id),
      ])
      setSelected(detail)
      setRuns(runsRes.runs)
    } catch {
      setSelected({ ...wf, steps: [] })
      setRuns([])
    }
  }, [workspace, appId])

  const refreshRuns = useCallback(async (workflowId: string, suppressErrors = false) => {
    if (!workspace) return
    try {
      const runsRes = await listWorkflowRuns(workspace.id, appId, workflowId)
      setRuns(runsRes.runs)
    } catch (e) {
      if (!suppressErrors) {
        setActionErr(e instanceof Error ? e.message : 'Failed to load workflow runs')
      }
    }
  }, [workspace, appId])

  useEffect(() => {
    if (!selected?.id) return
    if (!runs.some(run => ACTIVE_RUN_STATUSES.includes(run.status))) return

    const intervalId = window.setInterval(() => {
      void refreshRuns(selected.id, true)
    }, 3000)

    return () => window.clearInterval(intervalId)
  }, [selected?.id, runs, refreshRuns])

  // Create new workflow
  const handleCreate = useCallback(async () => {
    if (!workspace || !newName.trim()) return
    try {
      await createWorkflow(workspace.id, appId, {
        name: newName.trim(),
        trigger_type: 'manual',
        requires_approval: true,
        steps: [],
      })
      setNewName('')
      setCreating(false)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to create workflow')
    }
  }, [workspace, appId, newName, reload])

  // Delete workflow
  const handleDelete = useCallback(async (wfId: string) => {
    if (!workspace) return
    if (!confirm('Delete this workflow? This cannot be undone.')) return
    try {
      await deleteWorkflow(workspace.id, appId, wfId)
      if (selected?.id === wfId) setSelected(null)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to delete workflow')
    }
  }, [workspace, appId, selected, reload])

  // Activate / archive
  const handleActivate = useCallback(async () => {
    if (!workspace || !selected) return
    setActionErr('')
    try {
      const updated = await activateWorkflow(workspace.id, appId, selected.id)
      setSelected(prev => prev ? { ...prev, ...updated } : null)
      await reload()
    } catch (e) {
      setActionErr(e instanceof ApiError ? e.message : 'Failed to activate workflow')
    }
  }, [workspace, appId, selected, reload])

  const handleArchive = useCallback(async () => {
    if (!workspace || !selected) return
    try {
      const updated = await archiveWorkflow(workspace.id, appId, selected.id)
      setSelected(prev => prev ? { ...prev, ...updated } : null)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to archive workflow')
    }
  }, [workspace, appId, selected, reload])

  // Trigger a manual run with optional input data.
  const handleTrigger = useCallback(async (inputData?: Record<string, unknown>) => {
    if (!workspace || !selected) return
    setActionErr('')
    try {
      const run = await triggerWorkflow(workspace.id, appId, selected.id, inputData)
      setRuns(prev => [run, ...prev.filter(existing => existing.id !== run.id)])
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to trigger workflow'
      setActionErr(message)
      throw e instanceof Error ? e : new Error(message)
    }
  }, [workspace, appId, selected])

  // Review a step
  const handleReviewStep = useCallback(async (stepId: string) => {
    if (!workspace || !selected) return
    try {
      const step = await reviewStep(workspace.id, appId, selected.id, stepId)
      setSelected(prev =>
        prev ? { ...prev, steps: prev.steps.map(s => s.id === step.id ? step : s) } : null
      )
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to review step')
    }
  }, [workspace, appId, selected])

  // Save updated step list (replace-all)
  const handleSaveSteps = useCallback(async (steps: WorkflowStepInput[]) => {
    if (!workspace || !selected) return
    try {
      const res = await putWorkflowSteps(workspace.id, appId, selected.id, steps)
      setSelected(prev => prev ? { ...prev, steps: res.steps } : null)
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to save steps')
    }
  }, [workspace, appId, selected])

  // Patch workflow metadata (name, trigger, requires_approval)
  const handlePatchWorkflow = useCallback(async (patch: Parameters<typeof patchWorkflow>[3]) => {
    if (!workspace || !selected) return
    try {
      const updated = await patchWorkflow(workspace.id, appId, selected.id, patch)
      setSelected(prev => prev ? { ...prev, ...updated } : null)
      await reload()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to update workflow')
    }
  }, [workspace, appId, selected, reload])

  // ---- render ---------------------------------------------------------------
  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, color: C.text, fontSize: '0.75rem', overflow: 'hidden' }}>

      {/* Left: workflow list */}
      <div style={{ width: 220, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, color: C.text }}>Workflows</span>
          {isBuilder && (
            <button style={btn(true)} onClick={() => { setCreating(true); setActionErr('') }}>+</button>
          )}
        </div>

        {creating && (
          <div style={{ padding: 10, borderBottom: `1px solid ${C.border}` }}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
              placeholder="Workflow name…"
              style={{ width: '100%', boxSizing: 'border-box', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, padding: '4px 8px', color: C.text, fontSize: '0.72rem', marginBottom: 6 }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={btn(true)} onClick={handleCreate}>Create</button>
              <button style={btn()} onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 12, color: C.muted }}>Loading…</div>}
          {error && <div style={{ padding: 12, color: C.dangerFg }}>{error}</div>}
          {!loading && workflows.length === 0 && (
            <div style={{ padding: 12, color: C.muted }}>No workflows yet</div>
          )}
          {workflows.map(wf => (
            <div
              key={wf.id}
              onClick={() => selectWorkflow(wf)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: `1px solid ${C.border}`,
                background: selected?.id === wf.id ? '#161616' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {wf.name}
              </span>
              <span style={pill(wf.status)}>{wf.status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: detail or empty state */}
      {selected ? (
        <WorkflowDetail
          wf={selected}
          runs={runs}
          isAdmin={isAdmin}
          isBuilder={isBuilder}
          actionErr={actionErr}
          onActivate={handleActivate}
          onArchive={handleArchive}
          onTrigger={handleTrigger}
          onRefreshRuns={() => refreshRuns(selected.id)}
          onDelete={() => handleDelete(selected.id)}
          onReviewStep={handleReviewStep}
          onSaveSteps={handleSaveSteps}
          onPatchWorkflow={handlePatchWorkflow}
          triggerTargets={triggerTargets}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>
          Select a workflow
        </div>
      )}
    </div>
  )
}

// ============================================================================
// WorkflowDetail
// ============================================================================
interface DetailProps {
  wf: WorkflowWithSteps
  runs: WorkflowRun[]
  isAdmin: boolean
  isBuilder: boolean
  actionErr: string
  onActivate: () => void
  onArchive: () => void
  onTrigger: (inputData?: Record<string, unknown>) => Promise<void>
  onRefreshRuns: () => Promise<void>
  onDelete: () => void
  onReviewStep: (stepId: string) => void
  onSaveSteps: (steps: WorkflowStepInput[]) => Promise<void>
  onPatchWorkflow: (patch: Parameters<typeof patchWorkflow>[3]) => Promise<void>
  triggerTargets: WorkflowTriggerTarget[]
}

const STEP_TYPES: WorkflowStepType[] = ['query', 'mutation', 'condition', 'approval_gate', 'notification']

function blankDraftStep(): DraftStep {
  return { _key: crypto.randomUUID(), name: '', step_type: 'query', config: '{}', ai_generated: false }
}

interface DraftStep {
  _key: string
  name: string
  step_type: WorkflowStepType
  config: string       // JSON text edited inline
  ai_generated: boolean
}

function WorkflowDetail({ wf, runs, isAdmin, isBuilder, actionErr, onActivate, onArchive, onTrigger, onRefreshRuns, onDelete, onReviewStep, onSaveSteps, onPatchWorkflow, triggerTargets }: DetailProps) {
  const unreviewedCount = (wf.steps ?? []).filter(s => s.ai_generated && !s.reviewed_by).length

  // When the trigger is form_submit, expose the linked form's field names so
  // the mutation step editor can show a proper dropdown instead of raw {{input.x}} syntax.
  const linkedFormFields = React.useMemo(() => {
    if (wf.trigger_type !== 'form_submit') return []
    const widgetId = typeof wf.trigger_config?.widget_id === 'string' ? wf.trigger_config.widget_id : ''
    if (!widgetId) return []
    const target = triggerTargets.find(t => t.id === widgetId)
    return target?.fields ?? []
  }, [wf.trigger_type, wf.trigger_config, triggerTargets])

  const [editingSteps, setEditingSteps] = useState(false)
  const [draftSteps, setDraftSteps]     = useState<DraftStep[]>([])
  const [savingSteps, setSavingSteps]   = useState(false)
  const [stepsErr, setStepsErr]         = useState('')

  // Metadata local state (save on blur)
  const [metaName, setMetaName]         = useState(wf.name)
  const [metaDesc, setMetaDesc]         = useState(wf.description ?? '')
  const [metaTriggerType, setMetaTriggerType] = useState<WorkflowTrigger>(wf.trigger_type)
  const [triggerConfigDraft, setTriggerConfigDraft] = useState<Record<string, unknown>>(
    getTriggerConfigDraft(wf.trigger_type, wf.trigger_config),
  )
  const [runDialogOpen, setRunDialogOpen] = useState(false)
  const [runInputText, setRunInputText] = useState('{}')
  const [runInputError, setRunInputError] = useState('')
  const [running, setRunning] = useState(false)

  const triggerTargetsForType = getTriggerTargetsForType(metaTriggerType, triggerTargets)
  const currentWidgetId = getStringConfigValue(triggerConfigDraft, 'widget_id')
  const widgetTargetMissing = Boolean(
    currentWidgetId
      && (metaTriggerType === 'form_submit' || metaTriggerType === 'button_click')
      && !triggerTargetsForType.some(target => target.id === currentWidgetId),
  )
  const widgetTargetOptions = widgetTargetMissing
    ? [{ id: currentWidgetId, label: `Missing widget (${currentWidgetId})`, element: 'missing' }, ...triggerTargetsForType]
    : triggerTargetsForType
  const triggerConfigErrors = validateTriggerConfig(metaTriggerType, triggerConfigDraft, triggerTargets)

  // Sync local state when the workflow prop changes (e.g. after patch)
  useEffect(() => { setMetaName(wf.name) }, [wf.name])
  useEffect(() => { setMetaDesc(wf.description ?? '') }, [wf.description])
  useEffect(() => { setMetaTriggerType(wf.trigger_type) }, [wf.trigger_type])
  useEffect(() => {
    setTriggerConfigDraft(getTriggerConfigDraft(wf.trigger_type, wf.trigger_config))
  }, [wf.trigger_type, wf.trigger_config])

  const startEditing = () => {
    setDraftSteps((wf.steps ?? []).map(s => ({
      _key:         s.id,
      name:         s.name,
      step_type:    s.step_type,
      config:       JSON.stringify(s.config ?? {}, null, 2),
      ai_generated: s.ai_generated ?? false,
    })))
    setStepsErr('')
    setEditingSteps(true)
  }

  const cancelEditing = () => {
    setEditingSteps(false)
    setDraftSteps([])
    setStepsErr('')
  }

  const saveSteps = async () => {
    // Validate JSON configs
    const inputs: WorkflowStepInput[] = []
    for (const d of draftSteps) {
      if (!d.name.trim()) { setStepsErr('All steps must have a name.'); return }
      let cfg: Record<string, unknown> = {}
      try { cfg = JSON.parse(d.config || '{}') } catch { setStepsErr(`Step "${d.name}": config is not valid JSON`); return }
      inputs.push({ name: d.name.trim(), step_type: d.step_type, config: cfg, ai_generated: d.ai_generated })
    }
    setSavingSteps(true)
    try {
      await onSaveSteps(inputs)
      setEditingSteps(false)
      setDraftSteps([])
      setStepsErr('')
    } catch (e) {
      setStepsErr(e instanceof Error ? e.message : 'Failed to save steps')
    } finally {
      setSavingSteps(false)
    }
  }

  const updateDraft = (key: string, patch: Partial<DraftStep>) =>
    setDraftSteps(prev => prev.map(d => d._key === key ? { ...d, ...patch } : d))

  const deleteDraft = (key: string) =>
    setDraftSteps(prev => prev.filter(d => d._key !== key))

  const moveDraft = (key: string, dir: -1 | 1) =>
    setDraftSteps(prev => {
      const idx = prev.findIndex(d => d._key === key)
      if (idx < 0) return prev
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const arr = [...prev]
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })

  const persistTriggerConfig = async (triggerType: WorkflowTrigger, nextDraft: Record<string, unknown>) => {
    if (validateTriggerConfig(triggerType, nextDraft, triggerTargets).length > 0) {
      return false
    }

    await onPatchWorkflow({
      trigger_type: triggerType,
      trigger_config: buildTriggerConfig(triggerType, nextDraft),
    })

    return true
  }

  const handleTriggerTypeChange = (nextTriggerType: WorkflowTrigger) => {
    const nextDraft = getDefaultTriggerConfigDraft(nextTriggerType, triggerConfigDraft, triggerTargets)
    setMetaTriggerType(nextTriggerType)
    setTriggerConfigDraft(nextDraft)
    void persistTriggerConfig(nextTriggerType, nextDraft)
  }

  const updateTriggerConfigField = (key: string, value: string) => {
    setTriggerConfigDraft(prev => ({ ...prev, [key]: value }))
  }

  const openRunDialog = () => {
    setRunInputText(JSON.stringify(runs[0]?.input_data ?? {}, null, 2))
    setRunInputError('')
    setRunDialogOpen(true)
  }

  const handleRun = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(runInputText || '{}')
    } catch {
      setRunInputError('Run input must be valid JSON.')
      return
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setRunInputError('Run input must be a JSON object.')
      return
    }

    setRunning(true)
    setRunInputError('')
    try {
      await onTrigger(parsed as Record<string, unknown>)
      setRunDialogOpen(false)
    } catch (e) {
      setRunInputError(e instanceof Error ? e.message : 'Failed to trigger workflow')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {wf.name}
        </span>
        <span style={pill(wf.status)}>{wf.status}</span>
        <span style={{ color: C.muted }}>{TRIGGER_LABELS[wf.trigger_type]}</span>

        {isBuilder && wf.status !== 'archived' && (
          <button style={btn()} onClick={openRunDialog} title="Create a manual run with input data">▶ Run...</button>
        )}
        {isAdmin && wf.status === 'draft' && (
          <button
            style={btn(true)}
            onClick={onActivate}
            title={unreviewedCount > 0 ? `${unreviewedCount} step(s) need review first` : 'Activate workflow'}
          >
            Activate
          </button>
        )}
        {isBuilder && wf.status === 'active' && (
          <button style={btn()} onClick={onArchive}>Archive</button>
        )}
        {isBuilder && (
          <button style={btn(false, true)} onClick={onDelete}>Delete</button>
        )}
      </div>

      {actionErr && (
        <div style={{ padding: '6px 14px', background: '#450a0a55', color: C.dangerFg, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          {actionErr}
        </div>
      )}

      {unreviewedCount > 0 && !editingSteps && (
        <div style={{ padding: '6px 14px', background: '#92400e33', color: '#fcd34d', borderBottom: `1px solid ${C.border}`, flexShrink: 0, fontSize: '0.7rem' }}>
          {unreviewedCount} AI-generated step{unreviewedCount !== 1 ? 's' : ''} need{unreviewedCount === 1 ? 's' : ''} builder review before this workflow can be activated.
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>

        {/* Metadata */}
        {isBuilder && (
          <Section title="Metadata">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: C.muted, fontSize: '0.65rem' }}>Name</span>
                <input
                  value={metaName}
                  onChange={e => setMetaName(e.target.value)}
                  onBlur={() => { if (metaName.trim() && metaName !== wf.name) onPatchWorkflow({ name: metaName.trim() }) }}
                  style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: C.muted, fontSize: '0.65rem' }}>Description</span>
                <textarea
                  value={metaDesc}
                  onChange={e => setMetaDesc(e.target.value)}
                  onBlur={() => { if (metaDesc !== (wf.description ?? '')) onPatchWorkflow({ description: metaDesc }) }}
                  rows={2}
                  style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: C.muted, fontSize: '0.65rem' }}>Trigger Type</span>
                <select
                  value={metaTriggerType}
                  onChange={e => handleTriggerTypeChange(e.target.value as WorkflowTrigger)}
                  style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px' }}
                >
                  {(Object.keys(TRIGGER_LABELS) as WorkflowTrigger[]).map(t => (
                    <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ color: C.muted, fontSize: '0.65rem' }}>Trigger Config</span>
                {metaTriggerType === 'manual' && (
                  <div style={{ color: C.muted, fontSize: '0.72rem', lineHeight: 1.5 }}>
                    {getTriggerHelperText(metaTriggerType)}
                  </div>
                )}
                {metaTriggerType === 'schedule' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: C.muted, fontSize: '0.65rem' }}>Cron Expression</span>
                    <input
                      value={getStringConfigValue(triggerConfigDraft, 'cron')}
                      onChange={e => updateTriggerConfigField('cron', e.target.value)}
                      onBlur={() => { void persistTriggerConfig(metaTriggerType, triggerConfigDraft) }}
                      placeholder="0 * * * *"
                      spellCheck={false}
                      style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px' }}
                    />
                    <span style={{ color: C.muted, fontSize: '0.65rem', lineHeight: 1.5 }}>
                      {getTriggerHelperText(metaTriggerType)}
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {SCHEDULE_PRESETS.map(preset => (
                        <button
                          key={preset.label}
                          type="button"
                          style={btn()}
                          title={preset.description}
                          onClick={() => {
                            const nextDraft = { ...triggerConfigDraft, cron: preset.cron }
                            setTriggerConfigDraft(nextDraft)
                            void persistTriggerConfig(metaTriggerType, nextDraft)
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </label>
                )}
                {metaTriggerType === 'webhook' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: C.muted, fontSize: '0.65rem' }}>Secret Token / Hash</span>
                    <input
                      value={getStringConfigValue(triggerConfigDraft, 'secret_token_hash')}
                      onChange={e => updateTriggerConfigField('secret_token_hash', e.target.value)}
                      onBlur={() => { void persistTriggerConfig(metaTriggerType, triggerConfigDraft) }}
                      placeholder="whsec_..."
                      spellCheck={false}
                      style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px' }}
                    />
                    <span style={{ color: C.muted, fontSize: '0.65rem', lineHeight: 1.5 }}>
                      {getTriggerHelperText(metaTriggerType)} Stored under <code>secret_token_hash</code>.
                    </span>
                    <button
                      type="button"
                      style={btn()}
                      onClick={() => {
                        const nextDraft = { ...triggerConfigDraft, secret_token_hash: createWebhookSecret() }
                        setTriggerConfigDraft(nextDraft)
                        void persistTriggerConfig(metaTriggerType, nextDraft)
                      }}
                    >
                      Generate secret
                    </button>
                  </label>
                )}
                {(metaTriggerType === 'form_submit' || metaTriggerType === 'button_click') && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: C.muted, fontSize: '0.65rem' }}>
                      {metaTriggerType === 'form_submit' ? 'Form Widget' : 'Button Widget'}
                    </span>
                    {widgetTargetOptions.length > 0 ? (
                      <select
                        value={getStringConfigValue(triggerConfigDraft, 'widget_id')}
                        onChange={e => {
                          const nextDraft = { ...triggerConfigDraft, widget_id: e.target.value }
                          setTriggerConfigDraft(nextDraft)
                          void persistTriggerConfig(metaTriggerType, nextDraft)
                        }}
                        style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3, color: C.text, fontSize: '0.72rem', padding: '3px 7px' }}
                      >
                        <option value="">
                          Select a {metaTriggerType === 'form_submit' ? 'form' : 'button'} widget...
                        </option>
                        {widgetTargetOptions.map(target => (
                          <option key={target.id} value={target.id}>{target.label}</option>
                        ))}
                      </select>
                    ) : (
                      <div style={{ color: C.dangerFg, fontSize: '0.72rem', lineHeight: 1.5 }}>
                        Add a {metaTriggerType === 'form_submit' ? 'form' : 'button'} widget to the canvas before saving this trigger.
                      </div>
                    )}
                    <span style={{ color: C.muted, fontSize: '0.65rem', lineHeight: 1.5 }}>
                      {getTriggerHelperText(metaTriggerType)}
                    </span>
                  </label>
                )}
                {triggerConfigErrors.length > 0 && (
                  <div style={{ display: 'grid', gap: 4, padding: '8px 10px', borderRadius: 4, background: '#450a0a55', color: C.dangerFg, fontSize: '0.68rem' }}>
                    {triggerConfigErrors.map(error => (
                      <span key={error}>{error}</span>
                    ))}
                  </div>
                )}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={wf.requires_approval}
                  onChange={e => onPatchWorkflow({ requires_approval: e.target.checked })}
                />
                <span style={{ fontSize: '0.72rem' }}>Requires approval</span>
              </label>
            </div>
          </Section>
        )}

        {/* Steps */}
        <Section
          title={`Steps (${editingSteps ? draftSteps.length : (wf.steps ?? []).length})`}
          action={isBuilder && !editingSteps
            ? <button style={btn()} onClick={startEditing}>Edit Steps</button>
            : undefined}
        >
          {editingSteps ? (
            <>
              {stepsErr && (
                <div style={{ color: C.dangerFg, fontSize: '0.7rem', marginBottom: 8 }}>{stepsErr}</div>
              )}

              {draftSteps.length === 0 && (
                <div style={{ color: C.muted, padding: '4px 0', marginBottom: 8 }}>No steps — add one below.</div>
              )}

              {draftSteps.map((d, idx) => (
                <DraftStepRow
                  key={d._key}
                  draft={d}
                  index={idx}
                  total={draftSteps.length}
                  formFields={linkedFormFields}
                  onChange={patch => updateDraft(d._key, patch)}
                  onDelete={() => deleteDraft(d._key)}
                  onMove={dir => moveDraft(d._key, dir)}
                />
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button style={btn()} onClick={() => setDraftSteps(prev => [...prev, blankDraftStep()])}>
                  + Add Step
                </button>
                <button style={btn(true)} onClick={saveSteps} disabled={savingSteps}>
                  {savingSteps ? 'Saving…' : 'Save Steps'}
                </button>
                <button style={btn()} onClick={cancelEditing} disabled={savingSteps}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              {(wf.steps ?? []).length === 0 && (
                <div style={{ color: C.muted, padding: '4px 0' }}>No steps defined.</div>
              )}
              {(wf.steps ?? []).map((step, idx) => (
                <StepRow key={step.id} step={step} index={idx} isBuilder={isBuilder} onReview={() => onReviewStep(step.id)} />
              ))}
            </>
          )}
        </Section>

        {/* Requires approval notice */}
        <Section title="Safety">
          <div style={{ color: C.muted }}>
            Requires approval for mutating steps: <strong style={{ color: wf.requires_approval ? C.green : C.dangerFg }}>{wf.requires_approval ? 'Yes' : 'No'}</strong>
          </div>
        </Section>

        {/* Recent runs */}
        <Section
          title={`Recent Runs (${runs.length})`}
          action={<button style={btn()} onClick={() => { void onRefreshRuns() }}>Refresh</button>}
        >
          {runs.length === 0 && <div style={{ color: C.muted }}>No runs yet.</div>}
          {runs.map(run => (
            <RunRow key={run.id} run={run} />
          ))}
        </Section>
      </div>

      {runDialogOpen && (
        <RunDialog
          inputText={runInputText}
          error={runInputError}
          running={running}
          onChange={setRunInputText}
          onClose={() => { if (!running) setRunDialogOpen(false) }}
          onSubmit={handleRun}
        />
      )}
    </div>
  )
}

// ---- MentionInput --------------------------------------------------------
// Text input with a '#'-triggered suggestion dropdown.
// Typing '#' (or '#partial') opens a picker; clicking a suggestion replaces
// the '#...' token inline. The underlying value is always a plain string, so
// advanced users can still type {{input.x}} directly.
function MentionInput({
  value,
  onChange,
  placeholder,
  suggestions,
  inputStyle,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  suggestions: string[]
  inputStyle?: React.CSSProperties
}) {
  const [open, setOpen]           = useState(false)
  const [query, setQuery]         = useState('')
  const [triggerPos, setTriggerPos] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = suggestions.filter(s =>
    !query || s.toLowerCase().includes(query.toLowerCase())
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value
    const cursor = e.target.selectionStart ?? newVal.length
    const beforeCursor = newVal.slice(0, cursor)
    const hashIdx = beforeCursor.lastIndexOf('#')
    if (hashIdx !== -1) {
      const afterHash = beforeCursor.slice(hashIdx + 1)
      if (!afterHash.includes(' ')) {
        setTriggerPos(hashIdx)
        setQuery(afterHash)
        setOpen(true)
        onChange(newVal)
        return
      }
    }
    setOpen(false)
    onChange(newVal)
  }

  const applySuggestion = (suggestion: string) => {
    const before    = value.slice(0, triggerPos)
    const afterHash = value.slice(triggerPos + 1)
    const spaceIdx  = afterHash.search(/\s/)
    const after     = spaceIdx === -1 ? '' : afterHash.slice(spaceIdx)
    onChange(before + suggestion + after)
    setOpen(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <input
        ref={inputRef}
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, minWidth: '100%',
          background: '#1e1e1e', border: `1px solid ${C.border}`, borderRadius: 3,
          zIndex: 100, maxHeight: 140, overflowY: 'auto', marginTop: 2,
        }}>
          {filtered.map(s => (
            <div
              key={s}
              onMouseDown={e => { e.preventDefault(); applySuggestion(s) }}
              style={{ padding: '4px 10px', cursor: 'pointer', fontSize: '0.7rem', fontFamily: 'monospace', color: C.accentFg }}
              onMouseEnter={e => { e.currentTarget.style.background = '#2a2a2a' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- MutationStepEditor ----------------------------------------------------
// Structured form for mutation step configs. Replaces the raw JSON textarea
// when step_type === 'mutation', giving non-technical users a guided experience.
function MutationStepEditor({
  configStr,
  formFields,
  onChange,
}: {
  configStr: string
  formFields: string[]
  onChange: (cfg: string) => void
}) {
  const { workspace } = useAuth()
  const [connectors,  setConnectors]  = useState<Connector[]>([])
  const [columns,     setColumns]     = useState<ManagedTableColumn[]>([])
  const [loadingCols, setLoadingCols] = useState(false)

  // Parse the current JSON string on every render (cheap, avoids stale state)
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(configStr || '{}') as Record<string, unknown> } catch { /* keep empty */ }

  // Ref so effects can read the latest parsed object without re-running
  const parsedRef = useRef(parsed)
  parsedRef.current = parsed

  const connectorId      = typeof parsed.connector_id === 'string' ? parsed.connector_id : ''
  const selectedCon      = connectors.find(c => c.id === connectorId)
  const isManaged        = selectedCon?.type === 'managed'
  const operation        = typeof parsed.operation === 'string' ? parsed.operation : 'insert'
  const rowId            = typeof parsed.row_id    === 'string' ? parsed.row_id    : ''

  // data as { col → value } string map
  const dataObj: Record<string, string> = (() => {
    const d = parsed.data
    if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
      return Object.fromEntries(
        Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
      )
    }
    return {}
  })()

  const needsData  = operation === 'insert' || operation === 'update'
  const needsRowId = operation === 'update' || operation === 'delete'

  // Rows to render in the fields table: schema columns (if available) or manual entries
  const dataRows = (isManaged && columns.length > 0)
    ? columns.map(c => ({ col: c.name, val: dataObj[c.name] ?? `{{input.${c.name}}}` }))
    : Object.entries(dataObj).map(([col, val]) => ({ col, val }))

  // Fetch connector list once
  useEffect(() => {
    if (!workspace) return
    listConnectors(workspace.id).then(res => setConnectors(res.connectors)).catch(() => {})
  }, [workspace])

  // Fetch columns whenever a managed connector is selected
  useEffect(() => {
    if (!workspace || !connectorId || !isManaged) { setColumns([]); return }
    setLoadingCols(true)
    getManagedTableColumns(workspace.id, connectorId)
      .then(res => {
        const cols = [...res.columns].sort((a, b) => a.col_order - b.col_order)
        setColumns(cols)
        // Auto-populate missing data keys with {{input.x}} placeholders
        const p  = parsedRef.current
        const op = typeof p.operation === 'string' ? p.operation : 'insert'
        if ((op === 'insert' || op === 'update') && cols.length > 0) {
          const existing = (typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data))
            ? (p.data as Record<string, unknown>) : {}
          const next = { ...existing }
          let changed = false
          for (const c of cols) {
            if (!(c.name in next)) { next[c.name] = `{{input.${c.name}}}`; changed = true }
          }
          if (changed) onChange(JSON.stringify({ ...p, data: next }, null, 2))
        }
      })
      .catch(() => setColumns([]))
      .finally(() => setLoadingCols(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, connectorId, isManaged])

  // Merge a partial patch into the current parsed config and emit
  const emit = (patch: Partial<Record<string, unknown>>) =>
    onChange(JSON.stringify({ ...parsedRef.current, ...patch }, null, 2))

  const handleConnectorChange = (newId: string) => {
    const newCon = connectors.find(c => c.id === newId)
    if (newCon?.type === 'managed') {
      onChange(JSON.stringify({ connector_id: newId, operation: 'insert', data: {} }, null, 2))
    } else {
      onChange(JSON.stringify({ connector_id: newId }, null, 2))
    }
    setColumns([])
  }

  const handleOperationChange = (newOp: string) => {
    const next: Record<string, unknown> = { connector_id: connectorId, operation: newOp }
    if (newOp === 'insert' || newOp === 'update') next.data   = dataObj
    if (newOp === 'update' || newOp === 'delete') next.row_id = rowId || '{{input.row_id}}'
    onChange(JSON.stringify(next, null, 2))
  }

  const updateDataValue = (col: string, val: string) =>
    emit({ data: { ...dataObj, [col]: val } })

  const is: React.CSSProperties = {
    background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3,
    color: C.text, fontSize: '0.72rem', padding: '3px 7px',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── Connector picker ─────────────────────────────────────────────── */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: C.muted, fontSize: '0.65rem' }}>Connector</span>
        <select style={{ ...is, background: '#1a1a1a' }} value={connectorId}
          onChange={e => handleConnectorChange(e.target.value)}>
          <option value="">Select a connector…</option>
          {connectors.map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
          ))}
        </select>
      </label>

      {/* ── Nothing selected yet ─────────────────────────────────────────── */}
      {!connectorId && (
        <div style={{ color: C.muted, fontSize: '0.7rem' }}>
          Select a connector to configure this step.
        </div>
      )}

      {/* ── Managed connector — fully structured UI ──────────────────────── */}
      {connectorId && isManaged && (
        <>
          {/* Operation */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: C.muted, fontSize: '0.65rem' }}>Operation</span>
            <select style={{ ...is, background: '#1a1a1a' }} value={operation}
              onChange={e => handleOperationChange(e.target.value)}>
              <option value="insert">Add a new row</option>
              <option value="update">Edit an existing row</option>
              <option value="delete">Remove a row</option>
            </select>
          </label>

          {/* Row ID (update / delete) */}
          {needsRowId && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ color: C.muted, fontSize: '0.65rem' }}>Row ID</span>
              <input style={is} value={rowId} placeholder="{{input.row_id}}"
                onChange={e => emit({ row_id: e.target.value })} />
              <span style={{ color: C.muted, fontSize: '0.6rem' }}>
                {`ID of the row to ${operation}. Use {{input.row_id}} to pull it from a form field.`}
              </span>
            </label>
          )}

          {/* Data fields (insert / update) */}
          {needsData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: C.muted, fontSize: '0.65rem' }}>
                {loadingCols ? 'Loading columns…' : 'Fields'}
              </span>

              {!loadingCols && dataRows.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 1 }}>
                  <span style={{ width: 120, flexShrink: 0, color: C.muted, fontSize: '0.6rem' }}>Column</span>
                  <span style={{ width: 12,  flexShrink: 0 }} />
                  <span style={{ flex: 1, color: C.muted, fontSize: '0.6rem' }}>
                    {formFields.length > 0 ? 'Form field' : 'Value from form field'}
                  </span>
                </div>
              )}

              {dataRows.map(({ col, val }) => {
                // Extract the field name from a {{input.X}} token, or keep raw value.
                const inputMatch = /^\{\{input\.([^}]+)\}\}$/.exec(val.trim())
                const selectedField = inputMatch ? inputMatch[1] : ''
                const isLiteral = !inputMatch && val !== ''

                return (
                <div key={col} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {/* Column name — dropdown when schema loaded, text input in manual mode */}
                  {columns.length > 0 ? (
                    <select
                      style={{ ...is, width: 120, flexShrink: 0, background: '#1a1a1a' }}
                      value={col}
                      onChange={e => {
                        const newCol = e.target.value
                        const next: Record<string, string> = {}
                        for (const [k, v] of Object.entries(dataObj)) next[k === col ? newCol : k] = v
                        emit({ data: next })
                      }}
                    >
                      {columns.map(c => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={{ ...is, width: 120, flexShrink: 0, color: C.muted }}
                      value={col}
                      placeholder="column"
                      onChange={e => {
                        const next: Record<string, string> = {}
                        for (const [k, v] of Object.entries(dataObj)) next[k === col ? e.target.value : k] = v
                        emit({ data: next })
                      }}
                    />
                  )}
                  <span style={{ color: C.muted, fontSize: '0.65rem', flexShrink: 0 }}>←</span>
                  {/* Value — dropdown of form fields when known; falls back to MentionInput */}
                  {formFields.length > 0 ? (
                    isLiteral ? (
                      // The user chose "enter a fixed value" — show a text input + revert link
                      <>
                        <input
                          style={{ ...is, flex: 1 }}
                          value={val}
                          placeholder="fixed value…"
                          autoFocus
                          onChange={e => updateDataValue(col, e.target.value)}
                        />
                        <button
                          type="button"
                          style={{ background: 'none', border: 'none', color: C.muted, fontSize: '0.65rem', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
                          title="Pick a form field instead"
                          onClick={() => updateDataValue(col, '')}
                        >↩</button>
                      </>
                    ) : (
                      <select
                        style={{ ...is, flex: 1, background: '#1a1a1a' }}
                        value={selectedField || ''}
                        onChange={e => {
                          if (e.target.value === '__literal__') {
                            updateDataValue(col, '')
                          } else {
                            updateDataValue(col, `{{input.${e.target.value}}}`)
                          }
                        }}
                      >
                        <option value="">— pick a field —</option>
                        {formFields.map(f => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                        <option value="__literal__">— enter a fixed value —</option>
                      </select>
                    )
                  ) : (
                    <MentionInput
                      value={val}
                      placeholder={`{{input.${col || 'value'}}}`}
                      suggestions={
                        columns.length > 0
                          ? columns.map(c => `{{input.${c.name}}}`)
                          : Object.keys(dataObj).filter(Boolean).map(k => `{{input.${k}}}`)
                      }
                      inputStyle={{ ...is, fontFamily: 'monospace', fontSize: '0.68rem' }}
                      onChange={v => updateDataValue(col, v)}
                    />
                  )}
                  {/* Remove button only when no schema columns (manual mode) */}
                  {columns.length === 0 && (
                    <button type="button" style={{ ...btn(false, true), padding: '2px 6px' }}
                      onClick={() => { const n = { ...dataObj }; delete n[col]; emit({ data: n }) }}>
                      ×
                    </button>
                  )}
                </div>
              )})}

              {/* No-schema notice: only shown after load attempt, no columns found */}
              {!loadingCols && columns.length === 0 && isManaged && connectorId && (
                <div style={{ fontSize: '0.68rem', color: '#fcd34d', background: '#92400e22',
                  border: '1px solid #92400e', borderRadius: 3, padding: '5px 8px', lineHeight: 1.5 }}>
                  No columns found for this connector. Go to{' '}
                  <a href="/builder/connectors" target="_blank"
                    style={{ color: '#fcd34d', textDecoration: 'underline' }}>
                    Settings → Connectors
                  </a>
                  {' '}and upload a CSV to define the schema, then come back here.
                </div>
              )}

              {/* Add custom field row (manual mode only) */}
              {columns.length === 0 && !loadingCols && (
                <button type="button" style={{ ...btn(), alignSelf: 'flex-start', marginTop: 2 }}
                  onClick={() => emit({ data: { ...dataObj, '': '' } })}>
                  + Add field
                </button>
              )}

              {columns.length > 0 && !loadingCols && formFields.length === 0 && (
                <span style={{ color: C.muted, fontSize: '0.6rem', marginTop: 2 }}>
                  {`{{input.fieldName}} is replaced with what the user typed in that form field when they submit.`}
                </span>
              )}
              {columns.length > 0 && !loadingCols && formFields.length > 0 && (
                <span style={{ color: C.muted, fontSize: '0.6rem', marginTop: 2 }}>
                  Each column will be filled with the value the user enters in the selected form field.
                </span>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Non-managed connector — raw JSON fallback with hint ───────────── */}
      {connectorId && !isManaged && (
        <>
          <div style={{ color: C.muted, fontSize: '0.7rem', lineHeight: 1.6,
            padding: '6px 8px', background: '#1a1a1a', borderRadius: 3, border: `1px solid ${C.border}` }}>
            SQL/REST connectors use a raw JSON config. Enter it below.
          </div>
          <textarea
            style={{ background: '#1a1a1a', border: `1px solid ${C.border}`, borderRadius: 3,
              color: C.text, fontSize: '0.72rem', padding: '3px 7px',
              width: '100%', boxSizing: 'border-box', minHeight: 60,
              fontFamily: 'monospace', resize: 'vertical', whiteSpace: 'pre' }}
            placeholder="{}"
            value={configStr}
            onChange={e => onChange(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
    </div>
  )
}

// ---- DraftStepRow ----------------------------------------------------------
interface DraftStepRowProps {
  draft: DraftStep
  index: number
  total: number
  formFields: string[]
  onChange: (patch: Partial<DraftStep>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}

function DraftStepRow({ draft, index, total, formFields, onChange, onDelete, onMove }: DraftStepRowProps) {
  const inputStyle: React.CSSProperties = {
    background: '#1a1a1a',
    border: `1px solid ${C.border}`,
    borderRadius: 3,
    color: C.text,
    fontSize: '0.72rem',
    padding: '3px 7px',
  }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, padding: 10, marginBottom: 8, background: '#0d0d0d' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color: C.muted, fontSize: '0.65rem', width: 16, textAlign: 'right', flexShrink: 0 }}>{index + 1}</span>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Step name…"
          value={draft.name}
          onChange={e => onChange({ name: e.target.value })}
        />
        <select
          style={{ ...inputStyle, background: '#1a1a1a' }}
          value={draft.step_type}
          onChange={e => onChange({ step_type: e.target.value as WorkflowStepType })}
        >
          {STEP_TYPES.map(t => (
            <option key={t} value={t}>{STEP_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: '0.65rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.ai_generated}
            onChange={e => onChange({ ai_generated: e.target.checked })}
            style={{ accentColor: C.accent }}
          />
          AI
        </label>
        <button style={{ ...btn(), padding: '2px 7px' }} onClick={() => onMove(-1)} disabled={index === 0} title="Move up">↑</button>
        <button style={{ ...btn(), padding: '2px 7px' }} onClick={() => onMove(1)} disabled={index === total - 1} title="Move down">↓</button>
        <button style={{ ...btn(false, true), padding: '2px 7px' }} onClick={onDelete} title="Delete step">×</button>
      </div>
      {draft.step_type === 'mutation' ? (
        <MutationStepEditor
          configStr={draft.config}
          formFields={formFields}
          onChange={cfg => onChange({ config: cfg })}
        />
      ) : (
        <textarea
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', minHeight: 60, fontFamily: 'monospace', resize: 'vertical', whiteSpace: 'pre' }}
          placeholder="{}"
          value={draft.config}
          onChange={e => onChange({ config: e.target.value })}
          spellCheck={false}
        />
      )}
    </div>
  )
}

// ---- StepRow ---------------------------------------------------------------
interface StepRowProps {
  step: WorkflowStep
  index: number
  isBuilder: boolean
  onReview: () => void
}

function StepRow({ step, index, isBuilder, onReview }: StepRowProps) {
  const needsReview = step.ai_generated && !step.reviewed_by
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '8px 0',
      borderBottom: `1px solid ${C.border}`,
    }}>
      <div style={{ width: 20, textAlign: 'center', color: C.muted, flexShrink: 0, paddingTop: 2 }}>{index + 1}</div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontWeight: 500 }}>{step.name}</span>
          <span style={{ color: C.muted, fontSize: '0.65rem' }}>
            {STEP_TYPE_LABELS[step.step_type]}
          </span>
          {step.ai_generated && (
            <span style={{ background: '#1e3a8a33', color: '#93c5fd', fontSize: '0.6rem', padding: '1px 6px', borderRadius: 99 }}>
              AI-generated
            </span>
          )}
          {step.reviewed_by && (
            <span style={{ background: '#16653433', color: '#4ade80', fontSize: '0.6rem', padding: '1px 6px', borderRadius: 99 }}>
              Reviewed
            </span>
          )}
        </div>
        {step.config && Object.keys(step.config).length > 0 && (
          <pre style={{ margin: 0, color: C.muted, fontSize: '0.6rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(step.config, null, 2)}
          </pre>
        )}
      </div>
      {needsReview && isBuilder && (
        <button style={btn(true)} onClick={onReview}>Review</button>
      )}
    </div>
  )
}

// ---- RunRow ----------------------------------------------------------------
function RunRow({ run }: { run: WorkflowRun }) {
  const [expanded, setExpanded] = useState(Boolean(run.error_message || run.output_data || run.approval_id))
  const started = new Date(run.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const completed = run.completed_at
    ? new Date(run.completed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'In progress'
  const approvalState = run.approval_id ? getRunApprovalState(run.status) : null

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 0' }}>
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        style={{
          background: 'transparent',
          border: 'none',
          color: C.text,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 0,
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span style={{ color: C.muted, width: 12, flexShrink: 0 }}>{expanded ? 'v' : '>'}</span>
        <span style={pill(run.status)}>{run.status}</span>
        <span style={{ color: C.muted, fontSize: '0.65rem', flex: 1 }}>{started}</span>
        {approvalState && (
          <span style={{ background: approvalState.background, color: approvalState.color, fontSize: '0.6rem', padding: '1px 6px', borderRadius: 99 }}>
            {approvalState.label}
          </span>
        )}
        {run.error_message && !expanded && (
          <span style={{ color: C.dangerFg, fontSize: '0.65rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {run.error_message}
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, paddingLeft: 20, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <RunMetaItem label="Run ID">
              <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', wordBreak: 'break-all' }}>{run.id}</span>
            </RunMetaItem>
            <RunMetaItem label="Started">{started}</RunMetaItem>
            <RunMetaItem label="Completed">{completed}</RunMetaItem>
            <RunMetaItem label="Approval">
              {run.approval_id ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  {approvalState && (
                    <span style={{
                      background: approvalState.background,
                      color: approvalState.color,
                      fontSize: '0.6rem',
                      padding: '2px 7px',
                      borderRadius: 99,
                      justifySelf: 'start',
                    }}>
                      {approvalState.label}
                    </span>
                  )}
                  <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', wordBreak: 'break-all' }}>{run.approval_id}</span>
                  <Link
                    href={`/builder/approvals?approval=${run.approval_id}&filter=${approvalState?.filter ?? 'all'}`}
                    style={{ color: '#93c5fd', fontSize: '0.68rem', textDecoration: 'none' }}
                  >
                    Open approval
                  </Link>
                </div>
              ) : 'None'}
            </RunMetaItem>
          </div>

          <JsonBlock label="Input Data" value={run.input_data} emptyMessage="{}" />
          <JsonBlock label="Output Data" value={run.output_data} emptyMessage="No output data recorded." />

          <div>
            <div style={{ fontSize: '0.65rem', color: C.muted, marginBottom: 4 }}>Error</div>
            {run.error_message ? (
              <div style={{ color: C.dangerFg, fontSize: '0.72rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {run.error_message}
              </div>
            ) : (
              <div style={{ color: C.muted, fontSize: '0.72rem' }}>No error recorded.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function getRunApprovalState(status: WorkflowRunStatus) {
  if (status === 'awaiting_approval') {
    return {
      label: 'Awaiting approval',
      background: '#92400e33',
      color: '#fcd34d',
      filter: 'pending' as const,
    }
  }

  return {
    label: 'Resumed from approval',
    background: '#1e3a8a33',
    color: '#93c5fd',
    filter: 'all' as const,
  }
}

function RunMetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#0d0d0d', border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px' }}>
      <div style={{ fontSize: '0.65rem', color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '0.72rem', color: C.text }}>{children}</div>
    </div>
  )
}

function JsonBlock({ label, value, emptyMessage }: { label: string; value: unknown; emptyMessage: string }) {
  const hasValue = value !== undefined && value !== null

  return (
    <div>
      <div style={{ fontSize: '0.65rem', color: C.muted, marginBottom: 4 }}>{label}</div>
      {hasValue ? (
        <pre style={{ margin: 0, background: '#0d0d0d', border: `1px solid ${C.border}`, borderRadius: 4, padding: '8px 10px', color: C.text, fontSize: '0.65rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <div style={{ color: C.muted, fontSize: '0.72rem' }}>{emptyMessage}</div>
      )}
    </div>
  )
}

interface RunDialogProps {
  inputText: string
  error: string
  running: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

function RunDialog({ inputText, error, running, onChange, onClose, onSubmit }: RunDialogProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 10,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(380px, 100%)',
          height: '100%',
          background: C.surface,
          borderLeft: `1px solid ${C.border}`,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: C.text }}>Run Workflow</div>
            <div style={{ color: C.muted, fontSize: '0.68rem' }}>Send a JSON object as input_data for this test run.</div>
          </div>
          <button style={btn()} onClick={onClose} disabled={running}>Close</button>
        </div>

        <textarea
          value={inputText}
          onChange={event => onChange(event.target.value)}
          rows={16}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 220,
            background: '#0d0d0d',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.text,
            padding: '10px 12px',
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: '0.7rem',
          }}
        />

        {error && (
          <div style={{ color: C.dangerFg, fontSize: '0.7rem' }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button style={btn()} onClick={onClose} disabled={running}>Cancel</button>
          <button style={btn(true)} onClick={onSubmit} disabled={running}>
            {running ? 'Running...' : 'Run Workflow'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- helpers ---------------------------------------------------------------
function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 600, color: C.muted, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}
