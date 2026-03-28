# Release Checklist: UX-First Release Readiness
_Version: ux-first-release-readiness_
_Last updated: 2026-03-28_

This checklist encodes the go/no-go criteria for the self-serve UX-first release.
Run `pnpm release:smoke` to execute the automated portion.

---

## Pre-Release: Automated Gate

Run the following and confirm all pass:

```bash
pnpm release:smoke
```

This runs:
- `apps/web/tests/e2e/self-serve-smoke.spec.ts` — full self-serve journey smoke
- `apps/web/tests/e2e/publish-blockers.spec.ts` — blocker and recovery coverage

**All tests must pass with zero failures.**

---

## Self-Serve Journey Checklist

### Sign-In
- [ ] Login page renders without errors on a fresh browser visit
- [ ] Magic link form has a clearly labeled email input
- [ ] Dev login form is visually separated from the primary path
- [ ] Submitting the magic-link form shows feedback (no silent failure)

### Builder Access
- [ ] Authenticated users land on the builder home (not login or tools-only page)
- [ ] Unauthenticated users are redirected to login from all builder routes
- [ ] Builder loading state is visible (not blank) while auth resolves

### Workspace & App Creation
- [ ] First-time users see clear workspace setup guidance on the builder home
- [ ] App creation affordance is visible after workspace is set up
- [ ] Navigation emphasizes Apps and Connectors; secondary actions are less prominent

### Connector Setup
- [ ] Basic connector types (postgres, mysql, rest, managed, csv) are shown prominently
- [ ] Advanced types are behind a "Show advanced types" toggle
- [ ] Empty state provides guidance on how to add a first connector

### Editor & Publishing
- [ ] Publish button is the visually prominent primary CTA in the editor
- [ ] Publish blockers use plain-language messages (no internal widget IDs)
- [ ] Publish dialog asks "who should have access" — not technical audience capability language
- [ ] Audience options use plain labels ("Can find this tool", "Can use this tool")
- [ ] Editor loading state is visible (RouteGateShell), not blank
- [ ] Chat panel is de-emphasized as a preview/secondary feature
- [ ] SplitView "Generate with AI" button is hidden (not yet production-ready)

### Tools & Runtime
- [ ] Tools page has an `<h1 id="Your Tools">` heading
- [ ] Search input is always visible with a proper label
- [ ] Empty tools state provides a link to the builder
- [ ] Discovery-only tools clearly explain they cannot be launched
- [ ] Runtime blocked states use plain-language guidance with clear CTAs
- [ ] Runtime header shows tool name (not just generic "App")
- [ ] No "Edit in builder" link shown in the runtime to regular users

### Route States
- [ ] 404 page shows "Page not found" with a home link
- [ ] Top-level error boundary shows "Something went wrong" with a retry option
- [ ] Runtime loading screen shows while fetching tool version
- [ ] Root loading screen shows during app-shell transitions

### Accessibility & Layout
- [ ] `:focus-visible` ring is visible on all interactive elements
- [ ] All form inputs have associated `<label>` elements
- [ ] Login page is keyboard-navigable to the submit button
- [ ] Builder layout has a skip-to-content link
- [ ] Runtime page has a skip-to-content link
- [ ] Main landmark (`<main>`) is present on: tools, builder, runtime
- [ ] Pages render without horizontal overflow at 768px viewport width

---

## Post-Release Manual Spot Checks

- [ ] Sign in with a real magic link email on staging
- [ ] Create a test connector on staging and confirm it appears in the connector list
- [ ] Create a test app, add a widget, and attempt to publish
- [ ] Verify a real published tool is launchable from the tools page
- [ ] Verify discovery-only tools show the correct "can't open" state

---

## Rollback Criteria

Roll back the release if any of the following are observed in production:
- Login page fails to render for any browser
- Builder home blank-screens on authenticated load
- Publish dialog does not open
- Tools page does not load for authenticated users
- Any critical runtime blocked state redirects to a raw error

---

_Run `pnpm release:smoke` before every release on the `feature-ux-first-release-readiness` branch._
