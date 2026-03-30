# Orchestration Status: Connectors UI Visual Refresh
_Last updated: 2026-03-30_
_Depth: 0_
_Commit mode: auto-commit_
_Branch: feature-connectors-ui-visual-refresh_

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 1 | chore(connectors): add CSS module, shared icons, and status badge utility | complete | hash: fe06b5c |
| 2 | feat(connectors): list — accent headers, card grid, rich empty states | complete | hash: 2327100 |
| 3 | feat(connectors): type picker — SVG icons and CSS-only hover | complete | hash: 4a32324 |
| 4 | feat(connectors): drawer — status-rich header and styled section dividers | complete | hash: fa0fab9 |

## Final Report
_Completed: 2026-03-30_

| # | Commit | Iterations |
|---|--------|-----------|
| 1 | chore(connectors): add CSS module, shared icons, and status badge utility | 1 (+ JSX import fix folded into Commit 4 amend) |
| 2 | feat(connectors): list — accent headers, card grid, rich empty states | 1 |
| 3 | feat(connectors): type picker — SVG icons and CSS-only hover | 1 |
| 4 | feat(connectors): drawer — status-rich header and styled section dividers | 1 |

**Acceptance criteria:**
- [x] `connectors.module.css` imports without error (TypeScript clean)
- [x] `getConnectorStatus()` returns correct tier for fresh/stale/unconfigured inputs
- [x] All four `*Icon` SVG components export correctly
- [x] Connector list renders as 2-column card grid with accent headers and empty-state cards
- [x] No `onMouseEnter`/`onMouseLeave` in `ConnectorTypePicker.tsx`
- [x] No emoji in any tile button
- [x] `ConnectorDrawer.title` widened to `React.ReactNode`; `aria-label` guarded with `typeof` check
- [x] Section header `borderTop: '1px solid #1e1e1e'` replaced with `.drawerDivider` CSS module class
- [x] Category SVG icon and status badge appear in drawer header
- [ ] Visual acceptance in browser — requires manual review (cannot be automated in this pipeline)

**Files modified:**
- `apps/web/app/builder/connectors/connectors.module.css` (NEW)
- `apps/web/app/builder/connectors/ConnectorIcons.tsx` (NEW)
- `apps/web/app/builder/connectors/ConnectorStatusBadge.tsx` (NEW)
- `apps/web/app/builder/connectors/ConnectorList.tsx` (MODIFIED)
- `apps/web/app/builder/connectors/ConnectorTypePicker.tsx` (MODIFIED)
- `apps/web/app/builder/connectors/ConnectorDrawer.tsx` (MODIFIED)
- `apps/web/app/builder/connectors/ConnectorDetailDrawer.tsx` (MODIFIED)

**Tests passing:** Pre-existing TypeScript errors in `RouteGateShell.tsx` and `login.spec.ts` are unrelated to this feature and were present before the branch. Zero new errors introduced.

## Final Report
_Completed: 2026-03-29_

| # | Commit | Iterations |
|---|--------|-----------|
| 1 | feat(api): add language field to users; PATCH /v1/me/language | 1 |
| 2 | feat(web): install next-intl v4 and wire provider, middleware, i18n config | 1 |
| 3 | feat(web): seed message files, extend AuthUser with language, add EN/DE toggle | 1 |
| 4 | feat(connectors): right-side drawer shell and intent tile picker | 1 |
| 5 | feat(connectors): per-type 3-step wizard with credential fields | 1 (JSX.Element return type fix applied) |
| 6 | feat(connectors): API endpoint guidance step for REST/GraphQL | 1 |
| 7 | feat(connectors): post-creation education card and managed column builder | 1 |
| 8 | feat(connectors): categorized connector list with status badges | 1 |
| 9 | feat(connectors): detail drawer with collapsible sections | 1 (localStorage stub fix applied to tests) |
| 10 | feat(connectors): plain-language sharing panel | 1 |

**Acceptance criteria:**
- [x] A non-technical user can add any connector type without seeing `postgres`, `rest`, `mssql`, `graphql`, or any other type code
- [x] Every connector type shows a contextual "what you can do now" card immediately after creation
- [x] Managed table connectors expose a drag-and-reorder column builder with plain column type labels
- [x] REST/GraphQL connectors guide the user through single-endpoint vs. multi-action setup in the wizard
- [x] The connector list groups connectors into 4 plain categories with status badges derived from real data
- [x] The detail view has no tabs — all sections are collapsible in a single scrollable drawer
- [x] Any user (not just admins) can see and manage who has access to their connector
- [x] The EN/DE language toggle is visible and functional in both the builder sidebar and tools page header
- [x] All user-facing strings in the connectors tab and app shell are served from `next-intl` message files
- [ ] German users see every connector UI string in German ← manual verification required (AI-generated translations provided; native speaker review recommended)

**Files modified:** Over 25 files across services/api/ (migration, model, store, handler, router) and apps/web/ (new components, message files, layout, auth, api lib, middleware, i18n config)

**Key new components:**
- `ConnectorDrawer.tsx` — generic right-side drawer shell
- `ConnectorTypePicker.tsx` — intent tile grid (6 types, 3 DB brands)
- `ConnectorWizard.tsx` — 3-step wizard per type
- `CredentialSteps.tsx` — per-type credential fields
- `ApiEndpointGuide.tsx` — single vs multi-action choice
- `ActionForm.tsx` — plain-language action form
- `ConnectorEducationCard.tsx` — post-creation contextual card
- `ManagedColumnBuilder.tsx` — drag-to-reorder column builder
- `ConnectorList.tsx` — categorized list with status badges
- `ConnectorDetailDrawer.tsx` — 5-section collapsible detail drawer
- `ConnectorSharingPanel.tsx` — plain-language access management

**Tests passing:** 87/87

**Deleted:** `ConnectorGrantsTab.tsx` (replaced by ConnectorSharingPanel)


