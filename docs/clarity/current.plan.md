# Implementation Plan: UX-First Release Readiness Audit
_Last updated: 2026-03-28_
_Feature slug: ux-first-release-readiness_

## Goal
Prepare Lima for a near-term internal release aimed at non-technical users by fixing the highest-impact UX, clarity, trust, and completion gaps in the current product. The order prioritizes the self-serve path from setup to live use first, then broader builder simplification, then quality and release gates, because the current product requires a user to connect data, build a tool, publish it, and then use it before any real value is delivered.

## Phase 1 — Self-Serve User Readiness

### 1. Define the release path around self-serve success
Constrain the first release to the full self-serve journey that already exists in code and can be made dependable: sign in, create or select a workspace, add a connector, create an app, configure a usable tool, publish it, launch it, complete the task, and recover from common errors.
_Depends on: none_
Resolved decisions: optimize for a desktop-first internal release; treat many users as both builders and end users; judge readiness by whether a non-technical user can go from zero to a live usable tool without developer help; keep advanced admin depth secondary if it improves first-use clarity.

### 2. Replace technical and builder-centric runtime language with plain-language UX
Rewrite runtime headers, empty states, access-denied states, and unpublished states so non-technical users see task-oriented copy, next steps, and clear recovery actions instead of platform jargon.
_Depends on: Area 1_
Resolved decisions: remove terms like workspace, publication, builder, and app version from end-user surfaces unless strictly necessary; every blocked state should tell the user what happened, what to do next, and where to go.

### 3. Add complete loading, error, and missing-route coverage across the web app
Implement explicit loading, error, and not-found experiences for the main route groups so failures never collapse to blank screens, generic text, or broken navigation.
_Depends on: Area 1_
Resolved decisions: add route-level handling for login, tools, builder, and runtime flows; include retry paths and safe navigation back to the last meaningful screen.

### 4. Make tool discovery and launch feel guided instead of raw
Improve the tools surface with clearer hierarchy, friendlier search and empty states, launch affordances, and better handling when the user has lost access or needs a different workspace selected.
_Depends on: Areas 1, 2_
Resolved decisions: the tools page should act like a simple home screen for non-technical users after a tool has been created and published, not a catalog of internal objects; discovery-only listings should explain why they are visible but not launchable.

## Phase 2 — Builder UX Simplification

### 5. Simplify first-time builder onboarding and creation flows
Turn the current workspace creation, app creation, and first-open builder experience into a guided setup with plain-language explanations, sensible defaults, and visible next steps.
_Depends on: Area 1_
Resolved decisions: keep the first release builder experience focused on creating a basic app and publishing it; avoid exposing every platform concept upfront.

### 6. Establish a consistent web UI system for the current app shell
Replace scattered inline styling patterns with a small shared design layer for spacing, typography, colors, states, buttons, forms, cards, and panels so the product feels deliberate and teachable.
_Depends on: Area 1_
Resolved decisions: preserve the existing dark direction only if it becomes more legible and structured; consistency and readability matter more than visual novelty for this release.

### 7. Reduce editor complexity by staging advanced builder controls behind progressive disclosure
Keep the current editor capabilities, but reorganize them so core actions are obvious and secondary controls appear only when relevant.
_Depends on: Areas 5, 6_
Resolved decisions: prioritize add widget, edit content, preview, publish, and fix publish blockers; defer or visually de-emphasize AI-generation placeholders, workflow complexity, and low-frequency admin actions during first-run usage.

### 8. Add in-product guidance for non-technical builders
Introduce contextual help, empty-state guidance, validation hints, publish blockers, and short instructional copy throughout the builder so users can recover without outside support.
_Depends on: Areas 5, 6, 7_
Resolved decisions: guidance should be embedded next to the action being taken rather than placed in external docs; publish blockers should explain the user impact of the issue, not just the missing field.

## Phase 3 — Release Quality Gates

### 9. Add minimum release-grade validation for accessibility and responsiveness
Audit and fix the most important accessibility and layout issues in the current shell, including focus states, keyboard reachability, contrast, form labeling, button semantics, and narrow-width breakpoints.
_Depends on: Areas 2, 4, 6_
Resolved decisions: desktop-first does not mean desktop-only; the release bar should include acceptable tablet and narrow laptop behavior and no obvious keyboard traps.

### 10. Add web UI regression coverage for the primary release journeys
Create a lean but real automated safety net for login, tool discovery, runtime loading states, builder creation, and publish-critical flows.
_Depends on: Areas 3, 4, 5, 7, 8_
Resolved decisions: prioritize end-to-end coverage for the shipped paths because the web app currently has no visible UI test harness; keep scope small but user-critical.

### 11. Define and enforce a release checklist tied to actual shipped behavior
Convert this audit into a go/no-go checklist covering copy, navigation, empty states, blocked states, accessibility, publish readiness, and core smoke tests.
_Depends on: Areas 3, 8, 9, 10_
Resolved decisions: release should be blocked by user-facing trust failures even if core APIs work; UX failures are release failures for this audience.

## Brief: UX-First Release Readiness

### Problem
Lima already contains meaningful product surface area, but the current implementation is still shaped like a tool for technically confident internal builders rather than a dependable product for non-technical users. The main risk is not missing raw capability; it is that users will encounter jargon, ambiguous flows, weak recovery states, and inconsistent UI at exactly the moments they need reassurance.

### Current Context
The web app currently has working route groups for login, tools, builder, runtime, connectors, approvals, and admin. The root route performs role-based redirects and currently hard-separates end_user from builder access. The tools page lists published tools and supports search. The runtime can render multiple widget types and handles several permission and publication states. The builder supports app creation, connector setup, editing, autosave, publication, workflow editing, and multiple admin surfaces. The UI is heavily implemented with inline styles and a dark palette. There are no visible route-level error, not-found, or loading handlers in the main app tree. The repo shows backend Go tests, package-level tests for the Aura DSL, and no visible web UI or end-to-end test harness.

### Desired Outcome
A first-release user should be able to sign in, connect data, create and publish a simple tool, launch it, complete a basic task, and recover from problems without needing technical vocabulary or support intervention. The product should support the reality that many first-release users are both builders and users of the tools they create.

### Scope
Included: login and first-run messaging, tools home, runtime states and copy, builder first-run setup, editor simplification, shared UI system, contextual guidance, accessibility fixes, responsive cleanup, and minimum automated test coverage for core release journeys.

### Non-goals
Not included: redesigning the full platform architecture, shipping every advanced builder/admin capability at parity, relying on external documentation as the primary guidance layer, or broadening scope to mobile-native quality for this release.

### Constraints
The current codebase already exposes builder, admin, workflow, and connector concepts deeply in the UI. Styling is fragmented across many inline implementations. The runtime and builder are coupled to domain terms such as workspace, publication, approvals, and connector actions. The current routing model also separates end_user from builder access, even though the release may need self-serve users to do both. There is little visible protection against route-level failures. The release must work for users who do not understand those concepts.

### Decisions
Chosen assumptions for this brief: the near-term target is an internal desktop-first release; the primary bar is self-serve success across connector setup, app creation, publication, and tool use; many users should be treated as both builders and end users; advanced capabilities can be visually reduced or deferred if they compromise clarity. Keep the current product direction, but simplify language, navigation, first-run exposure, and role friction. Add in-product guidance instead of asking users to learn platform vocabulary elsewhere.

### Acceptance Criteria
A non-technical user can sign in, connect a data source, create a simple app, publish it, and launch it without seeing unexplained platform jargon. Every main self-serve flow has humane loading, empty, error, access-denied, and missing-resource states. The builder has a guided first-run path for workspace, connector, app creation, and publication. Publish blockers explain what must be fixed in plain language. Core flows are keyboard-usable, visually legible, and stable on common desktop and narrow-width layouts. Core released journeys are covered by automated UI smoke tests.

### Risks
The largest risk is breadth: the product already exposes many advanced surfaces, which makes it easy to ship complexity instead of confidence. Another risk is false readiness from backend completeness while the UX remains brittle. A third risk is lack of UI test coverage, which can turn small copy or navigation changes into regressions.

### Likely Impacted Areas
apps/web/app/login/page.tsx
apps/web/app/page.tsx
apps/web/app/tools/page.tsx
apps/web/app/app/[appId]/page.tsx
apps/web/app/app/[appId]/RuntimeRenderer.tsx
apps/web/app/builder/page.tsx
apps/web/app/builder/layout.tsx
apps/web/app/builder/BuilderSidebar.tsx
apps/web/app/builder/[appId]/page.tsx
apps/web/app/builder/[appId]/SplitViewOverlay.tsx
apps/web/app/globals.css
apps/web/lib/auth.tsx
apps/web/lib/appValidation.ts
package.json
apps/web/package.json

### Planning Handoff
The minimum context a planning or implementation agent needs next:
- recommended plan title: UX-first release hardening for non-technical users
- likely workstreams or phases: end-user runtime polish, builder simplification, shared UI system, accessibility and responsive fixes, release test coverage
- major dependencies: route-state handling, shared UI primitives, copy pass, end-to-end test harness choice, publish-validation messaging
- blockers or open questions still remaining: whether the release should actively hide some advanced builder/admin surfaces; whether the dark visual direction stays or is adjusted for higher readability; what exact smoke-test environment will back the web UI suite

## Prioritized Release Checklist

### Must-have before release
- Clarify or relax the current role split so self-serve users can move between building and launching tools without an artificial product boundary.
	Files: apps/web/app/page.tsx, apps/web/lib/auth.tsx, apps/web/app/builder/layout.tsx, apps/web/app/tools/layout.tsx
- Rewrite end-user copy across login, tools, and runtime so users are guided by outcomes instead of platform terms.
	Files: apps/web/app/login/page.tsx, apps/web/app/tools/page.tsx, apps/web/app/app/[appId]/page.tsx, apps/web/app/tools/layout.tsx
- Simplify connector setup and publication because they are part of the release-critical path to creating anything launchable.
	Files: apps/web/app/builder/connectors/page.tsx, apps/web/app/builder/[appId]/page.tsx, apps/web/lib/appValidation.ts
- Add route-level loading, error, and missing-route handling for the main app shells.
	Files: apps/web/app/layout.tsx, apps/web/app/builder/layout.tsx, apps/web/app/tools/layout.tsx, apps/web/app/app/layout.tsx
- Turn the tools experience into a simple launcher home with better empty states, launch failures, and access explanations.
	Files: apps/web/app/tools/page.tsx, apps/web/app/tools/layout.tsx
- Simplify first-run builder setup so workspace creation, app creation, and first-open actions are self-explanatory.
	Files: apps/web/app/builder/page.tsx, apps/web/app/builder/BuilderSidebar.tsx
- Reduce builder complexity on the main editor by emphasizing only the primary actions needed for v1.
	Files: apps/web/app/builder/[appId]/page.tsx, apps/web/app/builder/[appId]/Inspector.tsx, apps/web/app/builder/[appId]/ChatPanel.tsx, apps/web/app/builder/[appId]/SplitViewOverlay.tsx
- Establish shared UI primitives and tokens for the app shell instead of continuing to duplicate inline styling.
	Files: apps/web/app/globals.css, apps/web/app/login/page.tsx, apps/web/app/tools/page.tsx, apps/web/app/builder/page.tsx
- Fix baseline accessibility and narrow-width behavior for shipped paths.
	Files: apps/web/app/login/page.tsx, apps/web/app/tools/page.tsx, apps/web/app/app/[appId]/page.tsx, apps/web/app/builder/layout.tsx
- Add a real web UI smoke-test harness for the release paths.
	Files: package.json, apps/web/package.json

### Should-have if schedule allows
- Add better async feedback patterns such as toasts, inline success states, and persistent confirmation after save or submit.
	Files: apps/web/app/login/page.tsx, apps/web/app/builder/settings/page.tsx, apps/web/app/app/[appId]/RuntimeRenderer.tsx
- Improve connectors, approvals, and AI settings with more humane help text and clearer empty states.
	Files: apps/web/app/builder/connectors/page.tsx, apps/web/app/builder/approvals/page.tsx, apps/web/app/builder/settings/page.tsx
- Add iconography and stronger visual hierarchy to navigation-heavy admin pages.
	Files: apps/web/app/builder/admin/page.tsx, apps/web/app/builder/BuilderSidebar.tsx
- Improve redirect transitions so users are not dropped onto blank screens while auth and role checks resolve.
	Files: apps/web/app/page.tsx, apps/web/app/builder/layout.tsx, apps/web/app/tools/layout.tsx

### Defer from the first release if needed to protect quality
- Prominent version-history workflows and secondary editing surfaces.
	Files: apps/web/app/builder/[appId]/VersionHistory.tsx, apps/web/app/builder/[appId]/LayersPanel.tsx
- Chat-led and split-view creation flows until the main builder path is clear and dependable.
	Files: apps/web/app/builder/[appId]/ChatPanel.tsx, apps/web/app/builder/[appId]/SplitViewOverlay.tsx
- Deep admin/resource workflows that are not required to let a first builder create and publish a basic tool.
	Files: apps/web/app/builder/admin/resources/page.tsx, apps/web/app/builder/admin/groups/page.tsx, apps/web/app/builder/admin/members/page.tsx

## Page-by-Page UI Remediation Brief

### Shell-level gaps
- Add explicit loading, error, and not-found handling for all route groups. The current layouts return null during auth checks, which creates blank-screen moments.
	Files: apps/web/app/layout.tsx, apps/web/app/builder/layout.tsx, apps/web/app/tools/layout.tsx, apps/web/app/app/layout.tsx
- Introduce a shared page-shell system for headers, cards, forms, alerts, buttons, and empty states so the app stops feeling like unrelated screens.
	Files: apps/web/app/globals.css and all major page files under apps/web/app

### / and redirect behavior
- Current state: role-based redirect logic exists, but it is invisible to users while auth resolves.
	File: apps/web/app/page.tsx
- Remediation: add a short transition screen with clear messaging such as signing you in or taking you to your tools.

### /login
- Current state: login supports SSO, Google, magic link, and dev login in one dense panel.
	File: apps/web/app/login/page.tsx
- Problems: too many choices in one visual block, weak distinction between production and development flows, plain error states, and no reassurance about what happens next.
- Remediation: separate primary login from secondary options, move dev login into a clearly labeled advanced/dev section, add better error/success styling, and explain the magic-link flow in plain language.

### /tools layout and tools home
- Current state: the tools page lists tools, supports search, and launches a runtime route; the shell header is minimal.
	Files: apps/web/app/tools/layout.tsx, apps/web/app/tools/page.tsx
- Problems: it still feels like a catalog of internal objects, launch failures are plain text, workspace changes are implicit, and empty states are informative but not supportive.
- Remediation: make this the main end-user home screen, strengthen the header and page intro, clarify why a tool is available or not launchable, make launch/recovery states visually obvious, and explain workspace switching only when it affects the user.

### /app/[appId]
- Current state: runtime handles workspace-unavailable, unpublished, access-denied, and generic failure cases, then renders the app runtime.
	File: apps/web/app/app/[appId]/page.tsx
- Problems: several states still use internal product terms, the runtime header exposes builder-oriented navigation, and generic failures are too terse.
- Remediation: rewrite all blocked states into plain-language task guidance, remove or role-gate builder-oriented links from the end-user header, and provide a retry path plus a safe route back to tools.

### Runtime widget rendering
- Current state: runtime supports text, button, table, form, KPI, chart, filter, and markdown widgets with validation and approval-aware button behavior.
	File: apps/web/app/app/[appId]/RuntimeRenderer.tsx
- Problems: several runtime messages still read like configuration diagnostics, the canvas layout is functional but austere, and action feedback is transient and easy to miss.
- Remediation: translate configuration and unsupported-widget states into user-safe messaging, improve button/form success and pending states, and add more visible empty, loading, and recovery patterns inside widgets.

### /builder home
- Current state: builder home combines workspace creation, app creation, and app listing.
	File: apps/web/app/builder/page.tsx
- Problems: first-time setup and ongoing app management are mixed together, and the page assumes users already understand workspaces and apps.
- Remediation: make first-run builder onboarding distinct from the returning-user dashboard, explain what a workspace is only at the moment it matters, and turn app creation into a guided first task.

### Builder shell and navigation
- Current state: the builder shell uses a fixed sidebar with workspace selection, navigation, and account actions.
	Files: apps/web/app/builder/layout.tsx, apps/web/app/builder/BuilderSidebar.tsx
- Problems: auth loading returns a blank screen, navigation labels are platform-centric, and admin capabilities sit at the same visual level as core builder tasks.
- Remediation: add a loading shell, simplify or rename labels where possible, and visually separate core creation tasks from advanced administration.

### /builder/[appId] editor
- Current state: the editor exposes canvas editing, inspector, chat, workflows, publications, app settings, version history, and validation in one large surface.
	File: apps/web/app/builder/[appId]/page.tsx
- Problems: too many concepts are present at once for a first-time non-technical builder; core actions compete with advanced controls.
- Remediation: make add widget, edit content, preview, publish, and fix blockers the dominant path; stage workflows, history, and AI-led creation behind secondary affordances.

### /builder/connectors
- Current state: connectors management is feature-rich and supports many connector types.
	File: apps/web/app/builder/connectors/page.tsx
- Problems: the page is powerful but intimidating, especially for non-technical builders who may not know connection details or grant models.
- Remediation: keep the main list and creation flow, but convert advanced grants, actions, schema, and data-management controls into progressive-disclosure sections with clearer explanations.

### /builder/approvals
- Current state: approvals management is already task-focused and filterable.
	File: apps/web/app/builder/approvals/page.tsx
- Problems: the language is still operational rather than user-centered, and the UI lacks stronger empty/success patterns.
- Remediation: keep it visible for admins, but simplify the copy, clarify decision consequences, and improve status readability.

### /builder/settings
- Current state: AI settings are functional and reasonably constrained.
	File: apps/web/app/builder/settings/page.tsx
- Problems: the form still assumes users understand providers, models, and token behavior; save confirmation is minimal.
- Remediation: keep the page, but rewrite it as setup guidance with field help, example values, and stronger saved-state confirmation.

### /builder/admin and subpages
- Current state: admin links, audit, members, groups, and resources are present.
	Files: apps/web/app/builder/admin/page.tsx and subpages under apps/web/app/builder/admin
- Problems: these are important but not first-release builder tasks, and they add cognitive weight when placed alongside app creation.
- Remediation: keep them accessible for true admins, but de-emphasize them in the main builder journey and avoid surfacing them during first-run onboarding.

## Builder v1 Scope Controls

### Keep fully visible in v1
- Builder home with workspace/app creation, but in a guided format.
	File: apps/web/app/builder/page.tsx
- Core editor path: canvas, a simplified inspector, preview, publish, and publish blockers.
	Files: apps/web/app/builder/[appId]/page.tsx, apps/web/app/builder/[appId]/CanvasEditor.tsx, apps/web/app/builder/[appId]/Inspector.tsx
- Connectors list and basic connector creation because builders need data before they can produce usable tools.
	File: apps/web/app/builder/connectors/page.tsx
- Approvals because the release already includes approval-gated writes.
	File: apps/web/app/builder/approvals/page.tsx

### Simplify for v1
- Workspace creation language and app creation flow.
	File: apps/web/app/builder/page.tsx
- Sidebar labeling and information density.
	File: apps/web/app/builder/BuilderSidebar.tsx
- Publish dialog and publication setup so the primary question is who can use this tool, not how the platform models publications.
	File: apps/web/app/builder/[appId]/page.tsx
- Inspector surface so only the most common widget properties are immediately visible.
	File: apps/web/app/builder/[appId]/Inspector.tsx
- AI settings so the page behaves like a simple personal setup screen rather than a provider configuration sheet.
	File: apps/web/app/builder/settings/page.tsx

### Hide behind progressive disclosure in v1
- Chat-driven editing and split-view generation.
	Files: apps/web/app/builder/[appId]/ChatPanel.tsx, apps/web/app/builder/[appId]/SplitViewOverlay.tsx
- Advanced workflow editing, raw config, SQL-heavy controls, and specialist node configuration.
	Files: apps/web/app/builder/[appId]/WorkflowEditor.tsx, apps/web/app/builder/[appId]/WorkflowCanvas.tsx, apps/web/app/builder/[appId]/workflow-nodes/*
- Connector grants and advanced resource permissions.
	Files: apps/web/app/builder/connectors/ConnectorGrantsTab.tsx, apps/web/app/builder/admin/resources/page.tsx
- Secondary organization tools such as layers and floating workflow panels.
	Files: apps/web/app/builder/[appId]/LayersPanel.tsx, apps/web/app/builder/[appId]/FloatingWorkflowPanel.tsx

### Defer from the first release if quality or scope becomes tight
- Version history as a prominent user flow.
	File: apps/web/app/builder/[appId]/VersionHistory.tsx
- Workflow templates if they distract from the primary create-edit-publish journey.
	File: apps/web/app/builder/[appId]/workflowTemplates.ts
- Deep admin maintenance flows that are not required to get a simple internal tool into use.
	Files: apps/web/app/builder/admin/groups/page.tsx, apps/web/app/builder/admin/members/page.tsx, apps/web/app/builder/admin/resources/page.tsx
- Any unfinished AI-generation affordance that creates expectation without dependable output.
	File: apps/web/app/builder/[appId]/SplitViewOverlay.tsx

### Recommended v1 builder posture
For the first release, the builder should behave like a guided tool creator, not a platform cockpit. Users should see only the actions required to create a simple app, connect data, preview the result, publish it safely, and understand why publication is blocked when it is blocked. Everything else should either move into an advanced section or wait until the primary journey is smooth.
