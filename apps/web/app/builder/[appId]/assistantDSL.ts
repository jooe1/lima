import { compileAuthoring, parseV2, serializeV2, type AuraDocumentV2, type AuraEdge } from '@lima/aura-dsl'
import { type Connector } from '../../../lib/api'
import { getConnectorSchemaColumns } from '../../../lib/tableBinding'

export interface NormalizedAssistantDSL {
  source: string
  edges: AuraEdge[]
  mode: 'runtime' | 'authoring'
  document: AuraDocumentV2
}

export interface NormalizeAssistantDSLOptions {
  connectors?: Connector[]
}

function toAuthoringCompileOptions(options: NormalizeAssistantDSLOptions | undefined) {
  const connectors = options?.connectors ?? []
  if (connectors.length === 0) return undefined

  return {
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      type: connector.type,
      columns: getConnectorSchemaColumns(connector),
    })),
  }
}

export function normalizeAssistantDSL(source: string, newEdges?: AuraEdge[], options?: NormalizeAssistantDSLOptions): NormalizedAssistantDSL {
  try {
    const parsed = parseV2(source)
    return {
      source,
      edges: newEdges ?? parsed.edges,
      mode: 'runtime',
      document: { ...parsed, edges: newEdges ?? parsed.edges },
    }
  } catch (runtimeError) {
    try {
      const compiled = compileAuthoring(source, toAuthoringCompileOptions(options))
      return {
        source: serializeV2(compiled),
        edges: compiled.edges,
        mode: 'authoring',
        document: compiled,
      }
    } catch (authoringError) {
      const runtimeMessage = runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
      const authoringMessage = authoringError instanceof Error ? authoringError.message : String(authoringError)
      throw new Error(`runtime parse failed: ${runtimeMessage}; authoring compile failed: ${authoringMessage}`)
    }
  }
}