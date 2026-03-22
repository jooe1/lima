/**
 * Lima widget catalog — shared type contracts between the DSL, AI generation
 * layer, builder canvas, and runtime renderer.
 *
 * Adding a new widget type:
 *  1. Add its name to `WidgetType`.
 *  2. Add its prop schema to `WidgetPropSchemas`.
 *  3. Register it in `WIDGET_REGISTRY`.
 *
 * The renderer in apps/web imports from this package so that builder and
 * runtime always agree on widget shape.
 */

// ---- Widget types ----------------------------------------------------------

export type WidgetType =
  | 'table'
  | 'form'
  | 'text'
  | 'button'
  | 'chart'
  | 'kpi'
  | 'filter'
  | 'container'
  | 'modal'
  | 'tabs'
  | 'markdown'

// ---- Dashboard layout hints ------------------------------------------------
// DashboardQueryHint annotates a widget with the query pattern that best feeds
// it. The AI generation layer uses these hints to select and configure data
// bindings when building dashboard-oriented apps.

export type DashboardQueryPattern =
  | 'aggregate'   // single-row aggregate (COUNT, SUM, AVG) — best for KPI
  | 'time_series' // rows keyed by a date column — best for line/area charts
  | 'categorical' // grouped counts or sums per category — best for bar/pie charts
  | 'tabular'     // arbitrary rows — best for tables
  | 'filter_set'  // distinct values for a column — best for filter dropdowns
  | 'none'        // widget does not consume data directly

export interface DashboardQueryHint {
  pattern: DashboardQueryPattern
  /** Describes what query shape produces useful output for this widget. */
  description: string
  /** Example SQL sketch for the AI to adapt. Uses {{connector}} placeholder. */
  exampleSQL?: string
}

// ---- Prop schemas (JSON Schema–style, used for inspector and AI prompting) -

export interface PropDef {
  type: 'string' | 'number' | 'boolean' | 'expression' | 'action'
  label: string
  description?: string
  required?: boolean
  default?: unknown
}

export type PropSchema = Record<string, PropDef>

// Per-widget prop schemas — these drive both the inspector panel and the
// AI system-prompt context so the model knows which props are valid.
export const WidgetPropSchemas: Record<WidgetType, PropSchema> = {
  table: {
    columns: { type: 'string', label: 'Columns', description: 'Optional comma-separated fallback columns' },
  },
  form: {
    fields: { type: 'string', label: 'Fields', description: 'Comma-separated field names', required: true },
    submitLabel: { type: 'string', label: 'Submit label', default: 'Submit' },
    onSubmit: { type: 'action', label: 'On submit' },
  },
  text: {
    content: { type: 'string', label: 'Content', required: true },
    variant: { type: 'string', label: 'Variant', description: 'heading1 | heading2 | body | caption', default: 'body' },
  },
  button: {
    label: { type: 'string', label: 'Label', required: true },
    onClick: { type: 'action', label: 'On click' },
    variant: { type: 'string', label: 'Variant', description: 'primary | secondary | danger', default: 'primary' },
    disabled: { type: 'expression', label: 'Disabled', default: 'false' },
  },
  chart: {
    type: { type: 'string', label: 'Chart type', description: 'bar', default: 'bar' },
  },
  kpi: {
    value: { type: 'expression', label: 'Value', required: true },
    label: { type: 'string', label: 'Label', required: true },
    trend: { type: 'expression', label: 'Trend value' },
    prefix: { type: 'string', label: 'Prefix' },
    suffix: { type: 'string', label: 'Suffix' },
  },
  filter: {
    label: { type: 'string', label: 'Label', required: true },
    options: { type: 'expression', label: 'Options' },
    value: { type: 'expression', label: 'Value' },
    onChange: { type: 'action', label: 'On change' },
  },
  container: {
    direction: { type: 'string', label: 'Direction', description: 'row | column', default: 'column' },
    gap: { type: 'string', label: 'Gap', default: '16px' },
  },
  modal: {
    title: { type: 'string', label: 'Title', required: true },
    open: { type: 'expression', label: 'Open', default: 'false' },
    onClose: { type: 'action', label: 'On close' },
  },
  tabs: {
    tabs: { type: 'string', label: 'Tab labels', description: 'Comma-separated', required: true },
    activeTab: { type: 'expression', label: 'Active tab index', default: '0' },
  },
  markdown: {
    content: { type: 'string', label: 'Markdown content', required: true },
  },
}

// ---- Widget registry entry -------------------------------------------------

export interface WidgetMeta {
  type: WidgetType
  displayName: string
  description: string
  icon: string // name of a Lucide icon
  defaultSize: { w: number; h: number } // grid units
  propSchema: PropSchema
  /** Hints for dashboard-oriented query generation (Phase 6). */
  dashboardHint: DashboardQueryHint
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetMeta> = {
  table: {
    type: 'table',
    displayName: 'Table',
    description: 'Displays rows from a connector query',
    icon: 'Table',
    defaultSize: { w: 12, h: 6 },
    propSchema: WidgetPropSchemas.table,
    dashboardHint: {
      pattern: 'tabular',
      description: 'Feed with a SELECT query returning multiple rows.',
      exampleSQL: 'SELECT * FROM {{table}} ORDER BY created_at DESC LIMIT 100',
    },
  },
  form: {
    type: 'form',
    displayName: 'Form',
    description: 'Data-entry form with submit action',
    icon: 'FileText',
    defaultSize: { w: 6, h: 8 },
    propSchema: WidgetPropSchemas.form,
    dashboardHint: {
      pattern: 'none',
      description: 'Forms do not consume a query; they produce data on submit.',
    },
  },
  text: {
    type: 'text',
    displayName: 'Text',
    description: 'Static or dynamic text block',
    icon: 'Type',
    defaultSize: { w: 6, h: 2 },
    propSchema: WidgetPropSchemas.text,
    dashboardHint: {
      pattern: 'none',
      description: 'Text widgets display static or expression-bound content.',
    },
  },
  button: {
    type: 'button',
    displayName: 'Button',
    description: 'Clickable action trigger',
    icon: 'MousePointer',
    defaultSize: { w: 2, h: 1 },
    propSchema: WidgetPropSchemas.button,
    dashboardHint: {
      pattern: 'none',
      description: 'Buttons trigger workflow actions; they do not consume queries.',
    },
  },
  chart: {
    type: 'chart',
    displayName: 'Chart',
    description: 'Bar chart backed by connector data',
    icon: 'BarChart2',
    defaultSize: { w: 8, h: 6 },
    propSchema: WidgetPropSchemas.chart,
    dashboardHint: {
      pattern: 'categorical',
      description: 'Feed with a grouped query that returns label/value rows suitable for a bar chart.',
      exampleSQL: 'SELECT {{labelColumn}} AS label, COUNT(*) AS value FROM {{table}} GROUP BY {{labelColumn}} ORDER BY {{labelColumn}}',
    },
  },
  kpi: {
    type: 'kpi',
    displayName: 'KPI Tile',
    description: 'Single metric with optional trend',
    icon: 'TrendingUp',
    defaultSize: { w: 3, h: 3 },
    propSchema: WidgetPropSchemas.kpi,
    dashboardHint: {
      pattern: 'aggregate',
      description: 'Feed with a single-row aggregate query (COUNT, SUM, AVG, etc.).',
      exampleSQL: 'SELECT COUNT(*) AS value FROM {{table}}',
    },
  },
  filter: {
    type: 'filter',
    displayName: 'Filter',
    description: 'Select or search filter for related widgets',
    icon: 'Filter',
    defaultSize: { w: 4, h: 2 },
    propSchema: WidgetPropSchemas.filter,
    dashboardHint: {
      pattern: 'filter_set',
      description: 'Feed with a SELECT DISTINCT query to populate the options list.',
      exampleSQL: 'SELECT DISTINCT {{column}} AS value FROM {{table}} ORDER BY value',
    },
  },
  container: {
    type: 'container',
    displayName: 'Container',
    description: 'Flex layout container for child widgets',
    icon: 'Layout',
    defaultSize: { w: 12, h: 4 },
    propSchema: WidgetPropSchemas.container,
    dashboardHint: {
      pattern: 'none',
      description: 'Containers are layout wrappers; data is bound to child widgets.',
    },
  },
  modal: {
    type: 'modal',
    displayName: 'Modal',
    description: 'Overlay dialog for forms or confirmations',
    icon: 'Layers',
    defaultSize: { w: 8, h: 10 },
    propSchema: WidgetPropSchemas.modal,
    dashboardHint: {
      pattern: 'none',
      description: 'Modals are UI wrappers; bind data to the widgets inside them.',
    },
  },
  tabs: {
    type: 'tabs',
    displayName: 'Tabs',
    description: 'Tabbed view grouping child widgets by tab',
    icon: 'Columns',
    defaultSize: { w: 12, h: 8 },
    propSchema: WidgetPropSchemas.tabs,
    dashboardHint: {
      pattern: 'none',
      description: 'Tabs are navigation wrappers; bind data to the widgets inside each tab.',
    },
  },
  markdown: {
    type: 'markdown',
    displayName: 'Markdown',
    description: 'Rendered markdown content block',
    icon: 'FileCode',
    defaultSize: { w: 6, h: 4 },
    propSchema: WidgetPropSchemas.markdown,
    dashboardHint: {
      pattern: 'none',
      description: 'Markdown widgets display static documentation or instructions.',
    },
  },
}

// ---- Helpers ---------------------------------------------------------------

/** Returns the WidgetMeta for a given element name, or undefined. */
export function getWidget(element: string): WidgetMeta | undefined {
  return WIDGET_REGISTRY[element as WidgetType]
}

/** Returns all registered widget types sorted by display name. */
export function listWidgets(): WidgetMeta[] {
  return Object.values(WIDGET_REGISTRY).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )
}
