# Delivery Plan: UX-First Release Hardening for Non-Technical Users
_Last updated: 2026-03-28_
_Feature slug: ux-first-release-readiness_
_Source: docs/clarity/current.plan.md_

## Goal
Deliver a safe, reviewable implementation path for turning Lima into a self-serve internal product where a non-technical user can sign in, connect data, create a basic app, publish it, launch it, and recover from common failures; the commit order starts with test and routing foundations, then establishes shared UX primitives, then simplifies the self-serve builder and runtime flows, and finishes with route-state hardening, accessibility, and release smoke coverage.

## Stack Decisions
| Decision | Value | Reason |
|----------|-------|--------|
| Self-serve role model | Treat authenticated users as builder-capable in the web shell, with creation bounded by the resources and actions they already have access to | The clarified requirement is that every user should be able to build tools from the resources they can already use, while admin-only actions remain protected |
| Primary landing flow | Builder-first for self-serve users, tools as the post-publish launch surface | The current value path requires connector setup, app creation, and publication before tools are usable |
| Shared UI approach | Small in-repo UI primitive layer plus CSS variables in the Next app | The brief calls for a deliberate, teachable UI system without broad architecture changes |
| Browser regression tooling | Playwright end-to-end tests in apps/web | No browser test tooling exists today and the brief requires release-critical smoke coverage |
| Release quality bar | Desktop-first, keyboard-usable, narrow-width safe | Directly required by the clarity brief acceptance criteria |

## Commits

### Commit 1 — chore(web): add playwright smoke harness
**Why:** Establish a browser-test foundation early so every later UX commit can add or extend release-critical smoke coverage.
**Parallelizable with:** none

**Files:**
- `package.json` — MODIFIED: expose monorepo-level browser smoke command through the existing workspace scripts
- `apps/web/package.json` — MODIFIED: add web-local Playwright scripts and dev dependencies
- `apps/web/playwright.config.ts` — NEW: configure Playwright for the Next.js app and local base URL handling
- `apps/web/tests/e2e/helpers.ts` — NEW: shared browser-test helpers for navigation and authenticated setup
- `apps/web/tests/e2e/auth.spec.ts` — NEW: baseline smoke coverage for login-shell availability and route bootstrapping

**Interface contracts** (names and shapes other commits depend on):
- `loginAsDev(page, options?: { email?: string; companySlug?: string }): Promise<void>` — shared authenticated setup helper for later self-serve journey tests
- `waitForRouteReady(page, pathname: string): Promise<void>` — shared helper that later specs use to stabilize route assertions
- `pnpm --filter @lima/web test:e2e` — canonical web browser-smoke command used by later commits and release checks

**Implementation notes** (only non-obvious constraints):
- The repo currently has no established browser-test tooling, so this commit must keep setup minimal and isolated to `apps/web`.
- The helper contract should support the existing development login path so later specs can cover the builder flow without inventing backend fixtures.

**Tests** (written in this commit):
- `apps/web/tests/e2e/auth.spec.ts` — verify login screen render and basic route bootstrapping using the new Playwright harness

**Done criteria:**
- The repo has a single working Playwright entrypoint for the web app.
- Later commits can extend shared browser-test helpers instead of creating ad hoc setup logic.

### Commit 2 — feat(auth): support self-serve builder access with permission-aware route gates
**Why:** Remove the artificial boundary between “builder” and “user” flows while keeping tool creation constrained to the resources and actions each user is already allowed to access.
**Parallelizable with:** none

**Files:**
- `apps/web/lib/auth.tsx` — MODIFIED: expose derived access flags needed by the web shell
- `apps/web/app/page.tsx` — MODIFIED: replace the current hard role split with self-serve landing logic
- `apps/web/app/builder/layout.tsx` — MODIFIED: show a visible auth/loading gate instead of returning `null`
- `apps/web/app/tools/layout.tsx` — MODIFIED: show a visible auth/loading gate and align with shared access behavior
- `apps/web/app/_components/RouteGateShell.tsx` — NEW: reusable loading/redirect shell for authenticated route groups
- `apps/web/tests/e2e/routing.spec.ts` — NEW: verify route access and visible gate behavior for authenticated navigation

**Interface contracts** (names and shapes other commits depend on):
- `AuthContextValue.canAccessBuilder: boolean` — signals whether the current user can enter self-serve builder flows
- `AuthContextValue.canAccessTools: boolean` — signals whether the current user can enter launch/runtime flows
- `AuthContextValue.canCreateTools: boolean` — signals whether the current user can create and edit apps in the self-serve builder shell
- `RouteGateShell(props: { title: string; message: string }): JSX.Element` — shared route-wait UI for auth and redirect transitions

**Implementation notes** (only non-obvious constraints):
- Keep admin-only actions protected at the page/action level; this commit changes shell access and entry routing, not backend authorization rules.
- Builder access in this plan means users can create tools from resources they already have access to, not that all users gain universal connector or admin powers.
- Do not reintroduce blank screens while auth state resolves.

**Tests** (written in this commit):
- `apps/web/tests/e2e/routing.spec.ts` — cover builder-first landing for self-serve users and visible auth-gate messaging while route checks resolve

**Done criteria:**
- Authenticated self-serve users can reach the builder flow without being trapped on the tools-only path.
- The delivery plan clearly preserves permission-aware building rather than implying unrestricted access to all resources.
- Builder and tools layouts show visible waiting states instead of rendering nothing.

### Commit 3 — feat(ui): add shared UX primitives and redesign login flow
**Why:** Create the visual and interaction foundation the rest of the self-serve experience can reuse, while fixing the first screen users see.
**Parallelizable with:** none

**Files:**
- `apps/web/app/globals.css` — MODIFIED: add CSS variables, shared spacing/type tokens, focus states, and reusable surface styles
- `apps/web/app/_components/UxPrimitives.tsx` — NEW: small shared primitive set for cards, alerts, buttons, form fields, and empty states
- `apps/web/app/login/page.tsx` — MODIFIED: rebuild login into a clearer, guided self-serve entry flow
- `apps/web/app/auth/callback/page.tsx` — MODIFIED: align callback/loading feedback with the new shell language and primitives
- `apps/web/tests/e2e/login.spec.ts` — NEW: cover the redesigned login flow, async feedback, and visible error/success states

**Interface contracts** (names and shapes other commits depend on):
- `SurfaceCard(props: { title?: string; children: React.ReactNode }): JSX.Element` — shared shell surface used by later self-serve pages
- `InlineAlert(props: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }): JSX.Element` — shared status messaging primitive used in later builder/runtime work
- CSS custom properties under `:root` for color, spacing, radius, and focus styling — visual contract reused by later page commits

**Implementation notes** (only non-obvious constraints):
- Keep the shared primitive layer intentionally small; it should support the current app shell, not become a full design-system buildout.
- The login page still needs dev-only affordances, but they must be visually isolated from the primary production path.

**Tests** (written in this commit):
- `apps/web/tests/e2e/login.spec.ts` — cover primary login path, visible async feedback, and user-facing error handling

**Done criteria:**
- The app has reusable UI tokens/primitives that later commits can apply without duplicating inline patterns.
- The login flow reads like a guided product entry point rather than a technical utility screen.

### Commit 4 — feat(builder): guide workspace and app creation on the builder home
**Why:** Make the first builder step self-explanatory so users can get from zero to an app shell without needing platform knowledge.
**Parallelizable with:** none

**Files:**
- `apps/web/app/builder/page.tsx` — MODIFIED: split first-run setup from returning-user app management and add guided copy
- `apps/web/app/builder/BuilderSidebar.tsx` — MODIFIED: reduce cognitive load in navigation and make the core path more obvious
- `apps/web/tests/e2e/builder-home.spec.ts` — NEW: cover workspace creation, app creation, and guided first-run messaging

**Interface contracts** (names and shapes other commits depend on):
- `BuilderHomeView = 'setup' | 'apps'` — internal state split that later tests and maintainers rely on for the guided builder home
- `PrimaryBuilderNavItem` labels and ordering — navigation contract later commits preserve while adding deeper builder changes

**Implementation notes** (only non-obvious constraints):
- Explain “workspace” only at the moment it matters; do not force users to learn the platform model before they can create their first app.
- Keep sidebar changes compatible with the broader builder shell and future admin de-emphasis.

**Tests** (written in this commit):
- `apps/web/tests/e2e/builder-home.spec.ts` — cover first-run setup path and returning-user app list path

**Done criteria:**
- A first-time self-serve user can understand how to create a workspace and an app from the builder home.
- Navigation emphasizes core creation tasks over secondary administration.

### Commit 5 — feat(connectors): simplify self-serve connector setup
**Why:** Connector creation is part of the release-critical setup path and must stop feeling like an advanced admin screen.
**Parallelizable with:** none

**Files:**
- `apps/web/app/builder/connectors/page.tsx` — MODIFIED: reorganize connector setup around guided defaults and progressive disclosure for advanced controls
- `apps/web/app/builder/connectors/ConnectorSetupHint.tsx` — NEW: reusable guidance surface for connector onboarding and empty states
- `apps/web/tests/e2e/connectors.spec.ts` — NEW: cover first connector creation and the main guided setup path

**Interface contracts** (names and shapes other commits depend on):
- `ConnectorSetupHint(props: { title: string; body: string; actionLabel?: string }): JSX.Element` — shared guidance surface used within connector setup flows
- “basic” versus “advanced” connector sections within the connectors page — presentation contract later commits preserve when hardening the builder flow

**Implementation notes** (only non-obvious constraints):
- Keep advanced grants, actions, and low-frequency management controls accessible, but move them behind clear progressive-disclosure affordances.
- Do not change backend connector semantics in this commit; the work is UX reorganization around existing APIs.

**Tests** (written in this commit):
- `apps/web/tests/e2e/connectors.spec.ts` — cover connector list empty state, guided creation path, and successful return to the connector list

**Done criteria:**
- A non-technical builder can understand how to start adding a connector from the current page.
- Advanced connector controls no longer dominate the first-run experience.

### Commit 6 — feat(editor): streamline publish, sharing, and blocker flows
**Why:** The main editor currently exposes too much at once; v1 needs a dominant path of edit, preview, choose who can access the tool, publish it, and fix blockers.
**Parallelizable with:** none

**Files:**
- `apps/web/app/builder/[appId]/page.tsx` — MODIFIED: reorganize the editor chrome around the primary self-serve path
- `apps/web/app/builder/[appId]/Inspector.tsx` — MODIFIED: surface common widget properties first and reduce advanced noise
- `apps/web/app/builder/[appId]/ChatPanel.tsx` — MODIFIED: de-emphasize chat-led creation as a secondary flow
- `apps/web/app/builder/[appId]/SplitViewOverlay.tsx` — MODIFIED: hide or down-rank unfinished AI-generation affordances
- `apps/web/lib/appValidation.ts` — MODIFIED: convert production issues into clearer user-facing publish blockers
- `apps/web/tests/e2e/publish-flow.spec.ts` — NEW: cover create/edit/publish path and visible blocker messaging

**Interface contracts** (names and shapes other commits depend on):
- `getUserFacingProductionIssues(doc): Array<{ code: string; message: string }>` — returns blocker messages suitable for non-technical builders
- `PrimaryEditorAction = 'add-widget' | 'preview' | 'publish'` — interaction contract preserved across editor UI changes
- `showAdvancedBuilderControls: boolean` — toggles secondary creation surfaces without changing the primary editor flow
- `PublishAudienceSelection = 'group' | 'company' | 'discover-only'` — sharing model presented to users when they publish a tool
- `ToolShareTarget = { type: 'group' | 'company'; id?: string; capability: 'discover' | 'use' }` — sharing shape the publish UI must collect before calling publication APIs

**Implementation notes** (only non-obvious constraints):
- This commit should preserve existing editing capability while moving advanced/unfinished experiences out of the user’s way.
- Publish blockers must explain user impact, not just internal configuration details.
- The publish flow must read as a sharing flow for normal users: who should be able to discover or use this tool, including special groups and company-wide access when supported by existing APIs.

**Tests** (written in this commit):
- `apps/web/tests/e2e/publish-flow.spec.ts` — cover primary editor actions, blocker visibility, audience selection, and successful publish entry conditions

**Done criteria:**
- The editor’s main path is visually obvious and centered on getting a basic tool published.
- A non-technical builder can understand who they are sharing the tool with at publish time.
- Publish validation reads like user guidance rather than internal diagnostics.

### Commit 7 — feat(runtime): turn tools and runtime into a guided post-publish experience
**Why:** Once a tool exists, the tools home and runtime must feel like a simple launch surface, not a developer-facing artifact browser.
**Parallelizable with:** none

**Files:**
- `apps/web/app/tools/page.tsx` — MODIFIED: strengthen hierarchy, launch affordances, and post-publish guidance
- `apps/web/app/app/[appId]/page.tsx` — MODIFIED: rewrite blocked/runtime states into plain-language task guidance
- `apps/web/app/app/[appId]/RuntimeRenderer.tsx` — MODIFIED: replace diagnostic runtime messages with humane in-widget states and clearer pending/success feedback
- `apps/web/tests/e2e/runtime-launch.spec.ts` — NEW: cover launch from tools, blocked runtime states, and basic successful runtime use

**Interface contracts** (names and shapes other commits depend on):
- `ToolCardState = 'launchable' | 'discover-only' | 'inaccessible'` — state model used by the tools page to explain availability and next steps
- `RuntimeStateMessage(props: { tone: 'muted' | 'warning' | 'error'; message: string }): JSX.Element` — shared runtime feedback component for user-facing widget states

**Implementation notes** (only non-obvious constraints):
- Keep builder links out of the default runtime experience unless the current user is explicitly in a builder flow.
- “Discovery only” and access-denied states should explain what the user can do next instead of ending in a dead end.

**Tests** (written in this commit):
- `apps/web/tests/e2e/runtime-launch.spec.ts` — cover tools search/launch, discovery-only tool handling, and runtime state messaging

**Done criteria:**
- Published tools are easier to find and launch from the tools page.
- Runtime failure and blocked states use plain-language guidance and safe recovery paths.

### Commit 8 — feat(shell): add route-level loading and missing-resource state screens
**Why:** The current app still drops users into blank or generic states during route transitions and missing-resource paths.
**Parallelizable with:** none

**Files:**
- `apps/web/app/loading.tsx` — NEW: top-level loading state for app-shell transitions
- `apps/web/app/not-found.tsx` — NEW: top-level missing-route and missing-resource fallback
- `apps/web/app/error.tsx` — NEW: top-level recoverable error boundary UI
- `apps/web/app/app/[appId]/loading.tsx` — NEW: runtime-specific loading screen
- `apps/web/app/_components/RouteStateScreen.tsx` — NEW: shared screen component for loading/error/not-found states
- `apps/web/tests/e2e/route-states.spec.ts` — NEW: cover route-level loading and missing-resource presentation

**Interface contracts** (names and shapes other commits depend on):
- `RouteStateScreen(props: { title: string; body: string; actionHref?: string; actionLabel?: string }): JSX.Element` — shared full-screen state component for route-level experiences
- Root App Router conventions: `loading.tsx`, `not-found.tsx`, and `error.tsx` — route-state file contract used by the Next.js shell

**Implementation notes** (only non-obvious constraints):
- Keep these screens generic enough for reuse but written in user-facing language, not framework error language.
- This commit complements, rather than replaces, the visible auth-gate shells introduced earlier.

**Tests** (written in this commit):
- `apps/web/tests/e2e/route-states.spec.ts` — cover root loading, runtime loading, and missing-resource fallback paths

**Done criteria:**
- Main route groups have explicit loading and missing-resource experiences instead of blank or ambiguous states.
- Shared route-state screens are available for future recovery flows.

### Commit 9 — feat(accessibility): harden focus, semantics, and narrow-width layouts on shipped paths
**Why:** The release bar requires keyboard usability, legible focus states, and safe behavior on common narrow desktop widths.
**Parallelizable with:** none

**Files:**
- `apps/web/app/globals.css` — MODIFIED: strengthen focus rings, spacing behavior, and responsive shell rules
- `apps/web/app/login/page.tsx` — MODIFIED: improve form semantics and keyboard flow
- `apps/web/app/tools/page.tsx` — MODIFIED: improve search, launch-card semantics, and narrow-width layout behavior
- `apps/web/app/app/[appId]/page.tsx` — MODIFIED: improve runtime header semantics and responsive behavior
- `apps/web/app/builder/layout.tsx` — MODIFIED: improve shell responsiveness and keyboard-safe overflow behavior
- `apps/web/tests/e2e/accessibility.spec.ts` — NEW: cover focus order, keyboard reachability, and narrow-width smoke checks on shipped flows

**Interface contracts** (names and shapes other commits depend on):
- Global focus and responsive CSS custom properties in `globals.css` — accessibility contract used across all shipped screens
- Landmark structure for main route groups (`header`, `main`, form labels, actionable buttons) — semantics contract validated by browser smoke tests

**Implementation notes** (only non-obvious constraints):
- Keep the visual direction dark only if contrast and hierarchy remain strong enough for non-technical users.
- Treat keyboard traps and invisible focus as release blockers, not polish items.

**Tests** (written in this commit):
- `apps/web/tests/e2e/accessibility.spec.ts` — cover keyboard navigation, visible focus, and narrow-width layout safety on login, tools, builder shell, and runtime

**Done criteria:**
- Core shipped flows are keyboard-usable and visually legible.
- The app no longer breaks down on common narrow desktop and tablet-like widths.

### Commit 10 — test(web): add full self-serve smoke coverage and release gate scripts
**Why:** Finish the implementation with a small but real regression suite and an enforceable release command for the full self-serve journey.
**Parallelizable with:** none

**Files:**
- `package.json` — MODIFIED: add a top-level release smoke command that includes the web browser suite
- `apps/web/package.json` — MODIFIED: add release-smoke and targeted spec commands for self-serve validation
- `apps/web/tests/e2e/self-serve-smoke.spec.ts` — NEW: cover the full connector -> app -> publish -> launch path
- `apps/web/tests/e2e/publish-blockers.spec.ts` — NEW: cover the main publish-blocker and recovery cases
- `docs/release-checklist-ux-first-current.md` — NEW: encode the current go/no-go checklist tied to the shipped self-serve journey and smoke commands

**Interface contracts** (names and shapes other commits depend on):
- `pnpm release:smoke` — canonical release-gate command for the repo
- `pnpm --filter @lima/web test:e2e:self-serve` — targeted self-serve smoke command for the web app
- `docs/release-checklist-ux-first-current.md` sections aligned to the clarity acceptance criteria — human review contract for final release sign-off

**Implementation notes** (only non-obvious constraints):
- This commit should reuse the Playwright helpers and route assumptions established earlier instead of inventing separate release scripts.
- Keep the checklist current and specific to the shipped path, not the entire platform surface.

**Tests** (written in this commit):
- `apps/web/tests/e2e/self-serve-smoke.spec.ts` — full zero-to-live-tool smoke journey
- `apps/web/tests/e2e/publish-blockers.spec.ts` — blocker and recovery coverage for release-critical publish scenarios

**Done criteria:**
- The repo has an enforceable browser-based release smoke command.
- The shipped self-serve journey is covered end-to-end from setup through launch.

## Critical Files
| File | Why Critical |
|------|-------------|
| `apps/web/app/page.tsx` | Controls the top-level landing logic that currently separates end users from builder access |
| `apps/web/lib/auth.tsx` | Owns the auth context and any derived access flags the self-serve route model depends on |
| `apps/web/app/builder/page.tsx` | First-run self-serve entry point for workspace and app creation |
| `apps/web/app/builder/connectors/page.tsx` | Required setup surface for connecting data before a tool can be useful |
| `apps/web/app/builder/[appId]/page.tsx` | Main editor and publish flow, the center of the builder simplification work |
| `apps/web/app/app/[appId]/page.tsx` | User-facing runtime shell and blocked-state messaging |
| `apps/web/app/app/[appId]/RuntimeRenderer.tsx` | Controls runtime widget behavior and in-widget user feedback |
| `apps/web/app/globals.css` | Shared visual and accessibility foundation for the entire web shell |
| `apps/web/package.json` | Owns the web scripts and the new browser-smoke workflow |

## Open Questions
Minor unknowns the implementing agent should resolve at implementation time:
- Whether the new builder-first landing rule should switch to tools automatically when a workspace already has a published app, or remain consistently builder-first for all self-serve users.
- Whether the route-state screens should use a single shared illustration/icon treatment or stay text-first in the first pass.
- Whether the release checklist doc belongs under `docs/` long term or should later migrate into CI-owned release automation.

## Risks
| Risk | Mitigation |
|------|-----------|
| Relaxing the role split could expose builder navigation to users who still lack backend permissions for some actions | Keep action-level admin checks intact and limit this work to shell/navigation access plus humane recovery states |
| The builder editor simplification could accidentally remove discoverability for existing advanced users | Use progressive disclosure instead of hard deletion for advanced controls and keep capabilities accessible behind secondary affordances |
| Adding Playwright from scratch may introduce setup friction | Start with a minimal harness in commit 1 and reuse shared helpers across all later browser specs |
| Shared UI work could sprawl into a redesign | Keep the primitive layer small and scoped to currently shipped surfaces only |
| Route-state additions could overlap with existing layout-based auth waits | Treat route-state screens and auth-gate shells as complementary and cover both with explicit browser tests |
