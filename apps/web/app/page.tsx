'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../lib/auth'

export default function Home() {
  const router = useRouter()
  const { token, user, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading) {
      if (!token) {
        router.replace('/login')
      } else if (user?.role === 'end_user') {
        router.replace('/tools')
      } else {
        router.replace('/builder')
      }
    }
  }, [token, user, isLoading, router])

  return null
}
