import { describe, expect, it } from 'vitest'

import { sqlFromGuided, tryParseSQL, type GuidedState } from './stepSqlUtils'

describe('stepSqlUtils', () => {
  it('round-trips managed update SQL with quoted template values and quoted where identifiers', () => {
    const sql = 'UPDATE orders SET "Date"=\'{{Date}}\', "CustomerName"=\'{{CustomerName}}\' WHERE "OrderID"=\'{{OrderID}}\''

    const guided = tryParseSQL(sql, false)

    expect(guided).not.toBeNull()
    expect(guided?.setClauses).toEqual([
      { col: 'Date', val: '{{Date}}', quoted: true },
      { col: 'CustomerName', val: '{{CustomerName}}', quoted: true },
    ])
    expect(guided?.whereClauses).toEqual([
      { col: 'OrderID', op: '=', val: '{{OrderID}}', quoted: true },
    ])
    expect(sqlFromGuided(guided!, false)).toBe(
      'UPDATE orders SET Date = \'{{Date}}\', CustomerName = \'{{CustomerName}}\' WHERE OrderID = \'{{OrderID}}\'',
    )
  })
})

describe('stepSqlUtils mutation helpers', () => {
  it('ignores blank WHERE rows instead of emitting a dangling WHERE clause', () => {
    const state: GuidedState = {
      table: 'contacts',
      whereClauses: [{ col: '', op: '=', val: '' }],
      limit: '50',
      mutationOp: 'DELETE',
      setClauses: [{ col: '', val: '' }],
    }

    expect(sqlFromGuided(state, false)).toBe('DELETE FROM contacts')
  })

  it('round-trips INSERT DEFAULT VALUES back into guided mode', () => {
    const state: GuidedState = {
      table: 'contacts',
      whereClauses: [],
      limit: '50',
      mutationOp: 'INSERT',
      setClauses: [{ col: '', val: '' }],
    }

    const sql = sqlFromGuided(state, false)
    expect(sql).toBe('INSERT INTO contacts DEFAULT VALUES')
    expect(tryParseSQL(sql, false)).toEqual(state)
  })
})