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
