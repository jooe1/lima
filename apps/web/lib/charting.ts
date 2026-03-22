import { type DashboardQueryResponse } from './api'
import { applyDataFilters, type DataFilter } from './tableBinding'

export interface ChartPoint {
  label: string
  value: number
}

export interface ChartSeriesResult {
  labelColumn: string
  valueColumn: string
  points: ChartPoint[]
  error?: string
}

export type ChartAggregateMode = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max'

function coerceNumericValue(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return Number.NaN
    return Number(trimmed.replace(/,/g, ''))
  }
  return Number(value)
}

function aggregatePointValues(mode: Exclude<ChartAggregateMode, 'none' | 'count'>, values: number[]): number {
  if (mode === 'sum') {
    return values.reduce((sum, value) => sum + value, 0)
  }
  if (mode === 'avg') {
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
  if (mode === 'min') {
    return Math.min(...values)
  }
  return Math.max(...values)
}

function parseLimit(limit: number | string | undefined): number | undefined {
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) return limit
  if (typeof limit === 'string') {
    const parsed = parseInt(limit.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

export function buildChartSeries(
  data: DashboardQueryResponse | null,
  options: {
    labelCol?: string
    valueCol?: string
    aggregate?: string
    sortBy?: string
    sortDirection?: string
    limit?: number | string
    filters?: DataFilter[]
  } = {},
): ChartSeriesResult {
  if (!data) {
    return {
      labelColumn: '',
      valueColumn: '',
      points: [],
    }
  }

  const filteredData = applyDataFilters(data, options.filters) ?? data
  const aggregateMode = (options.aggregate?.trim() || 'none') as ChartAggregateMode
  const labelColumn = options.labelCol?.trim() || filteredData.columns[0] || ''
  const configuredValueColumn = options.valueCol?.trim() || filteredData.columns[1] || filteredData.columns[0] || ''

  if (!labelColumn) {
    return {
      labelColumn,
      valueColumn: configuredValueColumn,
      points: [],
      error: 'Choose a category column for this chart.',
    }
  }

  const rows = filteredData.rows
  if (rows.length === 0) {
    return {
      labelColumn,
      valueColumn: configuredValueColumn,
      points: [],
    }
  }

  let valueColumn = configuredValueColumn
  let points: ChartPoint[] = []

  if (aggregateMode === 'none') {
    if (!valueColumn) {
      return {
        labelColumn,
        valueColumn,
        points: [],
        error: 'Choose a value column for this chart.',
      }
    }

    points = rows.map(row => ({
      label: String(row[labelColumn] ?? ''),
      value: coerceNumericValue(row[valueColumn]),
    }))

    const hasNumericValue = points.some(point => Number.isFinite(point.value))
    if (!hasNumericValue) {
      return {
        labelColumn,
        valueColumn,
        points: [],
        error: `Value column "${valueColumn}" must be numeric.`,
      }
    }
  } else if (aggregateMode === 'count') {
    valueColumn = 'count'
    const grouped = new Map<string, number>()
    for (const row of rows) {
      const key = String(row[labelColumn] ?? '')
      grouped.set(key, (grouped.get(key) ?? 0) + 1)
    }
    points = Array.from(grouped.entries()).map(([label, value]) => ({ label, value }))
  } else {
    if (!valueColumn) {
      return {
        labelColumn,
        valueColumn,
        points: [],
        error: 'Choose a value column for this chart.',
      }
    }

    const grouped = new Map<string, number[]>()
    for (const row of rows) {
      const key = String(row[labelColumn] ?? '')
      const value = coerceNumericValue(row[valueColumn])
      if (!Number.isFinite(value)) continue
      const existing = grouped.get(key) ?? []
      existing.push(value)
      grouped.set(key, existing)
    }

    if (grouped.size === 0) {
      return {
        labelColumn,
        valueColumn,
        points: [],
        error: `Value column "${valueColumn}" must be numeric.`,
      }
    }

    points = Array.from(grouped.entries()).map(([label, values]) => ({
      label,
      value: aggregatePointValues(aggregateMode, values),
    }))
  }

  const normalizedSortBy = (options.sortBy?.trim() || 'none').toLowerCase()
  const sortDirection = options.sortDirection?.trim().toLowerCase() === 'asc' ? 1 : -1
  if (normalizedSortBy === 'label') {
    points.sort((left, right) => left.label.localeCompare(right.label) * sortDirection)
  } else if (normalizedSortBy === 'value') {
    points.sort((left, right) => (left.value - right.value) * sortDirection)
  }

  const maxPoints = parseLimit(options.limit)
  const limitedPoints = (maxPoints ? points.slice(0, maxPoints) : points).map(point => ({
      label: point.label,
      value: Number.isFinite(point.value) ? point.value : 0,
    }))

  return {
    labelColumn,
    valueColumn,
    points: limitedPoints,
  }
}