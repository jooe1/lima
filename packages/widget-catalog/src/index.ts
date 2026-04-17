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
  type: 'string' | 'number' | 'boolean' | 'expression' | 'action' | 'workflow_trigger'
  label: string
  description?: string
  required?: boolean
  default?: unknown
}

export type PropSchema = Record<string, PropDef>

export interface PortDef {
  name: string
  direction: 'input' | 'output'
  dataType: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'trigger' | 'void'
  description: string
  dynamic?: boolean  // true → additional ports generated at runtime from widget config
}

// Per-widget prop schemas — these drive both the inspector panel and the
// AI system-prompt context so the model knows which props are valid.
export const WidgetPropSchemas: Record<WidgetType, PropSchema> = {
  table: {
    columns: {
      type: 'string',
      label: 'Columns',
      description: 'Optional visible columns in display order; leave blank to use the bound data columns',
    },
  },
  form: {
    fields: { type: 'string', label: 'Fields', description: 'Comma-separated field names', required: true },
    submitLabel: { type: 'string', label: 'Submit label', default: 'Submit' },
    onSubmit: { type: 'workflow_trigger', label: 'On submit' },
  },
  text: {
    content: { type: 'string', label: 'Content', required: true },
    variant: { type: 'string', label: 'Variant', description: 'heading1 | heading2 | body | caption', default: 'body' },
  },
  button: {
    label: { type: 'string', label: 'Label', required: true },
    onClick: { type: 'workflow_trigger', label: 'On click' },
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
    placeholder: { type: 'string', label: 'Placeholder', default: 'Type to filter...' },
    options: { type: 'string', label: 'Options', description: 'Optional comma-separated preset options; leave blank for a free-text filter' },
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
  /** Port schema for Flow View wiring (Phase 1 dual-layer canvas). */
  ports: PortDef[]
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
    ports: [
      { name: 'selectedRow', direction: 'output', dataType: 'object', description: 'Currently selected row object' },
      { name: 'rows', direction: 'output', dataType: 'array', description: 'All rows currently displayed in the table' },
      { name: 'selectedRowIndex', direction: 'output', dataType: 'number', description: 'Zero-based index of the selected row' },
      { name: 'refresh', direction: 'input', dataType: 'trigger', description: 'Trigger a data refresh' },
      { name: 'setRows', direction: 'input', dataType: 'array', description: 'Override the displayed rows' },
      { name: 'setFilter', direction: 'input', dataType: 'object', description: 'Apply a filter object to the table' },
    ],
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
    ports: [
      { name: 'values', direction: 'output', dataType: 'object', description: 'Current form field values as an object' },
      { name: 'submitted', direction: 'output', dataType: 'trigger', description: 'Triggered when the form is submitted' },
      { name: '*', direction: 'output', dataType: 'string', description: 'One port per form field, keyed by field name', dynamic: true },
      { name: 'reset', direction: 'input', dataType: 'trigger', description: 'Reset the form to initial values' },
      { name: 'setValues', direction: 'input', dataType: 'object', description: 'Populate form fields programmatically' },
      { name: 'setErrors', direction: 'input', dataType: 'object', description: 'Set validation error messages on fields' },
    ],
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
    ports: [
      { name: 'content', direction: 'output', dataType: 'string', description: 'Current rendered text content as a string' },
      { name: 'setContent', direction: 'input', dataType: 'string', description: 'Override the displayed text content' },
    ],
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
    ports: [
      { name: 'clicked', direction: 'output', dataType: 'trigger', description: 'Triggered when the button is clicked' },
      { name: 'clickedAt', direction: 'output', dataType: 'date', description: 'Timestamp of the last click' },
      { name: 'setDisabled', direction: 'input', dataType: 'boolean', description: 'Enable or disable the button' },
      { name: 'setLabel', direction: 'input', dataType: 'string', description: 'Override the button label text' },
    ],
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
    ports: [
      { name: 'selectedPoint', direction: 'output', dataType: 'object', description: 'Currently selected chart data point' },
      { name: 'setData', direction: 'input', dataType: 'array', description: 'Override the chart data array' },
      { name: 'refresh', direction: 'input', dataType: 'trigger', description: 'Trigger a data refresh' },
    ],
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
    ports: [
      { name: 'value', direction: 'output', dataType: 'number', description: 'Current KPI numeric value' },
      { name: 'setValue', direction: 'input', dataType: 'number', description: 'Override the KPI value' },
      { name: 'setTrend', direction: 'input', dataType: 'string', description: 'Override the trend indicator value' },
    ],
  },
  filter: {
    type: 'filter',
    displayName: 'Filter',
    description: 'Interactive search or dropdown filter for related widgets',
    icon: 'Filter',
    defaultSize: { w: 4, h: 2 },
    propSchema: WidgetPropSchemas.filter,
    dashboardHint: {
      pattern: 'none',
      description: 'Filter widgets hold end-user input that can be linked to table and chart widgets.',
    },
    ports: [
      { name: 'value', direction: 'output', dataType: 'string', description: 'Current filter input value' },
      { name: 'selectedValue', direction: 'output', dataType: 'string', description: 'Currently selected option value' },
      { name: 'setOptions', direction: 'input', dataType: 'array', description: 'Populate the dropdown options list' },
      { name: 'setValue', direction: 'input', dataType: 'string', description: 'Set the current filter value programmatically' },
    ],
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
    ports: [
      { name: 'children', direction: 'input', dataType: 'array', description: 'Child widget slot (layout only)' },
    ],
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
    ports: [
      { name: 'closed', direction: 'output', dataType: 'trigger', description: 'Triggered when the modal is closed' },
      { name: 'open', direction: 'input', dataType: 'trigger', description: 'Trigger to open the modal' },
      { name: 'close', direction: 'input', dataType: 'trigger', description: 'Trigger to close the modal' },
    ],
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
    ports: [
      { name: 'activeTab', direction: 'output', dataType: 'string', description: 'Label of the currently active tab' },
      { name: 'activeTabIndex', direction: 'output', dataType: 'number', description: 'Zero-based index of the active tab' },
      { name: 'setActiveTab', direction: 'input', dataType: 'string', description: 'Programmatically set the active tab by label' },
    ],
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
    ports: [
      { name: 'setContent', direction: 'input', dataType: 'string', description: 'Override the markdown content' },
    ],
  },
}

// ---- Step node types (Flow View — dual-layer canvas Phase 1) ---------------

export type StepNodeType =
  | 'step:query'
  | 'step:mutation'
  | 'step:condition'
  | 'step:approval_gate'
  | 'step:notification'
  | 'step:transform'
  | 'step:http'

export interface StepNodeMeta {
  type: StepNodeType
  displayName: string
  description: string
  icon: string       // Lucide icon name
  ports: PortDef[]
}

export const STEP_NODE_REGISTRY: Record<StepNodeType, StepNodeMeta> = {
  'step:query': {
    type: 'step:query',
    displayName: 'Query',
    description: 'Execute a read-only SQL query against a connector',
    icon: 'Database',
    ports: [
      { name: 'params', direction: 'input', dataType: 'object', description: 'SQL parameters (one dynamic port per parameter)', dynamic: true },
      { name: 'result', direction: 'output', dataType: 'object', description: 'Full query result object' },
      { name: 'rows', direction: 'output', dataType: 'array', description: 'Array of result rows' },
      { name: 'firstRow', direction: 'output', dataType: 'object', description: 'First row of the result set' },
      { name: 'rowCount', direction: 'output', dataType: 'number', description: 'Number of rows returned' },
    ],
  },
  'step:mutation': {
    type: 'step:mutation',
    displayName: 'Mutation',
    description: 'Execute a write SQL statement (INSERT/UPDATE/DELETE)',
    icon: 'PenLine',
    ports: [
      { name: 'run', direction: 'input', dataType: 'trigger', description: 'Trigger execution of this mutation step' },
      { name: 'params', direction: 'input', dataType: 'object', description: 'SQL parameters (one dynamic port per parameter)', dynamic: true },
      { name: 'result', direction: 'output', dataType: 'object', description: 'Full mutation result object' },
      { name: 'affectedRows', direction: 'output', dataType: 'number', description: 'Number of rows affected' },
    ],
  },
  'step:condition': {
    type: 'step:condition',
    displayName: 'Condition',
    description: 'Branch execution based on a boolean expression',
    icon: 'GitBranch',
    ports: [
      { name: 'value', direction: 'input', dataType: 'object', description: 'Value to test' },
      { name: 'compareTo', direction: 'input', dataType: 'object', description: 'Value to compare against' },
      { name: 'trueBranch', direction: 'output', dataType: 'trigger', description: 'Triggered when condition is true' },
      { name: 'falseBranch', direction: 'output', dataType: 'trigger', description: 'Triggered when condition is false' },
    ],
  },
  'step:approval_gate': {
    type: 'step:approval_gate',
    displayName: 'Approval Gate',
    description: 'Pause execution and wait for a human approval decision',
    icon: 'ShieldCheck',
    ports: [
      { name: 'approved', direction: 'output', dataType: 'trigger', description: 'Triggered when the gate is approved' },
      { name: 'rejected', direction: 'output', dataType: 'trigger', description: 'Triggered when the gate is rejected' },
    ],
  },
  'step:notification': {
    type: 'step:notification',
    displayName: 'Notification',
    description: 'Send a notification to a channel',
    icon: 'Bell',
    ports: [
      { name: 'message', direction: 'input', dataType: 'string', description: 'Notification message body' },
      { name: 'channel', direction: 'input', dataType: 'string', description: 'Target channel or recipient' },
      { name: 'sent', direction: 'output', dataType: 'trigger', description: 'Triggered after the notification is sent' },
      { name: 'failed', direction: 'output', dataType: 'trigger', description: 'Triggered when notification delivery fails or the channel is unreachable' },
    ],
  },
  'step:transform': {
    type: 'step:transform',
    displayName: 'Transform',
    description: 'Reshape or compute data with a JS expression',
    icon: 'Braces',
    ports: [
      { name: 'input', direction: 'input', dataType: 'object', description: 'Data to transform' },
      { name: 'output', direction: 'output', dataType: 'object', description: 'Transformed result' },
    ],
  },
  'step:http': {
    type: 'step:http',
    displayName: 'HTTP Request',
    description: 'Call an external REST API endpoint',
    icon: 'Globe',
    ports: [
      { name: 'body', direction: 'input', dataType: 'object', description: 'Request body (JSON)' },
      { name: 'responseBody', direction: 'output', dataType: 'object', description: 'Parsed JSON response body' },
      { name: 'status', direction: 'output', dataType: 'number', description: 'HTTP response status code' },
      { name: 'ok', direction: 'output', dataType: 'trigger', description: 'Triggered on 2xx response' },
      { name: 'error', direction: 'output', dataType: 'trigger', description: 'Triggered on non-2xx or network error' },
    ],
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

/** Returns the StepNodeMeta for a given step element name, or undefined. */
export function getStepNode(element: string): StepNodeMeta | undefined {
  return STEP_NODE_REGISTRY[element as StepNodeType]
}

/**
 * Expand dynamic ports for a widget node using its runtime configuration.
 *
 * For `form` widgets: the generic `'*'` port is replaced with one concrete
 * output port per field listed in `nodeConfig.fields` (comma-separated string).
 * The `values`, `submitted`, and all input ports are preserved unchanged.
 *
 * All other widget types are returned unchanged.
 */
export function expandWidgetPorts(
  nodeConfig: Record<string, unknown>,
  ports: PortDef[],
): PortDef[] {
  const hasDynamic = ports.some(p => p.dynamic && p.direction === 'output')
  if (!hasDynamic) return ports

  const fields = typeof nodeConfig.fields === 'string'
    ? nodeConfig.fields.split(',').map(f => f.trim()).filter(Boolean)
    : []

  if (fields.length === 0) return ports

  // Replace the '*' dynamic output port with concrete per-field ports
  const result: PortDef[] = []
  for (const p of ports) {
    if (p.name === '*' && p.direction === 'output' && p.dynamic) {
      for (const field of fields) {
        result.push({
          name: field,
          direction: 'output',
          dataType: 'string',
          description: `Form field: ${field}`,
        })
      }
    } else {
      result.push(p)
    }
  }
  return result
}
