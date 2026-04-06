'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Company, Workspace } from './api'
import { listWorkspaces } from './api'

interface AuthUser {
  id: string
  companyId: string
  email?: string
  role: string
  language: 'en' | 'de'
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
  setLanguage: (lang: 'en' | 'de') => void
}

interface AuthDerivedFlags {
  canAccessBuilder: boolean
  canAccessTools: boolean
  canCreateTools: boolean
}

const AuthContext = createContext<(AuthState & AuthActions & AuthDerivedFlags) | null>(null)

function readLocaleCookie(): 'en' | 'de' {
  if (typeof document === 'undefined') return 'en'
  const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('NEXT_LOCALE='))
  return match?.split('=')[1] === 'de' ? 'de' : 'en'
}

function parseJWT(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    const language: 'en' | 'de' = payload.language === 'de' ? 'de' : readLocaleCookie()
    return { id: payload.sub, companyId: payload.company_id, role: payload.role, language }
  } catch {
    return null
  }
}

function resolveSelectedWorkspace(storedWorkspace: Workspace | null, workspaces: Workspace[]) {
  if (workspaces.length === 0) {
    return storedWorkspace
  }

  if (storedWorkspace) {
    const matchingWorkspace = workspaces.find(workspace => workspace.id === storedWorkspace.id)
    if (matchingWorkspace) {
      return matchingWorkspace
    }
  }

  return workspaces[0] ?? null
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
    const storedWorkspace: Workspace | null = workspaceRaw ? JSON.parse(workspaceRaw) : null

    if (!user || !company) {
      setState({ token: null, user: null, company: null, workspace: null, workspaces: [], isLoading: false })
      return
    }

    document.cookie = `NEXT_LOCALE=${user.language};path=/;max-age=31536000`

    let cancelled = false

    const rehydrate = async () => {
      let workspaces: Workspace[] = []
      try {
        const res = await listWorkspaces(company.id)
        workspaces = res.workspaces ?? []
      } catch {
        workspaces = []
      }

      const workspace = resolveSelectedWorkspace(storedWorkspace, workspaces)
      if (workspace) {
        localStorage.setItem('lima_workspace', JSON.stringify(workspace))
      } else {
        localStorage.removeItem('lima_workspace')
      }

      if (!cancelled) {
        setState({ token, user, company, workspace, workspaces, isLoading: false })
      }
    }

    void rehydrate()

    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async (token: string, company: Company) => {
    const user = parseJWT(token)
    if (!user) throw new Error('invalid token')
    document.cookie = `NEXT_LOCALE=${user.language};path=/;max-age=31536000`
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

  const setLanguage = useCallback((lang: 'en' | 'de') => {
    setState(s => s.user ? { ...s, user: { ...s.user, language: lang } } : s)
  }, [])

  const canAccessBuilder = !state.isLoading && state.token !== null && state.user !== null
  const canAccessTools = canAccessBuilder
  const canCreateTools = canAccessBuilder

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut, selectWorkspace, setLanguage, canAccessBuilder, canAccessTools, canCreateTools }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
