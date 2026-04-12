import { describe, it, expect, vi } from 'vitest'
import { createReactiveStore, buildDependencyGraph, topoSort, resolveExpression, createReactiveRuntime, evaluateTransform, EvaluationError } from './reactive'

describe('ReactiveStore', () => {
  it('get returns undefined for an unknown key', () => {
    const store = createReactiveStore()
    expect(store.get('widget1', 'port1')).toBeUndefined()
  })

  it('set then get returns the new value', () => {
    const store = createReactiveStore()
    store.set('widget1', 'port1', 'hello')
    expect(store.get('widget1', 'port1')).toBe('hello')
  })

  it('subscribe is called synchronously on set', () => {
    const store = createReactiveStore()
    const calls: unknown[] = []
    store.subscribe('w1', 'p1', (v) => calls.push(v))
    store.set('w1', 'p1', 42)
    expect(calls).toEqual([42])
  })

  it('unsubscribe function stops future calls', () => {
    const store = createReactiveStore()
    const calls: unknown[] = []
    const unsub = store.subscribe('w1', 'p1', (v) => calls.push(v))
    store.set('w1', 'p1', 1)
    unsub()
    store.set('w1', 'p1', 2)
    expect(calls).toEqual([1])
  })

  it('two subscribers on the same key are both called', () => {
    const store = createReactiveStore()
    const a: unknown[] = []
    const b: unknown[] = []
    store.subscribe('w1', 'p1', (v) => a.push(v))
    store.subscribe('w1', 'p1', (v) => b.push(v))
    store.set('w1', 'p1', 'x')
    expect(a).toEqual(['x'])
    expect(b).toEqual(['x'])
  })

  it('subscriber on different key is NOT called when unrelated key changes', () => {
    const store = createReactiveStore()
    const calls: unknown[] = []
    store.subscribe('w1', 'p1', (v) => calls.push(v))
    store.set('w2', 'p2', 'other')
    expect(calls).toHaveLength(0)
  })

  it('throwing subscriber does not prevent other subscribers from firing', () => {
    const store = createReactiveStore()
    const results: unknown[] = []
    store.subscribe('w', 'p', () => { throw new Error('boom') })
    store.subscribe('w', 'p', (v) => results.push(v))
    expect(() => store.set('w', 'p', 'val')).not.toThrow()
    expect(results).toEqual(['val'])
  })

  it('snapshot reflects current state and is not the live map', () => {
    const store = createReactiveStore()
    store.set('w1', 'p1', 'initial')
    const snap = store.snapshot()
    store.set('w1', 'p1', 'changed')
    // Snapshot should still show 'initial'
    expect(snap.get('w1')?.get('p1')).toBe('initial')
    // Live store has the new value
    expect(store.get('w1', 'p1')).toBe('changed')
  })
})

describe('buildDependencyGraph', () => {
  it('builds correct adjacency map from reactive edges', () => {
    const edges = [
      { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'reactive' as const },
      { id: 'e2', fromNodeId: 'B', fromPort: 'out', toNodeId: 'C', toPort: 'in', edgeType: 'reactive' as const },
    ]
    const graph = buildDependencyGraph(edges)
    expect(graph.get('A:out')).toContain('B:in')
    expect(graph.get('B:out')).toContain('C:in')
  })

  it('excludes async edges', () => {
    const edges = [
      { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'async' as const },
    ]
    const graph = buildDependencyGraph(edges)
    expect(graph.size).toBe(0)
  })
})

describe('topoSort', () => {
  it('sorts a linear chain correctly', () => {
    const graph = new Map([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ])
    const result = topoSort(graph)
    expect(result).not.toBeNull()
    expect(result!.indexOf('A')).toBeLessThan(result!.indexOf('B'))
    expect(result!.indexOf('B')).toBeLessThan(result!.indexOf('C'))
  })

  it('returns null for a cycle', () => {
    const graph = new Map([
      ['A', ['B']],
      ['B', ['A']],
    ])
    expect(topoSort(graph)).toBeNull()
  })
})

describe('resolveExpression', () => {
  it('resolves a single {{widgetId.portName}} placeholder', () => {
    const store = createReactiveStore()
    store.set('widget1', 'port1', 'hello')
    expect(resolveExpression('{{widget1.port1}}', store)).toBe('hello')
  })

  it('resolves nested path {{table1.selectedRow.name}}', () => {
    const store = createReactiveStore()
    store.set('table1', 'selectedRow', { name: 'Alice', email: 'alice@co.com' })
    expect(resolveExpression('{{table1.selectedRow.name}}', store)).toBe('Alice')
  })

  it('returns undefined (single match) for unknown widget', () => {
    const store = createReactiveStore()
    const result = resolveExpression('{{unknown.port}}', store)
    expect(result).toBeUndefined()
  })

  it('embeds multiple placeholders in a string', () => {
    const store = createReactiveStore()
    store.set('w1', 'first', 'John')
    store.set('w2', 'last', 'Doe')
    const result = resolveExpression('{{w1.first}} {{w2.last}}', store)
    expect(result).toBe('John Doe')
  })
})

describe('createReactiveRuntime', () => {
  it('propagates a value through a two-hop chain A.out → B.in → C.in', () => {
    const store = createReactiveStore()
    const doc = {
      edges: [
        { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'reactive' as const },
        { id: 'e2', fromNodeId: 'B', fromPort: 'in', toNodeId: 'C', toPort: 'in', edgeType: 'reactive' as const },
      ],
    }
    const runtime = createReactiveRuntime(doc, store)
    runtime.publish('A', 'out', 42)
    expect(store.get('B', 'in')).toBe(42)
    expect(store.get('C', 'in')).toBe(42)
  })

  it('calls onCycleDetected for a cyclic reactive edge graph', () => {
    const store = createReactiveStore()
    const cycles: string[][] = []
    const doc = {
      edges: [
        { id: 'e1', fromNodeId: 'A', fromPort: 'out', toNodeId: 'B', toPort: 'in', edgeType: 'reactive' as const },
        { id: 'e2', fromNodeId: 'B', fromPort: 'in', toNodeId: 'A', toPort: 'out', edgeType: 'reactive' as const },
      ],
    }
    const runtime = createReactiveRuntime(doc, store, { onCycleDetected: (ids) => cycles.push(ids) })
    expect(cycles).toHaveLength(1)
    runtime.publish('A', 'out', 1)
    // Should not loop forever
  })
})

describe('evaluateTransform', () => {
  it('applies a string transform', () => {
    expect(evaluateTransform('hello', '$.toUpperCase()')).toBe('HELLO')
  })

  it('filters an array', () => {
    const input = [{ active: true, name: 'A' }, { active: false, name: 'B' }]
    const result = evaluateTransform(input, '$.filter(r => r.active)') as typeof input
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })

  it('throws EvaluationError on __proto__ in expression', () => {
    expect(() => evaluateTransform({}, 'Object.__proto__')).toThrow(EvaluationError)
    expect(() => evaluateTransform({}, 'Object.__proto__')).toThrow('prototype pollution')
  })

  it('throws EvaluationError on constructor.constructor in expression', () => {
    expect(() => evaluateTransform({}, 'constructor.constructor("return process")()')).toThrow(EvaluationError)
  })

  it('throws EvaluationError on .prototype access', () => {
    expect(() => evaluateTransform({}, 'Array.prototype.push')).toThrow(EvaluationError)
  })

  it('throws EvaluationError when expression references window', () => {
    expect(() => evaluateTransform(null, 'window')).toThrow(EvaluationError)
  })

  it('throws EvaluationError on syntax error', () => {
    expect(() => evaluateTransform(null, 'this is not valid js {{{')).toThrow(EvaluationError)
  })

  it('throws EvaluationError on simulated timeout (mocked performance.now)', () => {
    // Mock performance.now to simulate a slow transform
    const original = globalThis.performance
    let callCount = 0
    globalThis.performance = {
      ...original,
      now: () => {
        callCount++
        return callCount === 1 ? 0 : 100  // 100ms elapsed → exceeds default 50ms
      },
    }
    try {
      expect(() => evaluateTransform(1, '$ + 1', 50)).toThrow(EvaluationError)
    } finally {
      globalThis.performance = original
    }
  })

  it('onTransformTimeout is called in createReactiveRuntime when transform throws', () => {
    const store = createReactiveStore()
    const timeouts: string[] = []
    const doc = {
      edges: [
        {
          id: 'e1',
          fromNodeId: 'A',
          fromPort: 'out',
          toNodeId: 'B',
          toPort: 'in',
          edgeType: 'reactive' as const,
          transform: 'Object.__proto__',  // will trigger pollution guard
        },
      ],
    }
    const runtime = createReactiveRuntime(doc, store, {
      onTransformTimeout: (edgeId) => timeouts.push(edgeId),
    })
    runtime.publish('A', 'out', 'test')
    expect(timeouts).toContain('e1')
    // Raw value should still be passed through (fallback)
    expect(store.get('B', 'in')).toBe('test')
  })
})
