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

  if (res.status === 204 || res.status === 205) {
    return undefined as T
  }

  const text = await res.text()
  if (!text.trim()) {
    return undefined as T
  }

  return JSON.parse(text) as T
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

export function requestMagicLink(email: string, companySlug?: string) {
  return request<{ status: string }>('/v1/auth/magic-link/request', {
    method: 'POST',
    body: JSON.stringify({ email, company_slug: companySlug || undefined }),
  })
}

export function getGoogleLoginURL() {
  return `${API_BASE}/v1/auth/google/login`
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

export type WorkspaceRole = 'workspace_admin' | 'app_builder' | 'end_user'

export type WorkspaceGrantSource = 'manual' | 'policy' | 'idp' | 'system_bootstrap'

export type WorkspaceAccessPolicyMatchKind = 'all_company_members' | 'company_group' | 'idp_group'

export interface MemberGrant {
  role: WorkspaceRole
  grant_source: WorkspaceGrantSource | string
  source_ref: string
  explanation: string
  match_kind?: WorkspaceAccessPolicyMatchKind
  group_id?: string
  group_name?: string
}

export interface WorkspaceMemberGrant {
  id: string
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  grant_source: WorkspaceGrantSource | string
  source_ref: string
  created_by?: string
  created_at: string
  updated_at: string
}

export interface WorkspaceAccessPolicyRule {
  id: string
  workspace_id: string
  match_kind: WorkspaceAccessPolicyMatchKind
  group_id?: string
  role: WorkspaceRole
  created_by?: string
  created_at: string
  updated_at: string
}

export interface WorkspaceAccessPolicyRuleInput {
  match_kind: WorkspaceAccessPolicyMatchKind
  group_id?: string
  role: WorkspaceRole
}

export interface Member {
  user_id: string
  workspace_id: string
  email: string
  name: string
  role: WorkspaceRole
  joined_at: string
  grants?: MemberGrant[]
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

interface WorkspaceMemberGrantEnvelope {
  grant: WorkspaceMemberGrant
}

export function upsertWorkspaceMember(
  companyId: string,
  workspaceId: string,
  data: { user_id?: string; email?: string; role: WorkspaceRole },
) {
  return request<WorkspaceMemberGrantEnvelope>(
    `/v1/companies/${companyId}/workspaces/${workspaceId}/members`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  ).then(res => res.grant)
}

export function removeWorkspaceMember(companyId: string, workspaceId: string, userId: string) {
  return request<void>(
    `/v1/companies/${companyId}/workspaces/${workspaceId}/members/${userId}`,
    {
      method: 'DELETE',
    },
  )
}

export interface CompanyUser {
  id: string
  company_id: string
  email: string
  name: string
  created_at: string
  updated_at: string
}

export function listCompanyUsers(companyId: string) {
  return request<{ users: CompanyUser[] }>(`/v1/companies/${companyId}/users`)
}

export function getWorkspaceAccessPolicy(companyId: string, workspaceId: string) {
  return request<{ rules: WorkspaceAccessPolicyRule[] }>(
    `/v1/companies/${companyId}/workspaces/${workspaceId}/access-policy`,
  )
}

export function putWorkspaceAccessPolicy(
  companyId: string,
  workspaceId: string,
  rules: WorkspaceAccessPolicyRuleInput[],
) {
  return request<{ rules: WorkspaceAccessPolicyRule[] }>(
    `/v1/companies/${companyId}/workspaces/${workspaceId}/access-policy`,
    {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    },
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
  node_metadata?: Record<string, { manuallyEdited: boolean }>
  created_by: string
  created_at: string
  updated_at: string
}

export interface AppVersion {
  id: string
  app_id: string
  version_num: number
  dsl_source: string
  node_metadata?: Record<string, { manuallyEdited: boolean }>
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
  patch: { name?: string; description?: string; dsl_source?: string; node_metadata?: Record<string, { manuallyEdited: boolean }> },
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

export interface PostMessageOptions {
  forceOverwrite?: boolean
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

export function postMessage(
  workspaceId: string,
  appId: string,
  threadId: string,
  content: string,
  options?: PostMessageOptions,
) {
  return request<PostMessageResponse>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/threads/${threadId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(options?.forceOverwrite ? { force_overwrite: true } : {}),
      }),
    },
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

export interface GetPublishedAppOptions {
  publicationId?: string
}

// getPublishedApp fetches the published AppVersion for use in the runtime shell.
// Returns 404 when the app is not published and 403 when the publication grants discovery only.
export function getPublishedApp(workspaceId: string, appId: string, options?: GetPublishedAppOptions) {
  const query = options?.publicationId
    ? `?publication_id=${encodeURIComponent(options.publicationId)}`
    : ''

  return request<AppVersion>(`/v1/workspaces/${workspaceId}/apps/${appId}/published${query}`)
}

// previewDraftApp fetches the current draft App (DSL + node_metadata) for builder preview.
// Requires app_builder or workspace_admin role — end_user receives 403.
export function previewDraftApp(workspaceId: string, appId: string) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/${appId}/preview`)
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
  next_step_id?: string
  false_branch_step_id?: string
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
  next_step_id?: string
  false_branch_step_id?: string
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

// ---- Dashboard queries (Phase 6) -------------------------------------------

export interface DashboardQueryRequest {
  sql: string
  params?: unknown[]
  limit?: number
}

export interface DashboardQueryResponse {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  /** Present when the connector type is not yet supported for queries. */
  error?: string
}

/** Execute a read-only SELECT query against a connector.
 *  Only SELECT queries are permitted; mutations are rejected by the API. */
export function runConnectorQuery(
  workspaceId: string,
  connectorId: string,
  req: DashboardQueryRequest,
) {
  return request<DashboardQueryResponse>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/query`,
    { method: 'POST', body: JSON.stringify(req) },
  )
}

// ---- Connectors (Phase 4) --------------------------------------------------

export type ConnectorType = 'postgres' | 'mysql' | 'mssql' | 'rest' | 'graphql' | 'managed'

export interface Connector {
  id: string
  workspace_id: string
  name: string
  type: ConnectorType
  schema_cache?: Record<string, unknown>
  schema_cached_at?: string
  created_by: string
  created_at: string
  updated_at: string
  company_id?: string
  owner_scope: string
}

export interface TestConnectorResponse {
  ok: boolean
  error?: string
}

export interface ConnectorSchemaResponse {
  schema: Record<string, unknown> | null
  schema_cached_at?: string
  refreshing?: boolean
}

interface ConnectorEnvelope {
  connector: Connector
}

export function listConnectors(workspaceId: string) {
  return request<{ connectors: Connector[] }>(`/v1/workspaces/${workspaceId}/connectors`)
}

export function createConnector(
  workspaceId: string,
  data: { name: string; type: ConnectorType; credentials: Record<string, unknown> },
) {
  return request<ConnectorEnvelope>(`/v1/workspaces/${workspaceId}/connectors`, {
    method: 'POST',
    body: JSON.stringify(data),
  }).then(res => res.connector)
}

export function getConnector(workspaceId: string, connectorId: string) {
  return request<ConnectorEnvelope>(`/v1/workspaces/${workspaceId}/connectors/${connectorId}`)
    .then(res => res.connector)
}

export function patchConnector(
  workspaceId: string,
  connectorId: string,
  data: { name?: string; credentials?: Record<string, unknown> },
) {
  return request<ConnectorEnvelope>(`/v1/workspaces/${workspaceId}/connectors/${connectorId}`, {
    method: 'PATCH',
    body: JSON.stringify(data)
  }).then(res => res.connector)
}

export function deleteConnector(workspaceId: string, connectorId: string) {
  return request<void>(`/v1/workspaces/${workspaceId}/connectors/${connectorId}`, {
    method: 'DELETE',
  })
}

export function testConnector(workspaceId: string, connectorId: string) {
  return request<TestConnectorResponse>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/test`,
    { method: 'POST' },
  )
}

export function getConnectorSchema(workspaceId: string, connectorId: string) {
  return request<ConnectorSchemaResponse>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/schema`,
  )
}

// ---- Managed table (Lima Table) -------------------------------------------

export interface ManagedTableColumn {
  id: string
  name: string
  col_type: string
  nullable: boolean
  col_order: number
}

export interface ManagedTableRow {
  id: string
  connector_id: string
  data: Record<string, unknown>
  created_by: string
  created_at: string
  updated_at: string
}

export function getManagedTableColumns(workspaceId: string, connectorId: string) {
  return request<{ columns: ManagedTableColumn[] }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/columns`,
  )
}

export function setManagedTableColumns(
  workspaceId: string,
  connectorId: string,
  columns: Array<{ name: string; col_type: string; nullable: boolean }>,
) {
  return request<{ columns: ManagedTableColumn[] }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/columns`,
    { method: 'PUT', body: JSON.stringify({ columns }) },
  )
}

export function listManagedTableRows(workspaceId: string, connectorId: string) {
  return request<{ rows: ManagedTableRow[] }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/rows`,
  )
}

export function insertManagedTableRow(
  workspaceId: string,
  connectorId: string,
  data: Record<string, unknown>,
) {
  return request<{ row: ManagedTableRow }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/rows`,
    { method: 'POST', body: JSON.stringify({ data }) },
  )
}

export function updateManagedTableRow(
  workspaceId: string,
  connectorId: string,
  rowId: string,
  data: Record<string, unknown>,
) {
  return request<{ row: ManagedTableRow }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/rows/${rowId}`,
    { method: 'PATCH', body: JSON.stringify({ data }) },
  )
}

export function deleteManagedTableRow(workspaceId: string, connectorId: string, rowId: string) {
  return request<void>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/rows/${rowId}`,
    { method: 'DELETE' },
  )
}

export function seedManagedTableFromCSV(
  workspaceId: string,
  connectorId: string,
  file: File,
  replace = false,
) {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const body = new FormData()
  body.append('file', file)

  const url = `${API_BASE}/v1/workspaces/${workspaceId}/connectors/${connectorId}/seed${replace ? '?replace=true' : ''}`
  return fetch(url, { method: 'POST', headers, body }).then(async (res) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new ApiError(res.status, err.error ?? 'unknown_error', err.message ?? res.statusText)
    }
    return res.json() as Promise<{ rows_inserted: number; columns_created: number }>
  })
}

export function exportManagedTableCSVUrl(workspaceId: string, connectorId: string) {
  return `${API_BASE}/v1/workspaces/${workspaceId}/connectors/${connectorId}/export.csv`
}

// ---- Audit log -------------------------------------------------------------

export interface AuditEvent {
  id: string
  workspace_id: string
  actor_id?: string
  event_type: string
  resource_type?: string
  resource_id?: string
  metadata?: Record<string, unknown>
  created_at: string
}

export function listAuditEvents(workspaceId: string, limit?: number) {
  const params = limit ? `?limit=${limit}` : ''
  return request<{ events: AuditEvent[] }>(`/v1/workspaces/${workspaceId}/audit${params}`)
}

export function exportAuditEventsCSV(workspaceId: string, since: string, until?: string) {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const params = new URLSearchParams({ since })
  if (until) params.set('until', until)
  return fetch(
    `${API_BASE}/v1/workspaces/${workspaceId}/audit/export?${params}`,
    { headers },
  ).then(async (res) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new ApiError(res.status, err.error ?? 'unknown_error', err.message ?? res.statusText)
    }
    return res.blob()
  })
}

// ---- Company groups --------------------------------------------------------

export interface CompanyGroup {
  id: string
  company_id: string
  name: string
  slug: string
  source_type: string
  external_ref?: string
  managed_by?: string
  created_at: string
  updated_at: string
}

export interface GroupMembership {
  group_id: string
  user_id: string
  joined_at: string
}

interface CompanyGroupEnvelope {
  group: CompanyGroup
}

export function listCompanyGroups(companyId: string) {
  return request<{ groups: CompanyGroup[] }>(`/v1/companies/${companyId}/groups`)
}

export function createCompanyGroup(
  companyId: string,
  data: { name: string; slug: string; source_type?: string },
) {
  return request<CompanyGroup | CompanyGroupEnvelope>(`/v1/companies/${companyId}/groups`, {
    method: 'POST',
    body: JSON.stringify(data),
  }).then(res => ('group' in res ? res.group : res))
}

export function deleteCompanyGroup(companyId: string, groupId: string) {
  return request<void>(`/v1/companies/${companyId}/groups/${groupId}`, { method: 'DELETE' })
}

export function listGroupMembers(companyId: string, groupId: string) {
  return request<{ members: GroupMembership[] }>(
    `/v1/companies/${companyId}/groups/${groupId}/members`,
  )
}

export function addGroupMember(companyId: string, groupId: string, userId: string) {
  return request<void>(`/v1/companies/${companyId}/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

export function removeGroupMember(companyId: string, groupId: string, userId: string) {
  return request<void>(`/v1/companies/${companyId}/groups/${groupId}/members/${userId}`, {
    method: 'DELETE',
  })
}

// ---- Company resources -----------------------------------------------------

export interface CompanyResource {
  id: string
  workspace_id: string
  name: string
  type: ConnectorType
  schema_cache?: Record<string, unknown>
  schema_cached_at?: string
  created_by: string
  created_at: string
  updated_at: string
  company_id?: string
  owner_scope: string
}

interface CompanyResourceEnvelope {
  resource: CompanyResource
}

export function listCompanyResources(companyId: string) {
  return request<{ resources: CompanyResource[] }>(`/v1/companies/${companyId}/resources`)
}

export function createCompanyResource(
  companyId: string,
  data: { workspace_id: string; name: string; type: ConnectorType; credentials: Record<string, unknown> },
) {
  return request<CompanyResourceEnvelope>(`/v1/companies/${companyId}/resources`, {
    method: 'POST',
    body: JSON.stringify(data),
  }).then(res => res.resource)
}

export function getCompanyResource(companyId: string, resourceId: string) {
  return request<CompanyResourceEnvelope>(`/v1/companies/${companyId}/resources/${resourceId}`)
    .then(res => res.resource)
}

export function patchCompanyResource(
  companyId: string,
  resourceId: string,
  data: { name?: string; credentials?: Record<string, unknown> },
) {
  return request<CompanyResourceEnvelope>(`/v1/companies/${companyId}/resources/${resourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }).then(res => res.resource)
}

export function deleteCompanyResource(companyId: string, resourceId: string) {
  return request<void>(`/v1/companies/${companyId}/resources/${resourceId}`, {
    method: 'DELETE',
  })
}

// ---- Resource grants -------------------------------------------------------

export interface ResourceGrant {
  id: string
  company_id: string
  resource_kind: string
  resource_id: string
  subject_type: string
  subject_id: string
  action: string
  scope_json?: string
  effect: string
  created_by?: string
  created_at: string
}

interface ResourceGrantEnvelope {
  grant: ResourceGrant
}

export function listResourceGrants(companyId: string, resourceId: string) {
  return request<{ grants: ResourceGrant[] }>(
    `/v1/companies/${companyId}/resources/${resourceId}/grants`,
  )
}

export function createResourceGrant(
  companyId: string,
  resourceId: string,
  data: {
    subject_type: string
    subject_id: string
    action: string
    effect?: string
    scope_json?: string
  },
) {
  return request<ResourceGrantEnvelope>(
    `/v1/companies/${companyId}/resources/${resourceId}/grants`,
    { method: 'POST', body: JSON.stringify(data) },
  ).then(res => res.grant)
}

export function deleteResourceGrant(companyId: string, resourceId: string, grantId: string) {
  return request<void>(
    `/v1/companies/${companyId}/resources/${resourceId}/grants/${grantId}`,
    { method: 'DELETE' },
  )
}

// ---- Connector resource grants (Phase 6) -----------------------------------

export function listConnectorGrants(workspaceId: string, connectorId: string) {
  return request<{ grants: ResourceGrant[] }>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/grants`,
  )
}

export function createConnectorGrant(
  workspaceId: string,
  connectorId: string,
  data: { subject_type: string; subject_id: string; action: string },
) {
  return request<ResourceGrantEnvelope>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/grants`,
    { method: 'POST', body: JSON.stringify(data) },
  ).then(res => res.grant)
}

export function deleteConnectorGrant(workspaceId: string, connectorId: string, grantId: string) {
  return request<void>(
    `/v1/workspaces/${workspaceId}/connectors/${connectorId}/grants/${grantId}`,
    { method: 'DELETE' },
  )
}

// ---- App publications ------------------------------------------------------

export interface AppPublication {
  id: string
  app_id: string
  app_version_id: string
  workspace_id: string
  company_id: string
  status: string
  published_by: string
  policy_profile_id?: string
  runtime_identity_id?: string
  created_at: string
  updated_at: string
}

export type PublicationCapability = 'discover' | 'use'

export interface PublicationAudience {
  group_id: string
  capability: PublicationCapability
}

export function createPublication(
  workspaceId: string,
  appId: string,
  data: { app_version_id: string; audiences: PublicationAudience[] },
) {
  return request<AppPublication>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/publications`,
    { method: 'POST', body: JSON.stringify(data) },
  )
}

export function listPublications(workspaceId: string, appId: string) {
  return request<{ publications: AppPublication[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/publications`,
  )
}

export function archivePublication(workspaceId: string, appId: string, publicationId: string) {
  return request<void>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/publications/${publicationId}`,
    { method: 'DELETE' },
  )
}

export function listPublicationAudiences(workspaceId: string, appId: string, publicationId: string) {
  return request<{ audiences: PublicationAudience[] }>(
    `/v1/workspaces/${workspaceId}/apps/${appId}/publications/${publicationId}/audiences`,
  )
}

// ---- Company tool discovery ------------------------------------------------

export interface CompanyTool {
  publication_id: string
  app_id: string
  app_name: string
  app_description: string
  app_version_id: string
  workspace_id: string
  company_id: string
  capability: PublicationCapability
  published_by: string
  published_at: string
}

export function listCompanyTools(companyId: string) {
  return request<{ tools: CompanyTool[] }>(`/v1/companies/${companyId}/tools`)
}
