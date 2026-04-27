import { describe, expect, it } from 'vitest'

import { getAppProductionIssues, hasConnectorBinding } from './appValidation'

describe('appValidation', () => {
  it('treats query-driven widgets as data-bound', () => {
    expect(hasConnectorBinding({
      element: 'table',
      id: 'orders',
      parentId: 'root',
      with: { queryAction: 'load_orders' },
    } as any)).toBe(true)
  })

  it('does not flag query-driven tables as missing a data binding', () => {
    const issues = getAppProductionIssues([
      {
        element: 'table',
        id: 'orders',
        parentId: 'root',
        with: { queryAction: 'load_orders', columns: 'OrderID,Amount' },
      },
    ] as any)

    expect(issues.some(issue => issue.code === 'missing_data_binding')).toBe(false)
  })
})