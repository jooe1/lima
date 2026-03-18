package maintenance

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lima/api/internal/cryptoutil"
	"github.com/lima/api/internal/model"
)

type replaceCall struct {
	workspaceID string
	connectorID string
	current     []byte
	next        []byte
}

type fakeStore struct {
	records       []model.ConnectorRecord
	listErr       error
	replaceErr    map[string]error
	replaceResult map[string]bool
	replaceCalls  []replaceCall
	pruneDeleted  int64
	pruneErr      error
}

func (f *fakeStore) ListConnectorRecordsForMaintenance(context.Context) ([]model.ConnectorRecord, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]model.ConnectorRecord, len(f.records))
	copy(out, f.records)
	return out, nil
}

func (f *fakeStore) ReplaceConnectorEncryptedCredentials(_ context.Context, workspaceID, connectorID string, currentEncCreds, nextEncCreds []byte) (bool, error) {
	f.replaceCalls = append(f.replaceCalls, replaceCall{
		workspaceID: workspaceID,
		connectorID: connectorID,
		current:     append([]byte(nil), currentEncCreds...),
		next:        append([]byte(nil), nextEncCreds...),
	})

	if err := f.replaceErr[connectorID]; err != nil {
		return false, err
	}

	updated := true
	if v, ok := f.replaceResult[connectorID]; ok {
		updated = v
	}
	if !updated {
		return false, nil
	}

	for idx := range f.records {
		if f.records[idx].WorkspaceID == workspaceID && f.records[idx].ID == connectorID {
			f.records[idx].EncryptedCredentials = append([]byte(nil), nextEncCreds...)
			break
		}
	}

	return true, nil
}

func (f *fakeStore) PruneExpiredAuditEvents(context.Context) (int64, error) {
	if f.pruneErr != nil {
		return 0, f.pruneErr
	}
	return f.pruneDeleted, nil
}

func TestReencryptConnectorSecrets(t *testing.T) {
	const (
		currentSecret  = "current-secret"
		previousSecret = "previous-secret"
	)

	currentPlaintext := []byte(`{"auth_type":"bearer","token":"current"}`)
	rotatedPlaintext := []byte(`{"auth_type":"bearer","token":"rotated"}`)

	currentCiphertext, err := cryptoutil.Encrypt(currentSecret, currentPlaintext)
	if err != nil {
		t.Fatalf("encrypt current ciphertext: %v", err)
	}
	previousCiphertext, err := cryptoutil.Encrypt(previousSecret, rotatedPlaintext)
	if err != nil {
		t.Fatalf("encrypt previous ciphertext: %v", err)
	}

	store := &fakeStore{
		records: []model.ConnectorRecord{
			{
				Connector:            model.Connector{ID: "conn-current", WorkspaceID: "ws-a"},
				EncryptedCredentials: currentCiphertext,
			},
			{
				Connector:            model.Connector{ID: "conn-rotated", WorkspaceID: "ws-b"},
				EncryptedCredentials: previousCiphertext,
			},
		},
	}

	svc := NewService(store, currentSecret, previousSecret)
	result, err := svc.ReencryptConnectorSecrets(context.Background(), ReencryptConnectorSecretsOptions{})
	if err != nil {
		t.Fatalf("ReencryptConnectorSecrets() error = %v", err)
	}

	if result.Processed != 2 {
		t.Fatalf("Processed = %d, want 2", result.Processed)
	}
	if result.AlreadyCurrent != 1 {
		t.Fatalf("AlreadyCurrent = %d, want 1", result.AlreadyCurrent)
	}
	if result.NeedsRotation != 1 {
		t.Fatalf("NeedsRotation = %d, want 1", result.NeedsRotation)
	}
	if result.Rotated != 1 {
		t.Fatalf("Rotated = %d, want 1", result.Rotated)
	}
	if result.Failed != 0 {
		t.Fatalf("Failed = %d, want 0", result.Failed)
	}
	if len(store.replaceCalls) != 1 {
		t.Fatalf("replace calls = %d, want 1", len(store.replaceCalls))
	}
	if !bytes.Equal(store.replaceCalls[0].current, previousCiphertext) {
		t.Fatal("replace call current ciphertext did not match scanned ciphertext")
	}

	plaintext, err := cryptoutil.Decrypt(currentSecret, store.replaceCalls[0].next)
	if err != nil {
		t.Fatalf("decrypt rotated ciphertext with current key: %v", err)
	}
	if !bytes.Equal(plaintext, rotatedPlaintext) {
		t.Fatalf("rotated plaintext mismatch: got %q want %q", plaintext, rotatedPlaintext)
	}
	if _, err := cryptoutil.Decrypt(previousSecret, store.replaceCalls[0].next); err == nil {
		t.Fatal("rotated ciphertext should no longer decrypt with previous key")
	}
}

func TestReencryptConnectorSecretsDryRun(t *testing.T) {
	const (
		currentSecret  = "current-secret"
		previousSecret = "previous-secret"
	)

	previousCiphertext, err := cryptoutil.Encrypt(previousSecret, []byte(`{"token":"rotate-me"}`))
	if err != nil {
		t.Fatalf("encrypt previous ciphertext: %v", err)
	}

	store := &fakeStore{
		records: []model.ConnectorRecord{{
			Connector:            model.Connector{ID: "conn-1", WorkspaceID: "ws-1"},
			EncryptedCredentials: previousCiphertext,
		}},
	}

	svc := NewService(store, currentSecret, previousSecret)
	result, err := svc.ReencryptConnectorSecrets(context.Background(), ReencryptConnectorSecretsOptions{DryRun: true})
	if err != nil {
		t.Fatalf("ReencryptConnectorSecrets() error = %v", err)
	}

	if result.Processed != 1 {
		t.Fatalf("Processed = %d, want 1", result.Processed)
	}
	if result.NeedsRotation != 1 {
		t.Fatalf("NeedsRotation = %d, want 1", result.NeedsRotation)
	}
	if result.Rotated != 0 {
		t.Fatalf("Rotated = %d, want 0", result.Rotated)
	}
	if len(store.replaceCalls) != 0 {
		t.Fatalf("replace calls = %d, want 0", len(store.replaceCalls))
	}
}

func TestReencryptConnectorSecretsReturnsFailures(t *testing.T) {
	const (
		currentSecret  = "current-secret"
		previousSecret = "previous-secret"
	)

	previousCiphertext, err := cryptoutil.Encrypt(previousSecret, []byte(`{"token":"rotate-me"}`))
	if err != nil {
		t.Fatalf("encrypt previous ciphertext: %v", err)
	}

	store := &fakeStore{
		records: []model.ConnectorRecord{{
			Connector:            model.Connector{ID: "conn-1", WorkspaceID: "ws-1"},
			EncryptedCredentials: previousCiphertext,
		}},
		replaceResult: map[string]bool{"conn-1": false},
	}

	svc := NewService(store, currentSecret, previousSecret)
	result, err := svc.ReencryptConnectorSecrets(context.Background(), ReencryptConnectorSecretsOptions{})
	if err == nil {
		t.Fatal("ReencryptConnectorSecrets() error = nil, want failure")
	}
	if result.Failed != 1 {
		t.Fatalf("Failed = %d, want 1", result.Failed)
	}
	if len(result.Failures) != 1 {
		t.Fatalf("Failures len = %d, want 1", len(result.Failures))
	}
	if !strings.Contains(result.Failures[0].Message, "changed since scan") {
		t.Fatalf("failure message = %q, want changed since scan", result.Failures[0].Message)
	}
}

func TestPruneExpiredAuditEvents(t *testing.T) {
	store := &fakeStore{pruneDeleted: 7}
	svc := NewService(store, "current-secret", "previous-secret")

	result, err := svc.PruneExpiredAuditEvents(context.Background())
	if err != nil {
		t.Fatalf("PruneExpiredAuditEvents() error = %v", err)
	}
	if result.Deleted != 7 {
		t.Fatalf("Deleted = %d, want 7", result.Deleted)
	}
}

func TestPruneExpiredAuditEventsReturnsError(t *testing.T) {
	store := &fakeStore{pruneErr: errors.New("db unavailable")}
	svc := NewService(store, "current-secret", "previous-secret")

	_, err := svc.PruneExpiredAuditEvents(context.Background())
	if err == nil {
		t.Fatal("PruneExpiredAuditEvents() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "db unavailable") {
		t.Fatalf("error = %q, want db unavailable", err.Error())
	}
}
