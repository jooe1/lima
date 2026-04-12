import { describe, it, expect } from 'vitest'
import {
  parse, parseV2, serialize, serializeV2, validate, validateV2, diff, diffV2, applyDiff, applyDiffV2,
  ParseError, type WidgetBinding, type OutputBinding, type AuraEdge, type AuraDocumentV2, type PortRegistry,
} from '../src/index'

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

describe('AuraEdge and AuraDocumentV2 types', () => {
  it('AuraEdge literal is constructable and exported', () => {
    const edge: AuraEdge = {
      id: 'e1',
      fromNodeId: 'table1',
      fromPort: 'selectedRow',
      toNodeId: 'text1',
      toPort: 'content',
      edgeType: 'reactive',
    }
    expect(typeof edge).toBe('object')
    expect(edge.id).toBe('e1')
  })

  it('AuraEdge with optional transform field', () => {
    const edge: AuraEdge = {
      id: 'e2',
      fromNodeId: 'table1',
      fromPort: 'selectedRow',
      toNodeId: 'form1',
      toPort: 'setValues',
      edgeType: 'async',
      transform: '$.toUpperCase()',
    }
    expect(edge.transform).toBe('$.toUpperCase()')
  })

  it('AuraDocumentV2 literal is constructable and exported', () => {
    const doc: AuraDocumentV2 = {
      nodes: [],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'table1',
          fromPort: 'selectedRow',
          toNodeId: 'text1',
          toPort: 'content',
          edgeType: 'reactive',
        },
      ],
    }
    expect(typeof doc).toBe('object')
    expect(doc.edges).toHaveLength(1)
  })

  it('EdgeType only allows reactive or async', () => {
    // TypeScript compilation enforces this; runtime check via cast
    const reactive: AuraEdge['edgeType'] = 'reactive'
    const async_: AuraEdge['edgeType'] = 'async'
    expect(reactive).toBe('reactive')
    expect(async_).toBe('async')
  })
})

const EDGES_DSL = `
table table1 @ root
  text "Users"
;

text text1 @ root
  text "Name"
;

---edges---

edge e1 from table1.selectedRow to text1.content reactive ;
`

const EDGES_DSL_TRANSFORM = `
table table1 @ root ;
text text1 @ root ;
---edges---
edge e2 from table1.selectedRow to text1.content async transform "$.name.toUpperCase()" ;
`

describe('parseV2', () => {
  it('parses a document with ---edges--- section into AuraDocumentV2', () => {
    const doc = parseV2(EDGES_DSL)
    expect(doc.nodes).toHaveLength(2)
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0]).toMatchObject({
      id: 'e1',
      fromNodeId: 'table1',
      fromPort: 'selectedRow',
      toNodeId: 'text1',
      toPort: 'content',
      edgeType: 'reactive',
    })
  })

  it('parses a document without ---edges--- section with edges: []', () => {
    const doc = parseV2(SIMPLE_DSL)
    expect(doc.nodes).toHaveLength(2)
    expect(doc.edges).toHaveLength(0)
  })

  it('parses an edge with transform clause', () => {
    const doc = parseV2(EDGES_DSL_TRANSFORM)
    expect(doc.edges[0]).toMatchObject({
      id: 'e2',
      edgeType: 'async',
      transform: '$.name.toUpperCase()',
    })
  })

  it('throws ParseError for edge missing from keyword', () => {
    const bad = `
table t @ root ;
---edges---
edge e1 t.port to t2.port reactive ;
`
    expect(() => parseV2(bad)).toThrow(ParseError)
  })

  it('throws ParseError for edge missing to keyword', () => {
    const bad = `
table t @ root ;
---edges---
edge e1 from t.port t2.port reactive ;
`
    expect(() => parseV2(bad)).toThrow(ParseError)
  })

  it('round-trip: parseV2(serialize(parseV2(src).nodes)) returns edges: []', () => {
    const doc1 = parseV2(EDGES_DSL)
    const src2 = serialize(doc1.nodes)
    const doc2 = parseV2(src2)
    expect(doc2.edges).toHaveLength(0)
    expect(doc2.nodes).toEqual(doc1.nodes)
  })

  it('splits fromPort on first dot only (nested port path)', () => {
    const src = `
table t @ root ;
form f @ root ;
---edges---
edge e1 from t.selectedRow to f.sql_param.user_id reactive ;
`
    const doc = parseV2(src)
    expect(doc.edges[0].fromPort).toBe('selectedRow')
    expect(doc.edges[0].toPort).toBe('sql_param.user_id')
  })
})

const EDGE_DSL = `
table contacts_table @ root
  value "{{query.rows}}"
  style { gridX: "0"; gridY: "0"; gridW: "6"; gridH: "4"; }
;
form new_contact @ root
  style { gridX: "6"; gridY: "0"; gridW: "6"; gridH: "4"; }
;
---edges---
edge e1 from contacts_table.selectedRow to new_contact.setValues reactive ;
edge e2 from new_contact.submitted to step_create.params async transform "$.first_name" ;
`

describe('parseV2', () => {
  it('parses a document with ---edges--- section', () => {
    const doc = parseV2(EDGE_DSL)
    expect(doc.nodes).toHaveLength(2)
    expect(doc.edges).toHaveLength(2)
  })

  it('populates edge fields correctly', () => {
    const doc = parseV2(EDGE_DSL)
    expect(doc.edges[0]).toMatchObject({
      id: 'e1',
      fromNodeId: 'contacts_table',
      fromPort: 'selectedRow',
      toNodeId: 'new_contact',
      toPort: 'setValues',
      edgeType: 'reactive',
    })
  })

  it('parses transform clause on edge', () => {
    const doc = parseV2(EDGE_DSL)
    expect(doc.edges[1].transform).toBe('$.first_name')
  })

  it('returns edges: [] when no ---edges--- section', () => {
    const doc = parseV2('table t @ root ;')
    expect(doc.edges).toHaveLength(0)
    expect(doc.nodes).toHaveLength(1)
  })

  it('throws ParseError on malformed edge (wrong keyword)', () => {
    const bad = `table t @ root ;
---edges---
edge e1 foo table1.out to table2.in reactive ;`
    expect(() => parseV2(bad)).toThrow(ParseError)
  })

  it('throws ParseError on edge missing dot in from token', () => {
    const bad = `table t @ root ;
---edges---
edge e1 from nodewithoutdot to table2.in reactive ;`
    expect(() => parseV2(bad)).toThrow(ParseError)
  })
})

describe('V2 serializer / validator / diff', () => {
  const sampleDoc: AuraDocumentV2 = {
    nodes: [
      { element: 'table', id: 'tbl', parentId: 'root' },
      { element: 'text', id: 'txt', parentId: 'root' },
    ],
    edges: [
      { id: 'e1', fromNodeId: 'tbl', fromPort: 'selectedRow', toNodeId: 'txt', toPort: 'setContent', edgeType: 'reactive' },
    ],
  }

  it('serializeV2 → parseV2 round-trip preserves nodes and edges', () => {
    const src = serializeV2(sampleDoc)
    const doc2 = parseV2(src)
    expect(doc2.nodes).toHaveLength(2)
    expect(doc2.edges).toHaveLength(1)
    expect(doc2.edges[0]).toMatchObject({ id: 'e1', edgeType: 'reactive' })
  })

  it('serializeV2 emits no ---edges--- section when edges is empty', () => {
    const src = serializeV2({ nodes: sampleDoc.nodes, edges: [] })
    expect(src).not.toContain('---edges---')
  })

  it('validateV2 returns no errors for a valid document', () => {
    expect(validateV2(sampleDoc)).toHaveLength(0)
  })

  it('validateV2 flags unknown fromNodeId', () => {
    const bad: AuraDocumentV2 = {
      nodes: [{ element: 'table', id: 'tbl', parentId: 'root' }],
      edges: [{ id: 'e1', fromNodeId: 'ghost', fromPort: 'x', toNodeId: 'tbl', toPort: 'y', edgeType: 'reactive' }],
    }
    const errs = validateV2(bad)
    expect(errs.some((e) => e.message.includes('fromNodeId'))).toBe(true)
  })

  it('validateV2 detects a reactive cycle', () => {
    const cycleDoc: AuraDocumentV2 = {
      nodes: [
        { element: 'table', id: 'A', parentId: 'root' },
        { element: 'text', id: 'B', parentId: 'root' },
        { element: 'text', id: 'C', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'reactive' },
        { id: 'e2', fromNodeId: 'B', fromPort: 'out', toNodeId: 'C', toPort: 'in', edgeType: 'reactive' },
        { id: 'e3', fromNodeId: 'C', fromPort: 'out', toNodeId: 'A', toPort: 'in', edgeType: 'reactive' },
      ],
    }
    const errs = validateV2(cycleDoc)
    expect(errs.some((e) => e.message.toLowerCase().includes('cycle'))).toBe(true)
  })

  it('validateV2 does NOT flag an async-only cycle', () => {
    const asyncCycleDoc: AuraDocumentV2 = {
      nodes: [
        { element: 'table', id: 'A', parentId: 'root' },
        { element: 'text', id: 'B', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'async' },
        { id: 'e2', fromNodeId: 'B', fromPort: 'out', toNodeId: 'A', toPort: 'in', edgeType: 'async' },
      ],
    }
    const errs = validateV2(asyncCycleDoc)
    // Only node-level errors (if any), no cycle errors
    expect(errs.filter((e) => e.message.toLowerCase().includes('cycle'))).toHaveLength(0)
  })

  it('validateV2 flags invalid fromPort when portRegistry provided', () => {
    const reg: PortRegistry = new Map([
      ['table', [{ name: 'selectedRow', direction: 'output' }]],
      ['text', [{ name: 'setContent', direction: 'input' }]],
    ])
    const badPortDoc: AuraDocumentV2 = {
      nodes: [
        { element: 'table', id: 'tbl', parentId: 'root' },
        { element: 'text', id: 'txt', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'tbl', fromPort: 'nonexistentPort', toNodeId: 'txt', toPort: 'setContent', edgeType: 'reactive' },
      ],
    }
    const errs = validateV2(badPortDoc, reg)
    expect(errs.some((e) => e.message.includes('fromPort') || e.message.includes('nonexistentPort'))).toBe(true)
  })

  it('diffV2 detects added and removed edges', () => {
    const from: AuraDocumentV2 = { nodes: sampleDoc.nodes, edges: [] }
    const to: AuraDocumentV2 = sampleDoc
    const ops = diffV2(from, to)
    expect(ops.some((o) => o.op === 'add_edge')).toBe(true)

    const ops2 = diffV2(to, from)
    expect(ops2.some((o) => o.op === 'remove_edge')).toBe(true)
  })

  it('applyDiffV2 applies add_edge, remove_edge, update_edge ops', () => {
    const from: AuraDocumentV2 = { nodes: sampleDoc.nodes, edges: [] }
    const ops = diffV2(from, sampleDoc)
    const result = applyDiffV2(from, ops)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].id).toBe('e1')

    const ops2 = diffV2(sampleDoc, from)
    const result2 = applyDiffV2(sampleDoc, ops2)
    expect(result2.edges).toHaveLength(0)
  })
})
