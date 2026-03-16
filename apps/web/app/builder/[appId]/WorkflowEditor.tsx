'use client'

import React, { useCallback, useEffect, useState } from 'react'
import {
  type Workflow,
  type WorkflowWithSteps,
  type WorkflowStep,
  type WorkflowRun,
  type WorkflowStepType,
  type WorkflowTrigger,
  type WorkflowStepInput,
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

interface Props {
  appId: string
}

// ============================================================================
// WorkflowEditor
// ============================================================================
export function WorkflowEditor({ appId }: Props) {
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

  // Manual trigger
  const handleTrigger = useCallback(async () => {
    if (!workspace || !selected) return
    setActionErr('')
    try {
      const run = await triggerWorkflow(workspace.id, appId, selected.id)
      setRuns(prev => [run, ...prev])
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : 'Failed to trigger workflow')
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
          onDelete={() => handleDelete(selected.id)}
          onReviewStep={handleReviewStep}
          onSaveSteps={handleSaveSteps}
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
  onTrigger: () => void
  onDelete: () => void
  onReviewStep: (stepId: string) => void
  onSaveSteps: (steps: WorkflowStepInput[]) => Promise<void>
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

function WorkflowDetail({ wf, runs, isAdmin, isBuilder, actionErr, onActivate, onArchive, onTrigger, onDelete, onReviewStep, onSaveSteps }: DetailProps) {
  const unreviewedCount = wf.steps.filter(s => s.ai_generated && !s.reviewed_by).length

  const [editingSteps, setEditingSteps] = useState(false)
  const [draftSteps, setDraftSteps]     = useState<DraftStep[]>([])
  const [savingSteps, setSavingSteps]   = useState(false)
  const [stepsErr, setStepsErr]         = useState('')

  const startEditing = () => {
    setDraftSteps(wf.steps.map(s => ({
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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {wf.name}
        </span>
        <span style={pill(wf.status)}>{wf.status}</span>
        <span style={{ color: C.muted }}>{TRIGGER_LABELS[wf.trigger_type]}</span>

        {isBuilder && wf.status !== 'archived' && (
          <button style={btn()} onClick={onTrigger} title="Create a manual run">▶ Run</button>
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

        {/* Steps */}
        <Section
          title={`Steps (${editingSteps ? draftSteps.length : wf.steps.length})`}
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
              {wf.steps.length === 0 && (
                <div style={{ color: C.muted, padding: '4px 0' }}>No steps defined.</div>
              )}
              {wf.steps.map((step, idx) => (
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
        <Section title={`Recent Runs (${runs.length})`}>
          {runs.length === 0 && <div style={{ color: C.muted }}>No runs yet.</div>}
          {runs.map(run => (
            <RunRow key={run.id} run={run} />
          ))}
        </Section>
      </div>
    </div>
  )
}

// ---- DraftStepRow ----------------------------------------------------------
interface DraftStepRowProps {
  draft: DraftStep
  index: number
  total: number
  onChange: (patch: Partial<DraftStep>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}

function DraftStepRow({ draft, index, total, onChange, onDelete, onMove }: DraftStepRowProps) {
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
      <textarea
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', minHeight: 60, fontFamily: 'monospace', resize: 'vertical', whiteSpace: 'pre' }}
        placeholder="{}"
        value={draft.config}
        onChange={e => onChange({ config: e.target.value })}
        spellCheck={false}
      />
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
  const started = new Date(run.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={pill(run.status)}>{run.status}</span>
      <span style={{ color: C.muted, fontSize: '0.65rem', flex: 1 }}>{started}</span>
      {run.error_message && (
        <span style={{ color: C.dangerFg, fontSize: '0.65rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.error_message}
        </span>
      )}
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
