'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Company, Workspace } from './api'
import { listWorkspaces } from './api'

interface AuthUser {
  id: string
  companyId: string
  email?: string
  role: string
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  company: Company | null
  workspace: Workspace | null
  workspaces: Workspace[]
  isLoading: boolean
}

interface AuthActions {
  signIn: (token: string, company: Company) => Promise<void>
  signOut: () => void
  selectWorkspace: (ws: Workspace) => void
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null)

function parseJWT(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return { id: payload.sub, companyId: payload.company_id, role: payload.role }
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    token: null, user: null, company: null, workspace: null, workspaces: [], isLoading: true,
  })

  // Rehydrate from localStorage on mount.
  useEffect(() => {
    const token = localStorage.getItem('lima_token')
    const companyRaw = localStorage.getItem('lima_company')
    const workspaceRaw = localStorage.getItem('lima_workspace')
    if (!token) {
      setState(s => ({ ...s, isLoading: false }))
      return
    }
    const user = parseJWT(token)
    const company: Company | null = companyRaw ? JSON.parse(companyRaw) : null
    const workspace: Workspace | null = workspaceRaw ? JSON.parse(workspaceRaw) : null
    setState({ token, user, company, workspace, workspaces: [], isLoading: false })
  }, [])

  const signIn = useCallback(async (token: string, company: Company) => {
    const user = parseJWT(token)
    if (!user) throw new Error('invalid token')
    localStorage.setItem('lima_token', token)
    localStorage.setItem('lima_company', JSON.stringify(company))

    let workspaces: Workspace[] = []
    try {
      const res = await listWorkspaces(company.id)
      workspaces = res.workspaces
    } catch { /* non-fatal — user may not have workspaces yet */ }

    const workspace = workspaces[0] ?? null
    if (workspace) localStorage.setItem('lima_workspace', JSON.stringify(workspace))

    setState({ token, user, company, workspace, workspaces, isLoading: false })
  }, [])

  const signOut = useCallback(() => {
    localStorage.removeItem('lima_token')
    localStorage.removeItem('lima_company')
    localStorage.removeItem('lima_workspace')
    setState({ token: null, user: null, company: null, workspace: null, workspaces: [], isLoading: false })
  }, [])

  const selectWorkspace = useCallback((ws: Workspace) => {
    localStorage.setItem('lima_workspace', JSON.stringify(ws))
    setState(s => ({ ...s, workspace: ws }))
  }, [])

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut, selectWorkspace }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
