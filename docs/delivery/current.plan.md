# Delivery Plan: Connectors UI Visual Refresh
_Last updated: 2026-03-30_
_Feature slug: connectors-ui-visual-refresh_
_Source: docs/clarity/current.plan.md_

## Goal
Deliver the visual refresh in four ordered commits: a pure-addition foundation commit (CSS module, shared icons, status badge utility) followed by three parallel commits that each modify exactly one existing component, making the execution safe and independently reviewable.

## Stack Decisions
| Decision | Value | Reason |
|----------|-------|--------|
| Styling | CSS modules | Eliminates all inline style objects; all values reference existing `--color-*` / `--radius-*` / `--space-*` tokens from `globals.css` |
| New accent colors | `--accent-databases` (#2dd4bf teal), `--accent-shared-tables` (#a78bfa purple) defined in `connectors.module.css` | `globals.css` has amber (`--color-warning`) and blue (`--color-info`) but no teal or purple |
| Icon sharing | `ConnectorIcons.tsx` — single new file | All 4 SVG icon components + `CATEGORY_ICONS`, `CATEGORY_ACCENT`, `TYPE_TO_CATEGORY` maps extracted from `ConnectorList.tsx`; imported by all three modified components |
| Status badge | `ConnectorStatusBadge.tsx` — single new file | `getConnectorStatus()` helper and `<ConnectorStatusBadge>` component shared between `ConnectorList.tsx` and `ConnectorDetailDrawer.tsx` |
| Status tiers | `fresh` (≤24h) / `stale` (1–7 days) / `unconfigured` (null) | Replaces binary `isConnected()` with three observable health states |
| Dynamic accent color | CSS custom property `--cat-accent` via `style` prop | Single `.sectionAccentBar` class; caller passes `style={{ '--cat-accent': CATEGORY_ACCENT[cat] }}` — no per-category class proliferation |
| Type picker hover | `[data-tile]` CSS attribute selectors in module | Replaces `onMouseEnter`/`onMouseLeave` JS handlers that mutated inline styles |
| Drawer header slot | `title?: React.ReactNode` (widened from `string`) in `ConnectorDrawer` | Lets `ConnectorDetailDrawer` pass a composed element (icon + name + badge) without adding new props |
| Test strategy | Extend `apps/web/tests/e2e/connectors.spec.ts` | No unit test framework exists in this directory; E2E test file already covers the connector page |

## Commits

### Commit 1 — chore(connectors): add CSS module, shared icons, and status badge utility
**Why:** Pure-addition foundation all three implementation commits import from; no existing file behavior changes.
**Parallelizable with:** none

**Files:**
- `apps/web/app/builder/connectors/connectors.module.css` — NEW: all CSS classes and custom properties consumed by Commits 2–4
- `apps/web/app/builder/connectors/ConnectorIcons.tsx` — NEW: 4 SVG icon components + `CATEGORY_ICONS`, `CATEGORY_ACCENT`, `TYPE_TO_CATEGORY` maps
- `apps/web/app/builder/connectors/ConnectorStatusBadge.tsx` — NEW: `getConnectorStatus()` helper + `<ConnectorStatusBadge>` component

**Interface contracts** (names and shapes other commits depend on):

From `ConnectorIcons.tsx`:
- `FilesIcon(): JSX.Element` — SVG, same geometry as current inline icon in `ConnectorList.tsx`
- `DatabasesIcon(): JSX.Element`
- `ApisIcon(): JSX.Element`
- `SharedTablesIcon(): JSX.Element`
- `CATEGORY_ICONS: Record<ConnectorCategory, () => JSX.Element>` — maps category to its icon component
- `CATEGORY_ACCENT: Record<ConnectorCategory, string>` — CSS custom-property string per category: `{ files: 'var(--accent-files)', databases: 'var(--accent-databases)', apis: 'var(--accent-apis)', 'shared-tables': 'var(--accent-shared-tables)' }`; the four `--accent-*` vars are defined inside `connectors.module.css`
- `TYPE_TO_CATEGORY: Partial<Record<ConnectorType, ConnectorCategory>>` — reverse lookup: `{ postgres: 'databases', mysql: 'databases', mssql: 'databases', rest: 'apis', graphql: 'apis', csv: 'files', managed: 'shared-tables' }`

From `ConnectorStatusBadge.tsx`:
- `getConnectorStatus(connector: Connector): { tier: 'fresh' | 'stale' | 'unconfigured', label: string }` — `fresh`: `schema_cached_at` within 24h, `label` = `"Synced Xh ago"`; `stale`: 1–7 days, `label` = `"Synced X days ago"`; `unconfigured`: null, `label` = `"Not set up yet"`
- `ConnectorStatusBadge({ connector }: { connector: Connector }): JSX.Element` — renders a pill badge using `.badgeFresh` / `.badgeStale` / `.badgeUnconfigured` classes from the CSS module

From `connectors.module.css` (CSS class names other commits must use exactly):
- `.sectionHeader` — flex row, left-bar accent via `border-left: 3px solid var(--cat-accent, #6b7280)`, uses `--cat-accent` CSS custom property set by caller
- `.categoryLabel` — section label typography
- `.countBadge` — count pill (right side of header)
- `.addBtn` — ghost CTA button in header
- `.cardGrid` — `display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem`
- `.card` — connector card; hover lifts via `box-shadow` and `border-color` transition
- `.cardIconWell` — tinted square for category icon; uses `--cat-accent` for background tint
- `.cardName` — connector name text
- `.typeChip` — small monospace type label (e.g. "postgres")
- `.manageBtn` — ghost button; visible only on `.card:hover`
- `.badgeFresh`, `.badgeStale`, `.badgeUnconfigured` — pill badge per tier
- `.badgeDot` — status dot; `.badgeFresh .badgeDot` gets CSS pulse animation via `@keyframes badgePulse`
- `.emptyCard` — dashed-border empty state; full width; `min-height: 100px`
- `.emptyIcon` — large (32px) dimmed category icon wrapper
- `.emptyDesc` — one-line description text
- `.emptyCta` — primary-filled CTA button
- `.typePickerTile` — replaces `tileStyle` const; `:hover` border-color via `[data-tile]` attribute rules
- `.typePickerBack` — replaces `backBtnStyle` const
- `.typePickerSubHead` — replaces `subHeadStyle` const
- `.drawerDivider` — replaces `borderTop: '1px solid #1e1e1e'` on section header buttons

**Implementation notes:**
- The four `--accent-*` CSS custom properties must be defined at `:root` scope inside `connectors.module.css` so that the `CATEGORY_ACCENT` values resolve when used as `style={{ '--cat-accent': ... }}` on any element in the page, not just those inside a scoped class.
- `TYPE_TO_CATEGORY` must be a `Partial<Record<ConnectorType, ConnectorCategory>>` to satisfy TypeScript without an exhaustive default; callers should null-check.
- `getConnectorStatus` relative-time label: use `Math.floor(diffMs / 3600000)` for hours and `Math.floor(diffMs / 86400000)` for days — no external date library.
- `badgePulse` `@keyframes` should animate `opacity` from 1 → 0.4 → 1 at a 2s duration, not `transform`, to avoid causing layout reflows.

**Tests** (written in this commit):
- `apps/web/tests/e2e/connectors.spec.ts` — add a unit-style check: call `getConnectorStatus` with three fabricated `Connector` objects (fresh, stale, null `schema_cached_at`) and assert the returned tier strings — this can be done as a Playwright `page.evaluate` block or an inline test import.

**Done criteria:**
- `connectors.module.css` imports without error in a Next.js build
- `getConnectorStatus({ schema_cached_at: new Date().toISOString() })` returns `tier: 'fresh'`
- `getConnectorStatus({ schema_cached_at: null })` returns `tier: 'unconfigured'`
- All four `*Icon` components render an SVG element

---

### Commit 2 — feat(connectors): list — accent headers, card grid, rich empty states
**Why:** Delivers all three major visual improvements to the connector list in one commit; all changes are in one file and depend only on Commit 1.
**Parallelizable with:** Commits 3 and 4

**Files:**
- `apps/web/app/builder/connectors/ConnectorList.tsx` — MODIFIED: full visual overhaul

**Interface contracts** (public surface unchanged):
- `ConnectorCategory` type — still exported unchanged
- `ConnectorList({ connectors, onManage, onAdd })` — prop shape unchanged; callers need no updates

**Implementation notes:**
- Delete the four inline SVG functions `FilesIcon`, `DatabasesIcon`, `ApisIcon`, `SharedTablesIcon` from `ConnectorList.tsx` and replace their import with `import { CATEGORY_ICONS, CATEGORY_ACCENT } from './ConnectorIcons'`.
- Delete `isConnected()` and replace with `import { ConnectorStatusBadge } from './ConnectorStatusBadge'`.
- Import `styles from './connectors.module.css'`.
- Section header element: `<div className={styles.sectionHeader} style={{ '--cat-accent': CATEGORY_ACCENT[category] } as React.CSSProperties}>` — TypeScript requires the `as React.CSSProperties` cast for custom properties.
- Card grid: the 2-column grid wraps the `categoryConnectors.map(...)` block. Each card needs `style={{ '--cat-accent': CATEGORY_ACCENT[category] } as React.CSSProperties}` for the icon well tint.
- Type chip: add `connector.type` in a `<span className={styles.typeChip}>` — this is the raw type value (e.g. "postgres") and is acceptable inside a chip label.
- Manage button: stays in DOM for accessibility; visibility is CSS-only via `.card:hover .manageBtn`.
- Empty-state description strings per category: `{ files: 'Upload CSV data files', databases: 'Connect Postgres, MySQL, or SQL Server', apis: 'Connect REST or GraphQL web services', 'shared-tables': 'Create managed shared data tables' }` — hardcode these; they are not translated in this feature.

**Tests** (written in this commit):
- `apps/web/tests/e2e/connectors.spec.ts` — assert that the connector list renders at least one `.cardGrid` element; assert that an empty category section contains a `.emptyCard` element.

**Done criteria:**
- Connector list renders as a 2-column card grid (no flat rows)
- Each card shows icon, name, type chip, and status badge
- Empty category shows dashed-border card with description and CTA (no underlined text link)
- No inline `style={{ ... }}` objects remain in `ConnectorList.tsx`
- All four `isConnected` references are removed

---

### Commit 3 — feat(connectors): type picker — SVG icons and CSS-only hover
**Why:** Removes emoji and JS style mutation from the type picker; uses shared icons and module hover rules.
**Parallelizable with:** Commits 2 and 4

**Files:**
- `apps/web/app/builder/connectors/ConnectorTypePicker.tsx` — MODIFIED

**Interface contracts** (public surface unchanged):
- `ConnectorTypePicker({ onSelect, initialCategory })` — prop shape unchanged

**Implementation notes:**
- Import `{ FilesIcon, DatabasesIcon, ApisIcon, SharedTablesIcon }` from `'./ConnectorIcons'` and `styles from './connectors.module.css'`.
- Replace emoji in `MAIN_TILES` and `DB_TILES` with component references: `spreadsheet→FilesIcon`, `database→DatabasesIcon`, `webService→ApisIcon`, `graphql→ApisIcon`, `sharedTable→SharedTablesIcon`, `moreOptions→null` (render a `⋯` text span instead). DB brand tiles: `postgres→DatabasesIcon`, `mysql→DatabasesIcon`, `mssql→DatabasesIcon`.
- Render icon as a `<span className={styles.tileIcon}><Icon /></span>` (add `.tileIcon` to the CSS module in Commit 1 if not already there — the implementer should add it: `font-size: 0; line-height: 0; display: flex;`).
- Remove ALL `onMouseEnter`/`onMouseLeave` handlers from both the main tile and DB sub-tile buttons.
- Replace the four style const objects (`tileStyle`, `backBtnStyle`, `subHeadStyle`, `labelStyle`) with `styles.typePickerTile`, `styles.typePickerBack`, `styles.typePickerSubHead`, and a plain inline font-size for labels.
- Hover border-color per tile: in `connectors.module.css`, add `[data-tile="spreadsheet"]:hover { --tile-hover-border: var(--accent-files); }` etc. for each data-tile value. The `.typePickerTile` base class sets `border-color: var(--tile-hover-border, var(--color-border))`. The `data-tile` attributes already exist on every tile button.
- The `disabled` state for `moreOptions` tile: keep `opacity: 0.4` and `cursor: default` as inline style (only 2 properties, justified for a one-off disabled variant).

**Tests** (written in this commit):
- `apps/web/tests/e2e/connectors.spec.ts` — open the "New connector" picker, assert that no tile contains an emoji character (use a regex check against inner text), assert that clicking the database tile navigates to the DB sub-step.

**Done criteria:**
- No emoji in any tile button
- No `onMouseEnter` or `onMouseLeave` attributes in `ConnectorTypePicker.tsx`
- All four style const objects removed
- Clicking a tile still fires `onSelect` with the correct `ConnectorType`

---

### Commit 4 — feat(connectors): drawer — status-rich header and styled section dividers
**Why:** Applies shared icon + status badge to the drawer header and replaces hardcoded `#1e1e1e` dividers with the module class.
**Parallelizable with:** Commits 2 and 3

**Files:**
- `apps/web/app/builder/connectors/ConnectorDrawer.tsx` — MODIFIED: widen `title` prop to `React.ReactNode`
- `apps/web/app/builder/connectors/ConnectorDetailDrawer.tsx` — MODIFIED: compose header JSX; replace `sectionHeaderStyle.borderTop` with module class

**Interface contracts:**
- `ConnectorDrawer` props after change: `{ isOpen: boolean; onClose: () => void; children: React.ReactNode; title?: React.ReactNode }` — `title` string usages elsewhere still work because `string extends React.ReactNode`
- `sectionHeaderStyle` in `ConnectorDetailDrawer.tsx`: remove `borderTop` from this object and add `className={styles.drawerDivider}` to every section header `<button>` element instead

**Implementation notes:**
- In `ConnectorDrawer.tsx`, the only change is the TypeScript type of `title`: `title?: string` → `title?: React.ReactNode`. The runtime rendering is identical — React renders both strings and elements.
- In `ConnectorDetailDrawer.tsx`:
  - Import `{ CATEGORY_ICONS, TYPE_TO_CATEGORY, CATEGORY_ACCENT }` from `'./ConnectorIcons'`
  - Import `{ ConnectorStatusBadge }` from `'./ConnectorStatusBadge'`
  - Import `styles from './connectors.module.css'`
  - Compose the header title: resolve `const category = TYPE_TO_CATEGORY[connector.type]` and `const Icon = category ? CATEGORY_ICONS[category] : null`. Pass to `ConnectorDrawer` as `title={<span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>{Icon && <Icon />}<span>{connector.name ?? t('title')}</span><ConnectorStatusBadge connector={connector} /></span>}`
  - `sectionHeaderStyle`: remove `borderTop: '1px solid #1e1e1e'` from the const. Add `className={styles.drawerDivider}` to each of the five `<button ... style={sectionHeaderStyle}>` elements. Using both a className and a style object on the same button is fine as long as neither conflicts.
  - The `aria-label` on `ConnectorDrawer`'s backdrop/dialog currently uses `title ?? 'Drawer'`. Since `title` is now `React.ReactNode`, update `aria-label` in `ConnectorDrawer.tsx` to `typeof title === 'string' ? title : 'Connector drawer'` to keep a valid ARIA string.

**Tests** (written in this commit):
- `apps/web/tests/e2e/connectors.spec.ts` — click Manage on a connected connector, assert the drawer header contains an SVG element and the status badge text (e.g., "Synced" or "Not set up yet").

**Done criteria:**
- Drawer header shows a category SVG icon to the left of the connector name
- Drawer header shows the correct status badge tier color and label
- Section accordion headers have a visible top border that resolves from the CSS variable (not hardcoded `#1e1e1e`)
- `ConnectorDrawer`'s `aria-label` is always a valid string

---

## Critical Files
| File | Why Critical |
|------|-------------|
| `apps/web/app/builder/connectors/connectors.module.css` | Foundation for all 3 implementation commits; class names are interface contracts |
| `apps/web/app/builder/connectors/ConnectorIcons.tsx` | `CATEGORY_ACCENT` and `TYPE_TO_CATEGORY` shapes are depended on by Commits 2, 3, and 4 |
| `apps/web/app/builder/connectors/ConnectorStatusBadge.tsx` | `getConnectorStatus()` signature consumed by Commits 2 and 4 |
| `apps/web/app/builder/connectors/ConnectorDrawer.tsx` | Single prop type change; downstream callers that pass a `string` title are unaffected but must not regress |
| `apps/web/app/globals.css` | Source of all `--color-*` tokens referenced in the module; must not be modified |

## Open Questions
Minor unknowns the implementing agent should resolve at implementation time:
- **CSS module `:root` scope:** Confirm that CSS custom properties defined at `:root` inside a `.module.css` file are compiled as global `:root` rules by Next.js / PostCSS — they should be, but verify in the first build. If not, move the four `--accent-*` definitions to `globals.css`.
- **`ConnectorStatusBadge` in E2E test:** The `getConnectorStatus` function is a pure utility; if wiring it into a `page.evaluate` call is awkward in Playwright, replace that test item with a DOM-visible assertion on the badge class name instead.

## Risks
| Risk | Mitigation |
|------|-----------|
| CSS module class names used as string literals across 3 files create a fragile coupling | Define a `// NOTE: class names below are referenced by name in ConnectorIcons.tsx and ConnectorStatusBadge.tsx` comment block at the top of `connectors.module.css` to flag them as a contract |
| Widening `ConnectorDrawer title` to `React.ReactNode` could break `aria-label` (must be string) | Commit 4 implementation notes specify the `typeof title === 'string'` guard — must not be skipped |
| Commits 2, 3, 4 run in parallel; if Commit 1 has a bug in `CATEGORY_ACCENT`, all three fail simultaneously | Merge and verify Commit 1 in isolation before starting parallel work |
| Removing `isConnected()` from `ConnectorList.tsx` (binary logic) and replacing with three tiers may silently change what counts as "connected" for the 1–7 day stale range | Current `isConnected` shows "Connected" for anything within 7 days → new logic shows "stale" (amber) for 1–7 days — confirm this visual demotion is acceptable before merging Commit 2 |










































