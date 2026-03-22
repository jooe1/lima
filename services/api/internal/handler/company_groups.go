package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// ListGroups returns all groups for a company.
func ListGroups(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		groups, err := s.ListCompanyGroups(r.Context(), companyID)
		if err != nil {
			log.Error("list company groups", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list groups")
			return
		}
		if groups == nil {
			groups = []model.CompanyGroup{}
		}
		respond(w, http.StatusOK, map[string]any{"groups": groups})
	}
}

// createGroupBody is the request payload for group creation.
type createGroupBody struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// CreateGroup creates a new manual company group.
func CreateGroup(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")

		if !isCompanyAdmin(s, w, r, companyID) {
			return
		}

		var body createGroupBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.Name == "" || body.Slug == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "name and slug are required")
			return
		}

		group, err := s.CreateCompanyGroup(r.Context(), companyID, body.Name, body.Slug, "manual", nil, nil)
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				respondErr(w, http.StatusConflict, "conflict", "a group with that slug already exists")
				return
			}
			log.Error("create company group", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create group")
			return
		}
		respond(w, http.StatusCreated, map[string]any{"group": group})
	}
}

// DeleteGroup deletes a manual company group.
// Synthetic and IdP-managed groups are protected from manual deletion.
func DeleteGroup(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		groupID := chi.URLParam(r, "groupID")

		if !isCompanyAdmin(s, w, r, companyID) {
			return
		}

		group, err := s.GetCompanyGroup(r.Context(), companyID, groupID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}

		if model.IsReadOnlyCompanyGroupSource(group.SourceType) {
			respondErr(w, http.StatusForbidden, "forbidden", "synthetic groups cannot be deleted manually")
			return
		}

		if err := s.DeleteCompanyGroup(r.Context(), companyID, groupID); err != nil {
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ListGroupMembers returns all members of a company group.
func ListGroupMembers(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID := chi.URLParam(r, "groupID")
		members, err := s.ListGroupMembers(r.Context(), groupID)
		if err != nil {
			log.Error("list group members", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list members")
			return
		}
		if members == nil {
			members = []model.GroupMembership{}
		}
		respond(w, http.StatusOK, map[string]any{"members": members})
	}
}

// addGroupMemberBody is the request payload for adding a group member.
type addGroupMemberBody struct {
	UserID string `json:"user_id"`
}

// AddGroupMember adds a user to a company group.
func AddGroupMember(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		groupID := chi.URLParam(r, "groupID")

		if !isCompanyAdmin(s, w, r, companyID) {
			return
		}

		var body addGroupMemberBody
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.UserID == "" {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "user_id is required")
			return
		}

		group, err := s.GetCompanyGroup(r.Context(), companyID, groupID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if model.IsReadOnlyCompanyGroupSource(group.SourceType) {
			respondErr(w, http.StatusForbidden, "forbidden", "synthetic groups cannot be edited manually")
			return
		}

		if err := s.AddGroupMember(r.Context(), groupID, body.UserID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if err := s.ReconcileProvisionedUserAccess(r.Context(), companyID, body.UserID); err != nil {
			log.Error("reconcile provisioned user access after group add", zap.Error(err), zap.String("company_id", companyID), zap.String("user_id", body.UserID))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to reconcile workspace access")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// RemoveGroupMember removes a user from a company group.
func RemoveGroupMember(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		companyID := chi.URLParam(r, "companyID")
		groupID := chi.URLParam(r, "groupID")
		userID := chi.URLParam(r, "userID")

		if !isCompanyAdmin(s, w, r, companyID) {
			return
		}

		group, err := s.GetCompanyGroup(r.Context(), companyID, groupID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if model.IsReadOnlyCompanyGroupSource(group.SourceType) {
			respondErr(w, http.StatusForbidden, "forbidden", "synthetic groups cannot be edited manually")
			return
		}

		if err := s.RemoveGroupMember(r.Context(), groupID, userID); err != nil {
			handleStoreErr(w, err)
			return
		}
		if err := s.ReconcileProvisionedUserAccess(r.Context(), companyID, userID); err != nil {
			log.Error("reconcile provisioned user access after group remove", zap.Error(err), zap.String("company_id", companyID), zap.String("user_id", userID))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to reconcile workspace access")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
