const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('lima_token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> ?? {}),
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
  constructor(readonly status: number, readonly code: string, message: string) {
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

export function devLogin(email: string, name: string, companySlug = 'dev', role = 'workspace_admin') {
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
  id: string; name: string; slug: string; created_at: string; updated_at: string
}

export interface Workspace {
  id: string; company_id: string; name: string; slug: string; created_at: string; updated_at: string
}

export interface Member {
  user_id: string; workspace_id: string; email: string; name: string; role: string; joined_at: string
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
  return request<{ members: Member[] }>(`/v1/companies/${companyId}/workspaces/${workspaceId}/members`)
}

// ---- Apps ------------------------------------------------------------------

export interface App {
  id: string; workspace_id: string; name: string; description?: string
  status: 'draft' | 'published' | 'archived'; dsl_source: string
  created_by: string; created_at: string; updated_at: string
}

export interface AppVersion {
  id: string; app_id: string; version_num: number; dsl_source: string
  published_by: string; published_at: string
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

export function patchApp(workspaceId: string, appId: string, patch: { name?: string; description?: string; dsl_source?: string }) {
  return request<App>(`/v1/workspaces/${workspaceId}/apps/${appId}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteApp(workspaceId: string, appId: string) {
  return request<{ status: string }>(`/v1/workspaces/${workspaceId}/apps/${appId}/`, { method: 'DELETE' })
}

export function publishApp(workspaceId: string, appId: string) {
  return request<AppVersion>(`/v1/workspaces/${workspaceId}/apps/${appId}/publish`, { method: 'POST' })
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
