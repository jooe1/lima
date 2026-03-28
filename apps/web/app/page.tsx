'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../lib/auth'

export default function Home() {
  const router = useRouter()
  const { token, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading) {
      if (!token) {
        router.replace('/login')
      } else {
        router.replace('/builder')
      }
    }
  }, [token, isLoading, router])

  return null
}
