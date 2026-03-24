// Package model contains the shared domain types for the Lima API.
// These structs map directly to the database tables defined in the migrations.
package model

import "time"

// ---- Tenancy ----------------------------------------------------------------

type Company struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Workspace struct {
	ID        string    `json:"id"`
	CompanyID string    `json:"company_id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type User struct {
	ID         string    `json:"id"`
	CompanyID  string    `json:"company_id"`
	Email      string    `json:"email"`
	Name       string    `json:"name"`
	SSOSubject *string   `json:"-"` // never serialised to clients
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// WorkspaceRole mirrors the workspace_role DB enum.
type WorkspaceRole string

const (
	RoleWorkspaceAdmin WorkspaceRole = "workspace_admin"
	RoleAppBuilder     WorkspaceRole = "app_builder"
	RoleEndUser        WorkspaceRole = "end_user"
)

func WorkspaceRoleRank(role WorkspaceRole) int {
	switch role {
	case RoleWorkspaceAdmin:
		return 3
	case RoleAppBuilder:
		return 2
	case RoleEndUser:
		return 1
	default:
		return 0
	}
}

func HighestWorkspaceRole(roles []WorkspaceRole) (WorkspaceRole, bool) {
	best := WorkspaceRole("")
	bestRank := 0
	for _, role := range roles {
		rank := WorkspaceRoleRank(role)
		if rank > bestRank {
			best = role
			bestRank = rank
		}
	}
	if bestRank == 0 {
		return "", false
	}
	return best, true
}

type WorkspaceGrantSource string

const (
	WorkspaceGrantSourceManual          WorkspaceGrantSource = "manual"
	WorkspaceGrantSourcePolicy          WorkspaceGrantSource = "policy"
	WorkspaceGrantSourceIDP             WorkspaceGrantSource = "idp"
	WorkspaceGrantSourceSystemBootstrap WorkspaceGrantSource = "system_bootstrap"
)

const (
	WorkspaceGrantSourceRefManual          = "manual"
	WorkspaceGrantSourceRefSystemBootstrap = "workspace_creator"
)

type WorkspaceAccessPolicyMatchKind string

const (
	WorkspaceAccessPolicyMatchAllCompanyMembers WorkspaceAccessPolicyMatchKind = "all_company_members"
	WorkspaceAccessPolicyMatchCompanyGroup      WorkspaceAccessPolicyMatchKind = "company_group"
	WorkspaceAccessPolicyMatchIDPGroup          WorkspaceAccessPolicyMatchKind = "idp_group"
)

func WorkspacePolicyGrantSourceRef(matchKind WorkspaceAccessPolicyMatchKind, groupID *string) string {
	switch matchKind {
	case WorkspaceAccessPolicyMatchAllCompanyMembers:
		return string(WorkspaceAccessPolicyMatchAllCompanyMembers)
	case WorkspaceAccessPolicyMatchCompanyGroup, WorkspaceAccessPolicyMatchIDPGroup:
		if groupID == nil {
			return string(matchKind)
		}
		return string(matchKind) + ":" + *groupID
	default:
		return string(matchKind)
	}
}

type MemberDetail struct {
	UserID      string        `json:"user_id"`
	WorkspaceID string        `json:"workspace_id"`
	Email       string        `json:"email"`
	Name        string        `json:"name"`
	Role        WorkspaceRole `json:"role"`
	JoinedAt    time.Time     `json:"joined_at"`
	Grants      []MemberGrant `json:"grants,omitempty"`
}

type MemberGrant struct {
	Role        WorkspaceRole                   `json:"role"`
	GrantSource WorkspaceGrantSource            `json:"grant_source"`
	SourceRef   string                          `json:"source_ref"`
	Explanation string                          `json:"explanation"`
	MatchKind   *WorkspaceAccessPolicyMatchKind `json:"match_kind,omitempty"`
	GroupID     *string                         `json:"group_id,omitempty"`
	GroupName   *string                         `json:"group_name,omitempty"`
}

type WorkspaceMemberGrant struct {
	ID          string               `json:"id"`
	WorkspaceID string               `json:"workspace_id"`
	UserID      string               `json:"user_id"`
	Role        WorkspaceRole        `json:"role"`
	GrantSource WorkspaceGrantSource `json:"grant_source"`
	SourceRef   string               `json:"source_ref"`
	CreatedBy   *string              `json:"created_by,omitempty"`
	CreatedAt   time.Time            `json:"created_at"`
	UpdatedAt   time.Time            `json:"updated_at"`
}

type WorkspaceAccessPolicyRule struct {
	ID          string                         `json:"id"`
	WorkspaceID string                         `json:"workspace_id"`
	MatchKind   WorkspaceAccessPolicyMatchKind `json:"match_kind"`
	GroupID     *string                        `json:"group_id,omitempty"`
	Role        WorkspaceRole                  `json:"role"`
	CreatedBy   *string                        `json:"created_by,omitempty"`
	CreatedAt   time.Time                      `json:"created_at"`
	UpdatedAt   time.Time                      `json:"updated_at"`
}

type WorkspaceAccessPolicyRuleInput struct {
	MatchKind WorkspaceAccessPolicyMatchKind `json:"match_kind"`
	GroupID   *string                        `json:"group_id,omitempty"`
	Role      WorkspaceRole                  `json:"role"`
}

// ---- Apps -------------------------------------------------------------------

// AppStatus mirrors the app_status DB enum.
type AppStatus string

const (
	StatusDraft     AppStatus = "draft"
	StatusPublished AppStatus = "published"
	StatusArchived  AppStatus = "archived"
)

// NodeMeta holds per-node metadata persisted alongside the DSL source.
type NodeMeta struct {
	ManuallyEdited bool `json:"manuallyEdited"`
}

type App struct {
	ID           string              `json:"id"`
	WorkspaceID  string              `json:"workspace_id"`
	Name         string              `json:"name"`
	Description  *string             `json:"description,omitempty"`
	Status       AppStatus           `json:"status"`
	DSLSource    string              `json:"dsl_source"`
	NodeMetadata map[string]NodeMeta `json:"node_metadata,omitempty"`
	CreatedBy    string              `json:"created_by"`
	CreatedAt    time.Time           `json:"created_at"`
	UpdatedAt    time.Time           `json:"updated_at"`
}

type AppVersion struct {
	ID           string              `json:"id"`
	AppID        string              `json:"app_id"`
	VersionNum   int                 `json:"version_num"`
	DSLSource    string              `json:"dsl_source"`
	NodeMetadata map[string]NodeMeta `json:"node_metadata,omitempty"`
	PublishedBy  string              `json:"published_by"`
	PublishedAt  time.Time           `json:"published_at"`
}

// ---- Audit ------------------------------------------------------------------

type AuditEvent struct {
	ID           string         `json:"id"`
	WorkspaceID  string         `json:"workspace_id"`
	ActorID      *string        `json:"actor_id,omitempty"`
	EventType    string         `json:"event_type"`
	ResourceType *string        `json:"resource_type,omitempty"`
	ResourceID   *string        `json:"resource_id,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
}

// ---- Conversation threads (Phase 3) -----------------------------------------

// MessageRole mirrors the message_role DB enum.
type MessageRole string

const (
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleSystem    MessageRole = "system"
)

type ConversationThread struct {
	ID          string    `json:"id"`
	AppID       string    `json:"app_id"`
	WorkspaceID string    `json:"workspace_id"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// DSLPatch is the JSONB payload stored alongside an assistant message.
// new_source contains the full updated Aura DSL produced by the generation job.
type DSLPatch struct {
	NewSource string `json:"new_source"`
}

type ThreadMessage struct {
	ID        string      `json:"id"`
	ThreadID  string      `json:"thread_id"`
	Role      MessageRole `json:"role"`
	Content   string      `json:"content"`
	DSLPatch  *DSLPatch   `json:"dsl_patch,omitempty"`
	CreatedAt time.Time   `json:"created_at"`
}

// ---- User AI settings ------------------------------------------------------

type AIProvider string

const (
	AIProviderOpenAI        AIProvider = "openai"
	AIProviderGitHubCopilot AIProvider = "github_copilot"
)

type UserAISettings struct {
	Configured     bool       `json:"configured"`
	UserID         string     `json:"user_id,omitempty"`
	Provider       AIProvider `json:"provider,omitempty"`
	Model          string     `json:"model,omitempty"`
	OpenAIBaseURL  *string    `json:"openai_base_url,omitempty"`
	HasSecret      bool       `json:"has_secret"`
	MaskedSecretID string     `json:"masked_secret_id,omitempty"`
}

type UserAISettingsRecord struct {
	UserAISettings
	EncryptedCredentials []byte `json:"-"`
}

// GenerationJobPayload is the JSON sent to the generation Redis queue.
type GenerationJobPayload struct {
	ThreadID    string `json:"thread_id"`
	MessageID   string `json:"message_id"`
	AppID       string `json:"app_id"`
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id"`
	// ForceOverwrite bypasses the manuallyEdited protection in the generation
	// worker, allowing the LLM to overwrite all nodes regardless of metadata.
	ForceOverwrite bool `json:"force_overwrite,omitempty"`
}

// ---- Connectors (Phase 4) ---------------------------------------------------

// ConnectorType mirrors the connector_type DB enum.
type ConnectorType string

const (
	ConnectorTypePostgres ConnectorType = "postgres"
	ConnectorTypeMySQL    ConnectorType = "mysql"
	ConnectorTypeMSSQL    ConnectorType = "mssql"
	ConnectorTypeREST     ConnectorType = "rest"
	ConnectorTypeGraphQL  ConnectorType = "graphql"
	ConnectorTypeManaged  ConnectorType = "managed"
)

// RelationalCredentials holds connection parameters for SQL connectors.
type RelationalCredentials struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	SSL      bool   `json:"ssl"`
}

// RestEndpointDef is a named endpoint shortcut defined by the connector admin.
// Stored as part of RestCredentials and projected to schema_cache for the frontend.
type RestEndpointDef struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

// RestCredentials holds connection parameters for REST API connectors.
type RestCredentials struct {
	BaseURL      string            `json:"base_url"`
	AuthType     string            `json:"auth_type"` // none | bearer | basic | api_key
	Token        string            `json:"token,omitempty"`
	Username     string            `json:"username,omitempty"`
	Password     string            `json:"password,omitempty"`
	APIKey       string            `json:"api_key,omitempty"`
	APIKeyHeader string            `json:"api_key_header,omitempty"` // default: X-API-Key
	Endpoints    []RestEndpointDef `json:"endpoints,omitempty"`
}

// Connector is the safe public view of a connector record.
// Credentials are never included in this struct.
type Connector struct {
	ID             string         `json:"id"`
	WorkspaceID    string         `json:"workspace_id"`
	Name           string         `json:"name"`
	Type           ConnectorType  `json:"type"`
	SchemaCache    map[string]any `json:"schema_cache,omitempty"`
	SchemaCachedAt *time.Time     `json:"schema_cached_at,omitempty"`
	CreatedBy      string         `json:"created_by"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	CompanyID      *string        `json:"company_id,omitempty"`
	OwnerScope     string         `json:"owner_scope"` // "company" or "workspace"
}

// ConnectorRecord extends Connector with the raw encrypted credentials for
// internal use only. The json:"-" tag prevents accidental serialisation.
type ConnectorRecord struct {
	Connector
	EncryptedCredentials []byte `json:"-"`
}

// SchemaJobPayload is the JSON envelope sent to the schema Redis queue.
type SchemaJobPayload struct {
	ConnectorID string `json:"connector_id"`
	WorkspaceID string `json:"workspace_id"`
}

// ManagedTableColumn defines one column in a Lima-managed table connector.
type ManagedTableColumn struct {
	ID          string `json:"id,omitempty"`
	ConnectorID string `json:"connector_id,omitempty"`
	Name        string `json:"name"`
	ColType     string `json:"col_type"` // text | number | boolean | date
	Nullable    bool   `json:"nullable"`
	ColOrder    int    `json:"col_order,omitempty"`
}

// ManagedTableRow is a single data row in a Lima-managed table connector.
type ManagedTableRow struct {
	ID          string         `json:"id"`
	ConnectorID string         `json:"connector_id"`
	Data        map[string]any `json:"data"`
	CreatedBy   string         `json:"created_by"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

// AppVersionManagedSnapshot records the column definitions and row data for a
// managed-table connector at the moment an app version was published, so that
// published apps serve deterministic, immutable data.
type AppVersionManagedSnapshot struct {
	AppVersionID  string           `json:"app_version_id,omitempty"`
	ConnectorName string           `json:"connector_name"`
	Columns       []map[string]any `json:"columns"`
	Rows          []map[string]any `json:"rows"`
	TotalRows     int              `json:"total_rows"`
}

// ---- Approvals (Phase 5) ----------------------------------------------------

// ApprovalStatus mirrors the approval_status DB enum.
type ApprovalStatus string

const (
	ApprovalPending  ApprovalStatus = "pending"
	ApprovalApproved ApprovalStatus = "approved"
	ApprovalRejected ApprovalStatus = "rejected"
)

// Approval is the safe public view of an approval record.
// The encrypted_payload is never included in API responses.
type Approval struct {
	ID              string         `json:"id"`
	WorkspaceID     string         `json:"workspace_id"`
	AppID           *string        `json:"app_id,omitempty"`
	ConnectorID     *string        `json:"connector_id,omitempty"`
	Description     string         `json:"description"`
	Status          ApprovalStatus `json:"status"`
	RequestedBy     string         `json:"requested_by"`
	ReviewedBy      *string        `json:"reviewed_by,omitempty"`
	ReviewedAt      *time.Time     `json:"reviewed_at,omitempty"`
	RejectionReason *string        `json:"rejection_reason,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// ApprovalRecord extends Approval with the raw encrypted payload for internal use.
// The json:"-" tag prevents accidental serialisation.
type ApprovalRecord struct {
	Approval
	EncryptedPayload []byte `json:"-"`
}

// ---- Workflows (Phase 6) ----------------------------------------------------

// WorkflowTrigger mirrors the workflow_trigger DB enum.
type WorkflowTrigger string

const (
	TriggerManual      WorkflowTrigger = "manual"
	TriggerFormSubmit  WorkflowTrigger = "form_submit"
	TriggerButtonClick WorkflowTrigger = "button_click"
	TriggerSchedule    WorkflowTrigger = "schedule"
	TriggerWebhook     WorkflowTrigger = "webhook"
)

// WorkflowStatus mirrors the workflow_status DB enum.
type WorkflowStatus string

const (
	WorkflowStatusDraft    WorkflowStatus = "draft"
	WorkflowStatusActive   WorkflowStatus = "active"
	WorkflowStatusArchived WorkflowStatus = "archived"
)

// WorkflowStepType mirrors the workflow_step_type DB enum.
type WorkflowStepType string

const (
	StepTypeQuery        WorkflowStepType = "query"
	StepTypeMutation     WorkflowStepType = "mutation"
	StepTypeCondition    WorkflowStepType = "condition"
	StepTypeApprovalGate WorkflowStepType = "approval_gate"
	StepTypeNotification WorkflowStepType = "notification"
)

// WorkflowRunStatus mirrors the workflow_run_status DB enum.
type WorkflowRunStatus string

const (
	RunStatusPending          WorkflowRunStatus = "pending"
	RunStatusRunning          WorkflowRunStatus = "running"
	RunStatusAwaitingApproval WorkflowRunStatus = "awaiting_approval"
	RunStatusCompleted        WorkflowRunStatus = "completed"
	RunStatusFailed           WorkflowRunStatus = "failed"
	RunStatusCancelled        WorkflowRunStatus = "cancelled"
)

// Workflow is the top-level workflow definition owned by an app.
type Workflow struct {
	ID               string          `json:"id"`
	WorkspaceID      string          `json:"workspace_id"`
	AppID            string          `json:"app_id"`
	Name             string          `json:"name"`
	Description      *string         `json:"description,omitempty"`
	TriggerType      WorkflowTrigger `json:"trigger_type"`
	TriggerConfig    map[string]any  `json:"trigger_config"`
	Status           WorkflowStatus  `json:"status"`
	RequiresApproval bool            `json:"requires_approval"`
	CreatedBy        string          `json:"created_by"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// WorkflowWithSteps embeds a Workflow together with its ordered steps.
// Returned by GetWorkflow so callers get the full definition in one round-trip.
type WorkflowWithSteps struct {
	Workflow
	Steps []WorkflowStep `json:"steps"`
}

// WorkflowStep is a single ordered action within a workflow.
// ai_generated=true means the step config was written by the AI agent and
// must be reviewed by a builder before the workflow can be activated.
type WorkflowStep struct {
	ID                string           `json:"id"`
	WorkflowID        string           `json:"workflow_id"`
	StepOrder         int              `json:"step_order"`
	NextStepID        *string          `json:"next_step_id,omitempty"`
	FalseBranchStepID *string          `json:"false_branch_step_id,omitempty"`
	Name              string           `json:"name"`
	StepType          WorkflowStepType `json:"step_type"`
	Config            map[string]any   `json:"config"`
	AIGenerated       bool             `json:"ai_generated"`
	ReviewedBy        *string          `json:"reviewed_by,omitempty"`
	ReviewedAt        *time.Time       `json:"reviewed_at,omitempty"`
	CreatedAt         time.Time        `json:"created_at"`
	UpdatedAt         time.Time        `json:"updated_at"`
}

// WorkflowRun records a single execution of a workflow.
type WorkflowRun struct {
	ID           string            `json:"id"`
	WorkflowID   string            `json:"workflow_id"`
	WorkspaceID  string            `json:"workspace_id"`
	Status       WorkflowRunStatus `json:"status"`
	TriggeredBy  *string           `json:"triggered_by,omitempty"`
	InputData    map[string]any    `json:"input_data"`
	OutputData   map[string]any    `json:"output_data,omitempty"`
	ErrorMessage *string           `json:"error_message,omitempty"`
	ApprovalID   *string           `json:"approval_id,omitempty"`
	StartedAt    time.Time         `json:"started_at"`
	CompletedAt  *time.Time        `json:"completed_at,omitempty"`
}

// WorkflowJobPayload is the JSON sent to the workflow Redis queue when a run is triggered.
type WorkflowJobPayload struct {
	RunID       string `json:"run_id"`
	WorkflowID  string `json:"workflow_id"`
	WorkspaceID string `json:"workspace_id"`
}

// WorkflowResumePayload is sent to the workflow queue after an approval
// decision so the worker can continue or fail the paused run.
type WorkflowResumePayload struct {
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Approved   bool   `json:"approved"`
}

// ---- Dashboard queries (Phase 6) --------------------------------------------

// DashboardQueryRequest is the payload for the read-only connector query endpoint.
// Only SELECT-class queries are permitted; mutations are rejected by the handler.
type DashboardQueryRequest struct {
	SQL    string `json:"sql"`
	Params []any  `json:"params,omitempty"`
	Limit  int    `json:"limit,omitempty"` // max rows; capped at 10000
	// AppVersionID is optional. When set, CSV connectors are served from the
	// snapshot recorded at publish time rather than the latest upload.
	AppVersionID string `json:"app_version_id,omitempty"`
}

// DashboardQueryResponse carries the rows returned from a connector query.
type DashboardQueryResponse struct {
	Columns  []string         `json:"columns"`
	Rows     []map[string]any `json:"rows"`
	RowCount int              `json:"row_count"`
}

// ---- Authorization (Migrations 010-011) -------------------------------------

// CompanyRoleBinding maps a subject to a company-level role.
type CompanyRoleBinding struct {
	CompanyID   string    `json:"company_id"`
	SubjectType string    `json:"subject_type"` // "user", "service_principal"
	SubjectID   string    `json:"subject_id"`
	Role        string    `json:"role"` // "company_admin", "resource_admin", "policy_admin", "company_member"
	CreatedAt   time.Time `json:"created_at"`
}

const (
	CompanyGroupSourceManual           = "manual"
	CompanyGroupSourceCompanySynthetic = "company_synthetic"
	CompanyGroupSourceWorkspaceSync    = "workspace_sync"
	CompanyGroupSourceIDP              = "idp"
	CompanyGroupSourceLegacyExternal   = "external"
	CompanyAllEmployeesGroupName       = "All Employees"
	CompanyAllEmployeesGroupSlug       = "system-all-employees"
)

func IsIDPGroupSource(source string) bool {
	return source == CompanyGroupSourceIDP || source == CompanyGroupSourceLegacyExternal
}

func IsReadOnlyCompanyGroupSource(source string) bool {
	return source == CompanyGroupSourceCompanySynthetic || source == CompanyGroupSourceWorkspaceSync || IsIDPGroupSource(source)
}

// CompanyGroup is a named set of users within a company, used for audience targeting and grants.
type CompanyGroup struct {
	ID          string    `json:"id"`
	CompanyID   string    `json:"company_id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	SourceType  string    `json:"source_type"` // "manual", "company_synthetic", "workspace_sync", "idp"
	ExternalRef *string   `json:"external_ref,omitempty"`
	ManagedBy   *string   `json:"managed_by,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// GroupMembership records that a user belongs to a company group.
type GroupMembership struct {
	GroupID  string    `json:"group_id"`
	UserID   string    `json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}

// ResourceGrant gives a subject permission to perform an action on a company-owned resource.
type ResourceGrant struct {
	ID           string    `json:"id"`
	CompanyID    string    `json:"company_id"`
	ResourceKind string    `json:"resource_kind"` // e.g. "connector"
	ResourceID   string    `json:"resource_id"`
	SubjectType  string    `json:"subject_type"` // "user", "group", "workspace", "app", "service_principal"
	SubjectID    string    `json:"subject_id"`
	Action       string    `json:"action"` // "query", "mutate", "manage", "bind", "read_schema"
	ScopeJSON    *string   `json:"scope_json,omitempty"`
	Effect       string    `json:"effect"` // "allow", "deny"
	CreatedBy    *string   `json:"created_by,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// ---- App Publications (Migration 013) ---------------------------------------

// AppPublication represents a published version of an app with audience metadata.
type AppPublication struct {
	ID                string    `json:"id"`
	AppID             string    `json:"app_id"`
	AppVersionID      string    `json:"app_version_id"`
	WorkspaceID       string    `json:"workspace_id"`
	CompanyID         string    `json:"company_id"`
	Status            string    `json:"status"` // "active", "archived"
	PublishedBy       string    `json:"published_by"`
	PolicyProfileID   *string   `json:"policy_profile_id,omitempty"`
	RuntimeIdentityID *string   `json:"runtime_identity_id,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

const (
	PublicationCapabilityDiscover = "discover"
	PublicationCapabilityUse      = "use"
)

// AppPublicationAudience links a publication to a company group with a capability level.
type AppPublicationAudience struct {
	PublicationID string `json:"publication_id"`
	GroupID       string `json:"group_id"`
	Capability    string `json:"capability"` // "discover", "use"
}

// CompanyTool is an enriched publication record with app display metadata for tool discovery.
type CompanyTool struct {
	PublicationID  string    `json:"publication_id"`
	AppID          string    `json:"app_id"`
	AppName        string    `json:"app_name"`
	AppDescription string    `json:"app_description"`
	AppVersionID   string    `json:"app_version_id"`
	WorkspaceID    string    `json:"workspace_id"`
	CompanyID      string    `json:"company_id"`
	Capability     string    `json:"capability"`
	PublishedBy    string    `json:"published_by"`
	PublishedAt    time.Time `json:"published_at"`
}
