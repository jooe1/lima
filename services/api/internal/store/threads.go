package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

// CreateThread inserts a new conversation thread for the given app.
func (s *Store) CreateThread(ctx context.Context, appID, workspaceID, userID string) (*model.ConversationThread, error) {
	t := &model.ConversationThread{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO conversation_threads (app_id, workspace_id, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id, app_id, workspace_id, created_by, created_at, updated_at`,
		appID, workspaceID, userID,
	).Scan(&t.ID, &t.AppID, &t.WorkspaceID, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create thread: %w", err)
	}
	return t, nil
}

// ListThreads returns all threads for an app, ordered by creation time descending.
func (s *Store) ListThreads(ctx context.Context, appID string) ([]model.ConversationThread, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, app_id, workspace_id, created_by, created_at, updated_at
		 FROM conversation_threads WHERE app_id = $1 ORDER BY created_at DESC`,
		appID,
	)
	if err != nil {
		return nil, fmt.Errorf("list threads: %w", err)
	}
	defer rows.Close()
	var threads []model.ConversationThread
	for rows.Next() {
		var t model.ConversationThread
		if err := rows.Scan(&t.ID, &t.AppID, &t.WorkspaceID, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list threads scan: %w", err)
		}
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// GetThread fetches a single thread by ID, scoped to an app.
func (s *Store) GetThread(ctx context.Context, appID, threadID string) (*model.ConversationThread, error) {
	t := &model.ConversationThread{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, app_id, workspace_id, created_by, created_at, updated_at
		 FROM conversation_threads WHERE id = $1 AND app_id = $2`,
		threadID, appID,
	).Scan(&t.ID, &t.AppID, &t.WorkspaceID, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get thread: %w", err)
	}
	return t, nil
}

// AddMessage appends a message to a thread. dslPatch may be nil for user messages.
func (s *Store) AddMessage(ctx context.Context, threadID string, role model.MessageRole, content string, dslPatch *model.DSLPatch) (*model.ThreadMessage, error) {
	var patchJSON []byte
	var err error
	if dslPatch != nil {
		patchJSON, err = json.Marshal(dslPatch)
		if err != nil {
			return nil, fmt.Errorf("marshal dsl patch: %w", err)
		}
	}

	msg := &model.ThreadMessage{}
	var rawPatch []byte
	err = s.pool.QueryRow(ctx,
		`INSERT INTO thread_messages (thread_id, role, content, dsl_patch)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, thread_id, role, content, dsl_patch, created_at`,
		threadID, string(role), content, patchJSON,
	).Scan(&msg.ID, &msg.ThreadID, &msg.Role, &msg.Content, &rawPatch, &msg.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("add message: %w", err)
	}

	if rawPatch != nil {
		var patch model.DSLPatch
		if err := json.Unmarshal(rawPatch, &patch); err == nil {
			msg.DSLPatch = &patch
		}
	}

	// Touch the thread's updated_at.
	_, _ = s.pool.Exec(ctx,
		`UPDATE conversation_threads SET updated_at = now() WHERE id = $1`,
		threadID,
	)

	return msg, nil
}

// ListMessages returns all messages in a thread ordered by creation time ascending.
func (s *Store) ListMessages(ctx context.Context, threadID string) ([]model.ThreadMessage, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, thread_id, role, content, dsl_patch, created_at
		 FROM thread_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
		threadID,
	)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	var msgs []model.ThreadMessage
	for rows.Next() {
		var msg model.ThreadMessage
		var rawPatch []byte
		if err := rows.Scan(&msg.ID, &msg.ThreadID, &msg.Role, &msg.Content, &rawPatch, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("list messages scan: %w", err)
		}
		if rawPatch != nil {
			var patch model.DSLPatch
			if err := json.Unmarshal(rawPatch, &patch); err == nil {
				msg.DSLPatch = &patch
			}
		}
		msgs = append(msgs, msg)
	}
	return msgs, rows.Err()
}
