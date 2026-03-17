package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/queue"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListThreads returns all conversation threads for an app.
func ListThreads(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "appID")
		threads, err := s.ListThreads(r.Context(), appID)
		if err != nil {
			log.Error("list threads", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list threads")
			return
		}
		if threads == nil {
			threads = []model.ConversationThread{}
		}
		respond(w, http.StatusOK, map[string]any{"threads": threads})
	}
}

// CreateThread starts a new conversation thread for an app.
func CreateThread(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		claims, _ := ClaimsFromContext(r.Context())

		thread, err := s.CreateThread(r.Context(), appID, workspaceID, claims.UserID)
		if err != nil {
			log.Error("create thread", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create thread")
			return
		}
		respond(w, http.StatusCreated, thread)
	}
}

// GetThread returns a single thread with its messages.
func GetThread(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "appID")
		threadID := chi.URLParam(r, "threadID")

		thread, err := s.GetThread(r.Context(), appID, threadID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, thread)
	}
}

// ListMessages returns all messages in a thread ordered oldest-first.
func ListMessages(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		threadID := chi.URLParam(r, "threadID")
		msgs, err := s.ListMessages(r.Context(), threadID)
		if err != nil {
			log.Error("list messages", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list messages")
			return
		}
		if msgs == nil {
			msgs = []model.ThreadMessage{}
		}
		respond(w, http.StatusOK, map[string]any{"messages": msgs})
	}
}

// PostMessage stores a user message and enqueues an AI generation job.
// The response returns the stored user message immediately; the assistant
// reply is delivered asynchronously via the generation worker.
func PostMessage(s *store.Store, enq *queue.Enqueuer, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")
		threadID := chi.URLParam(r, "threadID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			Content        string `json:"content"`
			ForceOverwrite bool   `json:"force_overwrite,omitempty"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Content == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "content is required")
			return
		}

		// Verify the thread belongs to this app before adding a message.
		if _, err := s.GetThread(r.Context(), appID, threadID); err != nil {
			handleStoreErr(w, err)
			return
		}

		// Store the user message immediately.
		msg, err := s.AddMessage(r.Context(), threadID, model.RoleUser, req.Content, nil)
		if err != nil {
			log.Error("add message", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to store message")
			return
		}

		// Enqueue the generation job. Failure to enqueue is non-fatal for the
		// stored message but is surfaced to the caller so the UI can retry.
		payload := model.GenerationJobPayload{
			ThreadID:       threadID,
			MessageID:      msg.ID,
			AppID:          appID,
			WorkspaceID:    workspaceID,
			UserID:         claims.UserID,
			ForceOverwrite: req.ForceOverwrite,
		}
		if enq != nil {
			if err := enq.EnqueueGeneration(r.Context(), payload); err != nil {
				log.Error("enqueue generation job", zap.Error(err))
				// Return the user message but flag that generation is unavailable.
				respond(w, http.StatusAccepted, map[string]any{
					"message":     msg,
					"queued":      false,
					"queue_error": "generation worker unavailable",
				})
				return
			}
		}

		respond(w, http.StatusAccepted, map[string]any{
			"message": msg,
			"queued":  true,
		})
	}
}
