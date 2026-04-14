package handler

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// appEventStore is the minimal store interface required by AppEvents.
// *store.Store satisfies this interface.
type appEventStore interface {
	GetApp(ctx context.Context, workspaceID, appID string) (*model.App, error)
}

// AppEvents serves a Server-Sent Events stream for a single app's workflow run events.
// The client receives "workflow_run_update" events as the worker publishes step/run events.
// Required auth: applied by the outer router middleware (Authenticate + RequireWorkspaceRole).
func AppEvents(s appEventStore, rdb *goredis.Client, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		appID := chi.URLParam(r, "appID")

		// Verify the app belongs to this workspace.
		if _, err := s.GetApp(r.Context(), workspaceID, appID); err != nil {
			handleStoreErr(w, err)
			return
		}

		// Set SSE headers.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		flusher, canFlush := w.(http.Flusher)

		// Subscribe to the app's event channel.
		pubsub := rdb.Subscribe(r.Context(), "app:"+appID+":events")
		defer pubsub.Close()

		msgCh := pubsub.Channel()

		for {
			select {
			case msg, open := <-msgCh:
				if !open {
					return
				}
				fmt.Fprintf(w, "event: workflow_run_update\ndata: %s\n\n", msg.Payload)
				if canFlush {
					flusher.Flush()
				}
			case <-r.Context().Done():
				return
			}
		}
	}
}
