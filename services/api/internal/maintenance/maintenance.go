package maintenance

import (
	"context"
	"fmt"

	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
)

type Store interface {
	ListConnectorRecordsForMaintenance(ctx context.Context) ([]model.ConnectorRecord, error)
	ReplaceConnectorEncryptedCredentials(ctx context.Context, workspaceID, connectorID string, currentEncCreds, nextEncCreds []byte) (bool, error)
	PruneExpiredAuditEvents(ctx context.Context) (int64, error)
}

type Service struct {
	store               Store
	currentSecret       string
	previousSecret      string
	encrypt             func(string, []byte) ([]byte, error)
	decrypt             func(string, []byte) ([]byte, error)
	decryptWithRotation func(string, string, []byte) ([]byte, error)
}

type ReencryptConnectorSecretsOptions struct {
	DryRun bool
}

type ConnectorReencryptFailure struct {
	WorkspaceID string
	ConnectorID string
	Message     string
}

type ReencryptConnectorSecretsResult struct {
	Processed      int
	AlreadyCurrent int
	NeedsRotation  int
	Rotated        int
	Failed         int
	Failures       []ConnectorReencryptFailure
}

type PruneExpiredAuditEventsResult struct {
	Deleted int64
}

func NewService(store Store, currentSecret, previousSecret string) *Service {
	return &Service{
		store:               store,
		currentSecret:       currentSecret,
		previousSecret:      previousSecret,
		encrypt:             cryptoutil.Encrypt,
		decrypt:             cryptoutil.Decrypt,
		decryptWithRotation: cryptoutil.DecryptWithRotation,
	}
}

func (s *Service) ReencryptConnectorSecrets(ctx context.Context, opts ReencryptConnectorSecretsOptions) (ReencryptConnectorSecretsResult, error) {
	var result ReencryptConnectorSecretsResult
	if s.currentSecret == "" {
		return result, fmt.Errorf("credentials encryption key is not configured")
	}

	records, err := s.store.ListConnectorRecordsForMaintenance(ctx)
	if err != nil {
		return result, fmt.Errorf("list connectors for maintenance: %w", err)
	}

	for _, rec := range records {
		result.Processed++

		if _, err := s.decrypt(s.currentSecret, rec.EncryptedCredentials); err == nil {
			result.AlreadyCurrent++
			continue
		}

		plaintext, err := s.decryptWithRotation(s.currentSecret, s.previousSecret, rec.EncryptedCredentials)
		if err != nil {
			result.recordFailure(rec.WorkspaceID, rec.ID, fmt.Errorf("decrypt connector credentials: %w", err))
			continue
		}

		result.NeedsRotation++
		if opts.DryRun {
			continue
		}

		nextCiphertext, err := s.encrypt(s.currentSecret, plaintext)
		if err != nil {
			result.recordFailure(rec.WorkspaceID, rec.ID, fmt.Errorf("encrypt connector credentials: %w", err))
			continue
		}

		updated, err := s.store.ReplaceConnectorEncryptedCredentials(ctx, rec.WorkspaceID, rec.ID, rec.EncryptedCredentials, nextCiphertext)
		if err != nil {
			result.recordFailure(rec.WorkspaceID, rec.ID, fmt.Errorf("update connector credentials: %w", err))
			continue
		}
		if !updated {
			result.recordFailure(rec.WorkspaceID, rec.ID, fmt.Errorf("connector credentials changed since scan"))
			continue
		}

		result.Rotated++
	}

	if result.Failed > 0 {
		return result, fmt.Errorf("connector secret re-encryption completed with %d failure(s)", result.Failed)
	}

	return result, nil
}

func (s *Service) PruneExpiredAuditEvents(ctx context.Context) (PruneExpiredAuditEventsResult, error) {
	deleted, err := s.store.PruneExpiredAuditEvents(ctx)
	if err != nil {
		return PruneExpiredAuditEventsResult{}, fmt.Errorf("prune expired audit events: %w", err)
	}
	return PruneExpiredAuditEventsResult{Deleted: deleted}, nil
}

func (r *ReencryptConnectorSecretsResult) recordFailure(workspaceID, connectorID string, err error) {
	r.Failed++
	r.Failures = append(r.Failures, ConnectorReencryptFailure{
		WorkspaceID: workspaceID,
		ConnectorID: connectorID,
		Message:     err.Error(),
	})
}
