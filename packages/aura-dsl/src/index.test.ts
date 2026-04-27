import { describe, it, expect } from 'vitest'
import {
  parse, parseV2, serialize, serializeV2, validate, validateV2, diff, diffV2, applyDiff, applyDiffV2,
  ParseError, STEP_ELEMENTS, migrateV1ToV2, normalizeInlineLinks,
  type WidgetBinding, type OutputBinding, type AuraEdge, type AuraDocumentV2, type PortRegistry, type V1Workflow, type InlineLink,
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

  it('round-trips style values containing markdown headings (#)', () => {
    const content = '## Heading\n\n#asda dasd as\nsome text'
    const source = `
markdown md1 @ root
  style { content: ${JSON.stringify(content)}; }
;
`
    const doc1 = parse(source)
    expect(doc1[0].style?.content).toBe(content)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('round-trips text clause containing # characters', () => {
    const text = '## Bold heading'
    const source = `markdown md2 @ root\n  text ${JSON.stringify(text)}\n;`
    const doc1 = parse(source)
    expect(doc1[0].text).toBe(text)
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

  it('parses comma-separated with entries for form config', () => {
    const source = `
form order_form @ root
  with fields="OrderID,Date,CustomerName", submitLabel="Save Order"
  style { gridX: "0"; gridY: "2"; gridW: "5"; gridH: "8" }
;
`

    const doc = parse(source)
    expect(doc[0].with).toEqual({
      fields: 'OrderID,Date,CustomerName',
      submitLabel: 'Save Order',
    })
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

describe('formRef and formFields clauses', () => {
  it('parses formRef on a button node', () => {
    const doc = parse('button save-btn @ root text "Save" action wf-123 formRef form1 ;')
    expect(doc[0]).toMatchObject({
      element: 'button',
      id: 'save-btn',
      action: 'wf-123',
      formRef: 'form1',
    })
    expect(doc[0].formFields).toBeUndefined()
  })

  it('parses formRef + formFields on a button node', () => {
    const doc = parse('button update-btn @ root text "Update" formRef form1 formFields "name,email" ;')
    expect(doc[0]).toMatchObject({
      formRef: 'form1',
      formFields: 'name,email',
    })
  })

  it('round-trips formRef and formFields through parse → serialize → parse', () => {
    const source = `
button save-btn @ root
  text "Save"
  action wf-abc
  formRef contact-form
  formFields "firstName,lastName"
;
`
    const doc1 = parse(source)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
    expect(doc2[0].formRef).toBe('contact-form')
    expect(doc2[0].formFields).toBe('firstName,lastName')
  })

  it('nodes without formRef/formFields parse and serialize cleanly', () => {
    const doc = parse('button btn @ root text "Click" ;')
    expect(doc[0].formRef).toBeUndefined()
    expect(doc[0].formFields).toBeUndefined()
    const src = serialize(doc)
    expect(src).not.toContain('formRef')
    expect(src).not.toContain('formFields')
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

  it('repairs a legacy stray parent suffix on a text clause', () => {
    const src = `
table orders_table @ content_row
  text "Orders" @ root
  with columns="OrderID,Date"
;
`

    const doc = parseV2(src)
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0]).toMatchObject({
      element: 'table',
      id: 'orders_table',
      parentId: 'content_row',
      text: 'Orders',
      with: { columns: 'OrderID,Date' },
    })
  })

  it('parses an edge with transform clause', () => {
    const doc = parseV2(EDGES_DSL_TRANSFORM)
    expect(doc.edges[0]).toMatchObject({
      id: 'e2',
      edgeType: 'async',
      transform: '$.name.toUpperCase()',
    })
  })

  it('parses and round-trips binding edges', () => {
    const src = `
form form1 @ root ;
step:mutation step1 @ root ;
---edges---
edge bind_abc12345 from form1.firstName to step1.bind:set:0 binding ;
`

    const doc = parseV2(src)
    expect(doc.edges[0]).toMatchObject({
      id: 'bind_abc12345',
      fromNodeId: 'form1',
      fromPort: 'firstName',
      toNodeId: 'step1',
      toPort: 'bind:set:0',
      edgeType: 'binding',
    })

    expect(parseV2(serializeV2(doc))).toEqual(doc)
  })

  it('parses legacy malformed edges whose fromPort contains spaces', () => {
    const src = `
form form1 @ root ;
step:mutation step1 @ root ;
---edges---
edge bind_abc12345 from form1.First name to step1.bind:set:0 binding ;
`

    const doc = parseV2(src)
    expect(doc.edges[0]).toMatchObject({
      fromNodeId: 'form1',
      fromPort: 'First name',
      toNodeId: 'step1',
      toPort: 'bind:set:0',
      edgeType: 'binding',
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

  it('serializeV2 quotes edge endpoints when port names contain spaces', () => {
    const spacedDoc: AuraDocumentV2 = {
      nodes: [
        { element: 'form', id: 'form1', parentId: 'root' },
        { element: 'step:mutation', id: 'step1', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'form1', fromPort: 'First name', toNodeId: 'step1', toPort: 'bind:set:0', edgeType: 'binding' },
      ],
    }

    const src = serializeV2(spacedDoc)
    expect(src).toContain('from "form1.First name"')
    expect(parseV2(src)).toEqual(spacedDoc)
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

describe('validateV2 step element rules', () => {
  it('accepts a node with element step:query in an otherwise valid doc', () => {
    const doc: AuraDocumentV2 = {
      nodes: [{ element: 'step:query', id: 'sq1', parentId: 'root' }],
      edges: [],
    }
    const errs = validateV2(doc)
    expect(errs).toHaveLength(0)
  })

  it('flags a node with an unknown step: prefix element', () => {
    const doc: AuraDocumentV2 = {
      nodes: [{ element: 'step:unknown_type', id: 'bad1', parentId: 'root' }],
      edges: [],
    }
    const errs = validateV2(doc)
    expect(errs.some((e) => e.message.includes('Unknown step element'))).toBe(true)
  })

  it('no error for async edge where toNodeId is a step node', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        { element: 'form', id: 'frm1', parentId: 'root' },
        { element: 'step:mutation', id: 'stp1', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'frm1', fromPort: 'submitted', toNodeId: 'stp1', toPort: 'params', edgeType: 'async' },
      ],
    }
    const errs = validateV2(doc)
    expect(errs.filter((e) => e.message.includes('must connect to at least one step node'))).toHaveLength(0)
  })

  it('flags async edge where both endpoints are widget nodes', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        { element: 'form', id: 'frm1', parentId: 'root' },
        { element: 'table', id: 'tbl1', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'frm1', fromPort: 'submitted', toNodeId: 'tbl1', toPort: 'refresh', edgeType: 'async' },
      ],
    }
    const errs = validateV2(doc)
    expect(errs.some((e) => e.message.includes('must connect to at least one step node'))).toBe(true)
  })

  it('no error for async edge where both endpoints are step nodes', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        { element: 'step:query', id: 'sq1', parentId: 'root' },
        { element: 'step:condition', id: 'sc1', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'sq1', fromPort: 'result', toNodeId: 'sc1', toPort: 'value', edgeType: 'async' },
      ],
    }
    const errs = validateV2(doc)
    expect(errs.filter((e) => e.message.includes('must connect to at least one step node'))).toHaveLength(0)
  })

  it('doc with only reactive edges and widget nodes passes async chain rule', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        { element: 'table', id: 'tbl1', parentId: 'root' },
        { element: 'text', id: 'txt1', parentId: 'root' },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'tbl1', fromPort: 'selectedRow', toNodeId: 'txt1', toPort: 'content', edgeType: 'reactive' },
      ],
    }
    const errs = validateV2(doc)
    expect(errs.filter((e) => e.message.includes('must connect to at least one step node'))).toHaveLength(0)
  })

  it('STEP_ELEMENTS exports all 7 step node types', () => {
    expect(STEP_ELEMENTS.size).toBe(7)
    expect(STEP_ELEMENTS.has('step:query')).toBe(true)
    expect(STEP_ELEMENTS.has('step:mutation')).toBe(true)
    expect(STEP_ELEMENTS.has('step:condition')).toBe(true)
    expect(STEP_ELEMENTS.has('step:approval_gate')).toBe(true)
    expect(STEP_ELEMENTS.has('step:notification')).toBe(true)
    expect(STEP_ELEMENTS.has('step:transform')).toBe(true)
    expect(STEP_ELEMENTS.has('step:http')).toBe(true)
  })

  it('validateV2 does not error on a node with element step:transform', () => {
    const doc: AuraDocumentV2 = {
      nodes: [{ element: 'step:transform', id: 'xform1', parentId: 'root' }],
      edges: [],
    }
    const errs = validateV2(doc)
    expect(errs.filter(e => e.message.includes('Unknown step element'))).toHaveLength(0)
  })

  it('validateV2 does not error on a node with element step:http', () => {
    const doc: AuraDocumentV2 = {
      nodes: [{ element: 'step:http', id: 'http1', parentId: 'root' }],
      edges: [],
    }
    const errs = validateV2(doc)
    expect(errs.filter(e => e.message.includes('Unknown step element'))).toHaveLength(0)
  })
})

describe('migrateV1ToV2', () => {
  it('no workflows returns original nodes with empty edges', () => {
    const doc = parse('form form1 @ root ;\ntable table1 @ root ;')
    const result = migrateV1ToV2(doc, [])
    expect(result.nodes).toEqual(doc)
    expect(result.edges).toHaveLength(0)
  })

  it('single step with widget_bindings produces async edge from widget to step', () => {
    const doc = parse('form form1 @ root ;')
    const workflow: V1Workflow = {
      id: 'wf1',
      steps: [
        { id: 'step1', element: 'step:query', widget_bindings: { query: 'form1.submit' } },
      ],
    }
    const result = migrateV1ToV2(doc, [workflow])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'form1',
      fromPort: 'submit',
      toNodeId: 'step1',
      toPort: 'query',
      edgeType: 'async',
    })
  })

  it('single step with output_bindings produces async edge from step to widget', () => {
    const doc = parse('table table1 @ root ;')
    const workflow: V1Workflow = {
      id: 'wf1',
      steps: [
        { id: 'step1', element: 'step:query', output_bindings: { result: 'table1.data' } },
      ],
    }
    const result = migrateV1ToV2(doc, [workflow])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'step1',
      fromPort: 'result',
      toNodeId: 'table1',
      toPort: 'data',
      edgeType: 'async',
    })
  })

  it('deduplicates edges when two workflows contain the same step producing the same edge', () => {
    const doc = parse('form form1 @ root ;')
    const wf1: V1Workflow = {
      id: 'wf1',
      steps: [{ id: 'step1', element: 'step:query', widget_bindings: { q: 'form1.submit' } }],
    }
    const wf2: V1Workflow = {
      id: 'wf2',
      steps: [{ id: 'step1', element: 'step:query', widget_bindings: { q: 'form1.submit' } }],
    }
    const result = migrateV1ToV2(doc, [wf1, wf2])
    // step1 in wf2 is skipped (ID collision); its edge would be duplicate — deduplicated
    expect(result.edges).toHaveLength(1)
  })

  it('skips adding a step node when its ID collides with an existing node', () => {
    const doc = parse('form form1 @ root ;')
    const workflow: V1Workflow = {
      id: 'wf1',
      steps: [
        { id: 'form1', element: 'step:query' }, // collides with existing node
      ],
    }
    const result = migrateV1ToV2(doc, [workflow])
    const form1Nodes = result.nodes.filter((n) => n.id === 'form1')
    expect(form1Nodes).toHaveLength(1)
  })

  it('edge IDs follow the e_{fromNodeId}_{fromPort}_{toNodeId}_{toPort} pattern', () => {
    const doc = parse('form widget1 @ root ;')
    const workflow: V1Workflow = {
      id: 'wf1',
      steps: [
        { id: 'step1', element: 'step:query', widget_bindings: { myPort: 'widget1.outputPort' } },
      ],
    }
    const result = migrateV1ToV2(doc, [workflow])
    expect(result.edges[0].id).toBe('e_widget1_outputPort_step1_myPort')
  })

  it('step with both widget_bindings and output_bindings produces two edges', () => {
    const doc = parse('form form1 @ root ;\ntable table1 @ root ;')
    const workflow: V1Workflow = {
      id: 'wf1',
      steps: [
        {
          id: 'step1',
          element: 'step:query',
          widget_bindings: { paramPort: 'form1.value' },
          output_bindings: { result: 'table1.data' },
        },
      ],
    }
    const result = migrateV1ToV2(doc, [workflow])
    expect(result.edges).toHaveLength(2)
    const edgeToStep = result.edges.find((e) => e.toNodeId === 'step1')
    const edgeFromStep = result.edges.find((e) => e.fromNodeId === 'step1')
    expect(edgeToStep).toBeDefined()
    expect(edgeFromStep).toBeDefined()
  })
})

// ---- Inline link grammar (Commit 2) ----------------------------------------

describe('inline link grammar — parse', () => {
  it('parses an on clause on a button node', () => {
    const src = `button btn1 @ root\n  on clicked -> mut1.run\n;`
    const doc = parse(src)
    expect(doc[0].inlineLinks).toHaveLength(1)
    expect(doc[0].inlineLinks![0]).toEqual<InlineLink>({
      direction: 'on',
      myPort: 'clicked',
      targetNodeId: 'mut1',
      targetPort: 'run',
    })
  })

  it('parses an input clause on a text node', () => {
    const src = `text txt1 @ root\n  input content <- sq1.firstRow\n;`
    const doc = parse(src)
    expect(doc[0].inlineLinks).toHaveLength(1)
    expect(doc[0].inlineLinks![0]).toEqual<InlineLink>({
      direction: 'input',
      myPort: 'content',
      targetNodeId: 'sq1',
      targetPort: 'firstRow',
    })
  })

  it('parses an output clause on a step node', () => {
    const src = `step:query sq1 @ root\n  output result -> tbl.setRows\n;`
    const doc = parse(src)
    expect(doc[0].inlineLinks).toHaveLength(1)
    expect(doc[0].inlineLinks![0]).toEqual<InlineLink>({
      direction: 'output',
      myPort: 'result',
      targetNodeId: 'tbl',
      targetPort: 'setRows',
    })
  })

  it('parses multiple inline link clauses on the same node', () => {
    const src = `step:condition cond1 @ root\n  output trueBranch -> approve.run\n  output falseBranch -> reject.run\n;`
    const doc = parse(src)
    expect(doc[0].inlineLinks).toHaveLength(2)
    expect(doc[0].inlineLinks![0].targetNodeId).toBe('approve')
    expect(doc[0].inlineLinks![1].targetNodeId).toBe('reject')
  })

  it('parses input clause with composite port name (dot-separated)', () => {
    // targetPort contains a dot: firstRow.name — split on FIRST dot only
    const src = `text txt1 @ root\n  input content <- sq1.firstRow.name\n;`
    const doc = parse(src)
    expect(doc[0].inlineLinks![0]).toMatchObject({
      direction: 'input',
      myPort: 'content',
      targetNodeId: 'sq1',
      targetPort: 'firstRow.name',
    })
  })

  it('parses a layout clause into style with layout_ prefix', () => {
    const src = `form form1 @ root\n  layout area="main" span="6"\n;`
    const doc = parse(src)
    expect(doc[0].style?.layout_area).toBe('main')
    expect(doc[0].style?.layout_span).toBe('6')
  })

  it('layout clause coexists with style block', () => {
    const src = `form form1 @ root\n  layout area="main"\n  style { gridX: "0"; }\n;`
    const doc = parse(src)
    expect(doc[0].style?.layout_area).toBe('main')
    expect(doc[0].style?.gridX).toBe('0')
  })

  it('throws ParseError for on clause missing arrow', () => {
    expect(() => parse('button btn @ root\n  on clicked target.run\n;')).toThrow(ParseError)
  })

  it('throws ParseError for input clause missing source dot separator', () => {
    expect(() => parse('text t @ root\n  input content <- nodewithoutdot\n;')).toThrow(ParseError)
  })
})

describe('inline link grammar — round-trip serialize/parse', () => {
  it('round-trips a node with on clause', () => {
    const src = `button btn1 @ root\n  on clicked -> mut1.run\n;`
    const doc1 = parse(src)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('round-trips a node with input and output clauses', () => {
    const src = [
      'step:query sq1 @ root',
      '  input params <- form1.values',
      '  output rows -> tbl1.setRows',
      ';',
    ].join('\n')
    const doc1 = parse(src)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })

  it('round-trips a node with layout clause', () => {
    const src = `form form1 @ root\n  layout area="sidebar" span="3"\n;`
    const doc1 = parse(src)
    const src2 = serialize(doc1)
    const doc2 = parse(src2)
    expect(doc2[0].style?.layout_area).toBe('sidebar')
    expect(doc2[0].style?.layout_span).toBe('3')
    expect(doc2).toEqual(doc1)
  })

  it('layout_* keys in style are emitted as layout clause, not inside style block', () => {
    const doc = parse(`form f1 @ root\n  layout area="main"\n;`)
    const src = serialize(doc)
    expect(src).toContain('layout area=')
    expect(src).not.toContain('layout_area')
  })

  it('regular style keys are still emitted inside style block', () => {
    const src = `table t @ root\n  style { gridX: "0"; gridW: "6"; }\n;`
    const doc1 = parse(src)
    const src2 = serialize(doc1)
    expect(src2).toContain('style {')
    expect(src2).toContain('gridX')
    const doc2 = parse(src2)
    expect(doc2).toEqual(doc1)
  })
})

// ---- normalizeInlineLinks (Commit 3) ---------------------------------------

describe('normalizeInlineLinks', () => {
  function makeDoc(nodes: import('../src/index').AuraNode[], edges: AuraEdge[] = []): AuraDocumentV2 {
    return { nodes, edges }
  }

  // Case 1: button on clicked -> mutation_step.run → async edge
  it('case 1: button on clicked -> mutation_step.run produces async edge', () => {
    const doc = makeDoc([
      { element: 'button', id: 'btn1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'clicked', targetNodeId: 'mutation_step', targetPort: 'run' },
      ]},
      { element: 'step:mutation', id: 'mutation_step', parentId: 'root' },
    ])
    const { doc: result, warnings } = normalizeInlineLinks(doc)
    expect(warnings).toHaveLength(0)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({
      id: 'e_btn1_clicked_mutation_step_run',
      fromNodeId: 'btn1', fromPort: 'clicked',
      toNodeId: 'mutation_step', toPort: 'run',
      edgeType: 'async',
    })
    expect(result.nodes[0].inlineLinks).toBeUndefined()
  })

  // Case 2: form on submitted -> mutation_step.run → async edge
  it('case 2: form on submitted -> mutation_step.run produces async edge', () => {
    const doc = makeDoc([
      { element: 'form', id: 'form1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'submitted', targetNodeId: 'mutation_step', targetPort: 'run' },
      ]},
      { element: 'step:mutation', id: 'mutation_step', parentId: 'root' },
    ])
    const { doc: result, warnings } = normalizeInlineLinks(doc)
    expect(warnings).toHaveLength(0)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'form1', fromPort: 'submitted',
      toNodeId: 'mutation_step', toPort: 'run',
      edgeType: 'async',
    })
  })

  // Case 3: step output result -> table (widget) → reactive edge
  it('case 3: step output result -> widget table produces reactive edge', () => {
    const doc = makeDoc([
      { element: 'step:query', id: 'sq1', parentId: 'root', inlineLinks: [
        { direction: 'output', myPort: 'result', targetNodeId: 'table1', targetPort: 'setRows' },
      ]},
      { element: 'table', id: 'table1', parentId: 'root' },
    ])
    const { doc: result, warnings } = normalizeInlineLinks(doc)
    expect(warnings).toHaveLength(0)
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'sq1', fromPort: 'result',
      toNodeId: 'table1', toPort: 'setRows',
      edgeType: 'reactive',
    })
  })

  // Case 4: step output result -> next_step (step:query) → async edge
  it('case 4: step output result -> step:query target produces async edge', () => {
    const doc = makeDoc([
      { element: 'step:query', id: 'sq1', parentId: 'root', inlineLinks: [
        { direction: 'output', myPort: 'result', targetNodeId: 'sq2', targetPort: 'run' },
      ]},
      { element: 'step:query', id: 'sq2', parentId: 'root' },
    ])
    const { doc: result } = normalizeInlineLinks(doc)
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'sq1', fromPort: 'result',
      toNodeId: 'sq2', toPort: 'run',
      edgeType: 'async',
    })
  })

  // Case 5: condition trueBranch + falseBranch → two async edges
  it('case 5: condition node with two output clauses produces two async edges', () => {
    const doc = makeDoc([
      { element: 'step:condition', id: 'cond1', parentId: 'root', inlineLinks: [
        { direction: 'output', myPort: 'trueBranch', targetNodeId: 'approve_step', targetPort: 'run' },
        { direction: 'output', myPort: 'falseBranch', targetNodeId: 'reject_step', targetPort: 'run' },
      ]},
      { element: 'step:mutation', id: 'approve_step', parentId: 'root' },
      { element: 'step:mutation', id: 'reject_step', parentId: 'root' },
    ])
    const { doc: result } = normalizeInlineLinks(doc)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]).toMatchObject({ fromPort: 'trueBranch', toNodeId: 'approve_step', edgeType: 'async' })
    expect(result.edges[1]).toMatchObject({ fromPort: 'falseBranch', toNodeId: 'reject_step', edgeType: 'async' })
  })

  // Case 6: widget input with composite port name (dot in source port)
  it('case 6: widget input <- step.firstRow.name produces reactive edge with composite port name', () => {
    const doc = makeDoc([
      { element: 'text', id: 'txt1', parentId: 'root', inlineLinks: [
        { direction: 'input', myPort: 'content', targetNodeId: 'sq1', targetPort: 'firstRow.name' },
      ]},
      { element: 'step:query', id: 'sq1', parentId: 'root' },
    ])
    const { doc: result, warnings } = normalizeInlineLinks(doc)
    expect(warnings).toHaveLength(0)
    expect(result.edges[0]).toMatchObject({
      id: 'e_sq1_firstRow.name_txt1_content',
      fromNodeId: 'sq1', fromPort: 'firstRow.name',
      toNodeId: 'txt1', toPort: 'content',
      edgeType: 'reactive',
    })
  })

  // Case 7: two nodes linking to same target → two distinct edges, no dup
  it('case 7: two nodes linking to same target produce two distinct edges', () => {
    const doc = makeDoc([
      { element: 'button', id: 'btn1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'clicked', targetNodeId: 'mut1', targetPort: 'run' },
      ]},
      { element: 'form', id: 'form1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'submitted', targetNodeId: 'mut1', targetPort: 'run' },
      ]},
      { element: 'step:mutation', id: 'mut1', parentId: 'root' },
    ])
    const { doc: result } = normalizeInlineLinks(doc)
    expect(result.edges).toHaveLength(2)
    const ids = result.edges.map((e) => e.id)
    expect(new Set(ids).size).toBe(2) // no duplicates
  })

  // Case 8: unknown target node → warning emitted, edge still present
  it('case 8: link to unknown node produces warning and dangling edge', () => {
    const doc = makeDoc([
      { element: 'button', id: 'btn1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'clicked', targetNodeId: 'ghost_node', targetPort: 'run' },
      ]},
    ])
    const { doc: result, warnings } = normalizeInlineLinks(doc)
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('ghost_node')
    expect(result.edges).toHaveLength(1) // edge still emitted
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'btn1', fromPort: 'clicked',
      toNodeId: 'ghost_node', toPort: 'run',
    })
  })

  // Case 9: round-trip through parseV2/serializeV2
  it('case 9: round-trip normalizeInlineLinks(parseV2(serializeV2(doc))).doc equals pre-serialization doc', () => {
    const preDoc: AuraDocumentV2 = {
      nodes: [
        { element: 'button', id: 'btn1', parentId: 'root' },
        { element: 'step:mutation', id: 'mut1', parentId: 'root' },
      ],
      edges: [
        { id: 'e_btn1_clicked_mut1_run', fromNodeId: 'btn1', fromPort: 'clicked', toNodeId: 'mut1', toPort: 'run', edgeType: 'async' },
      ],
    }
    const serialized = serializeV2(preDoc)
    const parsed = parseV2(serialized) // parseV2 calls normalizeInlineLinks internally
    const { doc: result } = normalizeInlineLinks(parsed) // second call is a no-op
    expect(result.nodes).toEqual(preDoc.nodes)
    expect(result.edges).toEqual(preDoc.edges)
  })

  // Deduplication: existing edge with same ID is not duplicated
  it('does not duplicate an edge if the same ID already exists in doc.edges', () => {
    const existingEdge: AuraEdge = {
      id: 'e_btn1_clicked_mut1_run',
      fromNodeId: 'btn1', fromPort: 'clicked',
      toNodeId: 'mut1', toPort: 'run',
      edgeType: 'async',
    }
    const doc = makeDoc([
      { element: 'button', id: 'btn1', parentId: 'root', inlineLinks: [
        { direction: 'on', myPort: 'clicked', targetNodeId: 'mut1', targetPort: 'run' },
      ]},
      { element: 'step:mutation', id: 'mut1', parentId: 'root' },
    ], [existingEdge])
    const { doc: result } = normalizeInlineLinks(doc)
    expect(result.edges).toHaveLength(1) // not duplicated
  })
})
