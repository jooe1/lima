# Implementation Plan: Connectors UI Visual Refresh
_Last updated: 2026-03-30_
_Feature slug: connectors-ui-visual-refresh_

## Goal
Apply a modern, polished visual refresh to the three connectors UI components — `ConnectorList.tsx`, `ConnectorTypePicker.tsx`, and `ConnectorDetailDrawer.tsx`. The refresh introduces a shared CSS module for design token–based styles, replaces flat rows with interactive cards, upgrades section headers with category identity, adds three-tier health-aware status badges, and replaces bare empty-state links with structured placeholder cards. The type picker and detail drawer receive matching consistency treatment so the whole panel feels cohesive. Every change stays within the existing component and API boundaries — no backend changes, no new routes.

## Areas

### 1. Shared CSS module — `connectors.module.css`
Create `apps/web/app/builder/connectors/connectors.module.css` defining all classes used by Areas 2–7: section header with left-bar accent, category color tokens as CSS custom properties, connector card grid and hover/focus states, three badge tier classes (fresh/stale/unconfigured), a `@keyframes` pulse animation for the status dot, empty-state card, type-picker tile hover, and drawer section dividers. All color values reference the existing `globals.css` CSS variables (`--color-*`, `--radius-*`, `--space-*`) — no new hex literals.
_Depends on: none_

### 2. Section headers with left-bar category accent
In `ConnectorList.tsx`, replace the faint `border-bottom: 1px solid #1e1e1e` header row with a row that has a 3px left-side accent bar, color-coded per category (amber for files, teal for databases, blue for APIs, purple for shared tables). Increase label font weight and size. Move the count badge to the right side next to the Add button. Remove inline styles; use CSS module classes.
_Depends on: Area 1_

### 3. Connector rows → 2-column card grid
In `ConnectorList.tsx`, replace the vertical list of flat rows with a 2-column CSS grid. Each card shows a larger (20px) category icon in a lightly tinted icon well (matching the category accent color), the connector name in larger text, a connector type chip (e.g. "postgres"), and the status badge. The Manage button appears as a ghost button that fades in on card `:hover`. Cards get a subtle `box-shadow` lift and `border-color` transition on hover. Remove all inline styles; use CSS module classes.
_Depends on: Areas 1, 2_

### 4. Three-tier health-aware status badges
Replace the binary Connected / Not-set-up badge with a three-tier system derived from `schema_cached_at`: **Fresh** (synced within 24h — green dot with CSS pulse + "Synced Xh ago"), **Stale** (synced 1–7 days ago — amber dot + "Synced X days ago"), **Unconfigured** (never synced — gray dot + "Not set up yet"). Extract a `getConnectorStatus()` helper that returns a tier value and a display string. Apply CSS module badge classes per tier. Used in both `ConnectorList.tsx` and `ConnectorDetailDrawer.tsx`.
_Depends on: Area 1_

### 5. Rich empty-state cards
In `ConnectorList.tsx`, replace the plain underlined text link in empty category sections with a structured empty-state card: dashed border, centered large (32px) dimmed category icon, a one-line plain-language description per category (e.g. "Connect a Postgres, MySQL, or MSSQL database"), and a solid primary CTA button. The card spans the full available width at a fixed min-height. Use CSS module classes.
_Depends on: Areas 1, 2_

### 6. Type picker visual upgrade + shared icons file
Extract the four category SVG icons from `ConnectorList.tsx` into a new shared file `ConnectorIcons.tsx`. In `ConnectorTypePicker.tsx`, replace emoji icons with the matching SVGs from `ConnectorIcons.tsx`. Apply per-category accent colors on tile border `:hover` instead of the flat `#2563eb` for all tiles. Remove all `onMouseEnter`/`onMouseLeave` JS hover handlers — replace with pure CSS `:hover` via the module. Update the back button and sub-step heading to use CSS module classes.
_Depends on: Areas 1, 3_

### 7. Detail drawer header and section-divider polish
In `ConnectorDetailDrawer.tsx`, update the drawer header to show the shared category SVG icon (from `ConnectorIcons.tsx`), the connector name at a larger weight, and the three-tier status badge (from Area 4). Replace the plain `border-top` section dividers between accordion sections with a styled divider class from the CSS module. No section content changes — only the header chrome and dividers.
_Depends on: Areas 1, 4, 6_
| `apps/web/lib/auth.tsx` | Add `language` field to `AuthUser`; update on preference save |
| `apps/web/lib/api.ts` | Add `patchUserLanguage(lang)` API call |
| `services/api/internal/model/model.go` | Add `Language` field to `User` struct |
| `services/api/migrations/` | New migration: `ALTER TABLE users ADD COLUMN language VARCHAR(5) DEFAULT 'en'` |
| `services/api/` | New handler: `PATCH /users/me/language` |

### Planning Handoff
- **Recommended implementation order:** Phase 0 first (i18n infra + backend migration) → Phase 1 (creation flow) → Phase 2 (education) → Phase 3 (list) → Phase 4 (detail/management). Phases 1–4 can be reviewed incrementally as the existing page is replaced section by section.
- **Workstreams:** (1) Backend: Go migration + language endpoint; (2) i18n infra: next-intl setup + message files; (3) Connector creation flow: tile picker + wizard; (4) Connector detail: drawer + collapsible sections; (5) Sharing panel
- **Major dependencies:** Phase 0 (i18n + backend) must land before any new connector UI ships translated strings. The drawer/detail redesign (Area 7) depends on the education card (Area 4) and column builder (Area 5) being ready to embed.
- **Key open question for implementer:** The access escalation prevention rule (Area 8) needs the API to return the current user's own grant level per connector — confirm whether `listConnectors` response already includes this or if a small API addition is needed before building the sharing panel.

