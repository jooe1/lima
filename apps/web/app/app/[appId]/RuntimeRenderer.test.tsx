import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { FlowEngineProvider, RuntimeRenderer, useFlowEngine, resolveSqlTemplate } from './RuntimeRenderer'
import type { AuraNode, AuraEdge } from '@lima/aura-dsl'

// ---- API mock ---------------------------------------------------------------

const mockRunConnectorMutation = vi.fn()
const mockRunConnectorQuery = vi.fn()

vi.mock('../../../lib/api', () => ({
  runConnectorMutation: (...args: unknown[]) => mockRunConnectorMutation(...args),
  runConnectorQuery: (...args: unknown[]) => mockRunConnectorQuery(...args),
  triggerWorkflow: vi.fn().mockResolvedValue({ status: 'ok' }),
}))

// ---- Helper -----------------------------------------------------------------

/**
 * Renders FlowEngineProvider with the given nodes/edges and returns a wrapper
 * around firePort that is safely called inside act().
 */
function renderEngine(nodes: AuraNode[], edges: AuraEdge[]) {
  const firePortRef = {
    current: null as null | ((nodeId: string, portName: string, value: unknown) => Promise<void>),
  }

  function Capture() {
    const { firePort } = useFlowEngine()
    firePortRef.current = firePort
    return null
  }

  render(
    <FlowEngineProvider nodes={nodes} edges={edges} workspaceId="ws1">
      <Capture />
    </FlowEngineProvider>,
  )

  return {
    async firePort(nodeId: string, portName: string, value: unknown) {
      await act(async () => {
        await firePortRef.current!(nodeId, portName, value)
      })
    },
  }
}

// ---- Fixtures ---------------------------------------------------------------

const FORM_NODE: AuraNode = {
  id: 'form1',
  element: 'form',
  parentId: 'root',
  with: { fields: 'email,name' },
}

const MUTATION_NODE: AuraNode = {
  id: 'mut1',
  element: 'step:mutation',
  parentId: 'root',
  with: { connector_id: 'conn1', sql: 'INSERT INTO t (email) VALUES ({{email}})' },
}

// ---- Tests ------------------------------------------------------------------

describe('FlowEngineProvider — binding edge / mutation trigger', () => {
  beforeEach(() => {
    mockRunConnectorMutation.mockClear()
    mockRunConnectorMutation.mockResolvedValue({ affected_rows: 1 })
    mockRunConnectorQuery.mockClear()
    mockRunConnectorQuery.mockResolvedValue({ rows: [], columns: [] })
  })

  it('Test 1: binding edge does NOT trigger mutation execution', async () => {
    const edges: AuraEdge[] = [
      {
        id: 'e1',
        fromNodeId: 'form1',
        fromPort: 'email',
        toNodeId: 'mut1',
        toPort: 'bind:set:0',
        edgeType: 'binding',
      },
    ]
    const { firePort } = renderEngine([FORM_NODE, MUTATION_NODE], edges)
    await firePort('form1', 'email', 'alice@example.com')
    expect(mockRunConnectorMutation).not.toHaveBeenCalled()
  })

  it('Test 2: run trigger DOES execute mutation', async () => {
    const edges: AuraEdge[] = [
      {
        id: 'e1',
        fromNodeId: 'form1',
        fromPort: 'submitted',
        toNodeId: 'mut1',
        toPort: 'run',
        edgeType: 'async',
      },
    ]
    const { firePort } = renderEngine([FORM_NODE, MUTATION_NODE], edges)
    await firePort('form1', 'submitted', { email: 'alice@example.com' })
    expect(mockRunConnectorMutation).toHaveBeenCalledOnce()
  })

  it('Test 3: binding edge populates slot accumulator without executing mutation', async () => {
    const edges: AuraEdge[] = [
      {
        id: 'e1',
        fromNodeId: 'form1',
        fromPort: 'email',
        toNodeId: 'mut1',
        toPort: 'bind:set:0',
        edgeType: 'binding',
      },
    ]
    const { firePort } = renderEngine([FORM_NODE, MUTATION_NODE], edges)
    await firePort('form1', 'email', 'test@example.com')
    expect(mockRunConnectorMutation).not.toHaveBeenCalled()
  })

  it('Test 4: slot bag values are resolved in SQL before mutation executes', async () => {
    const MUT4: AuraNode = {
      id: 'mut4',
      element: 'step:mutation',
      parentId: 'root',
      with: {
        connector_id: 'conn1',
        sql: "INSERT INTO t (name, email) VALUES ('{{slot.set.0}}', '{{slot.set.1}}')",
      },
    }
    const edges: AuraEdge[] = [
      { id: 'e1', fromNodeId: 'form1', fromPort: 'name',      toNodeId: 'mut4', toPort: 'bind:set:0', edgeType: 'binding' },
      { id: 'e2', fromNodeId: 'form1', fromPort: 'email',     toNodeId: 'mut4', toPort: 'bind:set:1', edgeType: 'binding' },
      { id: 'e3', fromNodeId: 'form1', fromPort: 'submitted', toNodeId: 'mut4', toPort: 'run',        edgeType: 'async' },
    ]
    const { firePort } = renderEngine([FORM_NODE, MUT4], edges)
    await firePort('form1', 'name',  'Alice')
    await firePort('form1', 'email', 'alice@example.com')
    await firePort('form1', 'submitted', {})
    expect(mockRunConnectorMutation).toHaveBeenCalledOnce()
    expect(mockRunConnectorMutation).toHaveBeenCalledWith(
      'ws1',
      'conn1',
      { sql: "INSERT INTO t (name, email) VALUES ('Alice', 'alice@example.com')" },
    )
  })

  it('Test 5: SQL injection in slot bag is escaped (single quotes doubled)', async () => {
    const MUT5: AuraNode = {
      id: 'mut5',
      element: 'step:mutation',
      parentId: 'root',
      with: {
        connector_id: 'conn1',
        sql: "SELECT * WHERE name = '{{slot.set.0}}'",
      },
    }
    const edges: AuraEdge[] = [
      { id: 'e1', fromNodeId: 'form1', fromPort: 'name',      toNodeId: 'mut5', toPort: 'bind:set:0', edgeType: 'binding' },
      { id: 'e2', fromNodeId: 'form1', fromPort: 'submitted', toNodeId: 'mut5', toPort: 'run',        edgeType: 'async' },
    ]
    const { firePort } = renderEngine([FORM_NODE, MUT5], edges)
    await firePort('form1', 'name', "O'Brien")
    await firePort('form1', 'submitted', {})
    expect(mockRunConnectorMutation).toHaveBeenCalledWith(
      'ws1',
      'conn1',
      { sql: "SELECT * WHERE name = 'O''Brien'" },
    )
  })

  it('Test 6: resolveSqlTemplate resolves slot tokens and legacy path tokens in the same SQL', () => {
    const sql = "VALUES ('{{slot.set.0}}', '{{form1.email}}')"
    const data = { email: 'b@x.com' }
    const slotBag = { 'slot.set.0': 'Alice' }
    expect(resolveSqlTemplate(sql, data, slotBag)).toBe("VALUES ('Alice', 'b@x.com')")
  })

  it('Test 7: table selectedRow populates connected form setValues even when keys differ by case/format', async () => {
    mockRunConnectorQuery.mockResolvedValue({
      rows: [{ FirstName: 'Alice', Last_Name: 'Doe', EmailAddress: 'alice@example.com' }],
      columns: ['FirstName', 'Last_Name', 'EmailAddress'],
    })

    const tableNode: AuraNode = {
      id: 'table1',
      element: 'table',
      parentId: 'root',
      with: { connector: 'conn1', connectorType: 'managed', sql: 'SELECT * FROM contacts' },
      style: { gridX: '0', gridY: '0', gridW: '6', gridH: '4' },
    }

    const editFormNode: AuraNode = {
      id: 'form2',
      element: 'form',
      parentId: 'root',
      with: { fields: 'firstName,lastName,emailAddress' },
      style: { gridX: '6', gridY: '0', gridW: '6', gridH: '4' },
    }

    const edges: AuraEdge[] = [
      {
        id: 'e1',
        fromNodeId: 'table1',
        fromPort: 'selectedRow',
        toNodeId: 'form2',
        toPort: 'setValues',
        edgeType: 'reactive',
      },
    ]

    render(
      <RuntimeRenderer
        doc={[tableNode, editFormNode]}
        edges={edges}
        workspaceId="ws1"
        appId="app1"
      />,
    )

    fireEvent.click(await screen.findByText('Alice'))

    await waitFor(() => {
      const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
      expect(inputs).toHaveLength(3)
      expect(inputs[0].value).toBe('Alice')
      expect(inputs[1].value).toBe('Doe')
      expect(inputs[2].value).toBe('alice@example.com')
    })
  })
})
