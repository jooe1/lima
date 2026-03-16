package queue

// GenerationPayload is the JSON envelope popped from the generation queue.
// It mirrors model.GenerationJobPayload in the API service.
type GenerationPayload struct {
	ThreadID    string `json:"thread_id"`
	MessageID   string `json:"message_id"`
	AppID       string `json:"app_id"`
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id"`
}

// SchemaPayload is the JSON envelope popped from the schema queue.
// It mirrors model.SchemaJobPayload in the API service.
type SchemaPayload struct {
	ConnectorID string `json:"connector_id"`
	WorkspaceID string `json:"workspace_id"`
}

// WorkflowPayload is the JSON envelope for a new workflow run execution job.
// It mirrors model.WorkflowJobPayload in the API service.
type WorkflowPayload struct {
	RunID       string `json:"run_id"`
	WorkflowID  string `json:"workflow_id"`
	WorkspaceID string `json:"workspace_id"`
}

// WorkflowResumePayload is sent when an admin approves or rejects an approval
// gate, allowing the worker to continue or fail the paused run.
// It mirrors model.WorkflowResumePayload in the API service.
type WorkflowResumePayload struct {
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Approved   bool   `json:"approved"`
}
