import { describe, it, expect } from 'vitest'
import { compileLayout } from './layout-compiler'
import { type AuraNode } from '@lima/aura-dsl'

function makeNode(id: string, area?: string, span?: string, extra: Partial<AuraNode> = {}): AuraNode {
  return {
    id,
    element: 'text',
    parentId: 'root',
    style: area ? { layout_area: area, ...(span ? { layout_span: span } : {}) } : {},
    ...extra,
  } as AuraNode
}

describe('compileLayout', () => {
  it('passthrough: nodes without layout hints are returned unchanged', () => {
    const node = makeNode('n1')
    node.style = { gridX: '2', gridY: '3', gridW: '4', gridH: '2' }
    const result = compileLayout([node])
    expect(result[0].style?.gridX).toBe('2')
    expect(result[0].style?.gridY).toBe('3')
  })

  it('header: placed at row 0, full width', () => {
    const result = compileLayout([makeNode('h1', 'header')])
    expect(result[0].style?.gridX).toBe('0')
    expect(result[0].style?.gridY).toBe('0')
    expect(result[0].style?.gridW).toBe('12')
  })

  it('main: placed at x=0 after header, span applied', () => {
    const result = compileLayout([makeNode('h1', 'header'), makeNode('m1', 'main', '6')])
    const main = result.find(n => n.id === 'm1')!
    expect(main.style?.gridX).toBe('0')
    expect(main.style?.gridW).toBe('6')
    const headerH = parseInt(result.find(n => n.id === 'h1')!.style!.gridH!, 10)
    expect(parseInt(main.style?.gridY!, 10)).toBeGreaterThanOrEqual(headerH)
  })

  it('sidebar: placed at x=9, width=3', () => {
    const result = compileLayout([makeNode('s1', 'sidebar')])
    expect(result[0].style?.gridX).toBe('9')
    expect(result[0].style?.gridW).toBe('3')
  })

  it('mixed doc: backward compat nodes unchanged alongside layout hint nodes', () => {
    const legacy = makeNode('l1')
    legacy.style = { gridX: '5', gridY: '1', gridW: '3', gridH: '2' }
    const result = compileLayout([legacy, makeNode('m1', 'main')])
    const legacyResult = result.find(n => n.id === 'l1')!
    expect(legacyResult.style?.gridX).toBe('5')
    expect(legacyResult.style?.gridY).toBe('1')
  })

  it('multiple headers stack vertically', () => {
    const result = compileLayout([makeNode('h1', 'header'), makeNode('h2', 'header')])
    const h1 = result.find(n => n.id === 'h1')!
    const h2 = result.find(n => n.id === 'h2')!
    expect(parseInt(h1.style!.gridY!, 10)).toBe(0)
    expect(parseInt(h2.style!.gridY!, 10)).toBe(parseInt(h1.style!.gridH!, 10))
  })

  it('footer placed after tallest column', () => {
    const result = compileLayout([
      makeNode('m1', 'main'),
      makeNode('m2', 'main'),
      makeNode('s1', 'sidebar'),
      makeNode('f1', 'footer'),
    ])
    const footer = result.find(n => n.id === 'f1')!
    const m1 = result.find(n => n.id === 'm1')!
    const m2 = result.find(n => n.id === 'm2')!
    const s1 = result.find(n => n.id === 's1')!
    const mainBottom = parseInt(m2.style!.gridY!, 10) + parseInt(m2.style!.gridH!, 10)
    const sideBottom = parseInt(s1.style!.gridY!, 10) + parseInt(s1.style!.gridH!, 10)
    expect(parseInt(footer.style!.gridY!, 10)).toBe(Math.max(mainBottom, sideBottom))
  })

  it('span is clamped to 1-9', () => {
    const wide = compileLayout([makeNode('m1', 'main', '15')])
    expect(parseInt(wide[0].style!.gridW!, 10)).toBe(9)
    const narrow = compileLayout([makeNode('m2', 'main', '0')])
    expect(parseInt(narrow[0].style!.gridW!, 10)).toBe(1)
  })

  it('uses existing gridH when set on node', () => {
    const node = makeNode('h1', 'header')
    node.style = { ...node.style, gridH: '5' }
    const result = compileLayout([node])
    expect(result[0].style?.gridH).toBe('5')
  })

  it('source order is preserved in returned array', () => {
    const input = [
      makeNode('h1', 'header'),
      makeNode('l1'),
      makeNode('m1', 'main'),
      makeNode('s1', 'sidebar'),
      makeNode('f1', 'footer'),
    ]
    const result = compileLayout(input)
    expect(result.map(n => n.id)).toEqual(['h1', 'l1', 'm1', 's1', 'f1'])
  })
})
