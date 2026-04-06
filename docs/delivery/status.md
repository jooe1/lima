# Orchestration Status: AI Connector Wizard — REST
_Last updated: 2026-04-01_
_Depth: 0_
_Commit mode: no-commit_

| # | Commit | Status | Notes |
|---|--------|--------|-------|
| 1 | feat(worker): add docfetch HTTP utility | complete | 7/7 tests pass |
| 2 | feat(worker): add connector-draft job type | complete | all tests pass |
| 3 | feat(api): add connector-draft endpoints | complete | all tests pass |
| 4 | feat(sdk): add ConnectorDraftResult types | complete | build passes, 3 types exported |
| 5 | feat(web): AI connector wizard | complete | 90/90 tests pass |

## Final Report
_Completed: 2026-04-01_

| # | Commit | Iterations |
|---|--------|-----------|
| 1 | feat(worker): add docfetch HTTP utility | 1 |
| 2 | feat(worker): add connector-draft job type | 1 |
| 3 | feat(api): add connector-draft endpoints | 1 |
| 4 | feat(sdk): add ConnectorDraftResult types | 1 |
| 5 | feat(web): AI connector wizard | 1 |

**Acceptance criteria:**
- [x] A non-technical user can add a Moco REST connector by pasting `https://everii-group.github.io/mocoapp-api-docs/` — wizard UI implemented with URL input step
- [x] The review screen shows at least the base URL and a non-empty endpoint checklist — implemented in `review` step
- [x] The `keyGuide` step shows service-specific instructions extracted from the docs — implemented in `key-input` step
- [ ] The activated connector appears in the connector list and passes schema discovery ← requires manual end-to-end test with a running stack
- [x] "Manual setup" still works unchanged for technical users — preserved; 2 regression tests confirm
- [x] If the docs URL is unreachable, the wizard shows a clear error — implemented; SSRF guard returns `ErrBlockedHost` → Redis error result → wizard shows error

**Files modified:**
- `services/worker/internal/docfetch/fetch.go` (new)
- `services/worker/internal/docfetch/fetch_test.go` (new)
- `services/worker/internal/queue/connectordraft.go` (new)
- `services/worker/internal/queue/connectordraft_test.go` (new)
- `services/worker/internal/queue/dispatcher.go` (modified)
- `services/api/internal/handler/connector_draft.go` (new)
- `services/api/internal/handler/connector_draft_test.go` (new)
- `services/api/internal/queue/enqueue.go` (modified)
- `services/api/internal/router/router.go` (modified)
- `packages/sdk-connectors/src/index.ts` (modified)
- `apps/web/lib/api.ts` (modified)
- `apps/web/app/builder/admin/resources/page.tsx` (modified)
- `apps/web/app/builder/admin/resources/page.test.tsx` (new)

**Tests passing:**
- Worker: `go test ./...` — all pass (docfetch: 7, queue: all)
- API: `go test ./...` — all pass
- Web: `pnpm exec vitest run` — 90/90 pass

**Note:** `apps/web pnpm build` has a pre-existing TypeScript error in `app/_components/RouteGateShell.tsx` (`Cannot find namespace 'JSX'`) that existed on `main` before this branch. None of the files in this feature touch that component.



