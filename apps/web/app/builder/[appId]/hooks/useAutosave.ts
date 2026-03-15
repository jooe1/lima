'use client'

import { useEffect, useRef, useState } from 'react'
import { serialize, type AuraDocument } from '@lima/aura-dsl'

/**
 * Autosaves the document after a debounce delay whenever it changes.
 * Pass onSave=undefined to disable (e.g. before the app data has loaded).
 */
export function useAutosave(
  doc: AuraDocument,
  onSave: ((source: string) => Promise<void>) | undefined,
  delay = 1500,
): { saving: boolean; savedAt: Date | null } {
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!onSaveRef.current) return
    const source = serialize(doc)
    if (source === lastSavedRef.current) return

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      const currentSource = serialize(doc)
      if (currentSource === lastSavedRef.current || !onSaveRef.current) return
      setSaving(true)
      try {
        await onSaveRef.current(currentSource)
        lastSavedRef.current = currentSource
        setSavedAt(new Date())
      } catch {
        // silent — the header shows "unsaved" state
      } finally {
        setSaving(false)
      }
    }, delay)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [doc, delay])

  return { saving, savedAt }
}
