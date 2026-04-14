'use client'

import { useEffect, useRef, useState } from 'react'
import { serializeV2, type AuraDocumentV2 } from '@lima/aura-dsl'

type NodeMetadataMap = Record<string, { manuallyEdited: boolean }>

/**
 * Autosaves the document and node metadata after a debounce delay whenever
 * either changes. Pass onSave=undefined to disable (e.g. before the app has
 * loaded).
 */
export function useAutosave(
  doc: AuraDocumentV2,
  nodeMetadata: NodeMetadataMap,
  onSave: ((source: string, nodeMetadata: NodeMetadataMap) => Promise<void>) | undefined,
  delay = 1500,
): { saving: boolean; savedAt: Date | null } {
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Keep a stable ref to latest nodeMetadata so the debounce callback captures current value
  const nodeMetadataRef = useRef(nodeMetadata)
  nodeMetadataRef.current = nodeMetadata

  useEffect(() => {
    if (!onSaveRef.current) return
    const source = serializeV2(doc)
    const combined = source + '\x00' + JSON.stringify(nodeMetadata)
    if (combined === lastSavedRef.current) return

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      const currentSource = serializeV2(doc)
      const currentCombined = currentSource + '\x00' + JSON.stringify(nodeMetadataRef.current)
      if (currentCombined === lastSavedRef.current || !onSaveRef.current) return
      setSaving(true)
      try {
        await onSaveRef.current(currentSource, nodeMetadataRef.current)
        lastSavedRef.current = currentCombined
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
  }, [doc, nodeMetadata, delay])

  return { saving, savedAt }
}
