/**
 * generate-port-manifest.ts
 *
 * Renders WIDGET_REGISTRY + STEP_NODE_REGISTRY to a JSON snapshot consumed by
 * the Go worker via go:embed. Run with:
 *   pnpm --filter "@lima/widget-catalog" generate
 *
 * Writes two copies:
 *  1. packages/widget-catalog/src/port-manifest.json   (checked-in reference)
 *  2. services/worker/internal/queue/port-manifest.json (go:embed target)
 */
import { WIDGET_REGISTRY, STEP_NODE_REGISTRY } from './index'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const manifest = {
  widgets: Object.values(WIDGET_REGISTRY).map(w => ({
    type: w.type,
    displayName: w.displayName,
    ports: w.ports,
  })),
  steps: Object.values(STEP_NODE_REGISTRY).map(s => ({
    type: s.type,
    displayName: s.displayName,
    ports: s.ports,
  })),
}

const json = JSON.stringify(manifest, null, 2)

const srcManifestPath = resolve(__dirname, 'port-manifest.json')
const workerManifestPath = resolve(__dirname, '../../../services/worker/internal/queue/port-manifest.json')

writeFileSync(srcManifestPath, json)
writeFileSync(workerManifestPath, json)

console.log(`Generated port-manifest.json (${manifest.widgets.length} widgets, ${manifest.steps.length} steps)`)
console.log(`  → ${srcManifestPath}`)
console.log(`  → ${workerManifestPath}`)
