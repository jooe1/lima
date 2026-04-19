/**
 * Aura DSL — canonical app source format for Lima.
 *
 * Syntax (flat, streaming-friendly, one statement per widget):
 *
 *   <element> <id> @ <parentId>
 *     text "Label"
 *     value "{{query.rows}}"
 *     forEach items key id
 *     if "{{user.isAdmin}}"
 *     with connector="pg-main"
 *     transform "row => ({ id: row.id, name: row.name })"
 *     action wf-abc-123
 *     style { width: "100%"; padding: "16px" }
 *   ;
 *
 * Rules:
 * - Every statement ends with `;`
 * - `@` is required; use `@root` for top-level widgets
 * - Clause order is fixed: text → value → forEach → key → if → with → transform → action → formRef → formFields → style
 * - No nested child blocks — parent/child is expressed through parentId references
 *
 * Button → Form attachment:
 * - `formRef <formId>` on a button node attaches the button to a form widget.
 *   At runtime the button reads that form's validated field values as its workflow payload.
 * - `formFields "field1,field2"` narrows which fields are submitted; omit or leave blank for all.
 */

// ---- AST types -------------------------------------------------------------

export type StyleMap = Record<string, string>

export interface WidgetBinding {
  widget_id: string
  port: string
  page_id: string
}

export interface OutputBinding {
  trigger_step_id: string  // step ID or "__workflow_complete__"
  widget_id: string
  port: string
  page_id: string
}

export interface AuraNode {
  element: string
  id: string
  parentId: string
  text?: string
  value?: string
  forEach?: string
  key?: string
  if?: string
  with?: Record<string, string>
  transform?: string
  action?: string   // workflow ID to trigger on form submit / button click
  /** ID of the form widget this button is attached to (Option 2/3 multi-button forms). */
  formRef?: string
  /** Comma-separated subset of form fields this button submits; empty or absent means all fields. */
  formFields?: string
  widget_bindings?: Record<string, WidgetBinding>
  output_bindings?: OutputBinding[]
  style?: StyleMap
  /** True if this node was manually edited and should survive AI rewrites */
  manuallyEdited?: boolean
}

export type AuraDocument = AuraNode[]

/** 'binding' edges connect a widget output port to a step node's column/value
 *  slot (e.g. form1.firstName → step-mutation.bind:set:0).  They are
 *  rendered as dashed purple wires on the Flow canvas and drive the
 *  drag-to-wire binding feature. */
export type EdgeType = 'reactive' | 'async' | 'binding'

export interface AuraEdge {
  id: string
  fromNodeId: string   // widget ID or step node ID (e.g. "step_load_user")
  fromPort: string     // output port name (e.g. "selectedRow", "result")
  toNodeId: string
  toPort: string       // input port name (e.g. "content", "sql_param.user_id")
  edgeType: EdgeType
  transform?: string   // optional JS expression; $ is the source value
}

export interface AuraDocumentV2 {
  nodes: AuraNode[]
  edges: AuraEdge[]
}

// ---- Parser ----------------------------------------------------------------

/**
 * parse converts a Aura DSL source string into an AuraDocument (array of
 * AuraNodes). Throws a ParseError on syntax violations.
 *
 * Grammar overview (line-based tokeniser):
 *   statement      := header clause* ';'
 *   header         := IDENT IDENT '@' IDENT
 *   clause         := text_clause | value_clause | foreach_clause
 *                   | key_clause | if_clause | with_clause
 *                   | transform_clause | style_clause
 */
export function parse(source: string): AuraDocument {
  const tokens = tokenise(source)
  let pos = 0

  const peek = () => tokens[pos]
  const consume = () => tokens[pos++]
  const expect = (val: string) => {
    const t = consume()
    if (t !== val) throw new ParseError(`expected '${val}', got '${t}' at token ${pos}`)
    return t
  }

  const nodes: AuraNode[] = []
  while (pos < tokens.length) {
    if (peek() === ';') { consume(); continue } // stray semicolon — skip
    nodes.push(parseNode(tokens, peek, consume, expect, () => pos))
  }

  return nodes
}

/**
 * parseV2 parses an Aura V2 DSL source string into an AuraDocumentV2.
 *
 * The source may optionally contain an `---edges---` separator:
 *   <node statements>
 *   ---edges---
 *   <edge statements>
 *
 * Documents without `---edges---` are treated as having an empty edge list.
 * Throws `ParseError` on syntax violations.
 *
 * Edge statement grammar:
 *   edge <id> from <fromNodeId>.<fromPort> to <toNodeId>.<toPort> <edgeType> [transform <quotedExpr>] ;
 *
 * Notes:
 * - `fromNodeId.fromPort` is a single token; split on the FIRST dot only
 *   because toPort values can contain dots (e.g. `sql_param.user_id`).
 * - Valid edgeType values are `reactive`, `async`, and `binding`.
 */

/**
 * Repairs DSL edge statements where port names contain spaces (e.g. `form1.first name`).
 * Spaces within a port name segment are replaced with `_` so the parser can tokenize correctly.
 * Only the edge section (after `---edges---`) is modified.
 */
export function repairDSL(source: string): string {
  const SENTINEL = '---edges---'
  const sentinelIdx = source.indexOf(SENTINEL)
  if (sentinelIdx === -1) return source

  const nodeSource = source.slice(0, sentinelIdx + SENTINEL.length)
  const edgeSource = source.slice(sentinelIdx + SENTINEL.length)

  // Fix patterns like `from nodeId.port1 part2 to` and `to nodeId.port1 part2 <edgeType>`
  // by joining the broken port name segments with `_`.
  // The pattern: after `from ` or `to `, a token containing a dot followed by a space and
  // another non-keyword word before the next keyword (`to`, `reactive`, `async`, `binding`, `;`).
  const KEYWORDS = new Set(['to', 'from', 'edge', 'reactive', 'async', 'binding', 'transform'])
  const repairedEdgeSource = edgeSource.replace(
    /((?:from|to)\s+\S+\.\S*)\s+([^\s;]+)/g,
    (match, beforeSpace, afterSpace) => {
      if (KEYWORDS.has(afterSpace)) return match
      return `${beforeSpace}_${afterSpace}`
    }
  )

  return nodeSource + repairedEdgeSource
}

export function parseV2(source: string): AuraDocumentV2 {
  const SENTINEL = '---edges---'
  const sentinelIdx = source.indexOf(SENTINEL)

  let nodeSource: string
  let edgeSource: string

  if (sentinelIdx === -1) {
    nodeSource = source
    edgeSource = ''
  } else {
    nodeSource = source.slice(0, sentinelIdx)
    edgeSource = source.slice(sentinelIdx + SENTINEL.length)
  }

  // Parse nodes using the existing parser (backward-compatible)
  const nodes = parse(nodeSource)

  // Parse edges
  const edges: AuraEdge[] = []
  if (edgeSource.trim()) {
    const tokens = tokeniseEdges(edgeSource)
    let pos = 0

    const peek = () => tokens[pos]
    const consume = () => tokens[pos++]
    const expect = (val: string) => {
      const t = consume()
      if (t !== val) throw new ParseError(`expected '${val}' in edge statement, got '${t}'`)
      return t
    }

    while (pos < tokens.length) {
      if (peek() === ';') { consume(); continue }

      expect('edge')
      const id = consume()
      expect('from')

      // fromNodeId.fromPort — split on first dot only.
      // Handles two forms:
      //   1. Quoted: "nodeId.port name" (emitted by serializeV2 when port has spaces)
      //   2. Legacy unquoted split: nodeId.portPart1 portPart2 (stored before quoting was added)
      let fromRaw = consume()
      if (fromRaw.startsWith('"') && fromRaw.endsWith('"')) {
        // Quoted form: strip outer quotes
        fromRaw = fromRaw.slice(1, -1)
      } else {
        // Legacy form: consume extra non-keyword tokens that are part of a space-split port name
        while (peek() !== 'to' && peek() !== ';' && peek() !== undefined &&
               !/^(reactive|async|binding|transform)$/.test(peek())) {
          fromRaw = fromRaw + ' ' + consume()
        }
      }
      const firstDot = fromRaw.indexOf('.')
      if (firstDot === -1) throw new ParseError(`edge '${id}': from token '${fromRaw}' must be in format 'nodeId.portName'`)
      const fromNodeId = fromRaw.slice(0, firstDot)
      const fromPort = fromRaw.slice(firstDot + 1)

      expect('to')

      // toNodeId.toPort — same handling
      let toRaw = consume()
      if (toRaw.startsWith('"') && toRaw.endsWith('"')) {
        toRaw = toRaw.slice(1, -1)
      } else {
        while (peek() !== ';' && peek() !== undefined &&
               !/^(reactive|async|binding|transform)$/.test(peek())) {
          toRaw = toRaw + ' ' + consume()
        }
      }
      const toDot = toRaw.indexOf('.')
      if (toDot === -1) throw new ParseError(`edge '${id}': to token '${toRaw}' must be in format 'nodeId.portName'`)
      const toNodeId = toRaw.slice(0, toDot)
      const toPort = toRaw.slice(toDot + 1)

      const edgeTypeToken = consume()
      if (edgeTypeToken !== 'reactive' && edgeTypeToken !== 'async' && edgeTypeToken !== 'binding') {
        throw new ParseError(`edge '${id}': unknown edgeType '${edgeTypeToken}'; expected 'reactive', 'async', or 'binding'`)
      }
      const edgeType = edgeTypeToken as EdgeType

      const edge: AuraEdge = { id, fromNodeId, fromPort, toNodeId, toPort, edgeType }

      // Optional transform clause
      if (peek() === 'transform') {
        consume()
        edge.transform = consumeEdgeString(tokens, () => consume())
      }

      if (peek() === ';') consume()
      edges.push(edge)
    }
  }

  return { nodes, edges }
}

/** Parses a single node statement from the shared token stream. */
function parseNode(
  tokens: string[],
  peek: () => string,
  consume: () => string,
  expect: (val: string) => string,
  getPos: () => number,
): AuraNode {
  const element = consume()
  const id = consume()
  expect('@')
  const parentId = consume()

  const node: AuraNode = { element, id, parentId }

  // Parse clauses until `;`
  while (getPos() < tokens.length && peek() !== ';') {
    const clause = consume()
    switch (clause) {
      case 'text':
        node.text = consumeString(tokens, getPos() - 1, () => consume())
        break
      case 'value':
        node.value = consumeString(tokens, getPos() - 1, () => consume())
        break
      case 'forEach':
        node.forEach = consume()
        break
      case 'key':
        node.key = consume()
        break
      case 'if':
        node.if = consumeString(tokens, getPos() - 1, () => consume())
        break
      case 'with':
        node.with = parseWithMap(tokens, () => peek(), () => consume())
        break
      case 'transform':
        node.transform = consumeString(tokens, getPos() - 1, () => consume())
        break
      case 'action':
        node.action = consume()
        break
      case 'formRef':
        node.formRef = consume()
        break
      case 'formFields':
        node.formFields = consumeString(tokens, getPos() - 1, () => consume())
        break
      case 'widget_bindings':
        node.widget_bindings = JSON.parse(consumeString(tokens, getPos() - 1, () => consume()))
        break
      case 'output_bindings':
        node.output_bindings = JSON.parse(consumeString(tokens, getPos() - 1, () => consume()))
        break
      case 'style':
        node.style = parseStyleBlock(tokens, () => peek(), () => consume(), expect)
        break
      default:
        throw new ParseError(`unknown clause '${clause}' in node '${id}'`)
    }
  }
  if (peek() === ';') consume()
  return node
}

// ---- Serializer ------------------------------------------------------------

/** serialize converts an AuraDocument back to canonical DSL source. */
export function serialize(doc: AuraDocument): string {
  return doc.map(serializeNode).join('\n')
}

/**
 * serializeV2 converts an AuraDocumentV2 back to canonical V2 DSL source.
 * If edges.length > 0, appends an `---edges---` section.
 */
export function serializeV2(doc: AuraDocumentV2): string {
  const nodePart = doc.nodes.map(serializeNode).join('\n')
  if (doc.edges.length === 0) return nodePart

  const edgeLines = doc.edges.map((e) => {
    const fromEndpoint = /\s/.test(e.fromPort) ? `"${e.fromNodeId}.${e.fromPort}"` : `${e.fromNodeId}.${e.fromPort}`
    const toEndpoint = /\s/.test(e.toPort) ? `"${e.toNodeId}.${e.toPort}"` : `${e.toNodeId}.${e.toPort}`
    let line = `edge ${e.id} from ${fromEndpoint} to ${toEndpoint} ${e.edgeType}`
    if (e.transform !== undefined) line += ` transform ${JSON.stringify(e.transform)}`
    line += ' ;'
    return line
  })
  return `${nodePart}\n---edges---\n${edgeLines.join('\n')}`
}

function serializeNode(n: AuraNode): string {
  const lines: string[] = [`${n.element} ${n.id} @ ${n.parentId}`]

  if (n.text !== undefined) lines.push(`  text ${JSON.stringify(n.text)}`)
  if (n.value !== undefined) lines.push(`  value ${JSON.stringify(n.value)}`)
  if (n.forEach !== undefined) lines.push(`  forEach ${n.forEach}`)
  if (n.key !== undefined) lines.push(`  key ${n.key}`)
  if (n.if !== undefined) lines.push(`  if ${JSON.stringify(n.if)}`)
  if (n.with && Object.keys(n.with).length > 0) {
    const entries = Object.entries(n.with)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ')
    lines.push(`  with ${entries}`)
  }
  if (n.transform !== undefined) lines.push(`  transform ${JSON.stringify(n.transform)}`)
  if (n.action !== undefined) lines.push(`  action ${n.action}`)
  if (n.formRef !== undefined) lines.push(`  formRef ${n.formRef}`)
  if (n.formFields !== undefined) lines.push(`  formFields ${JSON.stringify(n.formFields)}`)
  if (n.widget_bindings && Object.keys(n.widget_bindings).length > 0) {
    lines.push(`  widget_bindings ${JSON.stringify(JSON.stringify(n.widget_bindings))}`)
  }
  if (n.output_bindings && n.output_bindings.length > 0) {
    lines.push(`  output_bindings ${JSON.stringify(JSON.stringify(n.output_bindings))}`)
  }
  if (n.style && Object.keys(n.style).length > 0) {
    lines.push(`  style {`)
    for (const [k, v] of Object.entries(n.style)) {
      lines.push(`    ${k}: ${JSON.stringify(v)};`)
    }
    lines.push(`  }`)
  }

  lines.push(';')
  return lines.join('\n')
}

// ---- Validator -------------------------------------------------------------

export interface ValidationError {
  nodeId: string
  message: string
}

/**
 * validate returns an array of validation errors (empty means valid).
 * It does not throw.
 */
export function validate(doc: AuraDocument): ValidationError[] {
  const errors: ValidationError[] = []
  const ids = new Set<string>()

  for (const node of doc) {
    if (!node.element) errors.push({ nodeId: node.id, message: 'element is required' })
    if (!node.id) errors.push({ nodeId: '', message: 'id is required' })
    if (!node.parentId) errors.push({ nodeId: node.id, message: 'parentId is required' })

    if (ids.has(node.id)) {
      errors.push({ nodeId: node.id, message: `duplicate id '${node.id}'` })
    }
    ids.add(node.id)
  }

  // Check parentId references (root is a reserved parent)
  for (const node of doc) {
    if (node.parentId !== 'root' && !ids.has(node.parentId)) {
      errors.push({ nodeId: node.id, message: `parentId '${node.parentId}' not found` })
    }
    if (node.widget_bindings) {
      for (const [configKey, binding] of Object.entries(node.widget_bindings)) {
        if (!ids.has(binding.widget_id)) {
          errors.push({
            nodeId: node.id,
            message: `widget binding on node '${node.id}' references unknown widget '${binding.widget_id}' (key '${configKey}')`,
          })
        }
      }
    }
    if (node.output_bindings) {
      for (const binding of node.output_bindings) {
        if (!ids.has(binding.widget_id)) {
          errors.push({
            nodeId: node.id,
            message: `output binding on node '${node.id}' references unknown widget '${binding.widget_id}'`,
          })
        }
      }
    }
  }

  return errors
}

// ---- Diff / merge ----------------------------------------------------------

/**
 * DiffOp represents a single change operation.
 * NOTE: The addition of add_edge / remove_edge / update_edge variants is a
 * minor breaking change: any exhaustive switch(op.op) over the original three
 * variants will need a `default` branch or explicit handling of the new cases.
 */
export type DiffOp =
  | { op: 'add';         node: AuraNode }
  | { op: 'remove';      id: string }
  | { op: 'update';      id: string; patch: Partial<AuraNode> }
  | { op: 'add_edge';    edge: AuraEdge }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'update_edge'; edgeId: string; patch: Partial<AuraEdge> }

// ---- Port registry (structural — avoids importing from widget-catalog) ----

/** Structural port descriptor for use in validateV2. */
export interface PortRegistryEntry { name: string; direction: 'input' | 'output' }
/** Map from element-type string (e.g. 'table', 'step:query') to port list. */
export type PortRegistry = Map<string, readonly PortRegistryEntry[]>

/**
 * diff computes the minimal set of operations to go from `from` to `to`.
 * Nodes marked `manuallyEdited` in `from` are protected: they appear in the
 * diff result as-is unless the caller passes `force: true`.
 */
export function diff(from: AuraDocument, to: AuraDocument, opts?: { force?: boolean }): DiffOp[] {
  const ops: DiffOp[] = []
  const fromMap = new Map(from.map((n) => [n.id, n]))
  const toMap = new Map(to.map((n) => [n.id, n]))

  for (const [id, toNode] of toMap) {
    const fromNode = fromMap.get(id)
    if (!fromNode) {
      ops.push({ op: 'add', node: toNode })
    } else if (!opts?.force && fromNode.manuallyEdited) {
      // Preserve manual edits (FR-22)
      continue
    } else {
      const patch = nodePatch(fromNode, toNode)
      if (Object.keys(patch).length > 0) {
        ops.push({ op: 'update', id, patch })
      }
    }
  }

  for (const id of fromMap.keys()) {
    if (!toMap.has(id)) ops.push({ op: 'remove', id })
  }

  return ops
}

/**
 * applyDiff applies a set of DiffOps to a document and returns the new document.
 */
export function applyDiff(doc: AuraDocument, ops: DiffOp[]): AuraDocument {
  const map = new Map(doc.map((n) => [n.id, { ...n }]))

  for (const op of ops) {
    switch (op.op) {
      case 'add':
        map.set(op.node.id, op.node)
        break
      case 'remove':
        map.delete(op.id)
        break
      case 'update': {
        const existing = map.get(op.id)
        if (existing) map.set(op.id, { ...existing, ...op.patch })
        break
      }
      default:
        // add_edge / remove_edge / update_edge — not applicable for AuraDocument ops
        break
    }
  }

  return Array.from(map.values())
}

const ALLOWED_ELEMENTS = new Set([
  'table', 'form', 'button', 'text', 'kpi', 'chart', 'filter', 'markdown', 'modal', 'tabs', 'container',
])

export const STEP_ELEMENTS = new Set([
  'step:query', 'step:mutation', 'step:condition', 'step:approval_gate', 'step:notification',
])

/**
 * validateV2 validates an AuraDocumentV2 including edge references and
 * optional port-registry checks. Also detects reactive cycles via Kahn's
 * algorithm (async-only cycles are permitted).
 */
export function validateV2(doc: AuraDocumentV2, portRegistry?: PortRegistry): ValidationError[] {
  const errors = validate(doc.nodes)

  // Element validation: step elements and allowed widget elements
  for (const node of doc.nodes) {
    const { element, id } = node
    if (element.startsWith('step:')) {
      if (!STEP_ELEMENTS.has(element)) {
        errors.push({ nodeId: id, message: `Unknown step element '${element}'` })
      }
    } else if (!ALLOWED_ELEMENTS.has(element)) {
      errors.push({ nodeId: id, message: `Unknown element '${element}'` })
    }
  }

  const nodeIds = new Set(doc.nodes.map((n) => n.id))
  const nodeElementMap = new Map(doc.nodes.map((n) => [n.id, n.element]))

  for (const edge of doc.edges) {
    if (!nodeIds.has(edge.fromNodeId)) {
      errors.push({ nodeId: edge.id, message: `edge '${edge.id}' references unknown fromNodeId '${edge.fromNodeId}'` })
    }
    if (!nodeIds.has(edge.toNodeId)) {
      errors.push({ nodeId: edge.id, message: `edge '${edge.id}' references unknown toNodeId '${edge.toNodeId}'` })
    }

    if (portRegistry) {
      const fromElement = nodeElementMap.get(edge.fromNodeId)
      if (fromElement) {
        const fromPorts = portRegistry.get(fromElement)
        if (fromPorts) {
          const found = fromPorts.some((p) => p.name === edge.fromPort && p.direction === 'output')
          if (!found) {
            errors.push({ nodeId: edge.id, message: `edge '${edge.id}': port '${edge.fromPort}' not found as output on '${fromElement}'` })
          }
        }
      }
      const toElement = nodeElementMap.get(edge.toNodeId)
      if (toElement) {
        const toPorts = portRegistry.get(toElement)
        if (toPorts) {
          const found = toPorts.some((p) => p.name === edge.toPort && p.direction === 'input')
          if (!found) {
            errors.push({ nodeId: edge.id, message: `edge '${edge.id}': port '${edge.toPort}' not found as input on '${toElement}'` })
          }
        }
      }
    }
  }

  // Async chain rule: every async edge must touch at least one step node
  const stepNodeIds = new Set(doc.nodes.filter((n) => STEP_ELEMENTS.has(n.element)).map((n) => n.id))
  for (const edge of doc.edges) {
    if (edge.edgeType === 'async' && !stepNodeIds.has(edge.fromNodeId) && !stepNodeIds.has(edge.toNodeId)) {
      errors.push({ nodeId: edge.id, message: `Async edge '${edge.id}' must connect to at least one step node` })
    }
  }

  // Reactive cycle detection via Kahn's algorithm on reactive edges only
  const reactiveEdges = doc.edges.filter((e) => e.edgeType === 'reactive')
  if (reactiveEdges.length > 0) {
    // Build adjacency for nodeIds involved in reactive edges
    const inDegree = new Map<string, number>()
    const adj = new Map<string, string[]>()

    for (const e of reactiveEdges) {
      if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, [])
      adj.get(e.fromNodeId)!.push(e.toNodeId)
      inDegree.set(e.toNodeId, (inDegree.get(e.toNodeId) ?? 0) + 1)
      if (!inDegree.has(e.fromNodeId)) inDegree.set(e.fromNodeId, 0)
    }

    const queue: string[] = []
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node)
    }
    let processed = 0
    while (queue.length > 0) {
      const node = queue.shift()!
      processed++
      for (const neighbor of (adj.get(node) ?? [])) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) queue.push(neighbor)
      }
    }

    if (processed < inDegree.size) {
      // Find edges involved in cycle (nodes with remaining non-zero in-degree)
      const cycleNodes = new Set<string>()
      for (const [node, deg] of inDegree) {
        if (deg > 0) cycleNodes.add(node)
      }
      for (const e of reactiveEdges) {
        if (cycleNodes.has(e.fromNodeId) || cycleNodes.has(e.toNodeId)) {
          errors.push({ nodeId: e.id, message: `reactive cycle detected involving edge '${e.id}'` })
        }
      }
    }
  }

  return errors
}

/**
 * diffV2 computes the minimal set of V2 operations to go from `from` to `to`.
 */
export function diffV2(from: AuraDocumentV2, to: AuraDocumentV2, opts?: { force?: boolean }): DiffOp[] {
  const ops: DiffOp[] = diff(from.nodes, to.nodes, opts)

  const fromEdgeMap = new Map(from.edges.map((e) => [e.id, e]))
  const toEdgeMap = new Map(to.edges.map((e) => [e.id, e]))

  for (const [id, toEdge] of toEdgeMap) {
    const fromEdge = fromEdgeMap.get(id)
    if (!fromEdge) {
      ops.push({ op: 'add_edge', edge: toEdge })
    } else {
      const patch = edgePatch(fromEdge, toEdge)
      if (Object.keys(patch).length > 0) {
        ops.push({ op: 'update_edge', edgeId: id, patch })
      }
    }
  }
  for (const id of fromEdgeMap.keys()) {
    if (!toEdgeMap.has(id)) ops.push({ op: 'remove_edge', edgeId: id })
  }

  return ops
}

/**
 * applyDiffV2 applies a set of DiffOps to an AuraDocumentV2.
 */
export function applyDiffV2(doc: AuraDocumentV2, ops: DiffOp[]): AuraDocumentV2 {
  const nodes = applyDiff(doc.nodes, ops)
  const edgeMap = new Map(doc.edges.map((e) => [e.id, { ...e }]))

  for (const op of ops) {
    switch (op.op) {
      case 'add_edge':
        edgeMap.set(op.edge.id, op.edge)
        break
      case 'remove_edge':
        edgeMap.delete(op.edgeId)
        break
      case 'update_edge': {
        const existing = edgeMap.get(op.edgeId)
        if (existing) edgeMap.set(op.edgeId, { ...existing, ...op.patch })
        break
      }
      default:
        // Node ops handled by applyDiff above
        break
    }
  }

  return { nodes, edges: Array.from(edgeMap.values()) }
}

// ---- Internal helpers ------------------------------------------------------

export class ParseError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ParseError'
  }
}

function tokeniseEdges(source: string): string[] {
  return tokenise(source)
}

function consumeEdgeString(_tokens: string[], consume: () => string): string {
  return decodeStringToken(consume())
}

function tokenise(source: string): string[] {
  const tokens: string[] = []
  // Strip line comments (# ...) — only when # appears at the start of a line
  // (with optional leading whitespace). This preserves # inside quoted string
  // values such as markdown headings: content: "## Heading".
  const stripped = source.replace(/^\s*#[^\n]*/gm, '')
  // Match: key="quoted values", standalone quoted strings, style-block
  // delimiters, semicolons, or bare words.
  const re = /[^\s=]+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{}:;]|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    tokens.push(m[0])
  }
  return tokens
}

function consumeString(_tokens: string[], _at: number, consume: () => string): string {
  return decodeStringToken(consume())
}

function parseWithMap(
  _tokens: string[],
  peek: () => string,
  consume: () => string,
): Record<string, string> {
  const map: Record<string, string> = {}
  while (peek() !== ';' && peek() !== 'style' && peek() !== 'transform' && !isClause(peek())) {
    const pair = consume() // e.g. connector="pg-main"
    const eq = pair.indexOf('=')
    if (eq === -1) break
    const k = pair.slice(0, eq)
    const v = pair.slice(eq + 1)
    map[k] = decodeStringToken(v)
  }
  return map
}

function decodeStringToken(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const normalized = `"${raw.slice(1, -1).replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
    return JSON.parse(normalized)
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    const normalized = raw
      .slice(1, -1)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
    return JSON.parse(`"${normalized}"`)
  }
  return raw
}

function parseStyleBlock(
  _tokens: string[],
  peek: () => string,
  consume: () => string,
  expect: (v: string) => string,
): StyleMap {
  expect('{')
  const map: StyleMap = {}
  while (peek() !== '}') {
    let prop = consume() // e.g. "width" or "width:" (tokeniser may fuse key+colon)
    if (prop.endsWith(':')) {
      prop = prop.slice(0, -1)
    } else {
      expect(':')
    }
    const val = consume() // e.g. "\"100%\""
    const cleanVal = decodeStringToken(val)
    if (peek() === ';') consume() // trailing semicolon inside style block
    map[prop] = cleanVal
  }
  expect('}')
  return map
}

const CLAUSES = new Set(['text', 'value', 'forEach', 'key', 'if', 'with', 'transform', 'action', 'formRef', 'formFields', 'widget_bindings', 'output_bindings', 'style'])
function isClause(t: string): boolean {
  return CLAUSES.has(t)
}

function nodePatch(a: AuraNode, b: AuraNode): Partial<AuraNode> {
  const patch: Partial<AuraNode> = {}
  const keys = Object.keys(b) as (keyof AuraNode)[]
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      // @ts-expect-error dynamic key assignment
      patch[k] = b[k]
    }
  }
  return patch
}

function edgePatch(a: AuraEdge, b: AuraEdge): Partial<AuraEdge> {
  const patch: Partial<AuraEdge> = {}
  const keys = Object.keys(b) as (keyof AuraEdge)[]
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      // @ts-expect-error dynamic key assignment
      patch[k] = b[k]
    }
  }
  return patch
}

// ---- V1 migration types ----------------------------------------------------

export interface V1WorkflowStep {
  id: string
  name?: string
  element: string            // e.g. 'step:query', 'step:mutation', etc.
  action?: string            // e.g. 'run_query', 'send_notification'
  connector?: string         // connector id or name
  widget_bindings?: Record<string, string>  // portName → widgetId.portName
  output_bindings?: Record<string, string>  // portName → widgetId.portName
  position?: { x: number; y: number }
}

export interface V1WorkflowOutputBinding {
  stepId: string
  portName: string
  targetWidgetId: string
  targetPortName: string
}

export interface V1Workflow {
  id: string                 // workflow id
  steps: V1WorkflowStep[]
}

/**
 * migrateV1ToV2 converts an existing v1 AuraDocument and a list of V1Workflow
 * objects into an AuraDocumentV2, creating step AuraNodes and AuraEdges from
 * the workflow steps and their bindings.
 *
 * - Existing nodes from `doc` are preserved as-is.
 * - Step nodes whose ID already exists in `doc` are skipped (idempotent).
 * - Edges are deduplicated by their deterministic ID: e_{from}_{fromPort}_{to}_{toPort}.
 */
export function migrateV1ToV2(doc: AuraDocument, workflows: V1Workflow[]): AuraDocumentV2 {
  const existingIds = new Set(doc.map((n) => n.id))
  const nodes: AuraNode[] = [...doc]
  const edges: AuraEdge[] = []
  const edgeIds = new Set<string>()

  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      // Add step node only if its ID does not collide with an existing node
      if (!existingIds.has(step.id)) {
        const withProps: Record<string, string> = {
          action: step.action ?? '',
          connector: step.connector ?? '',
          ...(step.widget_bindings ?? {}),
        }
        nodes.push({ id: step.id, element: step.element, parentId: 'root', with: withProps })
        existingIds.add(step.id)
      }

      // widget_bindings (inputs): portName → "widgetId.portName" → async edge widget→step
      for (const [portName, widgetPortPair] of Object.entries(step.widget_bindings ?? {})) {
        const firstDot = widgetPortPair.indexOf('.')
        const widgetId = firstDot === -1 ? widgetPortPair : widgetPortPair.slice(0, firstDot)
        const widgetPortName = firstDot === -1 ? '' : widgetPortPair.slice(firstDot + 1)
        const id = `e_${widgetId}_${widgetPortName}_${step.id}_${portName}`
        if (!edgeIds.has(id)) {
          edgeIds.add(id)
          edges.push({ id, fromNodeId: widgetId, fromPort: widgetPortName, toNodeId: step.id, toPort: portName, edgeType: 'async' })
        }
      }

      // output_bindings (outputs): portName → "widgetId.portName" → async edge step→widget
      for (const [portName, widgetPortPair] of Object.entries(step.output_bindings ?? {})) {
        const firstDot = widgetPortPair.indexOf('.')
        const widgetId = firstDot === -1 ? widgetPortPair : widgetPortPair.slice(0, firstDot)
        const widgetPortName = firstDot === -1 ? '' : widgetPortPair.slice(firstDot + 1)
        const id = `e_${step.id}_${portName}_${widgetId}_${widgetPortName}`
        if (!edgeIds.has(id)) {
          edgeIds.add(id)
          edges.push({ id, fromNodeId: step.id, fromPort: portName, toNodeId: widgetId, toPort: widgetPortName, edgeType: 'async' })
        }
      }
    }
  }

  return { nodes, edges }
}

// Re-export reactive runtime (dual-layer canvas Phase 1)
export * from './reactive'
