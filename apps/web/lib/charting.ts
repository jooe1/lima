import { type DashboardQueryResponse } from './api'

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

function coerceNumericValue(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return Number.NaN
    return Number(trimmed.replace(/,/g, ''))
  }
  return Number(value)
}

export function buildChartSeries(
  data: DashboardQueryResponse | null,
  options: { labelCol?: string; valueCol?: string; limit?: number } = {},
): ChartSeriesResult {
  if (!data) {
    return {
      labelColumn: '',
      valueColumn: '',
      points: [],
    }
  }

  const labelColumn = options.labelCol?.trim() || data.columns[0] || ''
  const valueColumn = options.valueCol?.trim() || data.columns[1] || data.columns[0] || ''
  if (!labelColumn || !valueColumn) {
    return {
      labelColumn,
      valueColumn,
      points: [],
      error: 'Query must return label and value columns.',
    }
  }

  const rows = data.rows.slice(0, options.limit ?? 20)
  if (rows.length === 0) {
    return {
      labelColumn,
      valueColumn,
      points: [],
    }
  }

  const points = rows.map(row => ({
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

  return {
    labelColumn,
    valueColumn,
    points: points.map(point => ({
      label: point.label,
      value: Number.isFinite(point.value) ? point.value : 0,
    })),
  }
}