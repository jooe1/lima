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
 * - Clause order is fixed: text → value → forEach → key → if → with → transform → action → style
 * - No nested child blocks — parent/child is expressed through parentId references
 */

// ---- AST types -------------------------------------------------------------

export type StyleMap = Record<string, string>

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
  style?: StyleMap
  /** True if this node was manually edited and should survive AI rewrites */
  manuallyEdited?: boolean
}

export type AuraDocument = AuraNode[]

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
  const nodes: AuraDocument = []
  const tokens = tokenise(source)
  let pos = 0

  const peek = () => tokens[pos]
  const consume = () => tokens[pos++]
  const expect = (val: string) => {
    const t = consume()
    if (t !== val) throw new ParseError(`expected '${val}', got '${t}' at token ${pos}`)
    return t
  }

  while (pos < tokens.length) {
    if (peek() === ';') { consume(); continue } // stray semicolon — skip

    const element = consume()
    const id = consume()
    expect('@')
    const parentId = consume()

    const node: AuraNode = { element, id, parentId }

    // Parse clauses until `;`
    while (pos < tokens.length && peek() !== ';') {
      const clause = consume()
      switch (clause) {
        case 'text':
          node.text = consumeString(tokens, pos - 1, () => consume())
          break
        case 'value':
          node.value = consumeString(tokens, pos - 1, () => consume())
          break
        case 'forEach':
          node.forEach = consume()
          break
        case 'key':
          node.key = consume()
          break
        case 'if':
          node.if = consumeString(tokens, pos - 1, () => consume())
          break
        case 'with':
          node.with = parseWithMap(tokens, () => peek(), () => consume())
          break
        case 'transform':
          node.transform = consumeString(tokens, pos - 1, () => consume())
          break
        case 'action':
          node.action = consume()
          break
        case 'style':
          node.style = parseStyleBlock(tokens, () => peek(), () => consume(), expect)
          break
        default:
          throw new ParseError(`unknown clause '${clause}' in node '${id}'`)
      }
    }
    if (peek() === ';') consume()
    nodes.push(node)
  }

  return nodes
}

// ---- Serializer ------------------------------------------------------------

/** serialize converts an AuraDocument back to canonical DSL source. */
export function serialize(doc: AuraDocument): string {
  return doc.map(serializeNode).join('\n')
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
  }

  return errors
}

// ---- Diff / merge ----------------------------------------------------------

export type DiffOp =
  | { op: 'add'; node: AuraNode }
  | { op: 'remove'; id: string }
  | { op: 'update'; id: string; patch: Partial<AuraNode> }

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
    }
  }

  return Array.from(map.values())
}

// ---- Internal helpers ------------------------------------------------------

export class ParseError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ParseError'
  }
}

function tokenise(source: string): string[] {
  const tokens: string[] = []
  // Strip line comments (# ...)
  const stripped = source.replace(/#[^\n]*/g, '')
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
    const cleanVal =
      val.startsWith('"') || val.startsWith("'") ? val.slice(1, val.length - 1) : val
    if (peek() === ';') consume() // trailing semicolon inside style block
    map[prop] = cleanVal
  }
  expect('}')
  return map
}

const CLAUSES = new Set(['text', 'value', 'forEach', 'key', 'if', 'with', 'transform', 'action', 'style'])
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
