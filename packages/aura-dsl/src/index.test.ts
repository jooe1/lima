import { describe, it, expect } from 'vitest'
import { parse, serialize, validate, diff, applyDiff, ParseError } from '../src/index'

const SIMPLE_DSL = `
table orders-table @ root
  text "Orders"
  value "{{queries.getOrders.data}}"
  style { width: "100%"; }
;

button refresh-btn @ root
  text "Refresh"
;
`

describe('parse', () => {
  it('parses a simple document', () => {
    const doc = parse(SIMPLE_DSL)
    expect(doc).toHaveLength(2)
    expect(doc[0]).toMatchObject({
      element: 'table',
      id: 'orders-table',
      parentId: 'root',
      text: 'Orders',
      value: '{{queries.getOrders.data}}',
      style: { width: '100%' },
    })
    expect(doc[1]).toMatchObject({
      element: 'button',
      id: 'refresh-btn',
      parentId: 'root',
      text: 'Refresh',
    })
  })

  it('throws ParseError on unknown clause', () => {
    expect(() => parse('table t @ root unknown_clause "x" ;')).toThrow(ParseError)
  })

  it('throws ParseError on duplicate id', () => {
    const dupeDoc = parse('table a @ root ; table a @ root ;')
    const errs = validate(dupeDoc)
    expect(errs.some((e) => e.message.includes('duplicate'))).toBe(true)
  })
})

describe('serialize → parse round-trip', () => {
  it('survives a round-trip unchanged', () => {
    const doc1 = parse(SIMPLE_DSL)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('round-trips multiline quoted with values', () => {
    const source = `
table tickets @ root
  with
    columns="[\n      { key: 'ticket_id', label: 'Ticket ID' },\n      { key: 'status', label: 'Status' }\n    ]"
    data="{{tickets}}"
;
`

    const doc1 = parse(source)
    expect(doc1[0].with).toEqual({
      columns: "[\n      { key: 'ticket_id', label: 'Ticket ID' },\n      { key: 'status', label: 'Status' }\n    ]",
      data: '{{tickets}}',
    })

    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })
})

describe('validate', () => {
  it('returns no errors for a valid document', () => {
    const doc = parse(SIMPLE_DSL)
    expect(validate(doc)).toHaveLength(0)
  })

  it('flags a missing parentId reference', () => {
    const doc = parse('table t @ nonexistent ;')
    const errs = validate(doc)
    expect(errs.some((e) => e.message.includes('not found'))).toBe(true)
  })
})

describe('diff / applyDiff', () => {
  it('produces an add op for new nodes', () => {
    const from = parse('table t @ root ;')
    const to = parse('table t @ root ; button b @ root ;')
    const ops = diff(from, to)
    expect(ops).toContainEqual(expect.objectContaining({ op: 'add' }))
  })

  it('produces a remove op for deleted nodes', () => {
    const from = parse('table t @ root ; button b @ root ;')
    const to = parse('table t @ root ;')
    const ops = diff(from, to)
    expect(ops).toContainEqual(expect.objectContaining({ op: 'remove', id: 'b' }))
  })

  it('preserves manually-edited nodes by default', () => {
    const from = parse('table t @ root text "Original" ;')
    from[0].manuallyEdited = true
    const to = parse('table t @ root text "AI override" ;')
    const ops = diff(from, to)
    expect(ops.filter((o) => o.op === 'update')).toHaveLength(0)
  })

  it('overwrites manually-edited nodes when force=true', () => {
    const from = parse('table t @ root text "Original" ;')
    from[0].manuallyEdited = true
    const to = parse('table t @ root text "AI override" ;')
    const ops = diff(from, to, { force: true })
    expect(ops.some((o) => o.op === 'update')).toBe(true)
  })

  it('applyDiff produces the target document', () => {
    const from = parse('table t @ root ;')
    const to = parse('table t @ root text "Hello" ; button b @ root ;')
    const result = applyDiff(from, diff(from, to))
    const resultMap = Object.fromEntries(result.map((n) => [n.id, n]))
    expect(resultMap['t'].text).toBe('Hello')
    expect(resultMap['b']).toBeDefined()
  })
})
