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

type MemberDetail struct {
	UserID      string        `json:"user_id"`
	WorkspaceID string        `json:"workspace_id"`
	Email       string        `json:"email"`
	Name        string        `json:"name"`
	Role        WorkspaceRole `json:"role"`
	JoinedAt    time.Time     `json:"joined_at"`
}

// ---- Apps -------------------------------------------------------------------

// AppStatus mirrors the app_status DB enum.
type AppStatus string

const (
	StatusDraft     AppStatus = "draft"
	StatusPublished AppStatus = "published"
	StatusArchived  AppStatus = "archived"
)

type App struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspace_id"`
	Name        string    `json:"name"`
	Description *string   `json:"description,omitempty"`
	Status      AppStatus `json:"status"`
	DSLSource   string    `json:"dsl_source"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type AppVersion struct {
	ID          string    `json:"id"`
	AppID       string    `json:"app_id"`
	VersionNum  int       `json:"version_num"`
	DSLSource   string    `json:"dsl_source"`
	PublishedBy string    `json:"published_by"`
	PublishedAt time.Time `json:"published_at"`
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
}
