# Requirements Document

## 1. Business Objective
Build an AI-first internal-tools platform that lets companies create and maintain their own operational apps through conversation instead of manual low-code assembly or custom engineering work. The product should reduce the effort required to create CRUD tools, analytics dashboards, and workflow-driven internal apps while preserving manual control through an editable visual canvas.

## 2. Core Problem
Companies currently build internal tools through a mix of engineering backlogs, low-code builders, spreadsheets, and BI tools stitched together with manual workflows. These approaches create several problems:

- Business users must translate operational needs into component layouts, queries, workflows, or engineering tickets.
- Existing builders still require users to manually assemble interfaces and logic widget by widget.
- Iteration is slow because every request must be converted into UI structure, data bindings, and actions before the tool becomes usable.
- Non-technical or semi-technical users are blocked when they cannot express requirements in the configuration model of the builder.
- Teams need generated tools to remain editable before release so they can correct AI mistakes and tailor the result.

## 3. Current Process
Target customers currently create internal tools using one or more of the following approaches:

- Engineering teams build custom tools from backlog requests.
- Teams use Retool-like or Airtable/Appsmith-like builders and manually configure components, queries, and workflows.
- Teams rely on spreadsheets and manual operational processes when no proper internal tool exists.
- Teams combine BI dashboards with manual follow-up steps outside the reporting tool.

The desired replacement process is:

- A builder describes the tool in natural language to an AI agent.
- The AI agent begins creating widgets directly on a workspace canvas without requiring a separate approval step.
- The builder can move, edit, and refine generated widgets while the app is still being assembled.
- The completed app is only opened to end users as a working dashboard after the appropriate admin-controlled publishing step.

## 4. Functional Requirements
FR-1: The system SHALL provide a conversational interface where an app builder can describe an internal tool in natural language.

FR-2: The system SHALL allow the AI agent to begin generating UI widgets and layout changes immediately after a user submits a request.

FR-3: The system SHALL generate interactable internal apps that can support CRUD/admin workflows, analytics dashboards, and approval or process workflows.

FR-4: The system SHALL render generated output onto a visual workspace canvas that is infinitely scrollable.

FR-5: The system SHALL allow builders to move, resize, configure, and delete generated widgets on the canvas before publication.

FR-6: The system SHALL support prompt-based revisions so a builder can ask the AI agent to modify the generated app after initial creation.

FR-7: The system SHALL keep the conversational context and the generated canvas synchronized so edits requested in chat are reflected in the workspace.

FR-8: The system SHALL expose a visual editing experience for manual refinement in addition to AI-driven generation.

FR-9: The system SHALL support data connectors for relational databases including Postgres, MySQL, and SQL Server.

FR-10: The system SHALL support connectors for REST APIs and GraphQL APIs.

FR-11: The system SHALL support CSV and spreadsheet-based data import for app building workflows.

FR-12: The system SHALL allow the AI agent to generate data queries, API calls, and workflow actions based on the builder's request.

FR-13: The system SHALL allow the AI agent to generate custom business logic, subject to review and editing by the builder before publication.

FR-14: The system SHALL default the AI agent to schema and metadata access rather than unrestricted access to live production data.

FR-15: The system SHALL require explicit user approval before any AI-generated action can perform a write or mutating operation against an external system.

FR-16: The system SHALL support multiple isolated workspaces within a single company account.

FR-17: The system SHALL enforce role-based access control for workspace administration, app building, and end-user operation.

FR-18: The system SHALL support SSO-based authentication through SAML or OAuth-compatible identity providers.

FR-19: The system SHALL allow only a workspace admin to publish or expose an app to end users.

FR-20: The system SHALL separate builder-time editing from runtime app usage so unpublished drafts are not treated as end-user dashboards.

FR-21: The system SHALL provide a preview or draft state where builders can validate generated tools before requesting publication.

FR-22: The system SHALL preserve manual edits made by builders unless the builder explicitly asks the AI agent to overwrite or refactor those areas.

FR-23: The system SHALL present the app builder with enough generated structure, labels, and data bindings to operate the app as a real internal tool rather than a static mockup.

FR-24: The system SHALL support self-hosted or on-prem deployment for customers that do not want a SaaS-only model.

## 5. Non-Functional Requirements
- First-pass generation quality: The system SHALL target at least 75% UI correctness on the first generation pass, measured by *(needs clarification)*.
- Security: The system SHALL isolate company data, workspaces, apps, and credentials from other tenants.
- Access control: The system SHALL enforce SSO and RBAC consistently across builder and runtime experiences.
- Safety: The system SHALL block AI-initiated write operations until an authorized human explicitly approves them.
- Deployment: The system SHALL be deployable in self-hosted or on-prem environments.
- Performance for infinite canvas interactions: *(needs clarification)*.
- Maximum supported widget count per app: *(needs clarification)*.
- Generation latency from prompt to first usable widget: *(needs clarification)*.
- Audit logging, retention, and compliance requirements: *(needs clarification)*.
- High availability and backup requirements for enterprise customers: *(needs clarification)*.

## 6. User Roles & Permissions
Workspace Admin
- Permissions: configure authentication, manage roles, manage workspaces, manage data connectors, approve publication, and control end-user access.
- Explicit blocks: cannot delegate automatic AI publication without a product change; AI cannot bypass admin publication control.

App Builder
- Permissions: start AI conversations, generate apps, edit the canvas, configure widgets, adjust queries and workflows, preview drafts, and request publication.
- Explicit blocks: cannot publish apps to end users unless they also hold workspace-admin privileges; cannot bypass write-approval safeguards.

End User / Operator
- Permissions: access and use published internal tools that have been shared with them.
- Explicit blocks: cannot edit app structure, cannot manage connectors, and cannot access unpublished drafts unless separately granted builder or admin rights.

Additional enterprise roles such as auditor or compliance reviewer: *(not yet discussed — clarify before implementing)*

## 7. Integrations
- Relational databases: outbound connectivity to Postgres, MySQL, and SQL Server for schema discovery, querying, and approved write actions.
- REST APIs: outbound API calls for reading and, with explicit approval, writing data; authentication schemes and schema discovery depth are *(needs clarification)*.
- GraphQL APIs: outbound queries and mutations where supported by the target service; reliance on introspection is *(needs clarification)*.
- CSV and spreadsheets: import into the builder workflow for table-based tools and dashboard generation; export and sync behavior are *(needs clarification)*.
- Identity providers: inbound authentication and user identity assertions via SAML or OAuth-compatible systems.
- Additional SaaS business systems such as Salesforce, HubSpot, Stripe, or ticketing systems: *(not yet discussed — clarify before implementing)*.

## 8. Core Data Entities
- Company: a customer organization that owns one or more isolated workspaces.
- Workspace: a scoped environment within a company for builders, connectors, and apps.
- User: a human account assigned to one or more roles within a workspace.
- Role: a permission bundle such as workspace admin, app builder, or end user.
- App: a generated internal tool composed of layout, widgets, data bindings, and workflows.
- Canvas: the infinite visual surface on which widgets are placed and edited.
- Widget: a UI building block such as a table, form, chart, filter, button, or KPI tile.
- Conversation Thread: the chat history between the builder and the AI agent for a specific app or editing session.
- Generation Session: the record of an AI generation or revision cycle for an app.
- Data Connector: configuration for connecting a workspace to a database, API, or file-based source.
- Data Schema: metadata describing available tables, fields, endpoints, and relationships used for generation.
- Query: a generated or manually edited data-fetching instruction tied to a widget or workflow.
- Workflow Action: a generated or manually edited business action, approval step, or mutation.
- Draft Version: an unpublished app state under construction.
- Published Version: an approved app state available to end users.

## 9. Constraints
- The product must be AI-first rather than a traditional manual builder with AI added as a side feature.
- The builder experience must support both direct AI generation and manual visual editing.
- The workspace canvas must be infinitely scrollable.
- Generated widgets must remain editable before the app is published to end users.
- Only workspace admins can publish apps.
- Multiple workspaces per company are required.
- SSO, RBAC, and self-hosted/on-prem deployment are required for v1.
- The AI must default to schema and metadata access rather than unrestricted production data access.
- Mutating external systems requires explicit human approval.
- No explicit v1 exclusions were identified, which creates delivery risk and should be narrowed during planning.

## 10. Technical Risks & Assumptions
- Scope risk: supporting CRUD apps, analytics dashboards, and workflow apps from day one may be too broad for a first release.
- Product risk: no clear v1 out-of-scope list was provided, which increases the chance of schedule slippage and diluted product quality.
- Accuracy risk: the 75% first-pass UI correctness target is defined, but the measurement method and acceptance test are still *(needs clarification)*.
- Safety risk: AI-generated business logic and workflow steps can introduce incorrect or unsafe behavior if review controls are weak.
- Data risk: generating useful apps from schema and metadata alone may be insufficient for some use cases unless carefully designed with previews, mappings, or approved samples.
- Platform risk: an infinite scrollable canvas can become difficult to manage without navigation, grouping, or search mechanisms; those controls were *(not yet discussed — clarify before implementing)*.
- Enterprise risk: self-hosted and on-prem support can materially affect architecture, deployment, upgrade strategy, and support burden.
- Assumption: workspace admins are responsible for publication governance and connector trust decisions.
- Assumption: builders are willing to refine AI output visually and through follow-up prompts instead of expecting perfect one-shot generation.
- Assumption: backward-compatibility requirements are not applicable yet because this is a new product concept.