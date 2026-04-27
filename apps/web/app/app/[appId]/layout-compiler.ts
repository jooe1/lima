import { type AuraNode } from '@lima/aura-dsl'

/**
 * compileLayout converts layout hints (style.layout_area, style.layout_span, etc.)
 * on each node into explicit gridX / gridY / gridW / gridH values.
 *
 * Layout areas (12-column grid, CELL=40px):
 *   "header"  → full-width, gridX=0, gridY=0, gridW=12, gridH=2
 *   "sidebar" → right sidebar, fixed 3-column width; stacked below header
 *   "main"    → primary content area; span controls column width (1-9); stacked below header
 *   "footer"  → full-width row at bottom; placed after tallest column
 *
 * "main" and "sidebar" nodes are laid out in source-document order, each
 * advancing its respective column cursor independently.
 *
 * Nodes WITHOUT layout hints keep their existing gridX/gridY/gridW/gridH values
 * (backward compatible with V1 apps). A node has layout hints if
 * `style.layout_area` is present and truthy.
 *
 * Default heights when not specified:
 *   header/footer: 2
 *   main: 4
 *   sidebar: 4
 *
 * gridH: use style.gridH if already set on the node, else use the default for the area.
 *
 * Returns a new array of nodes with grid coordinates populated on layout-hint nodes.
 * Does NOT mutate input nodes.
 */
export function compileLayout(nodes: AuraNode[]): AuraNode[] {
  const DEFAULT_H: Record<string, number> = {
    header: 2,
    main: 4,
    sidebar: 4,
    footer: 2,
  }

  // Bucket nodes by area; maintain source order for main+sidebar interleaving
  const headers: AuraNode[] = []
  const mainAndSidebar: AuraNode[] = []
  const footers: AuraNode[] = []

  for (const node of nodes) {
    const area = node.style?.layout_area
    if (!area) continue
    if (area === 'header') headers.push(node)
    else if (area === 'main' || area === 'sidebar') mainAndSidebar.push(node)
    else if (area === 'footer') footers.push(node)
    // unknown area values fall through to passthrough (no entry in compiled map)
  }

  // compiled map: id → updated node
  const compiled = new Map<string, AuraNode>()

  // --- Pass 1: headers, stacked vertically from y=0
  let headerBottom = 0
  for (const node of headers) {
    const defaultH = DEFAULT_H.header
    const h = resolveH(node, defaultH)
    compiled.set(node.id, {
      ...node,
      style: { ...node.style, gridX: '0', gridY: String(headerBottom), gridW: '12', gridH: String(h) },
    })
    headerBottom += h
  }

  // --- Pass 2: main + sidebar in source order, each column starts at headerBottom
  let mainY = headerBottom
  let sidebarY = headerBottom

  for (const node of mainAndSidebar) {
    const area = node.style!.layout_area!
    if (area === 'main') {
      const rawSpan = node.style?.layout_span !== undefined ? parseInt(node.style.layout_span, 10) : NaN
      const span = Math.min(9, Math.max(1, isNaN(rawSpan) ? 9 : rawSpan))
      const h = resolveH(node, DEFAULT_H.main)
      compiled.set(node.id, {
        ...node,
        style: { ...node.style, gridX: '0', gridY: String(mainY), gridW: String(span), gridH: String(h) },
      })
      mainY += h
    } else {
      // sidebar
      const h = resolveH(node, DEFAULT_H.sidebar)
      compiled.set(node.id, {
        ...node,
        style: { ...node.style, gridX: '9', gridY: String(sidebarY), gridW: '3', gridH: String(h) },
      })
      sidebarY += h
    }
  }

  // --- Pass 3: footers, placed after tallest of main/sidebar columns
  let footerY = Math.max(mainY, sidebarY)
  for (const node of footers) {
    const h = resolveH(node, DEFAULT_H.footer)
    compiled.set(node.id, {
      ...node,
      style: { ...node.style, gridX: '0', gridY: String(footerY), gridW: '12', gridH: String(h) },
    })
    footerY += h
  }

  // Return in original source order; passthrough nodes are returned as-is
  return nodes.map(node => compiled.get(node.id) ?? node)
}

/** Use style.gridH if present and valid; otherwise return the area default. */
function resolveH(node: AuraNode, defaultH: number): number {
  if (node.style?.gridH) {
    const parsed = parseInt(node.style.gridH, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return defaultH
}
