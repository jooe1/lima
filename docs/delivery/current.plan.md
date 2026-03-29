# Delivery Plan: Connectors Tab Redesign + App-Wide i18n
_Last updated: 2026-03-29_
_Feature slug: connectors-tab-redesign_
_Source: docs/clarity/current.plan.md_

## Goal
Deliver a fully redesigned, non-technical-friendly connectors experience with full English + German language support; the commit order starts with the Go backend language field and the Next.js i18n infrastructure (which every UI commit depends on), then builds the creation flow, post-creation education, list view, and detail management in that order, with `page.tsx` modified incrementally at each step.

## Stack Decisions
| Decision | Value | Reason |
|----------|-------|--------|
| i18n library | `next-intl` v4 | App Router native, TypeScript-first, cookie-based non-URL locale; no route changes needed |
| Locale storage | Per-user in DB (`users.language`), cookie `NEXT_LOCALE` as fast-path cache, fallback to `Accept-Language` | Clarity plan decision; survives server-side rendering |
| URL strategy | No `/de/` prefix | All existing routes remain unchanged; locale from cookie only |
| Translation source | AI-generated `messages/en.json` + `messages/de.json` | No professional translator pipeline needed |
| Language picker | EN/DE compact toggle in builder sidebar footer + tools header | No new settings page needed |
| Connector type picker | Intent tile grid in a right-side drawer | Replaces raw `<select>` with plain-language tiles |
| Setup flow | 3-step wizard inside the drawer, max 3 fields per step | Non-tech UX; technical fields behind tooltips or "More options" |
| Detail view | Single slide-in drawer, 5 collapsible sections, no tabs | Replaces current 3-tab bottom panel |
| Column builder save | Optimistic on blur | Clarity plan decision |
| Status derivation | `schema_cached_at` presence → "Connected" vs "Not set up yet" | No new backend field needed |
| Sharing panel audience | Visible to all users, not admin-only | Replaces `ConnectorGrantsTab` which was admin-only |

## Commits

### Commit 1 — feat(api): add language field to users; PATCH /v1/me/language
**Why:** All i18n work depends on the backend storing and serving the user's preferred language; this is the only backend change in the plan and must land first.
**Parallelizable with:** Commit 2

**Files:**
- `services/api/migrations/021_user_language.up.sql` — NEW: `ALTER TABLE users ADD COLUMN language VARCHAR(5) NOT NULL DEFAULT 'en'`
- `services/api/migrations/021_user_language.down.sql` — NEW: `ALTER TABLE users DROP COLUMN language`
- `services/api/internal/model/model.go` — MODIFIED: add `Language string` field to `User` struct
- `services/api/internal/store/users.go` — MODIFIED: add `language` to `userCols` constant, both `Scan` calls, and new `SetUserLanguage(ctx context.Context, userID, lang string) error` method
- `services/api/internal/handler/users.go` — NEW: `PatchMyLanguage(s *store.Store, log *zap.Logger) http.HandlerFunc`; validates lang is `"en"` or `"de"`, calls `SetUserLanguage`, returns 204 No Content
- `services/api/internal/router/router.go` — MODIFIED: add `r.Patch("/language", handler.PatchMyLanguage(s, log))` inside the existing `/v1/me` route group
- `services/api/internal/handler/users_test.go` — NEW: tests for `PatchMyLanguage`

**Interface contracts** (names and shapes other commits depend on):
- `PATCH /v1/me/language` request body: `{"language": "en" | "de"}` → 204 No Content; 400 if unsupported value
- `model.User.Language string` — `"en"` or `"de"`; DB default `"en"`
- `store.Store.SetUserLanguage(ctx context.Context, userID, lang string) error`

**Implementation notes:**
- Follow the exact pattern of `GetMyAISettings` in `handler/ai_settings.go`: extract claims with `ClaimsFromContext`, validate, call store, return. No new middleware needed.
- `userCols` in `store/users.go` is a bare string constant (`"id, company_id, email, name, sso_subject, created_at, updated_at"`) — append `, language` and add `&u.Language` to both `scanUser` and `scanUserRows` Scan calls.
- Reject any lang value not in `{"en", "de"}` with a 400; do not silently ignore unknown values.

**Tests** (written in this commit):
- `handler/users_test.go` — happy path PATCH returns 204, unknown lang returns 400, unauthenticated returns 401

**Done criteria:**
- `PATCH /v1/me/language` with `{"language":"de"}` returns 204; a subsequent user lookup shows `language = "de"`
- `{"language":"fr"}` returns 400
- Migration 021 runs cleanly; `\d users` shows `language varchar(5) not null default 'en'`

---

### Commit 2 — feat(web): install next-intl v4 and wire provider, middleware, i18n config
**Why:** Establish the Next.js i18n infrastructure that all subsequent `useTranslations()` calls require; no user-facing strings change in this commit.
**Parallelizable with:** Commit 1

**Files:**
- `apps/web/package.json` — MODIFIED: add `"next-intl": "^4.0.0"` to dependencies
- `apps/web/next.config.ts` — MODIFIED: wrap export with `createNextIntlPlugin('./i18n/request.ts')`
- `apps/web/middleware.ts` — NEW: re-export `createMiddleware` from next-intl configured with `locales: ['en','de']`, `defaultLocale: 'en'`; reads locale from `NEXT_LOCALE` cookie (`localeCookie: 'NEXT_LOCALE'`)
- `apps/web/i18n/routing.ts` — NEW: `export const routing = defineRouting({ locales: ['en','de'], defaultLocale: 'en', localePrefix: 'never' })`
- `apps/web/i18n/request.ts` — NEW: `getRequestConfig` async function; reads `NEXT_LOCALE` cookie from headers, falls back to `'en'`; returns `{ locale, messages: (await import(\`../messages/${locale}.json\`)).default }`
- `apps/web/app/layout.tsx` — MODIFIED: fetch messages server-side via `getMessages()` and wrap children with `<NextIntlClientProvider messages={messages}>`

**Interface contracts** (names and shapes other commits depend on):
- `useTranslations(namespace: string)` — available to all client components after this commit
- `getTranslations(namespace: string)` — available to server components
- Cookie name: `NEXT_LOCALE` — Commit 3's toggle sets this cookie to `"en"` or `"de"`
- `routing` export from `i18n/routing.ts` — imported by middleware

**Implementation notes:**
- `apps/web/middleware.ts` must live at the web app root (alongside `next.config.ts`), not inside `app/`. This is the standard next-intl App Router location.
- Do NOT use URL-based locale routing (`localePrefix: 'never'`); locale comes from the cookie only.
- `messages/en.json` and `messages/de.json` do not exist yet — create them as empty object stubs (`{}`) so the dynamic import in `request.ts` does not throw at startup. Commit 3 seeds them.
- `app/layout.tsx` is a Server Component — fetch messages server-side with `getMessages()` and pass to the Client Provider.

**Tests** (written in this commit):
- No new test file; verify `pnpm --filter @lima/web dev` starts without error with empty message stubs

**Done criteria:**
- `pnpm --filter @lima/web dev` starts without runtime errors
- `useTranslations('common')` can be called in a client component with an empty message file and returns the key as a fallback without crashing
- No existing routes or Server Component boundaries break

---

### Commit 3 — feat(web): seed message files, extend AuthUser with language, add EN/DE toggle
**Why:** Complete Phase 0 by seeding translations for all existing UI strings, wiring the stored language preference into the auth layer, and exposing the language toggle in the sidebar and tools header.
**Parallelizable with:** none (depends on Commits 1 + 2)

**Files:**
- `apps/web/messages/en.json` — MODIFIED: seed all existing hardcoded English strings from the app shell, builder nav, tools header, and login page; organized into namespaces `nav`, `common`, `auth`
- `apps/web/messages/de.json` — MODIFIED: AI-generated German equivalents for all seeded keys
- `apps/web/lib/auth.tsx` — MODIFIED: add `language: 'en' | 'de'` to `AuthUser` interface; populate from a bootstrap `/v1/me` GET on auth initialization
- `apps/web/lib/api.ts` — MODIFIED: add `patchUserLanguage(lang: 'en' | 'de'): Promise<void>` calling `PATCH /v1/me/language`; add `getMe(): Promise<{ language: 'en' | 'de' }>` if a `/v1/me` GET endpoint does not already exist
- `apps/web/app/builder/BuilderSidebar.tsx` — MODIFIED: add compact EN/DE toggle to sidebar footer; on click calls `patchUserLanguage`, sets `NEXT_LOCALE` cookie, calls `router.refresh()`
- `apps/web/app/tools/layout.tsx` — MODIFIED: add matching EN/DE toggle to header

**Interface contracts** (names and shapes other commits depend on):
- `AuthUser.language: 'en' | 'de'` — accessible via `useAuth().user.language` from Commit 4 onward
- `patchUserLanguage(lang: 'en' | 'de'): Promise<void>` — from `lib/api.ts`; used by both toggles
- Cookie set pattern in the toggle: `document.cookie = \`NEXT_LOCALE=${lang};path=/;max-age=31536000\``; then `router.refresh()`
- Message namespace structure for connector commits: `"connectors"` namespace with keys added per-commit; `"common"` for shared labels (Save, Cancel, Back, Next, Close, etc.)

**Implementation notes:**
- Check how `useAuth()` currently initializes `AuthUser` — if it decodes the JWT client-side, extend JWT claims to include `language` in `handler/auth.go`'s `issueJWT`; if it makes a `/v1/me` GET, add `language` to that response. The bootstrap GET approach is simpler.
- `router.refresh()` from `next/navigation` re-fetches Server Component data with the new cookie value — sufficient for locale switching without a full page reload.
- Do not nest message keys deeper than 2 levels: `{ "connectors": { "addConnector": "Add connector" } }`.

**Tests** (written in this commit):
- No new test file; cover the toggle with a manual smoke pass

**Done criteria:**
- EN/DE toggle is visible in the builder sidebar footer and in the tools page header
- Clicking DE: calls `PATCH /v1/me/language`, sets `NEXT_LOCALE=de` cookie, re-renders the page in German
- All existing nav/shell strings are served from next-intl message files (no hardcoded English strings remain in `BuilderSidebar.tsx`, `tools/layout.tsx`, or `app/layout.tsx`)
- `AuthUser.language` is `'de'` after the preference is saved

---

### Commit 4 — feat(connectors): right-side drawer shell and intent tile picker
**Why:** Replace the inline `ConnectorForm` and raw `<select>` type picker with a drawer-based tile grid; this is the entry point for the entire creation flow refactor.
**Parallelizable with:** none (depends on Commit 3; all Phase 1–4 connector commits sequence through `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ConnectorDrawer.tsx` — NEW: right-side slide-in drawer shell; overlay backdrop on mobile, slide-in on desktop; close button in header. Props: `{ isOpen: boolean; onClose: () => void; children: React.ReactNode; title?: string }`
- `apps/web/app/builder/connectors/ConnectorTypePicker.tsx` — NEW: 6-tile intent picker rendered inside the drawer; tile labels via `useTranslations('connectors')`; "Connect a database" tile triggers an inline 3-tile sub-step (PostgreSQL / MySQL / SQL Server); emits `onSelect(type: ConnectorType, dbBrand?: 'postgres' | 'mysql' | 'mssql')`
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: replace inline `ConnectorForm` open logic with `ConnectorDrawer` + `ConnectorTypePicker`; add `drawerState: 'closed' | 'type-picker' | 'wizard' | 'detail'` to component state; retain all existing CRUD state and API call wiring
- `apps/web/messages/en.json` — MODIFIED: add `connectors.typePicker.*` keys (tile labels, database sub-step heading)
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorDrawer` props: `{ isOpen: boolean; onClose: () => void; children: React.ReactNode; title?: string }`
- `ConnectorTypePicker` props: `{ onSelect: (type: ConnectorType, dbBrand?: 'postgres' | 'mysql' | 'mssql') => void }`
- `drawerState: 'closed' | 'type-picker' | 'wizard' | 'detail'` — lives in `page.tsx`; Commit 5 sets `'wizard'`, Commit 9 sets `'detail'`
- Tile → `ConnectorType` map: "Upload a spreadsheet" → `csv`; "Connect a database" → sub-step → `postgres/mysql/mssql`; "Connect a web service" → `rest`; "Call a GraphQL API" → `graphql`; "Create a shared table" → `managed`

**Implementation notes:**
- The existing `ConnectorForm` component stays in `page.tsx` in this commit; Commit 5 removes it. Do not delete it here — just stop rendering it as the primary form.
- The "More options" collapsed area in the tile picker is a visual placeholder in this commit; it does not need to reveal additional tiles yet.
- The database sub-step is rendered inline within `ConnectorTypePicker` (not a separate drawer step): 3 tiles → PostgreSQL / MySQL / SQL Server; selection maps to `dbBrand` passed to `onSelect`.

**Tests** (written in this commit):
- `ConnectorDrawer.test.tsx` — NEW: renders open/closed states; close button fires `onClose`; `ConnectorTypePicker` tile click calls `onSelect` with the correct `ConnectorType`

**Done criteria:**
- Clicking "New connector" opens `ConnectorDrawer` with 6 intent tiles
- "Connect a database" tile shows 3 brand sub-tiles; selecting one calls `onSelect` with correct type
- No raw connector type codes (`postgres`, `rest`, `mssql`, etc.) are visible to the user
- Existing connector list and detail panel continue to function (no regression)

---

### Commit 5 — feat(connectors): per-type 3-step wizard with credential fields
**Why:** Replace the one-step all-fields-at-once form with a guided 3-step flow showing max 3 fields per step with plain labels and contextual tooltips.
**Parallelizable with:** none (modifies `ConnectorDrawer.tsx` and `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ConnectorWizard.tsx` — NEW: wizard orchestrator; renders step 1 (connector name + plain description of what this type does), step 2 (type-specific credential fields from `CredentialSteps`), step 3 (access control placeholder; replaced by API endpoint guide for REST/GraphQL in Commit 6). Props: `{ connectorType: ConnectorType; dbBrand?: 'postgres' | 'mysql' | 'mssql'; onComplete: (connector: Connector) => void; onBack: () => void }`
- `apps/web/app/builder/connectors/CredentialSteps.tsx` — NEW: per-type step-2 field renderers; exports: `DatabaseStep`, `RestStep`, `CsvStep`, `ManagedStep`, `GraphQLStep`; each accepts `{ values: Record<string, string>; onChange: (key: string, value: string) => void }`. REST/GraphQL auth type shown as 4 tiles (No auth / Bearer token / API key / Username & password); MOCO hidden behind "More auth options" expand. CSV step auto-previews first 5 rows on file selection.
- `apps/web/app/builder/connectors/ConnectorDrawer.tsx` — MODIFIED: render `ConnectorTypePicker` when `drawerState === 'type-picker'`; render `ConnectorWizard` when `drawerState === 'wizard'`
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: remove `ConnectorForm` render path; on tile `onSelect`, set `drawerState = 'wizard'`; wire `ConnectorWizard.onComplete` to existing `createConnector` / `patchConnector` API calls
- `apps/web/messages/en.json` — MODIFIED: add `connectors.wizard.*` keys (step labels, field labels, tooltips, auth tile labels)
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorWizard` props: `{ connectorType: ConnectorType; dbBrand?: 'postgres' | 'mysql' | 'mssql'; onComplete: (connector: Connector) => void; onBack: () => void }`
- `CredentialSteps` named exports: `DatabaseStep`, `RestStep`, `CsvStep`, `ManagedStep`, `GraphQLStep` — each `(props: { values: Record<string, string>; onChange: (k: string, v: string) => void }) => JSX.Element`
- Step 3 slot in `ConnectorWizard` is a `children`-style extensibility point that Commit 6 fills for REST/GraphQL; for all other types it shows a "Who can use this?" intro paragraph (placeholder for Commit 10's sharing panel)

**Implementation notes:**
- Do NOT call the API on step 1→2 or 2→3 transitions; API call fires only when the user confirms step 3 ("Finish" / "Save" button).
- CSV step 2: auto-preview first 5 rows using `FileReader` + `String.split('\n')` + `split(',')` — no external CSV library. Preview renders as a small table.
- Managed type step 2: a single optional column name input ("Add your first column — you can add more later"); the full column builder is deferred to Commit 7.
- `ConnectorForm` can be removed from `page.tsx` in this commit once `ConnectorWizard` covers all types.

**Tests** (written in this commit):
- `ConnectorWizard.test.tsx` — NEW: step navigation (Next/Back), CSV preview renders on file load, form values persist when navigating back

**Done criteria:**
- Selecting any type from the tile picker opens a 3-step wizard inside the drawer
- Host/port/database fields have a "What's this?" tooltip; max 3 credential fields visible per step
- MOCO/token auth is hidden by default for REST; expand link reveals it
- CSV selection auto-previews 5 rows
- Completing the wizard creates the connector via the existing API; `ConnectorForm` is no longer rendered

---

### Commit 6 — feat(connectors): API endpoint guidance step for REST/GraphQL
**Why:** REST and GraphQL connectors need a choice between single-endpoint and action-catalog setups; this commit wires that choice into the wizard and introduces a simplified action form.
**Parallelizable with:** none (modifies `ConnectorWizard.tsx` and `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ApiEndpointGuide.tsx` — NEW: choice screen for REST/GraphQL wizard step 3; two tiles: "It does one specific thing" / "It has multiple actions". Props: `{ onSingleEndpoint: (label: string) => void; onMultiAction: () => void }`
- `apps/web/app/builder/connectors/ActionForm.tsx` — NEW: extracted + simplified action form; plain "Action name" field (→ `action_label`), "What URL does it call?" (→ `path_template`), HTTP method as 4 intent tiles ("Fetch data" / "Send data" / "Update" / "Delete"); `action_key`, `resource_name`, `input_fields` behind "Advanced options" toggle. Props: `{ action?: ActionDefinition; connectorId: string; workspaceId: string; onSave: (action: ActionDefinition) => void; onCancel: () => void }`
- `apps/web/app/builder/connectors/ConnectorWizard.tsx` — MODIFIED: for `rest`/`graphql` types, render `ApiEndpointGuide` at step 3; handle single-endpoint path (auto-create action then `onComplete`) and multi-action path (`onComplete` with a `{ multiAction: true }` flag)
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: on wizard `onComplete` with `multiAction: true`, set `drawerState = 'detail'` with action catalog section highlighted
- `apps/web/messages/en.json` — MODIFIED: add `connectors.apiGuide.*` and `connectors.actionForm.*` keys
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ApiEndpointGuide` props: `{ onSingleEndpoint: (label: string) => void; onMultiAction: () => void }`
- `ActionForm` props: `{ action?: ActionDefinition; connectorId: string; workspaceId: string; onSave: (action: ActionDefinition) => void; onCancel: () => void }`
- HTTP method tile → `http_method` map: "Fetch data" → `"GET"`, "Send data" → `"POST"`, "Update" → `"PUT"`, "Delete" → `"DELETE"` — defined as a constant in `ActionForm.tsx`
- `onComplete` extended signature: `(connector: Connector, opts?: { multiAction?: boolean }) => void`

**Implementation notes:**
- Single-endpoint auto-creation: generate `action_key` as a URL-safe slug of the user's label (lowercase, spaces → underscores); `resource_name` defaults to the connector name slug; `path_template` defaults to `""`.
- The existing inline action edit UI in `page.tsx` should be replaced by `ActionForm` in this commit. Check `page.tsx` for any inline action state and remove the duplicate form.
- Confirm with the backend team (or `connector_actions.go`) that `action_key` accepts auto-generated slug values before implementation — see Open Questions.

**Tests** (written in this commit):
- `ActionForm.test.tsx` — NEW: HTTP method tiles map to correct `http_method` values; "Advanced options" toggle reveals hidden fields

**Done criteria:**
- REST/GraphQL wizard step 3 shows the two-tile choice screen
- "It does one specific thing" auto-creates one action and completes the wizard
- "It has multiple actions" saves the connector and opens the action catalog with "Add your first action" prompt
- HTTP method picker in `ActionForm` shows intent tiles, not a raw `<select>`
- Technical fields are collapsed by default under "Advanced options"

---

### Commit 7 — feat(connectors): post-creation education card and managed column builder
**Why:** Every connector must show contextual next-steps immediately after creation; managed tables need an editable column builder instead of read-only type chips.
**Parallelizable with:** none (modifies `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ConnectorEducationCard.tsx` — NEW: per-type card with dismissal state stored in localStorage. Props: `{ connector: Connector; onDismiss: () => void; onCTA?: () => void }`. Card copy and CTA vary by `connector.type` per clarity plan Phase 2 Area 4.
- `apps/web/app/builder/connectors/ManagedColumnBuilder.tsx` — NEW: editable column list with drag-to-reorder (HTML5 drag API, no external DnD library); each row: name input + plain type picker; blur-to-save (optimistic `patchConnector`); "Add a column" button appends blank row. Props: `{ connectorId: string; workspaceId: string; columns: ManagedTableColumn[]; onColumnsChange: () => void }`
- `apps/web/app/builder/connectors/ConnectorSetupHint.tsx` — MODIFIED: remove usages from `page.tsx` in this commit; file may be deleted if no other consumers import it
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: after `createConnector` resolves, set a flag to show `ConnectorEducationCard` in the detail area; render `ManagedColumnBuilder` for managed-type connectors
- `apps/web/messages/en.json` — MODIFIED: add `connectors.educationCard.*` and `connectors.columnBuilder.*` keys
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorEducationCard` props: `{ connector: Connector; onDismiss: () => void; onCTA?: () => void }`
- `ManagedColumnBuilder` props: `{ connectorId: string; workspaceId: string; columns: ManagedTableColumn[]; onColumnsChange: () => void }`
- localStorage key pattern: `lima_edu_dismissed_${connectorId}` — checked on mount; if set, card renders nothing
- `col_type` → plain label map (constant exported from `ManagedColumnBuilder.tsx`, imported by Commit 9): `'text' → 'Text'`, `'int4' | 'float8' → 'Number'`, `'bool' → 'Yes/No'`, `'date' | 'timestamp' → 'Date'`, `'bytea' → 'File'`

**Implementation notes:**
- `ConnectorEducationCard` is temporarily placed in the detail area via direct `page.tsx` state; Commit 9 relocates it to the top of `ConnectorDetailDrawer`. The component itself does not care about placement.
- `ManagedColumnBuilder` calls the existing `patchConnector` from `lib/api.ts` on each blur to save the updated `columns` array.
- Raw `col_type` strings must never be displayed — always map through the plain label constant.

**Tests** (written in this commit):
- `ConnectorEducationCard.test.tsx` — NEW: correct per-type CTA text; localStorage dismissed state hides card on remount
- `ManagedColumnBuilder.test.tsx` — NEW: "Add a column" appends a row; plain type labels render; blur calls save (mocked API)

**Done criteria:**
- After creating any connector, the contextual education card appears with per-type copy and CTA
- Dismissing the card writes to localStorage; refreshing does not re-show it
- Managed connector detail shows the editable column builder; raw `col_type` values (`text`, `int4`, `bool`) are never shown

---

### Commit 8 — feat(connectors): categorized connector list with status badges
**Why:** Replace the flat card grid with a grouped, status-first list that lets non-technical users find their connectors at a glance.
**Parallelizable with:** none (modifies `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ConnectorList.tsx` — NEW: vertically grouped list with 4 categories: "Your Files" (csv), "Databases" (postgres/mysql/mssql), "APIs & Web Services" (rest/graphql), "Shared Tables" (managed); per row: SVG category icon + name + status badge + owner name + "Manage" button; category header has count badge + "＋ Add" button; empty categories collapse to "＋ Add your first [category]" link. Props: `{ connectors: Connector[]; onManage: (connector: Connector) => void; onAdd: (category: ConnectorCategory) => void }`
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: replace card grid render with `ConnectorList`; wire `onManage` to open existing detail; wire `onAdd` to open drawer with tile picker at the correct category pre-highlighted
- `apps/web/messages/en.json` — MODIFIED: add `connectors.list.*` keys (category names, status labels, "Manage", "Add" CTAs)
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorList` props: `{ connectors: Connector[]; onManage: (connector: Connector) => void; onAdd: (category: ConnectorCategory) => void }`
- `ConnectorCategory = 'files' | 'databases' | 'apis' | 'shared-tables'` — exported from `ConnectorList.tsx`; used by `page.tsx` to pre-select tile picker context
- Status badge derivation: `connector.schema_cached_at` non-null and within 7 days → `"Connected"` (green); otherwise → `"Not set up yet"` (grey)
- SVG icons: one per category (not per sub-type); inline SVG or local `icons/` folder; do not add an icon library dependency

**Implementation notes:**
- Remove `ConnectorCard` component from `page.tsx` once `ConnectorList` replaces it.
- The existing "Refresh" button moves to a small icon button (↻) in the page header — not per-row.
- Empty category collapse: render category header + the "＋ Add your first [category]" link only; connector rows section is `null`.
- Never expose `connector.type` raw values in the rendered list — use category names only.

**Tests** (written in this commit):
- `ConnectorList.test.tsx` — NEW: connectors grouped correctly; empty category collapses; status badge reflects `schema_cached_at`

**Done criteria:**
- Connector list shows 4 plain category groups; raw type codes not visible
- Status badge is "Connected" for connectors with a non-null `schema_cached_at` and "Not set up yet" otherwise
- Empty categories show only the "＋ Add your first [category]" link
- "Manage" and "＋ Add" buttons work correctly

---

### Commit 9 — feat(connectors): detail drawer with collapsible sections
**Why:** Replace the current 3-tab bottom panel with a single slide-in drawer containing 5 collapsible accordion sections; integrate the education card and column builder into the drawer.
**Parallelizable with:** none (depends on Commits 7 + 8; modifies `page.tsx`)

**Files:**
- `apps/web/app/builder/connectors/ConnectorDetailDrawer.tsx` — NEW: slide-in right-side drawer; 5 collapsible sections (first 2 open by default): (1) "What you can do" — `ConnectorEducationCard` (dismissible; after dismissal collapses to a one-line "Show tips" link); (2) "Your data" — `ManagedColumnBuilder` for managed, 10-row preview table for csv/database, action list for rest/graphql with "Add action" CTA; (3) "Connection settings" — credential edit using `CredentialSteps` as a single-step form + "Test connection" button with plain result copy; (4) "Who has access" — `<ConnectorSharingPanel>` placeholder (`data-testid="sharing-panel-placeholder"`) replaced in Commit 10; (5) "For developers" — schema tree, raw query tester, type badge — admin-only, collapsed by default. Props: `{ connector: Connector | null; isOpen: boolean; onClose: () => void; onConnectorChange: () => void }`
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: replace `DetailPanel` (3-tab panel) with `ConnectorDetailDrawer`; wire "Manage" clicks from `ConnectorList` to set `drawerState = 'detail'`; set `selectedConnector` on manage click
- `apps/web/messages/en.json` — MODIFIED: add `connectors.detail.*` keys (section headings, test connection copy, "For developers" label)
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorDetailDrawer` props: `{ connector: Connector | null; isOpen: boolean; onClose: () => void; onConnectorChange: () => void }`
- Section 4 is a `data-testid="sharing-panel-placeholder"` div — Commit 10 replaces this with `<ConnectorSharingPanel>`
- "Test connection" result copy map: `"ok"` backend status → `"Everything looks good ✓"`; error → `"We couldn't connect — {plain reason}. Check your {password / API key / address}."` — do not expose raw backend error strings

**Implementation notes:**
- Sections use controlled expand/collapse state (not `<details>/<summary>`) so programmatic opening (e.g., after education card CTA) works reliably.
- "For developers" section renders only when `useAuth().user.role === 'workspace_admin'`; moves `SchemaTree` and `QueryResultTable` out of the main panel and into this section.
- Use `CredentialSteps` from Commit 5 rendered as a single-step form (not a 3-step wizard) inside "Connection settings".
- Old `DetailPanel` component can be deleted from `page.tsx` in this commit.

**Tests** (written in this commit):
- `ConnectorDetailDrawer.test.tsx` — NEW: open/close state, first 2 sections expanded by default, section 5 not rendered for non-admin

**Done criteria:**
- Clicking "Manage" on any row opens `ConnectorDetailDrawer` (not the old 3-tab panel)
- First 2 sections expanded; remaining 3 collapsed by default
- "For developers" section not visible to non-admin users
- "Test connection" button shows plain-language success/failure copy
- Old 3-tab `DetailPanel` is no longer rendered

---

### Commit 10 — feat(connectors): plain-language sharing panel
**Why:** Replace the admin-only `ConnectorGrantsTab` with a sharing panel visible to all users, using only plain-language vocabulary (no "grants", "permissions", or "audience").
**Parallelizable with:** none (depends on Commit 9)

**Files:**
- `apps/web/app/builder/connectors/ConnectorSharingPanel.tsx` — NEW: sharing panel; current grantees as name+avatar chips with inline role dropdown ("Can view data" / "Can view and edit data"); "Add people" search input (name or email); remove (×) button per chip; owner chip pinned first and non-removable; admin-only "Restrict to read-only for everyone" toggle; escalation prevention: role dropdown disabled for options above the current user's own grant level for this connector. Props: `{ connectorId: string; workspaceId: string }`
- `apps/web/app/builder/connectors/ConnectorDetailDrawer.tsx` — MODIFIED: replace section 4 placeholder div with `<ConnectorSharingPanel connectorId={connector.id} workspaceId={workspaceId} />`
- `apps/web/messages/en.json` — MODIFIED: add `connectors.sharing.*` keys (role labels, "Add people" placeholder, "Who has access" heading, admin toggle label)
- `apps/web/messages/de.json` — MODIFIED: German equivalents

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorSharingPanel` props: `{ connectorId: string; workspaceId: string }`
- API calls used (all existing): `listResourceGrants`, `createResourceGrant`, `deleteResourceGrant` from `lib/api.ts`
- Role label → capability map: "Can view data" = read grant; "Can view and edit data" = read/write grant
- **Open question must be resolved before implementation:** Escalation prevention requires knowing the current user's own grant level for this connector — see Open Questions below

**Implementation notes:**
- `ConnectorGrantsTab.tsx` is superseded by this panel; delete it in this commit (no other files import it after Commit 9 removed the detail tab panel).
- Escalation prevention is enforced client-side by disabling role options in the dropdown that exceed the caller's own level; server-side enforcement is assumed to exist in the grants API.
- No "grants", "permissions", "audience", or "capability" vocabulary in any rendered string — use only "access", "who can use this", "view", "edit".

**Tests** (written in this commit):
- `ConnectorSharingPanel.test.tsx` — NEW: grantee chips render; owner chip has no × button; role dropdown disables options above current user level (mocked props)

**Done criteria:**
- "Who has access" drawer section shows current grantees as name chips with role dropdowns
- "Add people" input is functional
- Owner chip is listed first with no remove button
- Role dropdown does not offer "Can view and edit data" to a user who only has read access
- "Restrict to read-only for everyone" toggle is visible only to admins
- No "grants", "permissions", or "audience" text is visible anywhere in the panel
- `ConnectorGrantsTab.tsx` is deleted

---

## Critical Files
| File | Why Critical |
|------|-------------|
| `apps/web/app/builder/connectors/page.tsx` | Modified in every connector commit (4–10); all new components are wired through it |
| `services/api/internal/store/users.go` | `userCols` const and Scan calls must stay in sync with the `language` column added in migration 021 |
| `services/api/internal/router/router.go` | Single route registration file; Commit 1 adds the language endpoint in the `/v1/me` group |
| `apps/web/lib/auth.tsx` | `AuthUser.language` added in Commit 3 and consumed by every connector component via `useAuth()` |
| `apps/web/messages/en.json` | Grows in every commit from 3 onward; all new keys must be mirrored in `de.json` |
| `apps/web/messages/de.json` | German mirror of `en.json`; must never diverge in key structure |
| `apps/web/middleware.ts` | next-intl cookie locale reading; misconfiguration silently breaks locale switching |
| `apps/web/i18n/request.ts` | Server-side locale resolution; must correctly read `NEXT_LOCALE` cookie from headers |

## Open Questions
Minor unknowns the implementing agent should resolve at implementation time:
- **Commit 3 / AuthUser initialization:** Check whether `AuthUser` is currently populated from the decoded JWT or from a `/v1/me` bootstrap GET. If from JWT, extend the JWT `Claims` struct in `handler/auth.go` to include `language` and re-issue on language change. If from a bootstrap GET, add `language` to that response.
- **Commit 10 / Escalation prevention:** Confirm whether `GET /workspaces/{id}/connectors/{id}/grants` (or `listResourceGrants`) already returns the current caller's own grant entry in the response. If not, a small API addition is required before `ConnectorSharingPanel` can enforce the escalation rule.
- **Commit 6 / `action_key` validation:** Confirm that the backend `connector_actions.go` accepts auto-generated slug values (lowercase, underscores) for `action_key` before implementing the single-endpoint auto-create path.

## Risks
| Risk | Mitigation |
|------|-----------|
| `page.tsx` (~1300 lines) accumulates merge conflicts as each of commits 4–10 modifies it | Keep each commit's change to `page.tsx` minimal — extract all logic into new component files and swap only the render call; review diff per commit before merging |
| next-intl v4 provider wrapping may break Server Component data fetching boundaries in Next.js 15 | Test `pnpm dev` immediately after Commit 2 before proceeding; `NextIntlClientProvider` must not wrap the root Server Component directly |
| AI-generated German translations may produce awkward phrasing for technical compound nouns | Flag connector-specific German strings (Commit 3 onward) for a native-speaker spot-check before release; `en.json` is the authoritative source |
| Access escalation prevention (Commit 10) may expose a missing API capability | Resolve the open question before starting Commit 10; do not stub the escalation check as always-passing |
| CSV auto-preview (Commit 5) with naive `split('\n')` may break on quoted fields containing commas or newlines | Treat the preview as best-effort for simple CSVs; add a visible caveat "Preview may not show all formatting" rather than adding a CSV parsing library |




























