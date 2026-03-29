# Orchestration Status: Connectors Tab Redesign + App-Wide i18n
_Last updated: 2026-03-29_
_Depth: 0_
_Commit mode: auto-commit_
_Branch: feature-ux-first-release-readiness (no new branch)_

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 1 | feat(api): add language field to users; PATCH /v1/me/language | complete | hash: d6e60a9 |
| 2 | feat(web): install next-intl v4 and wire provider, middleware, i18n config | complete | hash: 0592dd0 |
| 3 | feat(web): seed message files, extend AuthUser with language, add EN/DE toggle | complete | hash: 1ac0b48 |
| 4 | feat(connectors): right-side drawer shell and intent tile picker | complete | hash: 43f101e |
| 5 | feat(connectors): per-type 3-step wizard with credential fields | complete | hash: 227485e |
| 6 | feat(connectors): API endpoint guidance step for REST/GraphQL | complete | hash: c00276a |
| 7 | feat(connectors): post-creation education card and managed column builder | complete | hash: 30d26ba |
| 8 | feat(connectors): categorized connector list with status badges | complete | hash: ace61e7 |
| 9 | feat(connectors): detail drawer with collapsible sections | complete | hash: 55c1c34 |
| 10 | feat(connectors): plain-language sharing panel | complete | hash: 064ae3a |

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


