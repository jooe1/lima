import { describe, it, expect } from 'vitest'
import {
  WIDGET_REGISTRY,
  STEP_NODE_REGISTRY,
  expandWidgetPorts,
  type WidgetType,
  type StepNodeType,
} from './index'

describe('WIDGET_REGISTRY ports', () => {
  const widgetTypes = Object.keys(WIDGET_REGISTRY) as WidgetType[]

  it('every widget has a non-empty ports array', () => {
    for (const type of widgetTypes) {
      expect(WIDGET_REGISTRY[type].ports.length).toBeGreaterThan(0)
    }
  })

  it('all direction values are "input" or "output"', () => {
    for (const type of widgetTypes) {
      for (const port of WIDGET_REGISTRY[type].ports) {
        expect(['input', 'output']).toContain(port.direction)
      }
    }
  })

  it('no duplicate port names within a widget (ignoring dynamic "*" sentinel)', () => {
    for (const type of widgetTypes) {
      const names = WIDGET_REGISTRY[type].ports
        .filter((p) => p.name !== '*')
        .map((p) => p.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    }
  })
})

describe('STEP_NODE_REGISTRY ports', () => {
  const stepTypes = Object.keys(STEP_NODE_REGISTRY) as StepNodeType[]

  it('every step node has a non-empty ports array', () => {
    for (const type of stepTypes) {
      expect(STEP_NODE_REGISTRY[type].ports.length).toBeGreaterThan(0)
    }
  })

  it('all step port direction values are "input" or "output"', () => {
    for (const type of stepTypes) {
      for (const port of STEP_NODE_REGISTRY[type].ports) {
        expect(['input', 'output']).toContain(port.direction)
      }
    }
  })

  it('no duplicate port names within a step node', () => {
    for (const type of stepTypes) {
      const names = STEP_NODE_REGISTRY[type].ports.map((p) => p.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    }
  })
})

describe('expandWidgetPorts', () => {
  const formPorts = WIDGET_REGISTRY['form'].ports

  it('form widget with fields expands "*" into concrete per-field output ports', () => {
    const result = expandWidgetPorts({ fields: 'name,email,status' }, formPorts)
    const outputNames = result.filter(p => p.direction === 'output').map(p => p.name)
    expect(outputNames).toContain('name')
    expect(outputNames).toContain('email')
    expect(outputNames).toContain('status')
    expect(outputNames).toContain('values')
    expect(outputNames).toContain('submitted')
    expect(outputNames).not.toContain('*')
    expect(result.filter(p => p.direction === 'input').length).toBe(
      formPorts.filter(p => p.direction === 'input').length,
    )
  })

  it('form widget with no fields returns catalog ports unchanged', () => {
    const result = expandWidgetPorts({}, formPorts)
    expect(result).toEqual(formPorts)
  })

  it('form widget with empty fields string returns catalog ports unchanged', () => {
    const result = expandWidgetPorts({ fields: '   ' }, formPorts)
    expect(result).toEqual(formPorts)
  })

  it('non-form widget (table) returns ports unchanged', () => {
    const tablePorts = WIDGET_REGISTRY['table'].ports
    const result = expandWidgetPorts({ fields: 'name,email' }, tablePorts)
    expect(result).toEqual(tablePorts)
  })
})
