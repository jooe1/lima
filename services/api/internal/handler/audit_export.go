package handler

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ExportAuditEventsCSV streams workspace audit events as CSV.
//
// Query parameters:
//   - since  RFC3339 timestamp, required
//   - until  RFC3339 timestamp, optional (default: now)
//   - cursor RFC3339 timestamp, optional — keyset cursor for pagination
//   - limit  int, optional (default 1000, max 5000 per page)
//
// The response is a CSV file with one row per audit event. Use the
// X-Next-Cursor response header to fetch the next page; when the header
// is absent the export is complete.
func ExportAuditEventsCSV(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")

		sinceStr := r.URL.Query().Get("since")
		if sinceStr == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "'since' query parameter is required (RFC3339)")
			return
		}
		since, err := time.Parse(time.RFC3339, sinceStr)
		if err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid 'since': must be RFC3339")
			return
		}

		var until time.Time
		if untilStr := r.URL.Query().Get("until"); untilStr != "" {
			until, err = time.Parse(time.RFC3339, untilStr)
			if err != nil {
				respondErr(w, http.StatusBadRequest, "bad_request", "invalid 'until': must be RFC3339")
				return
			}
		}

		var cursor time.Time
		if cursorStr := r.URL.Query().Get("cursor"); cursorStr != "" {
			cursor, err = time.Parse(time.RFC3339Nano, cursorStr)
			if err != nil {
				respondErr(w, http.StatusBadRequest, "bad_request", "invalid 'cursor': must be RFC3339Nano")
				return
			}
		}

		limit := 1000
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if n, parseErr := strconv.Atoi(limitStr); parseErr == nil && n > 0 {
				limit = n
			}
		}

		filter := store.AuditExportFilter{
			Since:  since,
			Until:  until,
			Cursor: cursor,
			Limit:  limit,
		}

		events, err := s.ExportAuditEvents(r.Context(), workspaceID, filter)
		if err != nil {
			log.Error("export audit events", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to export audit events")
			return
		}

		// Set pagination cursor for the next page.
		if len(events) == limit {
			// There may be more — provide a cursor pointing just past the last row.
			last := events[len(events)-1]
			w.Header().Set("X-Next-Cursor", last.CreatedAt.UTC().Format(time.RFC3339Nano))
		}

		filename := fmt.Sprintf("audit-%s-%s.csv", workspaceID, since.UTC().Format("20060102"))
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
		w.WriteHeader(http.StatusOK)

		cw := csv.NewWriter(w)
		_ = cw.Write([]string{
			"id", "workspace_id", "actor_id", "event_type",
			"resource_type", "resource_id", "created_at",
		})
		for _, e := range events {
			actorID := ""
			if e.ActorID != nil {
				actorID = *e.ActorID
			}
			resourceType := ""
			if e.ResourceType != nil {
				resourceType = *e.ResourceType
			}
			resourceID := ""
			if e.ResourceID != nil {
				resourceID = *e.ResourceID
			}
			_ = cw.Write([]string{
				e.ID,
				e.WorkspaceID,
				actorID,
				e.EventType,
				resourceType,
				resourceID,
				e.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
		cw.Flush()
	}
}
