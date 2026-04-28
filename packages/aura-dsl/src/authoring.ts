import type { AuraDocumentV2, AuraEdge, AuraNode } from './index'

export type AuraAuthoringScalar = string | number | boolean
export type AuraAuthoringAttrs = Record<string, AuraAuthoringScalar>

export interface AuraAuthoringRef {
  id: string
  port: string
}

interface AuraAuthoringBaseStatement {
  statementType: string
}

export interface AuraAuthoringAppStatement extends AuraAuthoringBaseStatement {
  statementType: 'app'
  id: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringEntityStatement extends AuraAuthoringBaseStatement {
  statementType: 'entity'
  id: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringPageStatement extends AuraAuthoringBaseStatement {
  statementType: 'page'
  id: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringLayoutStatement extends AuraAuthoringBaseStatement {
  statementType: 'layout'
  layoutType: 'stack' | 'grid' | 'slot'
  id: string
  parentId: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringWidgetStatement extends AuraAuthoringBaseStatement {
  statementType: 'widget'
  widgetType: string
  id: string
  parentId: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringFieldStatement extends AuraAuthoringBaseStatement {
  statementType: 'field'
  targetId: string
  value: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringColumnStatement extends AuraAuthoringBaseStatement {
  statementType: 'column'
  targetId: string
  value: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringOptionStatement extends AuraAuthoringBaseStatement {
  statementType: 'option'
  targetId: string
  value: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringActionStatement extends AuraAuthoringBaseStatement {
  statementType: 'action'
  id: string
  parentId: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringBindStatement extends AuraAuthoringBaseStatement {
  statementType: 'bind'
  source: AuraAuthoringRef
  target: AuraAuthoringRef
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringRunStatement extends AuraAuthoringBaseStatement {
  statementType: 'run'
  source: AuraAuthoringRef
  targetId: string
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringEffectStatement extends AuraAuthoringBaseStatement {
  statementType: 'effect'
  source: AuraAuthoringRef
  target: AuraAuthoringRef
  attrs: AuraAuthoringAttrs
}

export interface AuraAuthoringSetStatement extends AuraAuthoringBaseStatement {
  statementType: 'set'
  targetId: string
  key: string
  value: AuraAuthoringScalar
}

export interface AuraAuthoringNoteStatement extends AuraAuthoringBaseStatement {
  statementType: 'note'
  id: string
  text: string
}

export type AuraAuthoringStatement =
  | AuraAuthoringAppStatement
  | AuraAuthoringEntityStatement
  | AuraAuthoringPageStatement
  | AuraAuthoringLayoutStatement
  | AuraAuthoringWidgetStatement
  | AuraAuthoringFieldStatement
  | AuraAuthoringColumnStatement
  | AuraAuthoringOptionStatement
  | AuraAuthoringActionStatement
  | AuraAuthoringBindStatement
  | AuraAuthoringRunStatement
  | AuraAuthoringEffectStatement
  | AuraAuthoringSetStatement
  | AuraAuthoringNoteStatement

export interface AuraAuthoringDocument {
  statements: AuraAuthoringStatement[]
}

export interface AuraAuthoringValidationError {
  message: string
  severity?: 'error' | 'warning'
  statementType?: AuraAuthoringStatement['statementType']
  id?: string
}

export interface AuraAuthoringCompileConnector {
  id: string
  name?: string
  type?: string
  columns?: string[]
}

export interface AuraAuthoringCompileOptions {
  connectors?: AuraAuthoringCompileConnector[]
}

export class AuraAuthoringParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuraAuthoringParseError'
  }
}

type WidgetArea = 'header' | 'main' | 'sidebar' | 'footer'

interface WidgetPlacement {
  area: WidgetArea
  span?: number
}

const AUTHORING_WIDGET_TYPES = new Set([
  'table', 'form', 'button', 'text', 'kpi', 'chart', 'filter', 'markdown', 'modal', 'tabs', 'container',
])

const AUTHORING_ACTION_KIND_TO_STEP: Record<string, AuraNode['element']> = {
  managed_crud: 'step:mutation',
  create_record: 'step:mutation',
  update_record: 'step:mutation',
  delete_selected: 'step:mutation',
  query: 'step:query',
  approval: 'step:approval_gate',
  notify: 'step:notification',
  http_request: 'step:http',
}

const AUTHORING_ACTION_SOURCE_EVENTS = new Set(['success', 'error', 'done', 'approved', 'rejected'])
const AUTHORING_PAGE_SOURCE_EVENTS = new Set(['loaded'])
const AUTHORING_KEYWORDS = new Set([
  'app',
  'entity',
  'page',
  'stack',
  'grid',
  'slot',
  'widget',
  'field',
  'column',
  'option',
  'action',
  'bind',
  'run',
  'effect',
  'set',
  'note',
])
const AUTHORING_WITH_MERGE_KEYWORDS = new Set(['app', 'entity', 'page', 'stack', 'grid', 'slot', 'widget', 'action'])

export function parseAuthoring(source: string): AuraAuthoringDocument {
  const statements: AuraAuthoringStatement[] = []

  for (const rawLine of repairAuthoringCommonSyntax(source).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line === '---' || line.startsWith('#')) continue
    statements.push(parseAuthoringLine(line))
  }

  return { statements }
}

export function validateAuthoring(doc: AuraAuthoringDocument): AuraAuthoringValidationError[] {
  const errors: AuraAuthoringValidationError[] = []
  const idMap = new Map<string, AuraAuthoringStatement>()
  const pageIds = new Set<string>()
  const layoutIds = new Set<string>()
  const widgetMap = new Map<string, AuraAuthoringWidgetStatement>()
  const actionMap = new Map<string, AuraAuthoringActionStatement>()
  const fieldsByWidgetId = new Map<string, string[]>()
  const columnsByWidgetId = new Map<string, string[]>()

  for (const statement of doc.statements) {
    if (!hasStatementId(statement)) continue
    if (idMap.has(statement.id)) {
      errors.push({ message: `duplicate authoring id '${statement.id}'`, statementType: statement.statementType, id: statement.id })
      continue
    }
    idMap.set(statement.id, statement)
    if (statement.statementType === 'page') pageIds.add(statement.id)
    if (statement.statementType === 'layout') layoutIds.add(statement.id)
    if (statement.statementType === 'widget') widgetMap.set(statement.id, statement)
    if (statement.statementType === 'action') actionMap.set(statement.id, statement)
  }

  for (const statement of doc.statements) {
    if (statement.statementType === 'field') {
      pushListValue(fieldsByWidgetId, statement.targetId, statement.value)
    }
    if (statement.statementType === 'column') {
      pushListValue(columnsByWidgetId, statement.targetId, statement.value)
    }
  }

  const containerIds = new Set<string>([...pageIds, ...layoutIds])
  const refIds = new Set<string>([...pageIds, ...widgetMap.keys(), ...actionMap.keys()])

  for (const statement of doc.statements) {
    switch (statement.statementType) {
      case 'layout':
      case 'widget':
        if (!containerIds.has(statement.parentId)) {
          errors.push({
            message: `${statement.statementType} '${statement.id}' references unknown parent '${statement.parentId}'`,
            statementType: statement.statementType,
            id: statement.id,
          })
        }
        break
      case 'action': {
        if (!containerIds.has(statement.parentId)) {
          errors.push({
            message: `action '${statement.id}' references unknown parent '${statement.parentId}'`,
            statementType: 'action',
            id: statement.id,
          })
        }
        const actionKind = stringifyScalar(statement.attrs.kind ?? 'managed_crud')
        if (actionKind === 'managed_crud') {
          errors.push({
            message: `Warning: action '${statement.id}': kind=managed_crud is deprecated. Use create_record or update_record instead.`,
            severity: 'warning',
            statementType: 'action',
            id: statement.id,
          })
        }
        const sourceAttr = readStringAttr(statement.attrs.source)
        const formAttr = readStringAttr(statement.attrs.form)
        if ((actionKind === 'update_record' || actionKind === 'delete_selected') && !sourceAttr) {
          errors.push({
            message: `action '${statement.id}': kind=${actionKind} requires a source attribute`,
            statementType: 'action',
            id: statement.id,
          })
        }
        if (sourceAttr && !widgetMap.has(sourceAttr)) {
          errors.push({
            message: `action '${statement.id}': source '${sourceAttr}' is not a known widget`,
            statementType: 'action',
            id: statement.id,
          })
        }
        if ((actionKind === 'create_record' || actionKind === 'update_record') && !formAttr) {
          errors.push({
            message: `action '${statement.id}': kind=${actionKind} requires a form attribute`,
            statementType: 'action',
            id: statement.id,
          })
        }
        if (formAttr && (!widgetMap.has(formAttr) || widgetMap.get(formAttr)?.widgetType !== 'form')) {
          errors.push({
            message: `action '${statement.id}': form '${formAttr}' must reference a form widget`,
            statementType: 'action',
            id: statement.id,
          })
        }
        break
      }
      case 'field': {
        const target = widgetMap.get(statement.targetId)
        if (!target) {
          errors.push({ message: `field target '${statement.targetId}' not found`, statementType: 'field', id: statement.targetId })
        } else if (target.widgetType !== 'form') {
          errors.push({ message: `field target '${statement.targetId}' must be a form widget`, statementType: 'field', id: statement.targetId })
        }
        break
      }
      case 'column': {
        const target = widgetMap.get(statement.targetId)
        if (!target) {
          errors.push({ message: `column target '${statement.targetId}' not found`, statementType: 'column', id: statement.targetId })
        } else if (target.widgetType !== 'table') {
          errors.push({ message: `column target '${statement.targetId}' must be a table widget`, statementType: 'column', id: statement.targetId })
        }
        break
      }
      case 'option': {
        const target = widgetMap.get(statement.targetId)
        if (!target) {
          errors.push({ message: `option target '${statement.targetId}' not found`, statementType: 'option', id: statement.targetId })
        } else if (target.widgetType !== 'filter') {
          errors.push({ message: `option target '${statement.targetId}' must be a filter widget`, statementType: 'option', id: statement.targetId })
        }
        break
      }
      case 'bind':
        if (!refIds.has(statement.source.id)) {
          errors.push({ message: `bind source '${statement.source.id}' not found`, statementType: 'bind', id: statement.source.id })
        }
        if (!refIds.has(statement.target.id)) {
          errors.push({ message: `bind target '${statement.target.id}' not found`, statementType: 'bind', id: statement.target.id })
        }
        if (refIds.has(statement.source.id)) {
          const sourceError = validateSourceRef(statement.source, widgetMap, actionMap, pageIds, fieldsByWidgetId, columnsByWidgetId, { allowPage: false })
          if (sourceError) {
            errors.push({ message: sourceError, statementType: 'bind', id: statement.source.id })
          }
        }
        if (refIds.has(statement.target.id)) {
          const targetError = validateTargetRef(statement.target, widgetMap, actionMap, fieldsByWidgetId, columnsByWidgetId)
          if (targetError) {
            errors.push({ message: targetError, statementType: 'bind', id: statement.target.id })
          }
        }
        break
      case 'run':
        if (statement.source.id === 'page' && pageIds.size !== 1) {
          errors.push({
            message: `run source '${statement.source.id}.${statement.source.port}' requires exactly one declared page or an explicit page id`,
            statementType: 'run',
            id: statement.source.id,
          })
        }
        if (statement.source.id !== 'page' && !refIds.has(statement.source.id)) {
          errors.push({ message: `run source '${statement.source.id}' not found`, statementType: 'run', id: statement.source.id })
        }
        if (!actionMap.has(statement.targetId)) {
          errors.push({ message: `run target '${statement.targetId}' must be a declared action`, statementType: 'run', id: statement.targetId })
        }
        if (statement.source.id === 'page' || refIds.has(statement.source.id)) {
          const sourceError = validateSourceRef(resolvePageAliasRef(statement.source, pageIds), widgetMap, actionMap, pageIds, fieldsByWidgetId, columnsByWidgetId, { allowPage: true })
          if (sourceError) {
            errors.push({ message: sourceError, statementType: 'run', id: statement.source.id })
          }
        }
        break
      case 'effect':
        if (!refIds.has(statement.source.id)) {
          errors.push({ message: `effect source '${statement.source.id}' not found`, statementType: 'effect', id: statement.source.id })
        }
        if (!refIds.has(statement.target.id)) {
          errors.push({ message: `effect target '${statement.target.id}' not found`, statementType: 'effect', id: statement.target.id })
        }
        if (actionMap.has(statement.source.id)) {
          const sourceError = validateActionEventRef(statement.source)
          if (sourceError) {
            errors.push({ message: sourceError, statementType: 'effect', id: statement.source.id })
          }
        }
        if (refIds.has(statement.target.id)) {
          const targetError = validateTargetRef(statement.target, widgetMap, actionMap, fieldsByWidgetId, columnsByWidgetId)
          if (targetError) {
            errors.push({ message: targetError, statementType: 'effect', id: statement.target.id })
          }
        }
        break
      default:
        break
    }
  }

  return errors
}

export function lowerAuthoring(doc: AuraAuthoringDocument, options: AuraAuthoringCompileOptions = {}): AuraDocumentV2 {
  const authoringErrors = validateAuthoring(doc)
  const hardErrors = authoringErrors.filter((e) => !e.severity || e.severity === 'error')
  if (hardErrors.length > 0) {
    throw new Error(hardErrors.map((error) => error.message).join('; '))
  }

  const pageMap = new Map<string, AuraAuthoringPageStatement>()
  const layoutMap = new Map<string, AuraAuthoringLayoutStatement>()
  const widgetMap = new Map<string, AuraAuthoringWidgetStatement>()
  const actionMap = new Map<string, AuraAuthoringActionStatement>()
  const entityMap = new Map<string, AuraAuthoringEntityStatement>()
  const fieldsByWidgetId = new Map<string, string[]>()
  const columnsByWidgetId = new Map<string, string[]>()
  const optionsByWidgetId = new Map<string, Array<{ label: string; value: string }>>()
  const setStatementsByTargetId = new Map<string, AuraAuthoringSetStatement[]>()

  for (const statement of doc.statements) {
    switch (statement.statementType) {
      case 'page':
        pageMap.set(statement.id, statement)
        break
      case 'layout':
        layoutMap.set(statement.id, statement)
        break
      case 'widget':
        widgetMap.set(statement.id, statement)
        break
      case 'action':
        actionMap.set(statement.id, statement)
        break
      case 'entity':
        entityMap.set(statement.id, statement)
        break
      case 'field':
        pushListValue(fieldsByWidgetId, statement.targetId, statement.value)
        break
      case 'column':
        pushListValue(columnsByWidgetId, statement.targetId, statement.value)
        break
      case 'option':
        pushListValue(optionsByWidgetId, statement.targetId, {
          label: statement.value,
          value: stringifyScalar(statement.attrs.value ?? statement.value),
        })
        break
      case 'set':
        pushListValue(setStatementsByTargetId, statement.targetId, statement)
        break
      default:
        break
    }
  }

  const nodes: AuraNode[] = []

  for (const page of pageMap.values()) {
    const pageWith = attrsToStringMap(page.attrs, ['title'])
    pageWith.authoring_type = 'page'
    nodes.push({
      element: 'container',
      id: page.id,
      parentId: 'root',
      text: readStringAttr(page.attrs.title),
      with: pageWith,
      style: { gridX: '0', gridY: '0', gridW: '0', gridH: '0' },
    })
  }

  const widgetNodes: AuraNode[] = []
  const widgetPlacements = new Map<string, WidgetPlacement>()
  const widgetOrder: string[] = []
  for (const statement of doc.statements) {
    if (statement.statementType !== 'widget') continue

    const pageId = resolvePageId(statement.parentId, pageMap, layoutMap) ?? 'root'
    const withMap = attrsToStringMap(statement.attrs)
    const style: Record<string, string> = {}
    const text = extractWidgetText(statement.widgetType, withMap)

    const fields = fieldsByWidgetId.get(statement.id)
    if (statement.widgetType === 'form' && fields && fields.length > 0) {
      withMap.fields = fields.join(',')
    }
    const columns = columnsByWidgetId.get(statement.id)
    if (statement.widgetType === 'table' && columns && columns.length > 0) {
      withMap.columns = columns.join(',')
    }
    const options = optionsByWidgetId.get(statement.id)
    if (statement.widgetType === 'filter' && options && options.length > 0) {
      style.options = options.map((option) => option.value).join(',')
    }

    applySetStatements(setStatementsByTargetId.get(statement.id) ?? [], withMap, style)
    const placement = resolveWidgetPlacement(statement.parentId, pageMap, layoutMap)
    style.layout_area = placement.area
    if (placement.span !== undefined) {
      style.layout_span = String(placement.span)
    }

    widgetPlacements.set(statement.id, placement)
    widgetOrder.push(statement.id)
    widgetNodes.push({
      element: statement.widgetType,
      id: statement.id,
      parentId: pageId,
      text,
      with: Object.keys(withMap).length > 0 ? withMap : undefined,
      style,
    })
  }

  applyWidgetGrid(widgetNodes, widgetOrder, widgetPlacements)
  nodes.push(...widgetNodes)
  const widgetNodeMap = new Map(widgetNodes.map((node) => [node.id, node]))

  const syntheticEdges: Array<{
    source: { nodeId: string; port: string }
    target: { nodeId: string; port: string }
    edgeType: AuraEdge['edgeType']
  }> = []

  let actionIndex = 0
  for (const statement of doc.statements) {
    if (statement.statementType !== 'action') continue

    const pageId = resolvePageId(statement.parentId, pageMap, layoutMap) ?? 'root'
    const withMap = attrsToStringMap(statement.attrs)
    const style: Record<string, string> = {
      flowX: '450',
      flowY: String(80 + (actionIndex * 140)),
    }

    const entityId = readAuthoringActionEntityId(statement)
    if (entityId) {
      const entity = entityMap.get(entityId)
      if (entity) {
        for (const [key, value] of Object.entries(entity.attrs)) {
          if (withMap[key] === undefined) {
            withMap[key] = stringifyScalar(value)
          }
        }
      }
    }

    applySetStatements(setStatementsByTargetId.get(statement.id) ?? [], withMap, style)
    if (lowerActionElement(statement) === 'step:query') {
      lowerQueryAuthoringAction(statement, withMap, widgetNodeMap, columnsByWidgetId, syntheticEdges, options)
    }
    const actionKind = stringifyScalar(statement.attrs.kind ?? 'managed_crud')
    if (actionKind === 'create_record' || actionKind === 'update_record' || actionKind === 'delete_selected') {
      lowerMutationAuthoringAction(statement, withMap, syntheticEdges)
    }
    nodes.push({
      element: lowerActionElement(statement),
      id: statement.id,
      parentId: pageId,
      text: titleCaseId(statement.id),
      with: withMap,
      style,
    })
    actionIndex++
  }

  const edges: AuraEdge[] = []
  const edgeIds = new Set<string>()
  for (const statement of doc.statements) {
    switch (statement.statementType) {
      case 'bind': {
        const source = lowerRef(statement.source, 'source', widgetMap, actionMap)
        const target = lowerRef(statement.target, 'target', widgetMap, actionMap)
        const edgeType = actionMap.has(statement.target.id) ? 'binding' : 'reactive'
        addEdge(edges, edgeIds, source, target, edgeType)
        break
      }
      case 'run': {
        const source = lowerRef(resolvePageAliasRef(statement.source, pageMap.keys()), 'source', widgetMap, actionMap)
        addEdge(edges, edgeIds, source, { nodeId: statement.targetId, port: 'run' }, 'async')
        break
      }
      case 'effect': {
        const source = lowerRef(statement.source, 'source', widgetMap, actionMap)
        const target = lowerRef(statement.target, 'target', widgetMap, actionMap)
        const edgeType = actionMap.has(statement.target.id) ? 'async' : 'reactive'
        addEdge(edges, edgeIds, source, target, edgeType)
        break
      }
      default:
        break
    }
  }

  for (const syntheticEdge of syntheticEdges) {
    addEdge(edges, edgeIds, syntheticEdge.source, syntheticEdge.target, syntheticEdge.edgeType)
  }

  return { nodes, edges }
}

export function compileAuthoring(source: string, options: AuraAuthoringCompileOptions = {}): AuraDocumentV2 {
  return lowerAuthoring(parseAuthoring(source), options)
}

function repairAuthoringCommonSyntax(source: string): string {
  if (!source.trim()) return source

  const rawLines = source.split(/\r?\n/)
  const repaired: string[] = []

  for (let index = 0; index < rawLines.length; index++) {
    const trimmed = rawLines[index].trim()
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) {
      repaired.push(rawLines[index])
      continue
    }

    if (isStandaloneAuthoringWithLine(trimmed)) {
      const mergeTargetIndex = findAuthoringWithMergeTargetIndex(repaired)
      if (mergeTargetIndex >= 0) {
        const payloadParts: string[] = []
        const inlinePayload = trimmed.slice('with'.length).trim()
        if (inlinePayload) payloadParts.push(inlinePayload)

        while (index + 1 < rawLines.length) {
          const nextLine = rawLines[index + 1].trim()
          if (!nextLine || nextLine === '---' || nextLine.startsWith('#')) break
          const nextTokens = tokenizeAuthoringLine(nextLine)
          if (nextTokens.length > 0 && AUTHORING_KEYWORDS.has(nextTokens[0])) break
          if (isStandaloneAuthoringWithLine(nextLine)) break
          payloadParts.push(nextLine)
          index += 1
        }

        if (payloadParts.length > 0) {
          repaired[mergeTargetIndex] = `${repaired[mergeTargetIndex].trim()} ${payloadParts.join(' ')}`
          continue
        }
      }
    }

    repaired.push(rawLines[index])
  }

  return repaired.join('\n')
}

function isStandaloneAuthoringWithLine(line: string): boolean {
  return line === 'with' || line.startsWith('with ') || line.startsWith('with\t')
}

function findAuthoringWithMergeTargetIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue
    const tokens = tokenizeAuthoringLine(trimmed)
    if (tokens.length > 0 && AUTHORING_WITH_MERGE_KEYWORDS.has(tokens[0])) {
      return index
    }
    break
  }
  return -1
}

function parseAuthoringLine(line: string): AuraAuthoringStatement {
  const tokens = tokenizeAuthoringLine(line)
  if (tokens.length === 0) {
    throw new AuraAuthoringParseError('empty authoring line')
  }

  switch (tokens[0]) {
    case 'app':
      return { statementType: 'app', id: expectToken(tokens, 1, 'app'), attrs: parseAttrTokens(tokens, 2) }
    case 'entity':
      return { statementType: 'entity', id: expectToken(tokens, 1, 'entity'), attrs: parseAttrTokens(tokens, 2) }
    case 'page':
      return { statementType: 'page', id: expectToken(tokens, 1, 'page'), attrs: parseAttrTokens(tokens, 2) }
    case 'stack':
    case 'grid':
    case 'slot':
      return parseParentedStatement(tokens, 'layout')
    case 'widget':
      return parseWidgetStatement(tokens)
    case 'field':
      return parseValueStatement(tokens, 'field')
    case 'column':
      return parseValueStatement(tokens, 'column')
    case 'option':
      return parseValueStatement(tokens, 'option')
    case 'action':
      return parseParentedStatement(tokens, 'action')
    case 'bind':
      return parseRefEdgeStatement(tokens, 'bind')
    case 'run':
      return parseRunStatement(tokens)
    case 'effect':
      return parseRefEdgeStatement(tokens, 'effect')
    case 'set':
      return parseSetStatement(tokens)
    case 'note':
      return parseNoteStatement(tokens)
    default:
      throw new AuraAuthoringParseError(`unknown authoring keyword '${tokens[0]}'`)
  }
}

function parseParentedStatement(
  tokens: string[],
  statementType: 'layout' | 'action',
): AuraAuthoringLayoutStatement | AuraAuthoringActionStatement {
  const keyword = tokens[0]
  const id = expectToken(tokens, 1, keyword)
  if (tokens[2] !== '@') {
    throw new AuraAuthoringParseError(`${keyword} '${id}' must include '@ parentId'`)
  }
  const parentId = expectToken(tokens, 3, keyword)
  const attrs = parseAttrTokens(tokens, 4)
  if (statementType === 'layout') {
    return {
      statementType,
      layoutType: keyword as AuraAuthoringLayoutStatement['layoutType'],
      id,
      parentId,
      attrs,
    }
  }
  return { statementType, id, parentId, attrs }
}

function parseWidgetStatement(tokens: string[]): AuraAuthoringWidgetStatement {
  let widgetType = expectToken(tokens, 1, 'widget')
  let id = expectToken(tokens, 2, 'widget')
  let parentTokenIndex = 3

  if (widgetType.startsWith('type=')) {
    widgetType = decodeInlineToken(widgetType.slice('type='.length))
    id = expectToken(tokens, 3, 'widget')
    parentTokenIndex = 4
  } else if (id.startsWith('type=')) {
    const declaredType = decodeInlineToken(id.slice('type='.length))
    if (!AUTHORING_WIDGET_TYPES.has(declaredType)) {
      throw new AuraAuthoringParseError(`unknown widget type '${declaredType}'`)
    }
    widgetType = declaredType
    id = expectToken(tokens, 3, 'widget')
    parentTokenIndex = 4
  }

  if (!AUTHORING_WIDGET_TYPES.has(widgetType)) {
    throw new AuraAuthoringParseError(`unknown widget type '${widgetType}'`)
  }
  if (tokens[parentTokenIndex] !== '@') {
    throw new AuraAuthoringParseError(`widget '${id}' must include '@ parentId'`)
  }
  return {
    statementType: 'widget',
    widgetType,
    id,
    parentId: expectToken(tokens, parentTokenIndex + 1, 'widget'),
    attrs: parseAttrTokens(tokens, parentTokenIndex + 2),
  }
}

function parseValueStatement(
  tokens: string[],
  statementType: 'field' | 'column' | 'option',
): AuraAuthoringFieldStatement | AuraAuthoringColumnStatement | AuraAuthoringOptionStatement {
  return {
    statementType,
    targetId: expectToken(tokens, 1, statementType),
    value: decodeInlineToken(expectToken(tokens, 2, statementType)),
    attrs: parseAttrTokens(tokens, 3),
  } as AuraAuthoringFieldStatement | AuraAuthoringColumnStatement | AuraAuthoringOptionStatement
}

function parseRefEdgeStatement(
  tokens: string[],
  statementType: 'bind' | 'effect',
): AuraAuthoringBindStatement | AuraAuthoringEffectStatement {
  if (tokens[2] !== '->') {
    throw new AuraAuthoringParseError(`${statementType} must include '->'`)
  }
  return {
    statementType,
    source: parseAuthoringRef(expectToken(tokens, 1, statementType)),
    target: parseAuthoringRef(expectToken(tokens, 3, statementType)),
    attrs: parseAttrTokens(tokens, 4),
  } as AuraAuthoringBindStatement | AuraAuthoringEffectStatement
}

function parseRunStatement(tokens: string[]): AuraAuthoringRunStatement {
  if (tokens[2] !== '->') {
    throw new AuraAuthoringParseError(`run must include '->'`)
  }
  return {
    statementType: 'run',
    source: parseAuthoringRef(expectToken(tokens, 1, 'run')),
    targetId: expectToken(tokens, 3, 'run'),
    attrs: parseAttrTokens(tokens, 4),
  }
}

function parseSetStatement(tokens: string[]): AuraAuthoringSetStatement {
  const targetId = expectToken(tokens, 1, 'set')
  const attrs = parseAttrTokens(tokens, 2)
  const [key, value] = Object.entries(attrs)[0] ?? []
  if (!key) {
    throw new AuraAuthoringParseError(`set '${targetId}' must include a key=value pair`)
  }
  return { statementType: 'set', targetId, key, value }
}

function parseNoteStatement(tokens: string[]): AuraAuthoringNoteStatement {
  return {
    statementType: 'note',
    id: expectToken(tokens, 1, 'note'),
    text: decodeInlineToken(tokens.slice(2).join(' ')),
  }
}

function tokenizeAuthoringLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of line) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      current += char
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function parseAttrTokens(tokens: string[], startIndex: number): AuraAuthoringAttrs {
  const attrs: AuraAuthoringAttrs = {}
  for (let index = startIndex; index < tokens.length; index++) {
    const token = tokens[index]
    const eqIndex = token.indexOf('=')
    if (eqIndex === -1) {
      throw new AuraAuthoringParseError(`expected key=value token, got '${token}'`)
    }
    attrs[token.slice(0, eqIndex)] = parseScalarToken(token.slice(eqIndex + 1))
  }
  return attrs
}

function parseAuthoringRef(raw: string): AuraAuthoringRef {
  const dotIndex = raw.indexOf('.')
  if (dotIndex <= 0 || dotIndex === raw.length - 1) {
    throw new AuraAuthoringParseError(`expected ref in the form id.port, got '${raw}'`)
  }
  return { id: raw.slice(0, dotIndex), port: raw.slice(dotIndex + 1) }
}

function parseScalarToken(raw: string): AuraAuthoringScalar {
  const decoded = decodeInlineToken(raw)
  if (decoded === 'true') return true
  if (decoded === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(decoded)) return Number(decoded)
  return decoded
}

function decodeInlineToken(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw)
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
  }
  return raw
}

function expectToken(tokens: string[], index: number, keyword: string): string {
  const token = tokens[index]
  if (!token) throw new AuraAuthoringParseError(`${keyword} is missing required tokens`)
  return token
}

function hasStatementId(statement: AuraAuthoringStatement): statement is AuraAuthoringAppStatement | AuraAuthoringEntityStatement | AuraAuthoringPageStatement | AuraAuthoringLayoutStatement | AuraAuthoringWidgetStatement | AuraAuthoringActionStatement | AuraAuthoringNoteStatement {
  return 'id' in statement
}

function validateSourceRef(
  ref: AuraAuthoringRef,
  widgetMap: Map<string, AuraAuthoringWidgetStatement>,
  actionMap: Map<string, AuraAuthoringActionStatement>,
  pageIds: Set<string>,
  fieldsByWidgetId: Map<string, string[]>,
  columnsByWidgetId: Map<string, string[]>,
  options: { allowPage: boolean },
): string | null {
  if (pageIds.has(ref.id)) {
    if (!options.allowPage) {
      return `ref '${ref.id}.${ref.port}' cannot use a page as a value source`
    }
    if (!AUTHORING_PAGE_SOURCE_EVENTS.has(ref.port)) {
      return `page source '${ref.id}.${ref.port}' must use one of: ${Array.from(AUTHORING_PAGE_SOURCE_EVENTS).join(', ')}`
    }
    return null
  }
  if (actionMap.has(ref.id)) {
    return validateActionEventRef(ref)
  }
  const widget = widgetMap.get(ref.id)
  if (!widget) return null
  if (!isValidWidgetSourcePort(widget, ref.port, fieldsByWidgetId, columnsByWidgetId)) {
    return `widget source '${ref.id}.${ref.port}' is not valid for widget type '${widget.widgetType}'`
  }
  return null
}

function validateTargetRef(
  ref: AuraAuthoringRef,
  widgetMap: Map<string, AuraAuthoringWidgetStatement>,
  actionMap: Map<string, AuraAuthoringActionStatement>,
  fieldsByWidgetId: Map<string, string[]>,
  columnsByWidgetId: Map<string, string[]>,
): string | null {
  if (actionMap.has(ref.id)) {
    return isValidActionTargetPort(ref.port)
      ? null
      : `action target '${ref.id}.${ref.port}' must be 'run' or a params-like input such as record_id or params.record_id`
  }
  const widget = widgetMap.get(ref.id)
  if (!widget) return null
  if (!isValidWidgetTargetPort(widget, ref.port, fieldsByWidgetId, columnsByWidgetId)) {
    return `widget target '${ref.id}.${ref.port}' is not valid for widget type '${widget.widgetType}'`
  }
  return null
}

function validateActionEventRef(ref: AuraAuthoringRef): string | null {
  if (!AUTHORING_ACTION_SOURCE_EVENTS.has(ref.port)) {
    return `action event '${ref.id}.${ref.port}' must use one of: ${Array.from(AUTHORING_ACTION_SOURCE_EVENTS).join(', ')}`
  }
  return null
}

function isValidWidgetSourcePort(
  widget: AuraAuthoringWidgetStatement,
  port: string,
  fieldsByWidgetId: Map<string, string[]>,
  columnsByWidgetId: Map<string, string[]>,
): boolean {
  switch (widget.widgetType) {
    case 'form': {
      if (port === 'submitted' || port === 'values') return true
      return (fieldsByWidgetId.get(widget.id) ?? []).includes(port)
    }
    case 'table':
      return port === 'rows'
        || port === 'selected_row'
        || port === 'selected_row_index'
        || matchesDynamicFieldPort(port, 'selected_row.', columnsByWidgetId.get(widget.id) ?? [])
    case 'button':
      return port === 'clicked' || port === 'clicked_at'
    case 'filter':
      return port === 'value' || port === 'selected_value'
    case 'chart':
      return port === 'selected_point' || port.startsWith('selected_point.')
    case 'kpi':
      return port === 'value'
    case 'text':
    case 'markdown':
      return port === 'content'
    case 'modal':
      return port === 'closed'
    case 'tabs':
      return port === 'active_tab' || port === 'active_tab_index'
    default:
      return false
  }
}

function isValidWidgetTargetPort(
  widget: AuraAuthoringWidgetStatement,
  port: string,
  fieldsByWidgetId: Map<string, string[]>,
  columnsByWidgetId: Map<string, string[]>,
): boolean {
  switch (widget.widgetType) {
    case 'form':
      return port === 'values'
        || port === 'reset'
        || matchesDynamicFieldPort(port, 'values.', fieldsByWidgetId.get(widget.id) ?? [])
    case 'table':
      return port === 'refresh'
        || port === 'rows'
        || matchesDynamicFieldPort(port, 'filter.', columnsByWidgetId.get(widget.id) ?? [])
    case 'chart':
      return port === 'refresh' || matchesDynamicFieldPort(port, 'filter.', [])
    case 'button':
      return port === 'disabled' || port === 'label'
    case 'text':
    case 'markdown':
      return port === 'content'
    case 'filter':
      return port === 'value'
    case 'kpi':
      return port === 'value'
    case 'modal':
      return port === 'open' || port === 'close'
    case 'tabs':
      return port === 'active_tab'
    default:
      return false
  }
}

function matchesDynamicFieldPort(port: string, prefix: string, knownFields: string[]): boolean {
  if (!port.startsWith(prefix)) return false
  const field = port.slice(prefix.length)
  if (!field) return false
  return knownFields.length === 0 || knownFields.includes(field)
}

function isValidActionTargetPort(port: string): boolean {
  return port === 'run' || /^(params\.)?[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(port)
}

function pushListValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const next = map.get(key) ?? []
  next.push(value)
  map.set(key, next)
}

function attrsToStringMap(attrs: AuraAuthoringAttrs, omitKeys: string[] = []): Record<string, string> {
  const omit = new Set(omitKeys)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (omit.has(key)) continue
    out[key] = stringifyScalar(value)
  }
  return out
}

function stringifyScalar(value: AuraAuthoringScalar): string {
  return typeof value === 'string' ? value : String(value)
}

function readStringAttr(value: AuraAuthoringScalar | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readAuthoringActionEntityId(statement: AuraAuthoringActionStatement): string | undefined {
  return readStringAttr(statement.attrs.entity) ?? readStringAttr(statement.attrs.source)
}

function resolveAuthoringQueryConnector(
  connectors: AuraAuthoringCompileConnector[],
  withMap: Record<string, string>,
  entityId: string | undefined,
): AuraAuthoringCompileConnector | undefined {
  if (connectors.length === 0) return undefined

  const connectorId = withMap.connector_id?.trim() || withMap.connector?.trim()
  const connectorType = withMap.connectorType?.trim() || withMap.connector_type?.trim()
  if (connectorId) {
    const exact = connectors.find((connector) => connector.id === connectorId)
    if (exact && (!connectorType || !exact.type || exact.type === connectorType)) {
      return exact
    }
  }

  const hints = [connectorId, entityId, withMap.table, withMap.source_table]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))

  for (const hint of hints) {
    const normalizedHint = normalizeAuthoringConnectorHint(hint)
    const match = connectors.find((connector) => {
      if (connectorType && connector.type && connector.type !== connectorType) return false
      return [connector.id, connector.name]
        .filter((value): value is string => Boolean(value))
        .some((value) => normalizeAuthoringConnectorHint(value) === normalizedHint)
    })
    if (match) return match
  }

  if (connectorType) {
    const typedMatches = connectors.filter((connector) => !connector.type || connector.type === connectorType)
    if (typedMatches.length === 1) return typedMatches[0]
  }

  if (connectors.length === 1) {
    const [onlyConnector] = connectors
    if (!connectorType || !onlyConnector.type || onlyConnector.type === connectorType) {
      return onlyConnector
    }
  }

  return undefined
}

function normalizeAuthoringConnectorHint(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function resolvePageAliasRef(
  ref: AuraAuthoringRef,
  pageIds: Iterable<string>,
): AuraAuthoringRef {
  if (ref.id !== 'page') return ref
  const [pageId] = Array.from(pageIds)
  return pageId ? { id: pageId, port: ref.port } : ref
}

function lowerQueryAuthoringAction(
  statement: AuraAuthoringActionStatement,
  withMap: Record<string, string>,
  widgetNodeMap: Map<string, AuraNode>,
  columnsByWidgetId: Map<string, string[]>,
  syntheticEdges: Array<{
    source: { nodeId: string; port: string }
    target: { nodeId: string; port: string }
    edgeType: AuraEdge['edgeType']
  }>,
  options: AuraAuthoringCompileOptions,
): void {
  const resolvedConnector = resolveAuthoringQueryConnector(
    options.connectors ?? [],
    withMap,
    readAuthoringActionEntityId(statement),
  )

  if (withMap.connector_id === undefined && resolvedConnector?.id) {
    withMap.connector_id = resolvedConnector.id
  }
  if (withMap.connector_id === undefined && withMap.connector !== undefined) {
    withMap.connector_id = withMap.connector
  }
  if (withMap.connectorType === undefined && resolvedConnector?.type) {
    withMap.connectorType = resolvedConnector.type
  }
  if (withMap.connectorType === undefined && withMap.connector_type !== undefined) {
    withMap.connectorType = withMap.connector_type
  }

  const targetId = readStringAttr(statement.attrs.target)
  if (!targetId) return

  const targetNode = widgetNodeMap.get(targetId)
  if (!targetNode) return

  const widgetWith: Record<string, string> = { ...(targetNode.with ?? {}), queryAction: statement.id }
  targetNode.with = widgetWith

  const availableColumns = mergeAuthoringColumns(
    columnsByWidgetId.get(targetId) ?? [],
    splitAuthoringCSV(withMap.resultColumns),
    resolvedConnector?.columns ?? [],
  )
  if (withMap.resultColumns === undefined && availableColumns.length > 0) {
    withMap.resultColumns = availableColumns.join(',')
  }
  if (withMap.sql === undefined) {
    const defaultSql = defaultAuthoringQuerySQL(
      withMap.connectorType,
      withMap.table ?? withMap.source_table ?? withMap.connector ?? readStringAttr(statement.attrs.source) ?? readStringAttr(statement.attrs.entity),
      splitAuthoringCSV(withMap.resultColumns),
    )
    if (defaultSql !== undefined) {
      withMap.sql = defaultSql
    }
  }

  if (targetNode.element === 'table') {
    syntheticEdges.push({
      source: { nodeId: statement.id, port: 'rows' },
      target: { nodeId: targetId, port: 'setRows' },
      edgeType: 'reactive',
    })
    return
  }

  if (targetNode.element === 'chart') {
    const inferred = inferAuthoringQueryChartColumns(withMap.profile, splitAuthoringCSV(withMap.resultColumns))
    if (widgetWith.labelCol === undefined && inferred.labelCol) {
      widgetWith.labelCol = inferred.labelCol
    }
    if (widgetWith.valueCol === undefined && inferred.valueCol) {
      widgetWith.valueCol = inferred.valueCol
    }
    if (widgetWith.aggregate === undefined && withMap.profile === 'time_series') {
      widgetWith.aggregate = 'sum'
    }
    syntheticEdges.push({
      source: { nodeId: statement.id, port: 'rows' },
      target: { nodeId: targetId, port: 'setData' },
      edgeType: 'reactive',
    })
  }
}

function lowerMutationAuthoringAction(
  statement: AuraAuthoringActionStatement,
  withMap: Record<string, string>,
  syntheticEdges: Array<{
    source: { nodeId: string; port: string }
    target: { nodeId: string; port: string }
    edgeType: AuraEdge['edgeType']
  }>,
): void {
  const kind = stringifyScalar(statement.attrs.kind ?? 'managed_crud')
  const sourceId = readStringAttr(statement.attrs.source)
  const formId = readStringAttr(statement.attrs.form)

  if (kind === 'create_record') {
    if (withMap.operation === undefined) withMap.operation = 'insert'
    if (formId) {
      syntheticEdges.push({
        source: { nodeId: formId, port: 'submitted' },
        target: { nodeId: statement.id, port: 'bind:values' },
        edgeType: 'binding',
      })
    }
    return
  }

  if (kind === 'update_record') {
    if (withMap.operation === undefined) withMap.operation = 'update'
    if (sourceId) {
      syntheticEdges.push({
        source: { nodeId: sourceId, port: 'selectedRow' },
        target: { nodeId: statement.id, port: 'bind:where:0' },
        edgeType: 'binding',
      })
    }
    if (formId) {
      syntheticEdges.push({
        source: { nodeId: formId, port: 'submitted' },
        target: { nodeId: statement.id, port: 'bind:values' },
        edgeType: 'binding',
      })
    }
    return
  }

  if (kind === 'delete_selected') {
    if (withMap.operation === undefined) withMap.operation = 'delete'
    if (sourceId) {
      syntheticEdges.push({
        source: { nodeId: sourceId, port: 'selectedRow' },
        target: { nodeId: statement.id, port: 'bind:where:0' },
        edgeType: 'binding',
      })
    }
    return
  }
}

function mergeAuthoringColumns(...groups: string[][]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const group of groups) {
    for (const column of group) {
      const normalized = column.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      merged.push(normalized)
    }
  }
  return merged
}

function splitAuthoringCSV(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function defaultAuthoringQuerySQL(
  connectorType: string | undefined,
  tableHint: string | undefined,
  preferredColumns: string[],
): string | undefined {
  const normalizedType = connectorType?.trim()
  if (!normalizedType) return undefined
  if (normalizedType === 'managed') return ''
  if (normalizedType === 'csv') {
    const selectList = authoringQuerySelectList(preferredColumns)
    return selectList === '*'
      ? 'SELECT * FROM csv'
      : `SELECT ${selectList} FROM csv`
  }
  if (normalizedType === 'rest') return '/'
  if (normalizedType === 'postgres' || normalizedType === 'mysql' || normalizedType === 'mssql') {
    const tableName = authoringQueryIdentifier(tableHint)
    if (!tableName) return undefined
    return `SELECT ${authoringQuerySelectList(preferredColumns)} FROM ${tableName}`
  }
  return undefined
}

function authoringQuerySelectList(columns: string[]): string {
  const normalized = columns
    .map(authoringQueryIdentifier)
    .filter((value): value is string => Boolean(value))
  if (normalized.length === 0 || normalized.length !== columns.length) return '*'
  return normalized.join(', ')
}

function authoringQueryIdentifier(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]
    const isAlpha = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
    const isDigit = char >= '0' && char <= '9'
    if (isAlpha || char === '_' || (index > 0 && isDigit)) continue
    return undefined
  }
  return trimmed
}

function inferAuthoringQueryChartColumns(
  profile: string | undefined,
  columns: string[],
): { labelCol?: string; valueCol?: string } {
  const timePatterns = ['date', 'month', 'time', 'day', 'week', 'year', 'period', 'created', 'updated']
  const labelPatterns = ['name', 'label', 'status', 'category', 'type']
  const valuePatterns = ['amount', 'revenue', 'total', 'value', 'count', 'sum', 'sales', 'price', 'cost', 'qty', 'quantity', 'score']
  const orderedLabelPatterns = profile?.trim() === 'time_series'
    ? [...timePatterns, ...labelPatterns]
    : labelPatterns

  const labelCol = columns.find(column => orderedLabelPatterns.some(pattern => column.toLowerCase().includes(pattern))) ?? columns[0]
  const valueCol = columns.find(column => column !== labelCol && valuePatterns.some(pattern => column.toLowerCase().includes(pattern)))
    ?? columns.find(column => column !== labelCol)
    ?? labelCol

  return { labelCol, valueCol }
}

function extractWidgetText(widgetType: string, withMap: Record<string, string>): string | undefined {
  const preferredKey = widgetType === 'button'
    ? 'label'
    : widgetType === 'text' || widgetType === 'markdown'
      ? 'content'
      : 'title'
  const text = withMap[preferredKey] ?? withMap.title ?? withMap.label
  delete withMap.title
  delete withMap.label
  if (widgetType === 'text' || widgetType === 'markdown') {
    delete withMap.content
  }
  return text
}

function resolvePageId(
  parentId: string,
  pageMap: Map<string, AuraAuthoringPageStatement>,
  layoutMap: Map<string, AuraAuthoringLayoutStatement>,
): string | undefined {
  let currentId: string | undefined = parentId
  while (currentId) {
    if (pageMap.has(currentId)) return currentId
    const layout = layoutMap.get(currentId)
    if (!layout) return undefined
    currentId = layout.parentId
  }
  return undefined
}

function resolveWidgetPlacement(
  parentId: string,
  pageMap: Map<string, AuraAuthoringPageStatement>,
  layoutMap: Map<string, AuraAuthoringLayoutStatement>,
): WidgetPlacement {
  let currentId: string | undefined = parentId
  while (currentId) {
    const layout = layoutMap.get(currentId)
    if (!layout) {
      if (pageMap.has(currentId)) break
      return { area: 'main' }
    }
    if (layout.layoutType === 'slot') {
      const area = normalizeArea(readStringAttr(layout.attrs.area) ?? inferAreaFromSlotId(layout.id))
      const span = typeof layout.attrs.span === 'number'
        ? layout.attrs.span
        : typeof layout.attrs.span === 'string' && /^\d+$/.test(layout.attrs.span)
          ? Number(layout.attrs.span)
          : undefined
      return { area, span }
    }
    currentId = layout.parentId
  }
  return { area: 'main' }
}

function normalizeArea(raw: string): WidgetArea {
  switch (raw) {
    case 'header':
    case 'sidebar':
    case 'footer':
      return raw
    case 'content':
    case 'main':
    default:
      return 'main'
  }
}

function inferAreaFromSlotId(id: string): string {
  if (id.includes('sidebar')) return 'sidebar'
  if (id.includes('header')) return 'header'
  if (id.includes('footer')) return 'footer'
  if (id.includes('content')) return 'content'
  return 'main'
}

function applySetStatements(
  setStatements: AuraAuthoringSetStatement[],
  withMap: Record<string, string>,
  style: Record<string, string>,
): void {
  for (const statement of setStatements) {
    if (statement.key.startsWith('style.')) {
      style[statement.key.slice(6)] = stringifyScalar(statement.value)
      continue
    }
    withMap[statement.key] = stringifyScalar(statement.value)
  }
}

function applyWidgetGrid(nodes: AuraNode[], widgetOrder: string[], placements: Map<string, WidgetPlacement>): void {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))

  let headerBottom = 0
  for (const nodeId of widgetOrder) {
    const node = nodeMap.get(nodeId)
    const placement = placements.get(nodeId)
    if (!node || !placement || placement.area !== 'header') continue
    const height = defaultWidgetHeight(node.element)
    node.style = { ...node.style, gridX: '0', gridY: String(headerBottom), gridW: '12', gridH: String(height) }
    headerBottom += height
  }

  let mainY = headerBottom
  let sidebarY = headerBottom
  for (const nodeId of widgetOrder) {
    const node = nodeMap.get(nodeId)
    const placement = placements.get(nodeId)
    if (!node || !placement || (placement.area !== 'main' && placement.area !== 'sidebar')) continue
    const height = defaultWidgetHeight(node.element)
    if (placement.area === 'sidebar') {
      node.style = { ...node.style, gridX: '9', gridY: String(sidebarY), gridW: '3', gridH: String(height) }
      sidebarY += height
      continue
    }
    const span = Math.min(9, Math.max(1, placement.span ?? 9))
    node.style = { ...node.style, gridX: '0', gridY: String(mainY), gridW: String(span), gridH: String(height) }
    mainY += height
  }

  let footerY = Math.max(mainY, sidebarY)
  for (const nodeId of widgetOrder) {
    const node = nodeMap.get(nodeId)
    const placement = placements.get(nodeId)
    if (!node || !placement || placement.area !== 'footer') continue
    const height = defaultWidgetHeight(node.element)
    node.style = { ...node.style, gridX: '0', gridY: String(footerY), gridW: '12', gridH: String(height) }
    footerY += height
  }
}

function defaultWidgetHeight(element: string): number {
  switch (element) {
    case 'button':
    case 'text':
    case 'filter':
    case 'kpi':
      return 2
    case 'form':
    case 'table':
    case 'chart':
    case 'markdown':
      return 4
    default:
      return 3
  }
}

function lowerActionElement(statement: AuraAuthoringActionStatement): AuraNode['element'] {
  return AUTHORING_ACTION_KIND_TO_STEP[stringifyScalar(statement.attrs.kind ?? 'managed_crud')] ?? 'step:transform'
}

function lowerRef(
  ref: AuraAuthoringRef,
  side: 'source' | 'target',
  widgetMap: Map<string, AuraAuthoringWidgetStatement>,
  actionMap: Map<string, AuraAuthoringActionStatement>,
): { nodeId: string; port: string } {
  if (actionMap.has(ref.id)) {
    return {
      nodeId: ref.id,
      port: side === 'source'
        ? lowerActionSourcePort(ref.port, actionMap.get(ref.id)!)
        : lowerActionTargetPort(ref.port),
    }
  }
  if (widgetMap.has(ref.id)) {
    return {
      nodeId: ref.id,
      port: side === 'source' ? lowerWidgetSourcePort(ref.port) : lowerWidgetTargetPort(ref.port),
    }
  }
  return { nodeId: ref.id, port: ref.port }
}

function lowerWidgetSourcePort(port: string): string {
  if (port === 'selected_row') return 'selectedRow'
  if (port.startsWith('selected_row.')) return `selectedRow.${port.slice('selected_row.'.length)}`
  if (port === 'selected_row_index') return 'selectedRowIndex'
  if (port === 'clicked_at') return 'clickedAt'
  return port
}

function lowerWidgetTargetPort(port: string): string {
  if (port === 'values') return 'setValues'
  if (port.startsWith('values.')) return `setValues.${port.slice('values.'.length)}`
  if (port === 'content') return 'setContent'
  if (port === 'disabled') return 'setDisabled'
  if (port === 'label') return 'setLabel'
  if (port === 'value') return 'setValue'
  if (port === 'rows') return 'setRows'
  if (port.startsWith('filter.')) return `setFilter.${port.slice('filter.'.length)}`
  return port
}

function lowerActionSourcePort(port: string, statement: AuraAuthoringActionStatement): string {
  const element = lowerActionElement(statement)
  switch (port) {
    case 'success':
    case 'done':
      if (element === 'step:http') return 'ok'
      if (element === 'step:approval_gate') return 'approved'
      if (element === 'step:notification') return 'sent'
      return 'result'
    case 'error':
      if (element === 'step:http') return 'error'
      if (element === 'step:approval_gate') return 'rejected'
      if (element === 'step:notification') return 'failed'
      return 'result'
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    default:
      return lowerWidgetSourcePort(port)
  }
}

function lowerActionTargetPort(port: string): string {
  if (port === 'run') return 'run'
  if (port.startsWith('params.')) return port
  return `params.${port}`
}

function addEdge(
  edges: AuraEdge[],
  edgeIds: Set<string>,
  source: { nodeId: string; port: string },
  target: { nodeId: string; port: string },
  edgeType: AuraEdge['edgeType'],
): void {
  const id = `e_${source.nodeId}_${source.port}_${target.nodeId}_${target.port}`
  if (edgeIds.has(id)) return
  edgeIds.add(id)
  edges.push({
    id,
    fromNodeId: source.nodeId,
    fromPort: source.port,
    toNodeId: target.nodeId,
    toPort: target.port,
    edgeType,
  })
}

function titleCaseId(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}