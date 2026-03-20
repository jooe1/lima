// Package handler contains HTTP handlers for the Lima API service.
// Core helpers (respond, decodeJSON, handleStoreErr) live here.
// Each entity group has its own file: auth.go, tenancy.go, apps.go, rbac.go.
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/api/internal/store"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// respond writes a JSON body with the given status code.
func respond(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// respondErr writes a structured error response.
func respondErr(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]string{"error": code, "message": message})
}

// decodeJSON decodes the request body into dst.
func decodeJSON(r *http.Request, dst any) error {
	return json.NewDecoder(r.Body).Decode(dst)
}

// handleStoreErr maps store sentinel errors to HTTP status codes.
func handleStoreErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		respondErr(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		respondErr(w, http.StatusConflict, "conflict", "resource already exists")
		return
	}
	respondErr(w, http.StatusInternalServerError, "internal_error", err.Error())
}

// ---- Health ----------------------------------------------------------------

// Healthz pings the database and reports service health.
func Healthz(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			respondErr(w, http.StatusServiceUnavailable, "db_unavailable", err.Error())
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// Livez reports whether the API process is up enough to serve requests.
func Livez() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// Metrics exposes the process Prometheus metrics for local scraping.
func Metrics() http.Handler {
	return promhttp.Handler()
}

// Approvals are implemented in approvals.go.
