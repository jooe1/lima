import { describe, it, expect } from 'vitest'
import { parseFormFields, validateFormFields, formatFormFields } from './formValidation'

describe('parseFormFields', () => {
  it('parses basic comma-separated string', () => {
    expect(parseFormFields('a, b, c')).toEqual(['a', 'b', 'c'])
  })

  it('trims whitespace from each field', () => {
    expect(parseFormFields(' x , y , z ')).toEqual(['x', 'y', 'z'])
  })

  it('filters empty slots from consecutive commas', () => {
    expect(parseFormFields('a,,b')).toEqual(['a', 'b'])
  })

  it('returns empty array for empty string', () => {
    expect(parseFormFields('')).toEqual([])
  })

  it('handles single field', () => {
    expect(parseFormFields('name')).toEqual(['name'])
  })

  it('filters leading and trailing commas', () => {
    expect(parseFormFields(',a,b,')).toEqual(['a', 'b'])
  })
})

describe('validateFormFields', () => {
  it('returns no duplicates for unique fields', () => {
    expect(validateFormFields(['a', 'b', 'c'])).toEqual({ valid: true, duplicates: [] })
  })

  it('detects a single duplicate', () => {
    expect(validateFormFields(['a', 'b', 'a'])).toEqual({ valid: true, duplicates: ['a'] })
  })

  it('detects multiple distinct duplicates', () => {
    expect(validateFormFields(['a', 'b', 'a', 'b'])).toEqual({ valid: true, duplicates: ['a', 'b'] })
  })

  it('lists a duplicate only once even if it appears 3+ times', () => {
    expect(validateFormFields(['x', 'x', 'x'])).toEqual({ valid: true, duplicates: ['x'] })
  })

  it('returns empty duplicates for an empty array', () => {
    expect(validateFormFields([])).toEqual({ valid: true, duplicates: [] })
  })

  it('valid is always true', () => {
    expect(validateFormFields(['a', 'a']).valid).toBe(true)
    expect(validateFormFields(['a', 'b']).valid).toBe(true)
  })
})

describe('formatFormFields', () => {
  it('joins fields with comma and space', () => {
    expect(formatFormFields(['a', 'b', 'c'])).toBe('a, b, c')
  })

  it('handles a single field', () => {
    expect(formatFormFields(['name'])).toBe('name')
  })

  it('returns empty string for empty array', () => {
    expect(formatFormFields([])).toBe('')
  })
})
