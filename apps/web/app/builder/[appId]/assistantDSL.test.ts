import { describe, expect, it } from 'vitest'
import { normalizeAssistantDSL } from './assistantDSL'

describe('normalizeAssistantDSL', () => {
  it('passes through runtime Aura DSL unchanged', () => {
    const source = [
      'form order_form @ root',
      '  with fields="OrderID"',
      ';',
    ].join('\n')

    const normalized = normalizeAssistantDSL(source)
    expect(normalized.mode).toBe('runtime')
    expect(normalized.source).toBe(source)
    expect(normalized.document.nodes[0]).toMatchObject({ element: 'form', id: 'order_form' })
  })

  it('compiles authoring Aura into runtime Aura DSL and edges', () => {
    const source = [
      'app order_admin',
      'page main title="Orders"',
      'widget form order_form @ main title="Order Form"',
      'field order_form OrderID',
      'widget table orders @ main title="Orders"',
      'column orders OrderID',
      'action save_order @ main kind=managed_crud form=order_form table=orders',
      'bind orders.selected_row -> order_form.values',
      'run order_form.submitted -> save_order',
    ].join('\n')

    const normalized = normalizeAssistantDSL(source)
    expect(normalized.mode).toBe('authoring')
    expect(normalized.source).toContain('form order_form @ main')
    expect(normalized.source).toContain('step:mutation save_order @ main')
    expect(normalized.edges).toContainEqual(expect.objectContaining({
      fromNodeId: 'orders',
      fromPort: 'selectedRow',
      toNodeId: 'order_form',
      toPort: 'setValues',
      edgeType: 'reactive',
    }))
  })

  it('prefers explicit new_edges for runtime Aura patches', () => {
    const source = [
      'button submit_button @ root',
      '  text "Submit"',
      ';',
    ].join('\n')

    const normalized = normalizeAssistantDSL(source, [{
      id: 'e_submit_button_clicked_save_order_run',
      fromNodeId: 'submit_button',
      fromPort: 'clicked',
      toNodeId: 'save_order',
      toPort: 'run',
      edgeType: 'async',
    }])

    expect(normalized.mode).toBe('runtime')
    expect(normalized.edges).toHaveLength(1)
    expect(normalized.edges[0].id).toBe('e_submit_button_clicked_save_order_run')
  })

  it('uses builder connector context to compile query authoring without explicit connector metadata', () => {
    const source = [
      'app revenue_dashboard',
      'page main title="Revenue Dashboard"',
      'widget table orders @ main title="Recent Orders"',
      'action load_orders @ main kind=query source=orders target=orders',
      'run page.loaded -> load_orders',
    ].join('\n')

    const normalized = normalizeAssistantDSL(source, undefined, {
      connectors: [{
        id: 'conn_orders',
        workspace_id: 'ws_1',
        name: 'Orders',
        type: 'managed',
        schema_cache: { columns: ['OrderID', 'Amount'] },
        created_by: 'user_1',
        created_at: '2026-04-27T00:00:00Z',
        updated_at: '2026-04-27T00:00:00Z',
        owner_scope: 'workspace',
      }],
    })

    const loadOrders = normalized.document.nodes.find((node) => node.id === 'load_orders')
    expect(normalized.mode).toBe('authoring')
    expect(loadOrders?.with).toMatchObject({
      connector_id: 'conn_orders',
      connectorType: 'managed',
      resultColumns: 'OrderID,Amount',
      sql: '',
    })
  })
})