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
    data: { type: 'expression', label: 'Data', description: 'Array expression', required: true },
    columns: { type: 'string', label: 'Columns', description: 'Comma-separated column keys' },
    pageSize: { type: 'number', label: 'Page size', default: 25 },
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
    data: { type: 'expression', label: 'Data', required: true },
    xField: { type: 'string', label: 'X field', required: true },
    yField: { type: 'string', label: 'Y field', required: true },
    type: { type: 'string', label: 'Chart type', description: 'bar | line | area | pie', default: 'bar' },
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
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetMeta> = {
  table: {
    type: 'table',
    displayName: 'Table',
    description: 'Displays rows from a query or array',
    icon: 'Table',
    defaultSize: { w: 12, h: 6 },
    propSchema: WidgetPropSchemas.table,
  },
  form: {
    type: 'form',
    displayName: 'Form',
    description: 'Data-entry form with submit action',
    icon: 'FileText',
    defaultSize: { w: 6, h: 8 },
    propSchema: WidgetPropSchemas.form,
  },
  text: {
    type: 'text',
    displayName: 'Text',
    description: 'Static or dynamic text block',
    icon: 'Type',
    defaultSize: { w: 6, h: 2 },
    propSchema: WidgetPropSchemas.text,
  },
  button: {
    type: 'button',
    displayName: 'Button',
    description: 'Clickable action trigger',
    icon: 'MousePointer',
    defaultSize: { w: 2, h: 1 },
    propSchema: WidgetPropSchemas.button,
  },
  chart: {
    type: 'chart',
    displayName: 'Chart',
    description: 'Bar, line, area, or pie chart',
    icon: 'BarChart2',
    defaultSize: { w: 8, h: 6 },
    propSchema: WidgetPropSchemas.chart,
  },
  kpi: {
    type: 'kpi',
    displayName: 'KPI Tile',
    description: 'Single metric with optional trend',
    icon: 'TrendingUp',
    defaultSize: { w: 3, h: 3 },
    propSchema: WidgetPropSchemas.kpi,
  },
  filter: {
    type: 'filter',
    displayName: 'Filter',
    description: 'Select or search filter for related widgets',
    icon: 'Filter',
    defaultSize: { w: 4, h: 2 },
    propSchema: WidgetPropSchemas.filter,
  },
  container: {
    type: 'container',
    displayName: 'Container',
    description: 'Flex layout container for child widgets',
    icon: 'Layout',
    defaultSize: { w: 12, h: 4 },
    propSchema: WidgetPropSchemas.container,
  },
  modal: {
    type: 'modal',
    displayName: 'Modal',
    description: 'Overlay dialog for forms or confirmations',
    icon: 'Layers',
    defaultSize: { w: 8, h: 10 },
    propSchema: WidgetPropSchemas.modal,
  },
  tabs: {
    type: 'tabs',
    displayName: 'Tabs',
    description: 'Tabbed view grouping child widgets by tab',
    icon: 'Columns',
    defaultSize: { w: 12, h: 8 },
    propSchema: WidgetPropSchemas.tabs,
  },
  markdown: {
    type: 'markdown',
    displayName: 'Markdown',
    description: 'Rendered markdown content block',
    icon: 'FileCode',
    defaultSize: { w: 6, h: 4 },
    propSchema: WidgetPropSchemas.markdown,
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
