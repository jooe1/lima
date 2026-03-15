# ADR-001: Monorepo structure and tooling

**Date:** 2026-03-15  
**Status:** Accepted

## Context

Lima is a multi-language project: a React/Next.js frontend, two Go backend services, and several TypeScript packages. We need a single repository that allows atomic commits across layers, shared tooling, and independent builds.

## Decision

- **Turborepo** orchestrates JavaScript/TypeScript builds, tests, and linting across `apps/` and `packages/`.
- **Go workspaces** (`go.work`) link `services/api` and `services/worker` so local cross-service imports work without publishing.
- **pnpm workspaces** manage Node dependencies with strict, deterministic lockfiles.
- Go services use separate `go.mod` files because they build to separate binaries and have different dependency surfaces.

## Consequences

- CI must run `pnpm install` and `go mod download` separately, but both can be cached by layer.
- New services or packages must be registered in `pnpm-workspace.yaml` (JS) or `go.work` (Go).
- The monorepo avoids a multi-repo setup that would complicate atomic feature delivery across the stack.
