// Package handler contains HTTP handlers for the Lima API service.
// Core helpers (respond, decodeJSON, handleStoreErr, stub) live here.
// Each entity group has its own file: auth.go, tenancy.go, apps.go, rbac.go.
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
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

// stub returns a placeholder handler for endpoints not yet implemented.
func stub(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respondErr(w, http.StatusNotImplemented, "not_implemented", name+" is not yet implemented")
	}
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

// ---- Connectors (Phase 4 stubs) --------------------------------------------

func ListConnectors(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("ListConnectors") }
func CreateConnector(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return stub("CreateConnector")
}
func GetConnector(s *store.Store, log *zap.Logger) http.HandlerFunc   { return stub("GetConnector") }
func PatchConnector(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("PatchConnector") }
func DeleteConnector(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return stub("DeleteConnector")
}
func TestConnector(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("TestConnector") }
func GetConnectorSchema(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return stub("GetConnectorSchema")
}

// ---- Threads (Phase 3 stubs) -----------------------------------------------

func ListThreads(s *store.Store, log *zap.Logger) http.HandlerFunc  { return stub("ListThreads") }
func CreateThread(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("CreateThread") }
func GetThread(s *store.Store, log *zap.Logger) http.HandlerFunc    { return stub("GetThread") }
func PostMessage(s *store.Store, log *zap.Logger) http.HandlerFunc  { return stub("PostMessage") }

// ---- Approvals (Phase 5 stubs) ---------------------------------------------

func ListApprovals(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("ListApprovals") }
func ApproveAction(s *store.Store, log *zap.Logger) http.HandlerFunc { return stub("ApproveAction") }
func RejectAction(s *store.Store, log *zap.Logger) http.HandlerFunc  { return stub("RejectAction") }
