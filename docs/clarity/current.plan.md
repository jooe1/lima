# Implementation Plan: Connectors Tab Redesign + App-Wide i18n
_Last updated: 2026-03-29_
_Feature slug: connectors-tab-redesign_

## Goal
Redesign the connectors tab from a developer-oriented form interface into an intuitive, self-serve experience for any office worker — sales, marketing, dev — with zero assumed technical knowledge. The redesign has two non-negotiable requirements: (1) no technical vocabulary appears as the first thing a user sees, and (2) every connector type always shows users what they can *do* with it — during setup, right after creation, and in the management view. The app must also support English and German. Since no i18n infrastructure exists today, Phase 0 lays the foundation that all UI phases depend on.

## User Context
- **Personas:** Sales (shared tables, CSV uploads), Marketing (API connections), Dev teams (databases, bug trackers) — all assumed zero tech skill
- **Self-serve creation:** Every user can add their own connector and control who has access; admins can restrict permissions but do not gatekeep creation
- **Core pain points:** Too many raw input fields at once, too many tabs, technical vocabulary, no sense of "what can I actually do with this thing"
- **Visual:** Full redesign allowed — no MVP constraints
- **Languages:** English + German; whole app translated; AI-generated translations; language selected per-user in account settings

## i18n Decisions (resolved)
- **Scope:** Whole app — every user-facing string in `apps/web/`
- **Library:** `next-intl` — the standard for Next.js App Router; supports server components, TypeScript, and no-URL locale (locale stored in user preference, not the URL path)
- **Locale detection:** Per-user account setting; stored in user profile; falls back to browser `Accept-Language` header on first visit
- **Translation workflow:** AI-generated `en.json` and `de.json` under `apps/web/messages/`; no professional translator pipeline needed
- **URL strategy:** Non-URL locale (no `/de/` prefix) — locale is injected via context from the user's saved preference, keeping all existing routes unchanged

---

## Phase 0 — i18n Foundation _(prerequisite for all UI phases)_

### 0. i18n infrastructure setup
Install `next-intl` v4. Add a `language` field (`varchar`, default `'en'`) to the backend Go `User` model and a new `PATCH /users/me/language` API endpoint. Extend the frontend `AuthUser` type and auth context to carry the user's language preference. On first visit, fall back to the browser's `Accept-Language` header; once a user explicitly picks a language it is saved to their profile. Create `apps/web/messages/en.json` and `apps/web/messages/de.json` with AI-generated translations for all existing UI strings. Wire the saved preference into the `next-intl` provider at the app shell root. Add a compact language toggle (EN / DE) to the builder sidebar footer and the tools page header — no separate settings page required. All subsequent areas in this plan must use `useTranslations()` for every user-facing string.

_Resolved decisions: next-intl v4 (App Router native, TypeScript, no-URL locale); language stored per-user on the backend; language picker lives in the sidebar footer and tools header as a compact EN/DE toggle; falls back to browser locale on first visit; no new account/settings page needed._
_Depends on: none_

---

## Phase 1 — Discovery & Creation

### 1. Intent-based connector type picker
Replace the `<select>` type picker and inline form with a visual tile grid rendered inside a right-side drawer. Six tiles, all translated:

| Tile label | Maps to |
|---|---|
| Upload a spreadsheet | `csv` |
| Connect a database | sub-step: PostgreSQL / MySQL / SQL Server |
| Connect a web service | `rest` |
| Call a GraphQL API | `graphql` |
| Create a shared table | `managed` |
| More options _(collapsed)_ | `mysql`, `mssql` revealed here too |

"Connect a database" opens a second tile row ("What kind of database do you use?" → PostgreSQL / MySQL / SQL Server) before proceeding to the wizard. This is one extra tap but non-tech users can answer it — they know their database brand. All underlying `ConnectorType` values remain internal; users never see `postgres`, `mssql`, etc. The existing `BASIC_CONNECTOR_TYPES` / `ADVANCED_CONNECTOR_TYPES` split is preserved in logic but expressed purely through tile visibility.

_Resolved decisions: drawer-based tile grid, database brand as a sub-step, no raw type codes ever shown, translated via next-intl._
_Depends on: Area 0_

### 2. Contextual setup wizard per connector type
Each connector type renders a 3-step progress flow inside the same right-side drawer opened by Area 1. Step 1 is common to all types: connector name + a plain-language description of what this connector does and what the user can do with it. Step 2 is type-specific, showing max 3 fields at a time with "What's this?" tooltips on technical fields. Step 3 is access control (Area 8 intro). Field grouping per type:

**Database (postgres/mysql/mssql):**
1. "Where is your database?" → Host + Port (tooltip: "Ask your IT team if unsure")
2. Database name + Username + Password
3. SSL toggle — plain label: "Encrypt the connection (recommended)"

**REST web service:**
1. "What's the web address?" → Base URL
2. "Does it need a key or password?" → Auth type (shown as plain tiles: No auth / Bearer token / API key / Username & password) → secret field for the chosen type. MOCO/token auth hidden under "More auth options".
3. Bridges into Area 3 endpoint guidance

**CSV upload:**
1. File upload — single field; auto-previews first 5 rows on selection

**Managed table:**
1. Skips to column builder (Area 5) — name is the only Step 1 field needed

**GraphQL:**
1. "What's the API address?" → Endpoint URL
2. Auth — same plain tile picker as REST (bearer token or no auth)

_Resolved decisions: max 3 fields per sub-step; MOCO/token auth hidden behind "More auth options"; plain-language auth type tiles not a raw select; tooltips on host/port/database; CSV auto-preview; translated via next-intl._
_Depends on: Areas 0, 1_

### 3. API connector endpoint guidance
At the end of the REST/GraphQL wizard (after URL + auth), show a single choice screen: "Does this service do one thing, or does it have multiple actions?" Two tiles: "It does one specific thing" (single-endpoint) vs. "It has multiple actions" (action catalog). For single-endpoint: auto-create one action with the base URL and prompt for a plain label ("What does this service do?") — done, no action catalog needed. For multi-action: save the connector, then immediately open the action catalog in the detail drawer with an "Add your first action" prompt visible. Action form fields are simplified for non-tech users: plain "Action name" (maps to `action_label`), "What URL does it call?" (maps to `path_template`), HTTP method as plain tiles ("Fetch data" = GET, "Send data" = POST, "Update" = PUT/PATCH, "Delete" = DELETE). The technical `action_key`, `resource_name`, and `input_fields` definition are collapsed under "Advanced options" in the action form.

_Resolved decisions: single vs. multi as a wizard tile choice; single-endpoint auto-creates one action; multi opens action catalog post-save; HTTP method shown as intent tiles; technical action form fields behind advanced toggle; translated via next-intl._
_Depends on: Area 2_

---

## Phase 2 — Post-Creation Education

### 4. "What you can do now" card shown after every connector is created
Immediately after a connector is saved, the detail drawer opens with a contextual next-steps card pinned at the top. Card content per type (all copy translated):
- **Managed table:** "Your shared table is ready. Add your first column to define what kind of information it holds." → CTA: "Add a column" (scrolls to column builder)
- **Database:** "Your database is connected. Check that everything works, then browse your tables." → CTA: "Test the connection" (triggers test) 
- **CSV upload:** Shows inline preview of first 5 rows with row count confirmation: "Your file was imported — X rows ready."
- **REST (single-endpoint):** "Your web service is set up and ready to use in your apps."
- **REST (multi-action):** "Your web service is connected. Add actions to define what it can do." → CTA: "Add an action"
- **GraphQL:** "Your API is connected. Add actions to use it in your apps." → CTA: "Add an action"

Dismissed state stored in `localStorage` keyed by connector ID. Does not reappear on subsequent visits once dismissed. Not shown when editing an existing connector.

_Resolved decisions: per-type copy; localStorage dismissal per connector ID; not shown on edit; CTA buttons scroll/trigger the relevant section; translated via next-intl._
_Depends on: Areas 0, 2_

### 5. Shared table column builder (managed connector)
Replace the current read-only column chip display (which shows raw `col_type` values in parentheses) with an editable column builder. Each column row shows: drag handle (reorder), plain name input, type picker using plain labels ("Text", "Number", "Yes/No", "Date", "File" — mapping to the existing `col_type` enum), and a delete button. An "Add a column" button appends a new blank row. Changes are saved immediately on blur (optimistic, with inline error recovery). The column builder appears in both the wizard Step 2 (for managed connectors) and the detail drawer "Your data" section. The existing CSV seed/export functionality is preserved but moved to a secondary "Import / Export" subsection below the column builder, with plain labels: "Import from CSV" (replace or append) and "Download as CSV".

_Resolved decisions: editable column builder replaces read-only chips; plain type labels used throughout; immediate-save on blur; CSV import/export preserved but labelled in plain language; same component used in wizard and detail view; translated via next-intl._
_Depends on: Area 4_

---

## Phase 3 — List View

### 6. Connector list redesign with status-first layout
Replace the card grid with a vertical list grouped into 4 plain translated categories: **Your Files** (csv), **Databases** (postgres, mysql, mssql), **APIs & Web Services** (rest, graphql), **Shared Tables** (managed). Each row shows: SVG type icon (one per category, not per sub-type), connector name, status badge, owner name, and a "Manage" button. Status badge derives from existing data: if `schema_cached_at` is present and recent → "Connected" (green); if missing → "Not set up yet" (grey); a future test-result error state → "Needs attention" (amber). Each category header has a count badge (e.g. "Databases · 2") and a "＋ Add" button. Empty categories are collapsed by default with a single "＋ Add your first [category]" link shown instead. No raw dates, schema hashes, or connector type codes visible anywhere. The existing "Refresh" button moves to a small icon button in the page header.

_Resolved decisions: 4 category groupings; status derived from schema_cached_at + future test state; empty categories collapsed; SVG icons per category; count badge on category header; translated via next-intl._
_Depends on: Areas 0, 1_

---

## Phase 4 — Detail & Management

### 7. Detail view redesign — collapsible sections, no tabs
Replace the current 3-tab panel (Details / Permissions / Actions) with a single right-side drawer that slides in when a connector row is clicked. Sections are collapsible accordions; the first two are open by default. All section labels translated.

1. **What you can do** — Area 4 card (dismissible; after dismissal collapses to a compact one-line summary with a "Show tips" link)
2. **Your data** — content varies by type: column builder for managed tables (Area 5); first 10 rows preview table for CSV and databases; action list for REST/GraphQL (with "Add action" CTA for admins)
3. **Connection settings** — edit name and credentials (existing `ConnectorForm` credential fields, simplified); "Test connection" button with plain-language result: "Everything looks good ✓" or "We couldn't connect — [plain reason]. Check your [password / API key / address]."
4. **Who has access** — Area 8 sharing panel
5. **Developer options** _(collapsed by default, labelled "For developers")_ — existing schema tree, raw SQL query tester, type badge with raw connector type code. Only visible to admins.

The drawer opens over the list (not below it as the current panel does), with an overlay backdrop on mobile and a slide-in on desktop. Close button in the drawer header.

_Resolved decisions: drawer replaces bottom panel; 5 collapsible sections; first 2 open by default; Developer options admin-only; test result copy in plain language with specific guidance; translated via next-intl._
_Depends on: Areas 0, 4, 5_

### 8. Access control panel with plain-language sharing
Replace the existing `ConnectorGrantsTab` (admin-only, hidden in the Permissions tab, uses "grants" terminology) with a sharing panel visible to all users inside the detail drawer (Area 7, section 4). The panel shows: current people with access as name + avatar chips, each with a role label dropdown: "Can view data" (read) or "Can view and edit data" (read/write). An "Add people" search input (by name or email) below the chips. A remove (×) button on each chip. Users can only add people up to their own access level — they cannot grant write access they don't have. Admins see one additional toggle: "Restrict to read-only for everyone" (overrides all individual grants to read). The connector owner is always shown first and cannot be removed. No "grants", "audience", "capability", or "permissions" vocabulary anywhere in the UI — only "access" and "who can use this".

_Resolved decisions: panel replaces admin-only grants tab; visible to all users not just admins; chips with inline role dropdown; add by name/email; owner pinned first; admin-only read-only-override toggle; escalation prevention (can't grant more than own access); translated via next-intl._
_Depends on: Area 6_

---

## Previously Explored Options (reference only)

Options A–E were presented as alternatives during the pre-plan phase. The plan above is a synthesized hybrid drawing primarily from Option A (intent-based tile picker), Option B (right-side drawer), Option C (no-tabs detail), and Option D (category grouping), plus the user's key requirement of per-type contextual education that was not present in any single option.

---

## Brief: Connectors Tab Redesign + App-Wide i18n

### Problem
The current connectors tab was built for technically confident developers. It presents raw type names (`postgres`, `rest`, `graphql`), all credential fields simultaneously, multiple tabs with no clear purpose hierarchy, and no guidance on what a connector actually enables. The target users — sales, marketing, and non-technical operations teams at English- and German-speaking companies — have no context for any of this. The result is that non-tech users either need hand-holding from an admin or give up. Additionally, there is zero i18n infrastructure in the app today, blocking all German-language companies from using it.

### Current Context
- `apps/web/app/builder/connectors/page.tsx` — single ~1300-line file containing `ConnectorsPage`, `ConnectorCard`, `ConnectorForm`, `CredentialFields`, `DetailPanel`, `ActionCatalogPanel`, `ActionForm`, `ConnectorGrantsTab` (imported), `SchemaTree`, `QueryResultTable`
- Connector types: `postgres`, `mysql`, `mssql`, `rest`, `graphql`, `csv`, `managed`
- Detail panel has 3 tabs: Details (schema, test, query, managed columns), Permissions (admin-only grants), Actions (REST/GraphQL action catalog)
- `ConnectorGrantsTab` — separate component, admin-only, uses "grants" terminology
- `ConnectorSetupHint` — basic empty state component
- Backend `User` struct has no `language` field; no user settings API endpoint exists
- No i18n library, no message files, no locale routing anywhere in the codebase
- Next.js 15 / React 19 — fully compatible with `next-intl` v4

### Desired Outcome
Any user — regardless of technical background or language — can add a connector, understand what it does, configure who can use it, and know what to do next, entirely without help. German-speaking users see the entire app in German. The connectors tab feels like a guided product feature, not a developer configuration panel.

### Scope
- **Phase 0:** `next-intl` v4 setup; Go `User` model migration (add `language` field); `PATCH /users/me/language` API endpoint; `apps/web/messages/en.json` + `de.json` with AI-generated translations for all existing strings; EN/DE toggle in builder sidebar footer and tools page header; `next-intl` provider wired into app shell
- **Phase 1:** Intent tile picker (Area 1); 3-step wizard per connector type (Area 2); API single vs. multi-action choice (Area 3)
- **Phase 2:** Post-creation education card (Area 4); managed table column builder (Area 5)
- **Phase 3:** Categorised status-first connector list (Area 6)
- **Phase 4:** Right-side drawer detail view, no tabs (Area 7); plain-language sharing panel (Area 8)

### Non-goals
- URL-based locale routing (`/de/...`) — not needed; locale is per-user preference
- Professional translator review pipeline — AI-generated translations are sufficient for now
- Mobile-native quality — desktop-first
- Redesign of any other builder pages beyond the connectors tab
- Adding new connector types not already supported
- Any backend changes beyond the `language` field migration and one new API endpoint

### Constraints
- The entire connectors page is a single large client component — the redesign should refactor it into smaller focused components without changing the existing API contract (`listConnectors`, `createConnector`, `patchConnector`, `deleteConnector`, `testConnector`, etc.)
- The `ConnectorGrantsTab` component will be replaced by the new sharing panel (Area 8) — the underlying grants API can remain unchanged
- The backend `ConnectorType` enum is the source of truth; UI labels must map to it without exposing it
- All new UI components must use `useTranslations()` from `next-intl` — no hardcoded English strings
- The `col_type` enum for managed table columns must be mapped to plain labels in the UI
- Access escalation prevention (users cannot grant more access than they have) requires a check against the current user's own access level for that connector

### Decisions
| Decision | Choice |
|---|---|
| i18n library | `next-intl` v4 |
| Locale storage | Per-user in DB, fallback to browser `Accept-Language` |
| Language picker placement | EN/DE toggle in builder sidebar footer + tools header |
| URL strategy | No `/de/` prefix — locale from user preference only |
| Translation source | AI-generated `en.json` + `de.json` |
| Type picker UX | Intent tile grid → database brand sub-step |
| Setup flow | Right-side drawer, 3-step wizard, max 3 fields per step |
| MOCO/token auth | Hidden behind "More auth options" |
| API endpoint choice | Single vs. multi-action tile choice in wizard |
| HTTP method labels | Intent tiles (Fetch data / Send data / Update / Delete) |
| Technical action fields | Behind "Advanced options" toggle |
| Post-creation education | Per-type card, localStorage dismissal keyed by connector ID |
| Column builder save | Immediate on blur, optimistic |
| Status derivation | From `schema_cached_at` presence |
| Empty categories | Collapsed with single "＋ Add" link |
| Detail view | Right-side slide-in drawer, 5 collapsible sections, no tabs |
| Developer options | Collapsed by default, admin-only |
| Sharing panel | Visible to all users (not admin-only); chips + role dropdown |
| Access escalation | Users cannot grant more than their own access level |
| Connector owner | Pinned first in sharing panel, cannot be removed |

### Acceptance Criteria
- A non-technical user can add any connector type without seeing `postgres`, `rest`, `mssql`, `graphql`, or any other type code
- Every connector type shows a contextual "what you can do now" card immediately after creation
- Managed table connectors expose a drag-and-reorder column builder with plain column type labels
- REST/GraphQL connectors guide the user through single-endpoint vs. multi-action setup in the wizard
- The connector list groups connectors into 4 plain categories with status badges derived from real data
- The detail view has no tabs — all sections are collapsible in a single scrollable drawer
- Any user (not just admins) can see and manage who has access to their connector
- The EN/DE language toggle is visible and functional in both the builder sidebar and tools page header
- All user-facing strings in the connectors tab and app shell are served from `next-intl` message files
- German users see every connector UI string in German

### Risks
- The single-file connector page is large (~1300 lines); refactoring into components without regressions requires care — recommend incremental extraction rather than a full rewrite in one pass
- The `next-intl` provider requires wrapping the app shell at the root layout level — this must not break existing server component boundaries in Next.js 15
- AI-generated German translations may produce awkward phrasing for technical concepts ("Gemeinsame Tabelle" vs. "Freigegebene Tabelle" etc.) — a native speaker review of connector-specific strings is advisable before release
- The access escalation prevention rule requires the client to know the current user's own access level for each connector, which is not currently returned by the API — this may require a small API response change

### Likely Impacted Areas
| File | Change |
|---|---|
| `apps/web/app/builder/connectors/page.tsx` | Full redesign — split into sub-components |
| `apps/web/app/builder/connectors/ConnectorSetupHint.tsx` | Replaced by Area 4 education card |
| `apps/web/app/builder/connectors/ConnectorGrantsTab.tsx` | Replaced by Area 8 sharing panel |
| `apps/web/app/builder/BuilderSidebar.tsx` | Add EN/DE language toggle to footer |
| `apps/web/app/tools/layout.tsx` | Add EN/DE language toggle to header |
| `apps/web/app/layout.tsx` | Add `next-intl` provider |
| `apps/web/messages/en.json` | New — all English strings |
| `apps/web/messages/de.json` | New — AI-generated German strings |
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

