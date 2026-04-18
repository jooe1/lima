/**
 * Parse a comma-separated fields string into an array of trimmed, non-empty names.
 * Does NOT deduplicate — callers that want deduplication should use validateFormFields.
 */
export function parseFormFields(fieldsStr: string): string[] {
  return fieldsStr
    .split(',')
    .map(f => f.trim())
    .filter(f => f.length > 0)
}

/**
 * Validate a list of field names, returning which are duplicates.
 * valid is always true (duplicates are allowed to persist in the DSL);
 * the duplicates array is used only for UI warnings.
 */
export function validateFormFields(fields: string[]): { valid: boolean; duplicates: string[] } {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const f of fields) {
    if (seen.has(f)) {
      if (!duplicates.includes(f)) duplicates.push(f)
    } else {
      seen.add(f)
    }
  }
  return { valid: true, duplicates }
}

/**
 * Format an array of field names back into a comma-separated string.
 */
export function formatFormFields(fields: string[]): string {
  return fields.join(', ')
}
