const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('lima_token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }))
    throw new ApiError(res.status, body.error ?? 'unknown_error', body.message ?? res.statusText)
  }
  return res.json()
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---- Auth ------------------------------------------------------------------

export interface DevLoginResponse {
  token: string
  user_id: string
  company: { id: string; name: string; slug: string }
}

export function devLogin(
  email: string,
  name: string,
  companySlug = 'dev',
  role = 'workspace_admin',
) {
  return request<DevLoginResponse>('/v1/auth/dev/login', {
    method: 'POST',
    body: JSON.stringify({ email, name, company_slug: companySlug, role }),
  })
}

export function getSSOLoginURL() {
  return `${API_BASE}/v1/auth/sso/login`
}

// ---- Tenancy ---------------------------------------------------------------

export interface Company {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

export interface Workspace {
  id: string
  company_id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

export interface Member {
  user_id: string
  workspace_id: string
  email: string
  name: string
  role: string
  joined_at: string
}

export function getCompany(companyId: string) {
  return request<Company>(`/v1/companies/${companyId}/`)
}

export function listWorkspaces(companyId: string) {
  return request<{ workspaces: Workspace[] }>(`/v1/companies/${companyId}/workspaces/`)
}

export function createWorkspace(companyId: string, name: string, slug: string) {
  return request<Workspace>(`/v1/companies/${companyId}/workspaces/`, {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  })
}

export function listMembers(companyId: string, workspaceId: string) {
  return request<{ members: Member[] }>(
    `/v1/companies/${companyId}/workspaces/${workspaceId}/members`,
  )
}

// ---- User AI settings -----------------------------------------------------

export type AIProvider = 'openai' | 'github_copilot'

export interface UserAISettings {
  configured: boolean
  user_id?: string
  provider?: AIProvider
  model?: string
  openai_base_url?: string
  has_secret: boolean
  masked_secret_id?: string
}

export interface UpdateUserAISettingsInput {
  provider: AIProvider
  model: string
  openai_base_url?: string
  api_key?: string
  github_token?: string
  clear_stored_secret?: boolean
}

export function getMyAISettings() {
  return request<UserAISettings>('/v1/me/ai-settings')
}

export function putMyAISettings(input: UpdateUserAISettingsInput) {
  return request<UserAISettings>('/v1/me/ai-settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

// ---- Apps ------------------------------------------------------------------

export interface App {
  id: string
  workspace_id: string
  name: string
  description?: string
  status: 'draft' | 'published' | 'archived'
  dsl_source: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface AppVersion {
  id: string
  app_id: string
  version_num: number
  dsl_source: string
  published_by: string
  published_at: string
}

export function listApps(workspaceId: string) {
  return request<{ apps: App[] }>(`/v1/workspaces/${workspaceId}/apps/`)
}

export function createApp(workspaceId: string, name: string, description?: string) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/`, {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
}

export function getApp(workspaceId: string, appId: string) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/${appId}/`)
}

export function patchApp(
  workspaceId: string,
  appId: string,
  patch: { name?: string; description?: string; dsl_source?: string },
) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/${appId}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteApp(workspaceId: string, appId: string) {
  return request<{ status: string }>(`/v1/workspaces/${workspaceId}/apps/${appId}/`, {
    method: 'DELETE',
  })
}

export function publishApp(workspaceId: string, appId: string) {
  return request<AppVersion>(`/v1/workspaces/${workspaceId}/apps/${appId}/publish`, {
    method: 'POST',
  })
}

export function rollbackApp(workspaceId: string, appId: string, versionNum: number) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/${appId}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ version_num: versionNum }),
  })
}

export function listAppVersions(workspaceId: string, appId: string) {
  return request<{ versions: AppVersion[] }>(`/v1/workspaces/${workspaceId}/apps/${appId}/versions`)
}

// ---- Conversation threads (Phase 3) ----------------------------------------

export interface ConversationThread {
  id: string
  app_id: string
  workspace_id: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface DSLPatch {
  new_source: string
}

export interface ThreadMessage {
  id: string
  thread_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  dsl_patch?: DSLPatch
  created_at: string
}

export interface PostMessageResponse {
  message: ThreadMessage
  queued: boolean
  queue_error?: string
}

export function listThreads(workspaceId: string, appId: string) {
  return request<{ threads: ConversationThread[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/threads`,
  )
}

export function createThread(workspaceId: string, appId: string) {
  return request<ConversationThread>(`/v1/workspaces/${workspaceId}/apps/${appId}/threads`, {
    method: 'POST',
  })
}

export function listMessages(workspaceId: string, appId: string, threadId: string) {
  return request<{ messages: ThreadMessage[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/threads/${threadId}/messages`,
  )
}

export function postMessage(workspaceId: string, appId: string, threadId: string, content: string) {
  return request<PostMessageResponse>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/threads/${threadId}/messages`,
    { method: 'POST', body: JSON.stringify({ content }) },
  )
}

// ---- Approvals (Phase 5) ---------------------------------------------------

export interface Approval {
  id: string
  workspace_id: string
  app_id?: string
  connector_id?: string
  description: string
  status: 'pending' | 'approved' | 'rejected'
  requested_by: string
  reviewed_by?: string
  reviewed_at?: string
  rejection_reason?: string
  created_at: string
  updated_at: string
}

export function listApprovals(workspaceId: string, status?: 'pending' | 'approved' | 'rejected') {
  const q = status ? `?status=${status}` : ''
  return request<{ approvals: Approval[] }>(`/v1/workspaces/${workspaceId}/approvals/${q}`)
}

export function createApproval(
  workspaceId: string,
  data: {
    app_id?: string
    connector_id?: string
    description: string
    payload: Record<string, unknown>
  },
) {
  return request<Approval>(`/v1/workspaces/${workspaceId}/approvals/`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function approveAction(workspaceId: string, approvalId: string) {
  return request<Approval>(`/v1/workspaces/${workspaceId}/approvals/${approvalId}/approve`, {
    method: 'POST',
  })
}

export function rejectAction(workspaceId: string, approvalId: string, reason?: string) {
  return request<Approval>(`/v1/workspaces/${workspaceId}/approvals/${approvalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ rejection_reason: reason ?? null }),
  })
}

// ---- Runtime (Phase 5) -----------------------------------------------------

// getPublishedApp fetches the latest published AppVersion for use in the runtime shell.
// Returns a 404 ApiError if the app is not in 'published' status (hard enforcement).
export function getPublishedApp(workspaceId: string, appId: string) {
  return request<AppVersion>(`/v1/workspaces/${workspaceId}/apps/${appId}/published`)
}

// ---- Workflows (Phase 6) ---------------------------------------------------

export type WorkflowTrigger =
  | 'manual'
  | 'form_submit'
  | 'button_click'
  | 'schedule'
  | 'webhook'

export type WorkflowStatus = 'draft' | 'active' | 'archived'

export type WorkflowStepType =
  | 'query'
  | 'mutation'
  | 'condition'
  | 'approval_gate'
  | 'notification'

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface WorkflowStep {
  id: string
  workflow_id: string
  step_order: number
  name: string
  step_type: WorkflowStepType
  config: Record<string, unknown>
  ai_generated: boolean
  reviewed_by?: string
  reviewed_at?: string
  created_at: string
  updated_at: string
}

export interface Workflow {
  id: string
  workspace_id: string
  app_id: string
  name: string
  description?: string
  trigger_type: WorkflowTrigger
  trigger_config: Record<string, unknown>
  status: WorkflowStatus
  requires_approval: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface WorkflowWithSteps extends Workflow {
  steps: WorkflowStep[]
}

export interface WorkflowRun {
  id: string
  workflow_id: string
  workspace_id: string
  status: WorkflowRunStatus
  triggered_by?: string
  input_data: Record<string, unknown>
  output_data?: Record<string, unknown>
  error_message?: string
  approval_id?: string
  started_at: string
  completed_at?: string
}

export interface WorkflowStepInput {
  name: string
  step_type: WorkflowStepType
  config: Record<string, unknown>
  ai_generated: boolean
}

export interface CreateWorkflowInput {
  name: string
  description?: string
  trigger_type?: WorkflowTrigger
  trigger_config?: Record<string, unknown>
  requires_approval?: boolean
  steps?: WorkflowStepInput[]
}

export function listWorkflows(workspaceId: string, appId: string) {
  return request<{ workflows: Workflow[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows`,
  )
}

export function getWorkflow(workspaceId: string, appId: string, workflowId: string) {
  return request<WorkflowWithSteps>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}`,
  )
}

export function createWorkflow(workspaceId: string, appId: string, input: CreateWorkflowInput) {
  return request<WorkflowWithSteps>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function patchWorkflow(
  workspaceId: string,
  appId: string,
  workflowId: string,
  patch: Partial<CreateWorkflowInput>,
) {
  return request<Workflow>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  )
}

export function deleteWorkflow(workspaceId: string, appId: string, workflowId: string) {
  return request<{ status: string }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}`,
    { method: 'DELETE' },
  )
}

export function activateWorkflow(workspaceId: string, appId: string, workflowId: string) {
  return request<Workflow>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/activate`,
    { method: 'POST' },
  )
}

export function archiveWorkflow(workspaceId: string, appId: string, workflowId: string) {
  return request<Workflow>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/archive`,
    { method: 'POST' },
  )
}

export function triggerWorkflow(
  workspaceId: string,
  appId: string,
  workflowId: string,
  inputData?: Record<string, unknown>,
) {
  return request<WorkflowRun>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/trigger`,
    { method: 'POST', body: JSON.stringify({ input_data: inputData ?? {} }) },
  )
}

export function listWorkflowRuns(workspaceId: string, appId: string, workflowId: string) {
  return request<{ runs: WorkflowRun[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/runs`,
  )
}

export function putWorkflowSteps(
  workspaceId: string,
  appId: string,
  workflowId: string,
  steps: WorkflowStepInput[],
) {
  return request<{ steps: WorkflowStep[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/steps`,
    { method: 'PUT', body: JSON.stringify({ steps }) },
  )
}

export function reviewStep(
  workspaceId: string,
  appId: string,
  workflowId: string,
  stepId: string,
) {
  return request<WorkflowStep>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/workflows/${workflowId}/steps/${stepId}/review`,
    { method: 'POST' },
  )
}
