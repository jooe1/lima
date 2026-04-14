package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// appEventsStoreStub implements appEventStore for testing.
type appEventsStoreStub struct {
	app    *model.App
	getErr error
}

func (s *appEventsStoreStub) GetApp(_ context.Context, _, _ string) (*model.App, error) {
	return s.app, s.getErr
}

// newTestRedisClient returns a *goredis.Client pointed at a non-existent server.
// With MaxRetries=0 and a pre-cancelled context, Subscribe returns immediately.
func newTestRedisClient() *goredis.Client {
	return goredis.NewClient(&goredis.Options{
		Addr:       "localhost:0",
		MaxRetries: 0,
	})
}

// withChiParams attaches chi URL parameters to r's context.
func withChiParams(r *http.Request, params map[string]string) *http.Request {
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// TestAppEvents_NotFoundReturns404 verifies that when GetApp returns ErrNotFound,
// the handler responds with 404 and does not set SSE headers.
func TestAppEvents_NotFoundReturns404(t *testing.T) {
	stub := &appEventsStoreStub{getErr: store.ErrNotFound}
	rdb := newTestRedisClient()
	defer rdb.Close()

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = withChiParams(r, map[string]string{"workspaceID": "ws-1", "appID": "app-1"})

	w := httptest.NewRecorder()
	AppEvents(stub, rdb, zap.NewNop())(w, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct == "text/event-stream" {
		t.Errorf("Content-Type should not be text/event-stream on 404, got %q", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "not_found") {
		t.Errorf("body = %q, want it to contain %q", body, "not_found")
	}
}

// TestAppEvents_SSEHeadersSetOnSuccess verifies that when GetApp succeeds,
// the handler sets SSE headers before waiting for events. The context is
// cancelled immediately so the handler exits after header-setting.
func TestAppEvents_SSEHeadersSetOnSuccess(t *testing.T) {
	stub := &appEventsStoreStub{app: &model.App{ID: "app-1"}}
	rdb := newTestRedisClient()
	defer rdb.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before calling handler so the event loop exits immediately

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	// Attach chi params using the pre-cancelled context so the entire request context is cancelled.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("workspaceID", "ws-1")
	rctx.URLParams.Add("appID", "app-1")
	r = r.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rctx))

	w := httptest.NewRecorder()
	AppEvents(stub, rdb, zap.NewNop())(w, r)

	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want %q", ct, "text/event-stream")
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want %q", cc, "no-cache")
	}
	if xa := w.Header().Get("X-Accel-Buffering"); xa != "no" {
		t.Errorf("X-Accel-Buffering = %q, want %q", xa, "no")
	}
	if conn := w.Header().Get("Connection"); conn != "keep-alive" {
		t.Errorf("Connection = %q, want %q", conn, "keep-alive")
	}
}
