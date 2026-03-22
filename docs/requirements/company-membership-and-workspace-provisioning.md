# Company Membership And Workspace Provisioning

**Status:** Draft

**Last Updated:** March 22, 2026

## 1. Purpose

Define the required behavior for how Lima provisions users into a company, assigns company-level bootstrap roles, manages system-owned groups, grants workspace membership, and reconciles automatic access over time.

This spec answers the employee-lifecycle questions that the current implementation leaves partial or implicit:

- what happens when the first employee joins a company
- what happens when later employees join the same company
- which memberships are automatic versus manual
- how workspace roles should be granted and recomputed
- how synthetic groups should stay synchronized with effective membership

## 2. Current Implementation Baseline

Observed current behavior in the codebase:

- SSO callback derives a company from the user's email domain, finds or creates that company, and upserts the user record.
- The login flow does not automatically create any `company_role_bindings`.
- Creating a workspace automatically enrolls the creator as `workspace_admin`.
- Workspace synthetic groups were created once by migration `012_synthetic_workspace_groups.up.sql` and backfilled from `workspace_members`.
- There is no runtime path that keeps `workspace_sync` groups aligned after later membership changes.
- There is no company-wide synthetic group representing all active employees.
- There is no explicit grant-source model for distinguishing manual workspace membership from policy-generated membership.

This spec defines the desired behavior that should replace those partial rules.

## 3. Goals

- Make employee provisioning deterministic and independent of join order.
- Separate company roles, workspace roles, and publication capabilities.
- Define which groups are system-managed, admin-managed, or IdP-managed.
- Ensure synthetic group membership always reflects current effective state.
- Preserve manual access while allowing automatic grants to be recomputed safely.
- Provide a clean audit trail for every automatic and manual access change.

## 4. Non-Goals

- This document does not define the full SAML or OIDC attribute-mapping configuration format.
- This document does not define fine-grained resource grants beyond company roles and workspace roles.
- This document does not define deny rules.
- This document does not define end-user publication capability semantics except where workspace membership is a prerequisite.

## 5. Core Principles

### 5.1 Join Order Must Not Matter

Two employees with the same current inputs and policies SHALL receive the same effective access regardless of which one joined first.

### 5.2 Effective Access Is Based On Current State

Effective company roles, workspace roles, and synthetic-group membership SHALL be based on current user state and current policy state, not historical sequence.

### 5.3 Automatic And Manual Grants Must Be Separable

The system SHALL distinguish among:

- manual admin grants
- automatic system grants
- IdP-driven grants
- policy-generated grants

This is required so automatic reconciliation can remove stale automatic access without destroying manual assignments.

## 6. Entities

### 6.1 Company User

A user record scoped to a company.

### 6.2 Company Role

A company-wide administrative role such as:

- `company_admin`
- `resource_admin`
- `policy_admin`
- `company_member`

### 6.3 Workspace Membership

A role binding between a user and a workspace such as:

- `workspace_admin`
- `app_builder`
- `end_user`

### 6.4 Company Group

A named set of users within a company.

Source types used by this spec are:

- `company_synthetic`
- `workspace_sync`
- `manual`
- `idp`

### 6.5 Workspace Membership Grant Source

The origin of a workspace membership grant. Expected categories are:

- `manual`
- `policy`
- `idp`
- `system_bootstrap`

## 7. Required Group Model

### 7.1 Company-Wide Synthetic Group

Each company SHALL have exactly one system-managed synthetic group representing all active employees in that company.

Recommended semantics:

- name: `All Employees`
- source type: `company_synthetic`
- membership: every active user in the company

This group exists so admins can grant broad access without manually maintaining a parallel group.

### 7.2 Workspace Synthetic Group

Each workspace SHALL have exactly one system-managed synthetic group representing all current members of that workspace.

Recommended semantics:

- name: `Workspace: <workspace name>`
- source type: `workspace_sync`
- membership: every current effective workspace member

This group SHALL be derived from effective workspace membership and SHALL be read-only in the UI.

### 7.3 Manual Company Groups

Manual groups:

- are created by company admins
- are edited by company admins
- are additive
- do not imply inherited access from earlier employees

### 7.4 IdP-Synced Groups

If IdP group sync is enabled, IdP groups:

- are created or updated from the external identity source
- are read-only inside Lima
- are additive with manual and synthetic groups

## 8. User Join And Provisioning Flow

### 8.1 First User In A New Company

The first successfully provisioned human user for a company SHALL become the bootstrap `company_admin` if the company has no existing company-admin binding.

The first user SHALL also:

- receive the `company_member` company role
- be added to the company-wide synthetic group

If that user creates a workspace, they SHALL also:

- become `workspace_admin` for that workspace
- be added to the workspace synthetic group for that workspace

### 8.2 Later Users Joining The Company

When a second or later employee joins the same company, the system SHALL:

- create or update the user record
- grant `company_member`
- add the user to the company-wide synthetic group
- evaluate workspace access policy
- create any resulting workspace memberships
- add the user to any matching workspace synthetic groups implied by those memberships

The system SHALL NOT copy the previous employee's manual groups, workspace roles, or company-admin privileges.

### 8.3 Re-Login And Reconciliation

On login, or via a dedicated reconciliation job, the system SHALL recompute all automatic memberships for the user.

This includes:

- company-wide synthetic group membership
- IdP-managed group membership
- policy-generated workspace grants
- workspace synthetic group membership derived from current workspace membership

## 9. Workspace Access Policy

### 9.1 Default Rule

Workspace access SHALL default to `manual_only`.

A newly provisioned company employee does not automatically gain workspace membership unless a policy or explicit grant says they should.

### 9.2 Supported Grant Sources

Workspace membership may originate from:

- an explicit manual grant
- a workspace access policy
- an IdP-driven mapping rule
- a system bootstrap grant for the workspace creator

### 9.3 Policy Model

Each workspace SHALL support a set of rules.

Each rule SHALL specify:

- matching source
  - `all_company_members`
  - `company_group`
  - `idp_group`
- source identifier when needed
- workspace role to grant
  - `end_user`
  - `app_builder`
  - `workspace_admin`

### 9.4 Effective Workspace Role

If multiple rules or grants match the same user for the same workspace, the effective workspace role SHALL be the highest role.

Role order is:

- `workspace_admin`
- `app_builder`
- `end_user`
- `none`

### 9.5 Explicit Versus Automatic Membership

The implementation SHALL preserve separate grant records for manual and automatic membership.

If both exist:

- both SHALL remain stored as distinct grant sources
- the effective workspace role SHALL be the highest role across those sources

If a policy later stops matching a user:

- the policy-generated grant SHALL be removed
- any remaining manual grant SHALL remain in effect

## 10. Synchronization Rules

### 10.1 Company Membership Sync

Whenever a user is created, reactivated, or deactivated in a company, the company-wide synthetic group SHALL be reconciled immediately or through a reliable asynchronous job.

### 10.2 Workspace Membership Sync

Whenever workspace membership is created, updated, or removed, the corresponding workspace synthetic group SHALL be reconciled immediately or through a reliable asynchronous job.

### 10.3 Policy Reconciliation

Whenever any of the following change, affected users SHALL be reconciled:

- workspace access policy
- manual group membership
- IdP group membership
- company role binding if policy depends on it

## 11. Audit Requirements

The system SHALL audit at least the following events:

- user provisioned in company
- bootstrap company admin assigned
- company role granted or revoked
- workspace membership granted, changed, or revoked
- group membership granted or revoked
- automatic reconciliation changed access

Each audit event SHALL record the change source:

- manual admin action
- automatic system reconciliation
- IdP synchronization

## 12. UX Requirements

Admins SHALL be able to inspect, for each user:

- company roles
- workspace memberships and roles
- manual groups
- IdP groups
- synthetic groups

The UI SHALL explain why a workspace role exists.

Example explanations:

- `Granted by workspace policy: all_company_members -> end_user`
- `Granted by manual workspace membership`
- `Granted by bootstrap workspace creator rule`

Synthetic and IdP-managed groups SHALL be shown as read-only.

## 13. Data Model Changes Required For Implementation

The current schema is not sufficient to implement this behavior without ambiguity. The implementation SHOULD add:

- a company-wide synthetic group source type
- explicit grant-source tracking for workspace membership
- workspace access policy storage
- reconciliation metadata such as rule ids or last-synced timestamps

One acceptable design is:

- keep `workspace_members` as the effective membership table
- add `workspace_member_grants` for grant sources
- compute the effective role from the highest active grant per user per workspace

## 14. Acceptance Criteria

The feature is complete when all of the following are true:

- the first user in a new company becomes bootstrap `company_admin` if no company admin exists
- every active user in a company is automatically added to the company-wide synthetic group
- join order does not affect resulting company roles, workspace roles, or synthetic-group membership
- a workspace creator becomes `workspace_admin` and is added to the matching workspace synthetic group
- later users added to a workspace are also added to that workspace synthetic group automatically
- users do not inherit manual groups or workspace roles from earlier employees
- workspace access can be driven by deterministic policy rules
- if a user matches multiple workspace rules, the highest workspace role wins
- if an automatic grant disappears, only that automatic grant is removed and manual grants remain
- admins can inspect why a user has a given workspace role

## 15. Migration Strategy

Migration SHOULD proceed in this order:

1. Create the company-wide synthetic group for each company.
2. Backfill every existing active user into that group.
3. Rebuild workspace synthetic groups from current effective workspace membership.
4. Introduce explicit workspace-grant source tracking.
5. Introduce workspace access policy with `manual_only` as the default.
6. Reconcile all users once after deployment.

## 16. Open Questions

- Should inactive or suspended users remain in the company-wide synthetic group?
- Should the bootstrap company-admin rule apply to the first successful SSO user only, or require an install-time bootstrap token?
- Should v1 support only a single default workspace rule for all company members, or full multi-rule policy from the start?