import { compileAuthoring, parseV2, serializeV2, type AuraDocumentV2, type AuraEdge } from '@lima/aura-dsl'

export interface NormalizedAssistantDSL {
  source: string
  edges: AuraEdge[]
  mode: 'runtime' | 'authoring'
  document: AuraDocumentV2
}

export function normalizeAssistantDSL(source: string, newEdges?: AuraEdge[]): NormalizedAssistantDSL {
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
      const compiled = compileAuthoring(source)
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