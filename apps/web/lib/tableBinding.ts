import { type DashboardQueryResponse } from './api'

export type TableAggregateMode = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface DataFilter {
  column?: string
  value?: string
}

interface TableBindingOptions {
  filterColumn?: string
  filterValue?: string
  aggregate?: string
  groupBy?: string
  aggregateColumn?: string
  filters?: DataFilter[]
}

function normalizeColumns(rawColumns: string | undefined): string[] {
  return (rawColumns ?? '')
    .split(',')
    .map(column => column.trim())
    .filter(Boolean)
}

function normalizeText(value: unknown): string {
  return value == null ? '' : String(value)
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function filterRows(
  rows: Record<string, unknown>[],
  columns: string[],
  filterColumn: string,
  filterValue: string,
): Record<string, unknown>[] {
  const needle = filterValue.trim().toLowerCase()
  if (!needle) return rows

  const normalizedColumn = filterColumn.trim()
  if (normalizedColumn) {
    return rows.filter(row => normalizeText(row[normalizedColumn]).toLowerCase().includes(needle))
  }

  return rows.filter(row =>
    columns.some(column => normalizeText(row[column]).toLowerCase().includes(needle)),
  )
}

export function applyDataFilters(
  data: DashboardQueryResponse | null,
  filters: DataFilter[] = [],
): DashboardQueryResponse | null {
  if (!data) return null

  let filteredRows = data.rows
  for (const filter of filters) {
    filteredRows = filterRows(
      filteredRows,
      data.columns,
      filter.column?.trim() ?? '',
      filter.value?.trim() ?? '',
    )
  }

  return {
    columns: data.columns,
    rows: filteredRows,
    row_count: filteredRows.length,
  }
}

function buildAggregateColumnName(mode: TableAggregateMode, aggregateColumn: string): string {
  if (mode === 'count') return 'count'
  const suffix = aggregateColumn.trim() || 'value'
  return `${mode}_${suffix}`
}

function aggregateRows(
  rows: Record<string, unknown>[],
  mode: TableAggregateMode,
  groupBy: string,
  aggregateColumn: string,
): DashboardQueryResponse {
  const normalizedGroupBy = groupBy.trim()
  const normalizedAggregateColumn = aggregateColumn.trim()
  const valueColumnName = buildAggregateColumnName(mode, normalizedAggregateColumn)

  if (mode === 'count') {
    if (!normalizedGroupBy) {
      return {
        columns: [valueColumnName],
        rows: [{ [valueColumnName]: rows.length }],
        row_count: 1,
      }
    }

    const counts = new Map<string, number>()
    for (const row of rows) {
      const key = normalizeText(row[normalizedGroupBy])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const groupedRows = Array.from(counts.entries())
      .map(([key, count]) => ({ [normalizedGroupBy]: key, [valueColumnName]: count }))
      .sort((left, right) => Number(right[valueColumnName]) - Number(left[valueColumnName]))

    return {
      columns: [normalizedGroupBy, valueColumnName],
      rows: groupedRows,
      row_count: groupedRows.length,
    }
  }

  if (!normalizedAggregateColumn) {
    return {
      columns: [],
      rows: [],
      row_count: 0,
      error: `Select a value column to use ${mode}.`,
    }
  }

  if (!normalizedGroupBy) {
    const values = rows
      .map(row => coerceNumber(row[normalizedAggregateColumn]))
      .filter((value): value is number => value != null)

    if (values.length === 0) {
      return {
        columns: [],
        rows: [],
        row_count: 0,
        error: `Column "${normalizedAggregateColumn}" must contain numeric values.`,
      }
    }

    const aggregatedValue =
      mode === 'sum'
        ? values.reduce((sum, value) => sum + value, 0)
        : mode === 'avg'
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : mode === 'min'
            ? Math.min(...values)
            : Math.max(...values)

    return {
      columns: [valueColumnName],
      rows: [{ [valueColumnName]: aggregatedValue }],
      row_count: 1,
    }
  }

  const groupedValues = new Map<string, number[]>()
  for (const row of rows) {
    const key = normalizeText(row[normalizedGroupBy])
    const value = coerceNumber(row[normalizedAggregateColumn])
    if (value == null) continue
    const existing = groupedValues.get(key) ?? []
    existing.push(value)
    groupedValues.set(key, existing)
  }

  if (groupedValues.size === 0) {
    return {
      columns: [],
      rows: [],
      row_count: 0,
      error: `Column "${normalizedAggregateColumn}" must contain numeric values.`,
    }
  }

  const groupedRows = Array.from(groupedValues.entries())
    .map(([key, values]) => {
      const aggregatedValue =
        mode === 'sum'
          ? values.reduce((sum, value) => sum + value, 0)
          : mode === 'avg'
            ? values.reduce((sum, value) => sum + value, 0) / values.length
            : mode === 'min'
              ? Math.min(...values)
              : Math.max(...values)

      return {
        [normalizedGroupBy]: key,
        [valueColumnName]: aggregatedValue,
      }
    })
    .sort((left, right) => Number(right[valueColumnName]) - Number(left[valueColumnName]))

  return {
    columns: [normalizedGroupBy, valueColumnName],
    rows: groupedRows,
    row_count: groupedRows.length,
  }
}

export function getVisibleTableColumns(
  data: DashboardQueryResponse | null,
  configuredColumns: string | undefined,
): string[] {
  const normalizedConfiguredColumns = normalizeColumns(configuredColumns)
  if (normalizedConfiguredColumns.length > 0) {
    return normalizedConfiguredColumns
  }
  return data?.columns ?? []
}

export function getConnectorSchemaColumns(
  connector: { schema_cache?: Record<string, unknown> } | undefined,
): string[] {
  const columns = connector?.schema_cache?.columns
  if (!Array.isArray(columns)) return []

  return columns.flatMap(column => {
    if (typeof column === 'string') return [column]
    if (column && typeof column === 'object' && 'name' in column) {
      const name = (column as Record<string, unknown>).name
      return typeof name === 'string' && name.trim() ? [name] : []
    }
    return []
  })
}

export function mergeColumns(...groups: string[][]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const group of groups) {
    for (const column of group) {
      const normalized = column.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      merged.push(normalized)
    }
  }

  return merged
}

export function applyTableDataBinding(
  data: DashboardQueryResponse | null,
  options: TableBindingOptions,
): DashboardQueryResponse | null {
  if (!data) return null

  const filteredData = applyDataFilters(data, [
    ...(options.filters ?? []),
    {
      column: options.filterColumn,
      value: options.filterValue,
    },
  ])
  const filteredRows = filteredData?.rows ?? []

  const aggregateMode = (options.aggregate?.trim() || 'none') as TableAggregateMode
  if (aggregateMode === 'none') {
    return {
      columns: data.columns,
      rows: filteredRows,
      row_count: filteredRows.length,
    }
  }

  return aggregateRows(
    filteredRows,
    aggregateMode,
    options.groupBy ?? '',
    options.aggregateColumn ?? '',
  )
}

export function getConnectorQuerySQL(
  connectorType: string | undefined,
  sql: string | undefined,
): string | null {
  const trimmed = sql?.trim() ?? ''
  if (connectorType === 'csv') {
    return trimmed || 'SELECT * FROM csv'
  }
  if (connectorType === 'managed') {
    // Managed (Lima Table) connectors serve rows directly — no SQL.
    // Return a sentinel so querySql is truthy and the preview fetch fires.
    return 'SELECT * FROM managed'
  }
  if (connectorType === 'rest') {
    // For REST connectors, sql holds the endpoint path (e.g. "/users").
    // Default to "/" so querySql is always truthy — the backend treats "/"
    // as "call the base URL directly" (no path appended), which is the right
    // behaviour when the full URL is already the connector's base_url.
    return trimmed || '/'
  }
  return trimmed || null
}