/**
 * Shared SQL building / parsing utilities used by both StepConfigPanel (guided
 * UI) and FlowCanvas (binding handle logic).
 *
 * Extracted here so neither file needs to import from the other.
 */

export type WhereOp = '=' | '!=' | 'LIKE' | '>' | '<' | '>=' | '<='
export interface WhereClause { col: string; op: WhereOp; val: string }
export interface SetClause { col: string; val: string }
export type MutationOp = 'INSERT' | 'UPDATE' | 'DELETE'

export interface GuidedState {
  table: string
  whereClauses: WhereClause[]
  limit: string
  // mutation-only
  mutationOp: MutationOp
  setClauses: SetClause[]
}

export function defaultGuided(): GuidedState {
  return { table: '', whereClauses: [], limit: '50', mutationOp: 'INSERT', setClauses: [{ col: '', val: '' }] }
}

export function sqlFromGuided(state: GuidedState, isQuery: boolean): string {
  const { table, whereClauses, limit, mutationOp, setClauses } = state
  if (!table) return ''

  const validWhereClauses = whereClauses.filter(w => w.col)
  const whereStr = validWhereClauses.length > 0
    ? ' WHERE ' + validWhereClauses
        .map(w => {
          const val = w.val.startsWith('{{') ? w.val : `'${w.val}'`
          return `${w.col} ${w.op} ${val}`
        }).join(' AND ')
    : ''

  if (isQuery) {
    const limitStr = limit ? ` LIMIT ${limit}` : ''
    return `SELECT * FROM ${table}${whereStr}${limitStr}`
  }

  if (mutationOp === 'DELETE') return `DELETE FROM ${table}${whereStr}`

  const validSets = setClauses.filter(s => s.col)
  if (mutationOp === 'INSERT') {
    const cols = validSets.map(s => s.col).join(', ')
    const vals = validSets.map(s => s.val.startsWith('{{') ? s.val : `'${s.val}'`).join(', ')
    return cols ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} DEFAULT VALUES`
  }

  // UPDATE
  const setStr = validSets.map(s => `${s.col} = ${s.val.startsWith('{{') ? s.val : `'${s.val}'`}`).join(', ')
  return setStr ? `UPDATE ${table} SET ${setStr}${whereStr}` : ''
}

const WHERE_CLAUSE_RE = /(\w+)\s*(=|!=|LIKE|>=|<=|>|<)\s*('([^']*)'|({{[^}]+}}))/gi

function whereMatch(str: string): WhereClause[] {
  const result: WhereClause[] = []
  let m
  const re = new RegExp(WHERE_CLAUSE_RE.source, 'gi')
  while ((m = re.exec(str)) !== null) {
    result.push({ col: m[1], op: m[2] as WhereOp, val: m[4] !== undefined ? m[4] : m[5] })
  }
  return result
}

/**
 * Try to parse a simple SQL query into guided state.
 * Returns null when the SQL is too complex to represent.
 */
export function tryParseSQL(sql: string, isQuery: boolean): GuidedState | null {
  const s = sql.trim()
  if (!s) return defaultGuided()

  if (isQuery) {
    const m = s.match(/^SELECT\s+[*\w,\s]+\s+FROM\s+(\w+)(.*?)(?:LIMIT\s+(\d+))?$/i)
    if (!m) return null
    const table = m[1]
    const rest = m[2] ?? ''
    const limit = m[3] ?? '50'
    const whereMatch_ = rest.match(/WHERE\s+(.*)/i)
    const whereClauses = whereMatch_ ? whereMatch(whereMatch_[1]) : []
    return { table, whereClauses, limit, mutationOp: 'INSERT', setClauses: [{ col: '', val: '' }] }
  }

  const insertDefault = s.match(/^INSERT\s+INTO\s+(\w+)\s+DEFAULT\s+VALUES$/i)
  if (insertDefault) {
    const table = insertDefault[1]
    return { table, whereClauses: [], limit: '50', mutationOp: 'INSERT', setClauses: [{ col: '', val: '' }] }
  }

  // INSERT
  const ins = s.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i)
  if (ins) {
    const table = ins[1]
    const cols = ins[2].split(',').map(c => c.trim())
    const vals = ins[3].split(',').map(v => v.trim().replace(/^'|'$/g, ''))
    const setClauses: SetClause[] = cols.map((col, i) => ({ col, val: vals[i] ?? '' }))
    return { table, setClauses, whereClauses: [], limit: '50', mutationOp: 'INSERT' }
  }

  // UPDATE
  const upd = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$/i)
  if (upd) {
    const table = upd[1]
    const setClauses: SetClause[] = upd[2].split(',').map(part => {
      const eq = part.indexOf('=')
      return { col: part.slice(0, eq).trim(), val: part.slice(eq + 1).trim().replace(/^'|'$/g, '') }
    })
    const whereClauses = upd[3] ? whereMatch(upd[3]) : []
    return { table, setClauses, whereClauses, limit: '50', mutationOp: 'UPDATE' }
  }

  // DELETE
  const del = s.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*))?$/i)
  if (del) {
    const table = del[1]
    const whereClauses = del[2] ? whereMatch(del[2]) : []
    return { table, whereClauses, setClauses: [{ col: '', val: '' }], limit: '50', mutationOp: 'DELETE' }
  }

  return null
}
