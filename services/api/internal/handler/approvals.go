package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListApprovals returns approval requests for a workspace.
// Accepts an optional ?status=pending|approved|rejected query parameter.
func ListApprovals(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")

		var statusFilter *model.ApprovalStatus
		if sv := r.URL.Query().Get("status"); sv != "" {
			st := model.ApprovalStatus(sv)
			statusFilter = &st
		}

		approvals, err := s.ListApprovals(r.Context(), workspaceID, statusFilter)
		if err != nil {
			log.Error("list approvals", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list approvals")
			return
		}
		if approvals == nil {
			approvals = []model.Approval{}
		}
		respond(w, http.StatusOK, map[string]any{"approvals": approvals})
	}
}

// CreateApproval records a new pending approval request for a write operation.
// The plaintext payload is encrypted at rest using the credentials encryption key.
func CreateApproval(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			AppID       *string        `json:"app_id"`
			ConnectorID *string        `json:"connector_id"`
			Description string         `json:"description"`
			Payload     map[string]any `json:"payload"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Description == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "description is required")
			return
		}

		// Encode and encrypt the mutation payload.
		payloadBytes, err := json.Marshal(req.Payload)
		if err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid payload")
			return
		}
		encrypted, err := cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, payloadBytes)
		if err != nil {
			log.Error("encrypt approval payload", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "internal_error", "failed to encrypt payload")
			return
		}

		approval, err := s.CreateApproval(r.Context(), workspaceID, req.AppID, req.ConnectorID, req.Description, encrypted, claims.UserID)
		if err != nil {
			log.Error("create approval", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create approval")
			return
		}

		auditApprovalEvent(r.Context(), s, log, claims, workspaceID, "approval.requested", &approval.ID)
		respond(w, http.StatusCreated, approval)
	}
}

// ApproveAction marks a pending approval as approved.
// Requires workspace_admin role (enforced via RBAC middleware).
func ApproveAction(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		approvalID := chi.URLParam(r, "approvalID")
		claims, _ := ClaimsFromContext(r.Context())

		approval, err := s.UpdateApprovalStatus(r.Context(), workspaceID, approvalID, model.ApprovalApproved, claims.UserID, nil)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		auditApprovalEvent(r.Context(), s, log, claims, workspaceID, "approval.approved", &approval.ID)
		respond(w, http.StatusOK, approval)
	}
}

// RejectAction marks a pending approval as rejected with an optional reason.
// Requires workspace_admin role (enforced via RBAC middleware).
func RejectAction(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		approvalID := chi.URLParam(r, "approvalID")
		claims, _ := ClaimsFromContext(r.Context())

		var req struct {
			RejectionReason *string `json:"rejection_reason"`
		}
		// Decode is best-effort; reason is optional.
		_ = decodeJSON(r, &req)

		approval, err := s.UpdateApprovalStatus(r.Context(), workspaceID, approvalID, model.ApprovalRejected, claims.UserID, req.RejectionReason)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		auditApprovalEvent(r.Context(), s, log, claims, workspaceID, "approval.rejected", &approval.ID)
		respond(w, http.StatusOK, approval)
	}
}

func auditApprovalEvent(ctx context.Context, s *store.Store, log *zap.Logger, claims *Claims, workspaceID, eventType string, resourceID *string) {
	r := "approval"
	event := &model.AuditEvent{
		WorkspaceID:  workspaceID,
		EventType:    eventType,
		ResourceType: &r,
		ResourceID:   resourceID,
	}
	if claims != nil {
		event.ActorID = &claims.UserID
	}
	if err := s.WriteAuditEvent(ctx, event); err != nil {
		log.Warn("audit write failed", zap.String("event", eventType), zap.Error(err))
	}
}
