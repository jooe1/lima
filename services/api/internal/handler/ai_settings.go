package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

type aiCredentials struct {
	APIKey      string `json:"api_key,omitempty"`
	GitHubToken string `json:"github_token,omitempty"`
}

func trimPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func GetMyAISettings(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
			return
		}
		settings, err := s.GetUserAISettings(r.Context(), claims.UserID)
		if err == store.ErrNotFound {
			respond(w, http.StatusOK, model.UserAISettings{Configured: false, HasSecret: false})
			return
		}
		if err != nil {
			log.Error("get ai settings", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to load ai settings")
			return
		}
		respond(w, http.StatusOK, settings.UserAISettings)
	}
}

func PutMyAISettings(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
			return
		}

		var req struct {
			Provider          model.AIProvider `json:"provider"`
			Model             string           `json:"model"`
			OpenAIBaseURL     *string          `json:"openai_base_url"`
			APIKey            *string          `json:"api_key"`
			GitHubToken       *string          `json:"github_token"`
			ClearStoredSecret bool             `json:"clear_stored_secret"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		modelID := strings.TrimSpace(req.Model)
		if modelID == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "model is required")
			return
		}

		existing, err := s.GetUserAISettings(r.Context(), claims.UserID)
		if err != nil && err != store.ErrNotFound {
			log.Error("get existing ai settings", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to load current ai settings")
			return
		}

		var encryptedCredentials []byte
		replaceSecret := false
		var openAIBaseURL *string

		switch req.Provider {
		case model.AIProviderOpenAI:
			openAIBaseURL = trimPointer(req.OpenAIBaseURL)
			if openAIBaseURL == nil || *openAIBaseURL == "" {
				defaultBaseURL := "https://api.openai.com/v1"
				openAIBaseURL = &defaultBaseURL
			}
			apiKey := trimPointer(req.APIKey)
			if req.ClearStoredSecret {
				replaceSecret = true
			} else if apiKey != nil && *apiKey != "" {
				payload, err := json.Marshal(aiCredentials{APIKey: *apiKey})
				if err != nil {
					respondErr(w, http.StatusInternalServerError, "internal_error", "failed to serialise credentials")
					return
				}
				encryptedCredentials, err = cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, payload)
				if err != nil {
					respondErr(w, http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
				replaceSecret = true
			}
		case model.AIProviderGitHubCopilot:
			gitHubToken := trimPointer(req.GitHubToken)
			if req.ClearStoredSecret {
				replaceSecret = true
			} else if gitHubToken != nil && *gitHubToken != "" {
				payload, err := json.Marshal(aiCredentials{GitHubToken: *gitHubToken})
				if err != nil {
					respondErr(w, http.StatusInternalServerError, "internal_error", "failed to serialise credentials")
					return
				}
				encryptedCredentials, err = cryptoutil.Encrypt(cfg.CredentialsEncryptionKey, payload)
				if err != nil {
					respondErr(w, http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
				replaceSecret = true
			} else if existing == nil || existing.Provider != model.AIProviderGitHubCopilot || !existing.HasSecret {
				respondErr(w, http.StatusBadRequest, "bad_request", "github_token is required for GitHub Copilot")
				return
			}
		default:
			respondErr(w, http.StatusBadRequest, "bad_request", "provider must be one of: openai, github_copilot")
			return
		}

		settings, err := s.UpsertUserAISettings(r.Context(), claims.UserID, req.Provider, modelID, openAIBaseURL, encryptedCredentials, replaceSecret)
		if err != nil {
			log.Error("save ai settings", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to save ai settings")
			return
		}

		respond(w, http.StatusOK, settings.UserAISettings)
	}
}
