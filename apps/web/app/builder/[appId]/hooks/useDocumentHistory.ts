'use client'

import { useCallback, useReducer } from 'react'
import { type AuraDocumentV2 } from '@lima/aura-dsl'

const MAX_HISTORY = 50

interface State {
  past: AuraDocumentV2[]
  present: AuraDocumentV2
  future: AuraDocumentV2[]
}

type Action =
  | { type: 'SET'; doc: AuraDocumentV2 }
  | { type: 'RESET'; doc: AuraDocumentV2 }
  | { type: 'UNDO' }
  | { type: 'REDO' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET':
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.present],
        present: action.doc,
        future: [],
      }
    case 'RESET':
      return { past: [], present: action.doc, future: [] }
    case 'UNDO':
      if (state.past.length === 0) return state
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
      }
    case 'REDO':
      if (state.future.length === 0) return state
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      }
  }
}

const EMPTY_DOC: AuraDocumentV2 = { nodes: [], edges: [] }

export function useDocumentHistory(initial: AuraDocumentV2 = EMPTY_DOC) {
  const [state, dispatch] = useReducer(reducer, {
    past: [],
    present: initial,
    future: [],
  })

  return {
    doc: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    set: useCallback((doc: AuraDocumentV2) => dispatch({ type: 'SET', doc }), []),
    reset: useCallback((doc: AuraDocumentV2) => dispatch({ type: 'RESET', doc }), []),
    undo: useCallback(() => dispatch({ type: 'UNDO' }), []),
    redo: useCallback(() => dispatch({ type: 'REDO' }), []),
  }
}
