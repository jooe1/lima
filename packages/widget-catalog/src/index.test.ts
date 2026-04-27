import { describe, it, expect } from 'vitest'
import {
  WIDGET_REGISTRY,
  STEP_NODE_REGISTRY,
  expandWidgetPorts,
  type WidgetType,
  type StepNodeType,
} from './index'

describe('form widget submitted port', () => {
  it('has a port named submitted with direction output and dataType trigger', () => {
    const formPorts = WIDGET_REGISTRY['form'].ports
    const submitted = formPorts.find(p => p.name === 'submitted')
    expect(submitted).toBeDefined()
    expect(submitted?.direction).toBe('output')
    expect(submitted?.dataType).toBe('trigger')
  })
})

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
    const expandableInputCount = formPorts.filter(p => p.expandable && p.direction === 'input').length
    expect(result.filter(p => p.direction === 'input').length).toBe(
      formPorts.filter(p => p.direction === 'input').length + 3 * expandableInputCount,
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

describe('expandWidgetPorts — expandable input ports', () => {
  it('generates child input ports for expandable input ports when fields are set', () => {
    const formPorts = WIDGET_REGISTRY['form'].ports
    const result = expandWidgetPorts({ fields: 'email,name' }, formPorts)
    expect(result.some(p => p.name === 'setValues.email' && p.direction === 'input')).toBe(true)
    expect(result.some(p => p.name === 'setValues.name' && p.direction === 'input')).toBe(true)
    expect(result.some(p => p.name === 'setErrors.email' && p.direction === 'input')).toBe(true)
    expect(result.some(p => p.name === 'setErrors.name' && p.direction === 'input')).toBe(true)
  })

  it('keeps the parent setValues and setErrors ports alongside child ports', () => {
    const formPorts = WIDGET_REGISTRY['form'].ports
    const result = expandWidgetPorts({ fields: 'email,name' }, formPorts)
    expect(result.some(p => p.name === 'setValues' && p.direction === 'input')).toBe(true)
    expect(result.some(p => p.name === 'setErrors' && p.direction === 'input')).toBe(true)
  })

  it('does not generate child input ports when no fields are configured', () => {
    const formPorts = WIDGET_REGISTRY['form'].ports
    const result = expandWidgetPorts({}, formPorts)
    expect(result.some(p => p.name.startsWith('setValues.'))).toBe(false)
    expect(result.some(p => p.name.startsWith('setErrors.'))).toBe(false)
  })

  it('still generates dynamic output field ports alongside child input ports', () => {
    const formPorts = WIDGET_REGISTRY['form'].ports
    const result = expandWidgetPorts({ fields: 'email,name' }, formPorts)
    // Output field ports
    expect(result.some(p => p.name === 'email' && p.direction === 'output')).toBe(true)
    expect(result.some(p => p.name === 'name' && p.direction === 'output')).toBe(true)
    // Child input ports
    expect(result.some(p => p.name === 'setValues.email' && p.direction === 'input')).toBe(true)
  })
})

describe('expandWidgetPorts — expandable output ports', () => {
  it('generates child output ports for expandable output ports when columns are set', () => {
    const tablePorts = WIDGET_REGISTRY['table'].ports
    const result = expandWidgetPorts({ columns: 'id,name,email' }, tablePorts)
    expect(result.some(p => p.name === 'selectedRow.id' && p.direction === 'output')).toBe(true)
    expect(result.some(p => p.name === 'selectedRow.name' && p.direction === 'output')).toBe(true)
    expect(result.some(p => p.name === 'selectedRow.email' && p.direction === 'output')).toBe(true)
  })

  it('keeps the parent selectedRow port alongside child ports', () => {
    const tablePorts = WIDGET_REGISTRY['table'].ports
    const result = expandWidgetPorts({ columns: 'id,name' }, tablePorts)
    expect(result.some(p => p.name === 'selectedRow' && p.direction === 'output')).toBe(true)
  })

  it('does not generate child output ports when no columns are configured', () => {
    const tablePorts = WIDGET_REGISTRY['table'].ports
    const result = expandWidgetPorts({}, tablePorts)
    expect(result.some(p => p.name.startsWith('selectedRow.'))).toBe(false)
  })

  it('uses childKeyDefault when nodeConfig key is absent', () => {
    // Simulate a port like chart.selectedPoint with childKeyDefault
    const mockPorts: import('./index').PortDef[] = [
      { name: 'selectedPoint', direction: 'output', dataType: 'object', description: 'Selected point', expandable: true, childKeySource: 'chartPointFields', childKeyDefault: 'label,value' },
    ]
    const result = expandWidgetPorts({}, mockPorts)
    expect(result.some(p => p.name === 'selectedPoint')).toBe(true)
    expect(result.some(p => p.name === 'selectedPoint.label')).toBe(true)
    expect(result.some(p => p.name === 'selectedPoint.value')).toBe(true)
  })
})

describe('expandWidgetPorts — table setFilter expandable input ports', () => {
  it('table setFilter expands child input ports from columns', () => {
    const tableWidget = WIDGET_REGISTRY['table']
    const ports = tableWidget.ports
    const expanded = expandWidgetPorts({ columns: 'id,status' }, ports)
    expect(expanded.some(p => p.name === 'setFilter.id' && p.direction === 'input')).toBe(true)
    expect(expanded.some(p => p.name === 'setFilter.status' && p.direction === 'input')).toBe(true)
  })
})

describe('step:query firstRow expandable ports', () => {
  it('expands firstRow child ports from resultColumns', () => {
    const meta = STEP_NODE_REGISTRY['step:query']
    expect(meta).toBeDefined()
    const ports = meta!.ports
    const expanded = expandWidgetPorts({ resultColumns: 'id,name,email' }, ports)
    expect(expanded.some(p => p.name === 'firstRow.id' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'firstRow.name' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'firstRow.email' && p.direction === 'output')).toBe(true)
  })

  it('does not expand firstRow when resultColumns is absent', () => {
    const meta = STEP_NODE_REGISTRY['step:query']
    const ports = meta!.ports
    const expanded = expandWidgetPorts({}, ports)
    expect(expanded.some(p => p.name.startsWith('firstRow.'))).toBe(false)
  })
})

describe('step:transform output expandable ports', () => {
  it('expands output child ports from outputFields', () => {
    const meta = STEP_NODE_REGISTRY['step:transform']
    expect(meta).toBeDefined()
    const expanded = expandWidgetPorts({ outputFields: 'firstName,lastName,age' }, meta!.ports)
    expect(expanded.some(p => p.name === 'output.firstName' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'output.lastName' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'output.age' && p.direction === 'output')).toBe(true)
  })

  it('does not expand output when outputFields is absent', () => {
    const meta = STEP_NODE_REGISTRY['step:transform']
    const expanded = expandWidgetPorts({}, meta!.ports)
    expect(expanded.some(p => p.name.startsWith('output.'))).toBe(false)
  })
})

describe('step:http responseBody expandable ports', () => {
  it('expands responseBody child ports from responseFields', () => {
    const meta = STEP_NODE_REGISTRY['step:http']
    expect(meta).toBeDefined()
    const expanded = expandWidgetPorts({ responseFields: 'id,token,user' }, meta!.ports)
    expect(expanded.some(p => p.name === 'responseBody.id' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'responseBody.token' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'responseBody.user' && p.direction === 'output')).toBe(true)
  })

  it('does not expand responseBody when responseFields is absent', () => {
    const meta = STEP_NODE_REGISTRY['step:http']
    const expanded = expandWidgetPorts({}, meta!.ports)
    expect(expanded.some(p => p.name.startsWith('responseBody.'))).toBe(false)
  })
})

describe('chart selectedPoint expandable ports', () => {
  it('expands selectedPoint with childKeyDefault label,value when chartPointFields absent', () => {
    const chartWidget = WIDGET_REGISTRY['chart']
    expect(chartWidget).toBeDefined()
    const expanded = expandWidgetPorts({}, chartWidget.ports)
    expect(expanded.some(p => p.name === 'selectedPoint')).toBe(true)
    expect(expanded.some(p => p.name === 'selectedPoint.label' && p.direction === 'output')).toBe(true)
    expect(expanded.some(p => p.name === 'selectedPoint.value' && p.direction === 'output')).toBe(true)
  })

  it('expands selectedPoint with custom chartPointFields', () => {
    const chartWidget = WIDGET_REGISTRY['chart']
    const expanded = expandWidgetPorts({ chartPointFields: 'x,y,z' }, chartWidget.ports)
    expect(expanded.some(p => p.name === 'selectedPoint.x')).toBe(true)
    expect(expanded.some(p => p.name === 'selectedPoint.y')).toBe(true)
    expect(expanded.some(p => p.name === 'selectedPoint.z')).toBe(true)
    expect(expanded.some(p => p.name === 'selectedPoint.label')).toBe(false)
  })
})
