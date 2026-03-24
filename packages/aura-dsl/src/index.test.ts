import { describe, it, expect } from 'vitest'
import { parse, serialize, validate, diff, applyDiff, ParseError, type WidgetBinding, type OutputBinding } from '../src/index'

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

describe('action clause', () => {
  it('parses an action clause on a button node', () => {
    const doc = parse('button btn1 @ root text "Submit" action wf-abc-123 ;')
    expect(doc[0]).toMatchObject({
      element: 'button',
      id: 'btn1',
      parentId: 'root',
      text: 'Submit',
      action: 'wf-abc-123',
    })
  })

  it('round-trips a node with an action clause', () => {
    const source = `
button submit-btn @ root
  text "Submit"
  action wf-abc-123
;
`
    const doc1 = parse(source)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('nodes without action clause parse and serialize cleanly', () => {
    const doc = parse('button btn @ root text "Cancel" ;')
    expect(doc[0].action).toBeUndefined()
    const src = serialize(doc)
    expect(src).not.toContain('action')
  })
})

describe('widget_bindings and output_bindings', () => {
  const WB: Record<string, WidgetBinding> = {
    'config.form': { widget_id: 'form1', port: 'data', page_id: 'page-1' },
  }
  const OB: OutputBinding[] = [
    { trigger_step_id: '__workflow_complete__', widget_id: 'table1', port: 'data', page_id: 'page-1' },
  ]

  it('parses a node with widget_bindings clause', () => {
    const source = `step step1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(WB))}\n;`
    const doc = parse(source)
    expect(doc[0].widget_bindings).toEqual(WB)
  })

  it('parses a node with output_bindings clause', () => {
    const source = `step step1 @ root\n  output_bindings ${JSON.stringify(JSON.stringify(OB))}\n;`
    const doc = parse(source)
    expect(doc[0].output_bindings).toEqual(OB)
  })

  it('validates that unknown widget_id in widget_bindings produces a ValidationError', () => {
    const badWB: Record<string, WidgetBinding> = {
      'config.form': { widget_id: 'form99', port: 'data', page_id: 'page-1' },
    }
    const source = `step step1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(badWB))}\n;`
    const doc = parse(source)
    const errs = validate(doc)
    expect(errs.some((e) => e.message.includes('form99'))).toBe(true)
  })

  it('validates that unknown widget_id in output_bindings produces a ValidationError', () => {
    const badOB: OutputBinding[] = [
      { trigger_step_id: '__workflow_complete__', widget_id: 'table99', port: 'data', page_id: 'page-1' },
    ]
    const source = `step step1 @ root\n  output_bindings ${JSON.stringify(JSON.stringify(badOB))}\n;`
    const doc = parse(source)
    const errs = validate(doc)
    expect(errs.some((e) => e.message.includes('table99'))).toBe(true)
  })

  it('does NOT flag unknown widget_id when the widget exists in the document', () => {
    const source = [
      `step step1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(WB))}\n;`,
      `form form1 @ root\n;`,
    ].join('\n')
    const doc = parse(source)
    const errs = validate(doc).filter((e) => e.message.includes('widget'))
    expect(errs).toHaveLength(0)
  })

  it('round-trips widget_bindings through parse → serialize → parse', () => {
    const source = [
      `step step1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(WB))}\n;`,
      `form form1 @ root\n;`,
    ].join('\n')
    const doc1 = parse(source)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('round-trips output_bindings through parse → serialize → parse', () => {
    const source = [
      `step step1 @ root\n  output_bindings ${JSON.stringify(JSON.stringify(OB))}\n;`,
      `table table1 @ root\n;`,
    ].join('\n')
    const doc1 = parse(source)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('widget_bindings treated as opaque in diff (not field-diffed)', () => {
    const wbA: Record<string, WidgetBinding> = { 'cfg.x': { widget_id: 'w1', port: 'p', page_id: 'pg' } }
    const wbB: Record<string, WidgetBinding> = { 'cfg.x': { widget_id: 'w2', port: 'p', page_id: 'pg' } }
    const srcA = `step s1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(wbA))}\n;\nform w1 @ root\n;\nform w2 @ root\n;`
    const srcB = `step s1 @ root\n  widget_bindings ${JSON.stringify(JSON.stringify(wbB))}\n;\nform w1 @ root\n;\nform w2 @ root\n;`
    const from = parse(srcA)
    const to = parse(srcB)
    const ops = diff(from, to)
    const updateOp = ops.find((o) => o.op === 'update' && o.id === 's1') as { op: 'update'; id: string; patch: Partial<import('../src/index').AuraNode> } | undefined
    expect(updateOp?.patch.widget_bindings).toEqual(wbB)
  })
})
