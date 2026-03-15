package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

type aiSettingsProviderConfig struct {
	OpenAIBaseURL *string `json:"openai_base_url,omitempty"`
}

func maskSecretID(provider model.AIProvider, encrypted []byte) string {
	if len(encrypted) == 0 {
		return ""
	}
	prefix := "secret"
	if provider == model.AIProviderGitHubCopilot {
		prefix = "github"
	}
	if len(encrypted) < 4 {
		return prefix + "-stored"
	}
	return fmt.Sprintf("%s-%x", prefix, encrypted[len(encrypted)-4:])
}

func (s *Store) GetUserAISettings(ctx context.Context, userID string) (*model.UserAISettingsRecord, error) {
	record := &model.UserAISettingsRecord{}
	var providerConfigRaw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT user_id, provider, model, provider_config, encrypted_credentials
		 FROM user_ai_settings WHERE user_id = $1`,
		userID,
	).Scan(&record.UserID, &record.Provider, &record.Model, &providerConfigRaw, &record.EncryptedCredentials)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get user ai settings: %w", err)
	}
	var providerConfig aiSettingsProviderConfig
	if len(providerConfigRaw) > 0 {
		if err := json.Unmarshal(providerConfigRaw, &providerConfig); err != nil {
			return nil, fmt.Errorf("unmarshal user ai provider config: %w", err)
		}
	}
	record.Configured = true
	record.HasSecret = len(record.EncryptedCredentials) > 0
	record.OpenAIBaseURL = providerConfig.OpenAIBaseURL
	record.MaskedSecretID = maskSecretID(record.Provider, record.EncryptedCredentials)
	return record, nil
}

func (s *Store) UpsertUserAISettings(ctx context.Context, userID string, provider model.AIProvider, modelID string, openAIBaseURL *string, encryptedCredentials []byte, replaceSecret bool) (*model.UserAISettingsRecord, error) {
	providerConfigRaw, err := json.Marshal(aiSettingsProviderConfig{OpenAIBaseURL: openAIBaseURL})
	if err != nil {
		return nil, fmt.Errorf("marshal user ai provider config: %w", err)
	}

	record := &model.UserAISettingsRecord{}
	var returnedProviderConfigRaw []byte
	err = s.pool.QueryRow(ctx,
		`INSERT INTO user_ai_settings (user_id, provider, model, provider_config, encrypted_credentials)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id) DO UPDATE SET
		   provider = EXCLUDED.provider,
		   model = EXCLUDED.model,
		   provider_config = EXCLUDED.provider_config,
		   encrypted_credentials = CASE WHEN $6 THEN EXCLUDED.encrypted_credentials ELSE user_ai_settings.encrypted_credentials END,
		   updated_at = now()
		 RETURNING user_id, provider, model, provider_config, encrypted_credentials`,
		userID, provider, modelID, providerConfigRaw, encryptedCredentials, replaceSecret,
	).Scan(&record.UserID, &record.Provider, &record.Model, &returnedProviderConfigRaw, &record.EncryptedCredentials)
	if err != nil {
		return nil, fmt.Errorf("upsert user ai settings: %w", err)
	}
	var providerConfig aiSettingsProviderConfig
	if len(returnedProviderConfigRaw) > 0 {
		if err := json.Unmarshal(returnedProviderConfigRaw, &providerConfig); err != nil {
			return nil, fmt.Errorf("unmarshal stored user ai provider config: %w", err)
		}
	}
	record.Configured = true
	record.HasSecret = len(record.EncryptedCredentials) > 0
	record.OpenAIBaseURL = providerConfig.OpenAIBaseURL
	record.MaskedSecretID = maskSecretID(record.Provider, record.EncryptedCredentials)
	return record, nil
}
