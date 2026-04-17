import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import { FlowCanvas, migrateLegacyBindingTokens, validateBindings } from './FlowCanvas'
import type { AuraDocumentV2 } from '@lima/aura-dsl'

// Capture the onConnect prop passed to <ReactFlow> so tests can invoke it directly.
let capturedOnConnect: ((connection: Record<string, unknown>) => void) | undefined

vi.mock('@xyflow/react', () => {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
  return {
    ReactFlow: (props: any) => {
      capturedOnConnect = props.onConnect
      return null
    },
    ReactFlowProvider: ({ children }: any) => children,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position,
    useNodesState: (initial: any) => [initial, vi.fn(), vi.fn()],
    useEdgesState: (initial: any) => [initial, vi.fn(), vi.fn()],
    useReactFlow: () => ({ screenToFlowPosition: (p: any) => p }),
    addEdge: (_edge: any, edges: any[]) => edges,
  }
})

// A form node with two explicit fields and a mutation node with a simple UPDATE.
// UPDATE users SET email = 'placeholder' → tryParseSQL gives setClauses[0] = { col:'email', val:'placeholder' }
// so targetHandle 'bind:set:0' is valid.
const BASE_DOC: AuraDocumentV2 = {
  nodes: [
    {
      id: 'form1',
      element: 'form',
      parentId: 'root',
      with: { fields: 'name,email' },
    },
    {
      id: 'mut1',
      element: 'step:mutation',
      parentId: 'root',
      with: { sql: "UPDATE users SET email = 'placeholder'" },
    },
  ],
  edges: [],
}

const MOCK_REACTIVE_STORE = {
  get: vi.fn(),
  set: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}

describe('FlowCanvas onConnect — bind slot type validation', () => {
  let onChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    capturedOnConnect = undefined
    onChange = vi.fn()
    render(
      <FlowCanvas
        doc={BASE_DOC}
        selectedId={null}
        onSelect={vi.fn()}
        onChange={onChange}
        workspaceId="ws1"
        reactiveStore={MOCK_REACTIVE_STORE as any}
      />
    )
  })

  it('rejects form1.values (dataType object) wired to bind:set:0 — onChange NOT called', () => {
    expect(capturedOnConnect).toBeDefined()
    capturedOnConnect!({
      source: 'form1',
      sourceHandle: 'values',
      target: 'mut1',
      targetHandle: 'bind:set:0',
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('accepts form1.email (dataType string, expanded port) wired to bind:set:0 — onChange IS called', () => {
    expect(capturedOnConnect).toBeDefined()
    capturedOnConnect!({
      source: 'form1',
      sourceHandle: 'email',
      target: 'mut1',
      targetHandle: 'bind:set:0',
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDoc = onChange.mock.calls[0][0] as AuraDocumentV2
    const mutNode = updatedDoc.nodes.find(n => n.id === 'mut1')
    expect(mutNode?.with?.sql).toContain('{{slot.set.0}}')
  })

  it('slot token does not contain widget id — {{slot.set.0}} not {{form1.email}}', () => {
    expect(capturedOnConnect).toBeDefined()
    capturedOnConnect!({
      source: 'form1',
      sourceHandle: 'email',
      target: 'mut1',
      targetHandle: 'bind:set:0',
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDoc = onChange.mock.calls[0][0] as AuraDocumentV2
    const mutNode = updatedDoc.nodes.find(n => n.id === 'mut1')
    expect(mutNode?.with?.sql).toContain('{{slot.set.0}}')
    expect(mutNode?.with?.sql).not.toContain('{{form1.email}}')
  })
})

const WHERE_DOC: AuraDocumentV2 = {
  nodes: [
    {
      id: 'form1',
      element: 'form',
      parentId: 'root',
      with: { fields: 'name,email' },
    },
    {
      id: 'mut1',
      element: 'step:mutation',
      parentId: 'root',
      with: { sql: "UPDATE users SET email = 'x' WHERE id = '1' AND name = 'y'" },
    },
  ],
  edges: [],
}

describe('FlowCanvas onConnect — bind:where slot token', () => {
  let onChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    capturedOnConnect = undefined
    onChange = vi.fn()
    render(
      <FlowCanvas
        doc={WHERE_DOC}
        selectedId={null}
        onSelect={vi.fn()}
        onChange={onChange}
        workspaceId="ws1"
        reactiveStore={MOCK_REACTIVE_STORE as any}
      />
    )
  })

  it('binding form1.name → bind:where:1 writes {{slot.where.1}} into SQL', () => {
    expect(capturedOnConnect).toBeDefined()
    capturedOnConnect!({
      source: 'form1',
      sourceHandle: 'name',
      target: 'mut1',
      targetHandle: 'bind:where:1',
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDoc = onChange.mock.calls[0][0] as AuraDocumentV2
    const mutNode = updatedDoc.nodes.find(n => n.id === 'mut1')
    expect(mutNode?.with?.sql).toContain('{{slot.where.1}}')
  })
})

describe('migrateLegacyBindingTokens', () => {
  it('Test 1: migrates legacy {{widgetId.port}} token to {{slot.set.N}}', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'form1',
          element: 'form',
          parentId: 'root',
          with: { fields: 'name' },
        },
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: { sql: "INSERT INTO t (name) VALUES ('{{form1.name}}')" },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: 'name',
          toNodeId: 'mut1',
          toPort: 'bind:set:0',
          edgeType: 'binding',
        },
      ],
    }

    const result = migrateLegacyBindingTokens(doc)
    const mutNode = result.nodes.find(n => n.id === 'mut1')
    expect(mutNode?.with?.sql).toBe("INSERT INTO t (name) VALUES ('{{slot.set.0}}')")
  })

  it('Test 2: idempotent — calling twice does not change already-migrated SQL', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'form1',
          element: 'form',
          parentId: 'root',
          with: { fields: 'name' },
        },
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: { sql: "INSERT INTO t (name) VALUES ('{{slot.set.0}}')" },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: 'name',
          toNodeId: 'mut1',
          toPort: 'bind:set:0',
          edgeType: 'binding',
        },
      ],
    }

    const once = migrateLegacyBindingTokens(doc)
    const twice = migrateLegacyBindingTokens(once)
    const mutNode = twice.nodes.find(n => n.id === 'mut1')
    expect(mutNode?.with?.sql).toBe("INSERT INTO t (name) VALUES ('{{slot.set.0}}')")
  })

  it('Test 3: non-mutation widget nodes are not modified', () => {
    const formNode = {
      id: 'form1',
      element: 'form',
      parentId: 'root',
      with: { fields: 'name' },
    }
    const doc: AuraDocumentV2 = {
      nodes: [formNode],
      edges: [],
    }

    const result = migrateLegacyBindingTokens(doc)
    expect(result.nodes[0]).toBe(formNode) // same reference — not cloned
  })

  it('Test 4: WHERE clause binding — bind:where:1 migrates {{form1.id}} to {{slot.where.1}}', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'form1',
          element: 'form',
          parentId: 'root',
          with: { fields: 'id' },
        },
        {
          id: 'qry1',
          element: 'step:query',
          parentId: 'root',
          with: { sql: "SELECT * FROM t WHERE id = '{{form1.id}}'" },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: 'id',
          toNodeId: 'qry1',
          toPort: 'bind:where:1',
          edgeType: 'binding',
        },
      ],
    }

    const result = migrateLegacyBindingTokens(doc)
    const qryNode = result.nodes.find(n => n.id === 'qry1')
    expect(qryNode?.with?.sql).toBe("SELECT * FROM t WHERE id = '{{slot.where.1}}'")
  })

  it('migrates wildcard form bindings to concrete field ports when the target slot column matches a form field', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'form1',
          element: 'form',
          parentId: 'root',
          style: { fields: 'FirstName,LastName,Company' },
        },
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: {
            sql: "INSERT INTO people (FirstName, LastName, Company) VALUES ('{{slot.set.0}}', '{{slot.set.1}}', '{{slot.set.2}}')",
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: '*',
          toNodeId: 'mut1',
          toPort: 'bind:set:0',
          edgeType: 'binding',
        },
        {
          id: 'e2',
          fromNodeId: 'form1',
          fromPort: '*',
          toNodeId: 'mut1',
          toPort: 'bind:set:1',
          edgeType: 'binding',
        },
        {
          id: 'e3',
          fromNodeId: 'form1',
          fromPort: '*',
          toNodeId: 'mut1',
          toPort: 'bind:set:2',
          edgeType: 'binding',
        },
      ],
    }

    const result = migrateLegacyBindingTokens(doc)
    expect(result.edges.find(edge => edge.id === 'e1')?.fromPort).toBe('FirstName')
    expect(result.edges.find(edge => edge.id === 'e2')?.fromPort).toBe('LastName')
    expect(result.edges.find(edge => edge.id === 'e3')?.fromPort).toBe('Company')
  })
})

describe('validateBindings', () => {
  it('Test 1: fully wired mutation with run trigger — no issues', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: { sql: "INSERT INTO t (name) VALUES ('{{slot.set.0}}')" },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: 'name',
          toNodeId: 'mut1',
          toPort: 'bind:set:0',
          edgeType: 'binding',
        },
        {
          id: 'e2',
          fromNodeId: 'form1',
          fromPort: 'submitted',
          toNodeId: 'mut1',
          toPort: 'run',
          edgeType: 'async',
        },
      ],
    }
    expect(validateBindings(doc)).toEqual([])
  })

  it('Test 2: unwired slot — returns one error mentioning slot.set.0', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: { sql: "INSERT INTO t (name) VALUES ('{{slot.set.0}}')" },
        },
      ],
      edges: [],
    }
    const issues = validateBindings(doc)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('slot.set.0')
  })

  it('Test 3: binding edge present but no run trigger — returns one warning mentioning "run"', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'mut1',
          element: 'step:mutation',
          parentId: 'root',
          with: { sql: "INSERT INTO t (name) VALUES ('{{slot.set.0}}')" },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNodeId: 'form1',
          fromPort: 'name',
          toNodeId: 'mut1',
          toPort: 'bind:set:0',
          edgeType: 'binding',
        },
      ],
    }
    const issues = validateBindings(doc)
    // The unwired-slot check does not fire because the binding edge is present
    const warnings = issues.filter(i => i.severity === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('run')
  })

  it('Test 4: non-mutation node — validateBindings returns no issues for it', () => {
    const doc: AuraDocumentV2 = {
      nodes: [
        {
          id: 'qry1',
          element: 'step:query',
          parentId: 'root',
          with: { sql: "SELECT * FROM t WHERE id = '{{slot.where.0}}'" },
        },
      ],
      edges: [],
    }
    expect(validateBindings(doc)).toEqual([])
  })
})
