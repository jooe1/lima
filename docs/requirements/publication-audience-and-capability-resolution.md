# Publication Audience And Capability Resolution

**Status:** Draft

**Last Updated:** March 22, 2026

## 1. Purpose

Define how Lima resolves company-group membership into publication discovery and launch capability for published apps.

This spec starts after workspace membership is already known. It does not decide who becomes a workspace member; it decides what a workspace member may discover or launch once publications and audience groups exist.

## 2. Current Implementation Baseline

Observed current behavior in the codebase:

- Company-scoped tool discovery already requires workspace membership through a join to `workspace_members`.
- Publications with no audience rows are treated as unrestricted within the workspace.
- Publication capability precedence already behaves as `use > discover` through SQL `MAX(...)` evaluation.
- Published-app launch checks only treat `use` as sufficient to run the app.
- There is no deny model.
- Group membership is currently whatever exists in `group_memberships`; the platform does not yet provide a company-wide synthetic group or automatic runtime reconciliation of synthetic memberships.

This spec defines the intended product behavior and the compatibility rules that the implementation should preserve.

## 3. Goals

- Make publication capability resolution deterministic and order-independent.
- Keep discovery and launch semantics easy to explain.
- Preserve the rule that publication audiences refine workspace access rather than replacing it.
- Define how multiple matching groups resolve into one effective capability.
- Make discovery surfaces and launch surfaces consistent.

## 4. Non-Goals

- This document does not define workspace provisioning.
- This document does not define deny rules.
- This document does not define per-widget or per-action runtime authorization.
- This document does not define cross-workspace discovery for non-members.

## 5. Entities

### 5.1 Company Group

A named company-scoped group whose membership may come from:

- `company_synthetic`
- `workspace_sync`
- `manual`
- `idp`

### 5.2 App Publication

A published app version associated with a workspace and company.

### 5.3 Publication Audience

A link between a publication and a company group with a capability value.

### 5.4 Publication Capability

Capabilities in scope for this spec are:

- `discover`
- `use`

## 6. Core Principles

### 6.1 Workspace Membership Comes First

Publication audiences SHALL refine access for existing workspace members. They SHALL NOT grant access to a workspace that the user is not already a member of.

### 6.2 Capability Resolution Is Set-Based

Capability SHALL be computed from the full set of matching audience groups. Group evaluation SHALL be set-based, not order-based.

### 6.3 Highest Capability Wins

If multiple matched groups grant different capabilities, the highest capability SHALL win.

Capability order is:

- `use`
- `discover`
- `none`

## 7. Group Set Used For Publication Evaluation

For a given workspace member, the effective group set used for publication evaluation SHALL be the union of:

- the company-wide synthetic group
- all matching workspace synthetic groups
- all manual company groups the user belongs to
- all current IdP-synced groups

No group suppresses another group in this version of the model.

## 8. Capability Semantics

### 8.1 `discover`

`discover` means:

- the user may see the app in discovery surfaces
- the user may not launch the app runtime

### 8.2 `use`

`use` means:

- the user may see the app in discovery surfaces
- the user may launch and operate the app runtime

## 9. Evaluation Rules

### 9.1 Unrestricted Publication

If a publication has no audience rows, it SHALL be available to all members of the workspace.

Effective result:

- discover: yes
- launch: yes

### 9.2 Group-Scoped Publication

If a publication has one or more audience rows, the user's effective capability SHALL be the highest capability granted by any matched audience group.

### 9.3 No Matching Audience

If a publication has audience rows and the user matches none of them, the user SHALL have no capability for that publication.

Effective result:

- discover: no
- launch: no

### 9.4 Multiple Group Matches

If a user matches one group with `discover` and another with `use`, the final capability SHALL be `use`.

This rule SHALL hold regardless of which group was assigned first or which employee joined first.

### 9.5 Launch Gate

Only `use` SHALL permit launch of a specific publication or published app runtime.

`discover` alone SHALL NOT permit launch.

## 10. Discovery And Launch Matrix

| Workspace member | Audience rows | Matching capability | Discover | Launch |
| --- | --- | --- | --- | --- |
| No | any | any | No | No |
| Yes | none | unrestricted | Yes | Yes |
| Yes | present | none | No | No |
| Yes | present | discover | Yes | No |
| Yes | present | use | Yes | Yes |

## 11. UX Requirements

The UI SHALL be able to explain why a user can or cannot discover or launch a publication.

Example explanations:

- `Publication unrestricted for workspace members`
- `Publication capability: discover via group Finance Reviewers`
- `Publication capability: use via group Builders`
- `No matching publication audience`

Discovery surfaces SHALL NOT show apps from workspaces the user is not otherwise a member of.

## 12. Audit Requirements

The system SHALL audit at least the following publication-related changes:

- publication created
- publication archived
- publication audience added
- publication audience removed
- publication audience capability changed

Each event SHALL identify whether the change came from:

- manual admin action
- automated reconciliation or migration
- IdP synchronization when applicable

## 13. Data And Query Requirements

The implementation SHALL preserve these rules:

- unrestricted publications are visible to all workspace members
- `use` outranks `discover`
- launch checks only succeed for `use`
- publication capability is computed from all matching groups, not the first matching group

If the platform later introduces deny rules, they SHALL require a new spec rather than silently changing this precedence model.

## 14. Acceptance Criteria

The feature is complete when all of the following are true:

- a user who is not a workspace member cannot discover or launch a publication from that workspace
- a publication with no audience rows is available to all workspace members
- a publication with audiences grants the highest matched capability among all matched groups
- `use` beats `discover`
- `discover` allows listing but not launch
- `use` allows both listing and launch
- join order does not affect final publication capability
- admins can inspect why a user has a given publication capability

## 15. Open Questions

- Should future discovery surfaces ever show apps from workspaces the user is not a member of?
  - This spec assumes `no`.
- Should the product eventually add an explicit `none` audience row or deny semantics?
  - This spec assumes additive allow-only behavior.
- Should publication capability ever be elevated by company role directly, or only through groups?
  - This spec assumes capability is group-based.