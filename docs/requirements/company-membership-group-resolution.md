# Membership And Publication Access Specs

**Status:** Draft

**Last Updated:** March 22, 2026

## Purpose

This document is the entry point for the two focused specs that define how Lima should handle employee provisioning, workspace membership, group resolution, and publication access.

The earlier combined draft covered too many lifecycle rules in one place. It has been split into two reviewable specs:

1. [Company Membership And Workspace Provisioning](company-membership-and-workspace-provisioning.md)
2. [Publication Audience And Capability Resolution](publication-audience-and-capability-resolution.md)

## Why The Split Matters

These concerns are related, but they are not the same decision surface:

- Company membership and workspace provisioning decide who becomes a member of what.
- Publication audience resolution decides what a user may discover or launch after workspace membership already exists.

Keeping them separate makes it easier to review product behavior, data-model changes, and migration sequencing without mixing provisioning rules with launch-time access rules.

## Current Implementation Baseline

The current codebase already contains parts of both systems, but not the full deterministic model:

- SSO login creates or updates the user record for a derived company.
- No automatic company role binding is assigned during login.
- Workspace creation auto-enrolls only the creator as `workspace_admin`.
- Workspace synthetic groups were backfilled once by migration from `workspace_members`.
- There is no runtime reconciliation that keeps those synthetic groups aligned after membership changes.
- Publication discovery and launch checks already require workspace membership first.
- Publication capability precedence already behaves as `use > discover`, but only within the currently available group memberships.

## Reading Order

Read the specs in this order:

1. [Company Membership And Workspace Provisioning](company-membership-and-workspace-provisioning.md)
2. [Publication Audience And Capability Resolution](publication-audience-and-capability-resolution.md)

The second spec assumes the group and workspace membership model defined in the first one.
