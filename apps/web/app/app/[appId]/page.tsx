import { use } from 'react'

/**
 * Runtime page for a published app.
 * Phase 5 will fetch the published version, hydrate the AuraDocument,
 * and render it through the runtime widget renderer.
 */
export default function RuntimeAppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params)
  return (
    <div style={{ padding: '2rem', color: '#555' }}>
      Runtime renderer for published app {appId} — Phase 5
    </div>
  )
}
