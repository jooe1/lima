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
