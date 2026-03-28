import { type AuraDocument, type AuraNode } from '@lima/aura-dsl'
import { WIDGET_REGISTRY, type WidgetType } from '@lima/widget-catalog'

export const PRODUCTION_UNSUPPORTED_WIDGETS = ['container', 'modal', 'tabs'] as const
const unsupportedWidgetSet = new Set<WidgetType>(PRODUCTION_UNSUPPORTED_WIDGETS)

export const SUPPORTED_CHART_TYPES = ['bar'] as const
export type SupportedChartType = (typeof SUPPORTED_CHART_TYPES)[number]

export interface ProductionIssue {
  code:
    | 'empty_document'
    | 'unsupported_widget'
    | 'missing_required_prop'
    | 'missing_data_binding'
    | 'unsupported_chart_type'
  nodeId?: string
  message: string
}

function getNodePropValue(node: AuraNode, propName: string): string {
  if (propName === 'text') {
    return node.text ?? ''
  }
  if (propName === 'label') {
    return String(node.style?.label ?? node.text ?? '')
  }
  if (propName === 'content') {
    return String(node.style?.content ?? node.text ?? '')
  }
  if (propName === 'value' || propName === 'data') {
    return node.value ?? ''
  }
  if (propName === 'transform') {
    return node.transform ?? ''
  }
  const withValue = node.with ? (node.with as Record<string, string | undefined>)[propName] : undefined
  return String(node.style?.[propName] ?? withValue ?? '')
}

export function isProductionReadyWidget(element: string): boolean {
  return !unsupportedWidgetSet.has(element as WidgetType)
}

export function hasConnectorBinding(node: AuraNode): boolean {
  const connectorId = node.with?.connector?.trim()
  if (!connectorId) return false
  if (node.with?.connectorType?.trim() === 'csv') return true
  if (node.with?.connectorType?.trim() === 'managed') return true
  // REST connectors with no explicit path call the base URL directly — that
  // is a valid binding even when sql is empty.
  if (node.with?.connectorType?.trim() === 'rest') return true
  return Boolean(node.with?.sql?.trim())
}

export function isSupportedChartType(type: string | undefined): type is SupportedChartType {
  if (!type) return true
  return SUPPORTED_CHART_TYPES.includes(type.trim() as SupportedChartType)
}

export function getMissingRequiredProps(node: AuraNode): string[] {
  const meta = WIDGET_REGISTRY[node.element as WidgetType]
  if (!meta) return []

  return Object.entries(meta.propSchema)
    .filter(([, def]) => def.required)
    .map(([propName]) => propName)
    .filter(propName => getNodePropValue(node, propName).trim().length === 0)
}

export function getAppProductionIssues(doc: AuraDocument): ProductionIssue[] {
  const issues: ProductionIssue[] = []
  const seen = new Set<string>()

  const pushIssue = (issue: ProductionIssue) => {
    const key = `${issue.code}:${issue.nodeId ?? 'app'}:${issue.message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }

  if (doc.length === 0) {
    pushIssue({
      code: 'empty_document',
      message: 'Add at least one widget before publishing this app.',
    })
  }

  for (const node of doc) {
    const widgetType = node.element as WidgetType
    const meta = WIDGET_REGISTRY[widgetType]
    if (!meta) continue

    if (unsupportedWidgetSet.has(widgetType)) {
      pushIssue({
        code: 'unsupported_widget',
        nodeId: node.id,
        message: `${node.id}: ${meta.displayName} widgets are not supported in the production runtime yet.`,
      })
      continue
    }

    for (const propName of getMissingRequiredProps(node)) {
      const propLabel = meta.propSchema[propName]?.label ?? propName
      pushIssue({
        code: 'missing_required_prop',
        nodeId: node.id,
        message: `${node.id}: ${meta.displayName} requires ${propLabel} before publish.`,
      })
    }

    if ((widgetType === 'table' || widgetType === 'chart') && !hasConnectorBinding(node)) {
      pushIssue({
        code: 'missing_data_binding',
        nodeId: node.id,
        message: `${node.id}: ${meta.displayName} requires a connector and base query before publish.`,
      })
    }

    if (widgetType === 'chart') {
      const chartType = (node.style?.type ?? 'bar').trim() || 'bar'
      if (!isSupportedChartType(chartType)) {
        pushIssue({
          code: 'unsupported_chart_type',
          nodeId: node.id,
          message: `${node.id}: Chart type "${chartType}" is not supported. Use bar.`,
        })
      }
    }
  }

  return issues
}

export function formatProductionIssues(issues: ProductionIssue[], maxVisible = 1): string {
  if (issues.length === 0) return ''

  const visible = issues.slice(0, maxVisible).map(issue => issue.message)
  const remaining = issues.length - visible.length
  if (remaining <= 0) return visible.join(' ')

  return `${visible.join(' ')} (+${remaining} more blocker${remaining === 1 ? '' : 's'})`
}

/**
 * Returns publish blockers as plain-language user guidance.
 * Unlike getAppProductionIssues, messages do not include internal node IDs.
 */
export function getUserFacingProductionIssues(doc: AuraDocument): Array<{ code: string; message: string }> {
  const raw = getAppProductionIssues(doc)
  return raw.map(issue => {
    switch (issue.code) {
      case 'empty_document':
        return { code: issue.code, message: 'Add at least one widget to your tool before publishing.' }
      case 'unsupported_widget': {
        const match = issue.message.match(/: (.+) widgets are not supported/)
        const widgetName = match ? match[1] : 'A widget'
        return { code: issue.code, message: `${widgetName} is not supported in the live runtime yet. Remove it or replace it with a supported widget.` }
      }
      case 'missing_required_prop': {
        const match = issue.message.match(/: (.+) requires (.+) before publish/)
        if (match) {
          return { code: issue.code, message: `Your ${match[1]} widget needs "${match[2]}" filled in before you can publish.` }
        }
        return { code: issue.code, message: 'A widget is missing required settings. Open the Inspector and fill in all required fields.' }
      }
      case 'missing_data_binding': {
        const match = issue.message.match(/: (.+) requires a connector/)
        const widgetName = match ? match[1] : 'A widget'
        return { code: issue.code, message: `Your ${widgetName} widget needs a data source connected before you can publish. Open the Inspector to add a connector.` }
      }
      case 'unsupported_chart_type': {
        return { code: issue.code, message: 'Your chart is using a chart type that isn\'t supported yet. Change it to "Bar" in the Inspector.' }
      }
      default:
        return { code: issue.code, message: issue.message }
    }
  })
}