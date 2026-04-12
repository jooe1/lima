import { describe, it, expect } from 'vitest'
import {
  WIDGET_REGISTRY,
  STEP_NODE_REGISTRY,
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
