package handler

import (
	"encoding/json"
	"testing"

	"github.com/lima/api/internal/model"
)

func TestMergeConnectorCredentialsPreservesOmittedSecrets(t *testing.T) {
	current := []byte(`{"base_url":"https://api.example.com/v1","auth_type":"bearer","token":"secret-token","endpoints":[{"label":"Sales","path":"/sales"}]}`)
	patch := []byte(`{"base_url":"https://api.example.com/v2"}`)

	mergedRaw, err := mergeConnectorCredentials(model.ConnectorTypeREST, current, patch)
	if err != nil {
		t.Fatalf("mergeConnectorCredentials() error = %v", err)
	}

	var merged map[string]any
	if err := json.Unmarshal(mergedRaw, &merged); err != nil {
		t.Fatalf("json.Unmarshal(mergedRaw) error = %v", err)
	}

	if got := merged["base_url"]; got != "https://api.example.com/v2" {
		t.Fatalf("merged base_url = %v, want updated value", got)
	}
	if got := merged["auth_type"]; got != "bearer" {
		t.Fatalf("merged auth_type = %v, want bearer", got)
	}
	if got := merged["token"]; got != "secret-token" {
		t.Fatalf("merged token = %v, want original token preserved", got)
	}
	if _, ok := merged["endpoints"]; !ok {
		t.Fatal("merged endpoints missing, want original endpoints preserved")
	}
}

func TestMergeConnectorCredentialsPrunesOldSecretsOnAuthChange(t *testing.T) {
	current := []byte(`{"base_url":"https://api.example.com/v1","auth_type":"bearer","token":"secret-token"}`)
	patch := []byte(`{"auth_type":"none"}`)

	mergedRaw, err := mergeConnectorCredentials(model.ConnectorTypeREST, current, patch)
	if err != nil {
		t.Fatalf("mergeConnectorCredentials() error = %v", err)
	}

	var merged map[string]any
	if err := json.Unmarshal(mergedRaw, &merged); err != nil {
		t.Fatalf("json.Unmarshal(mergedRaw) error = %v", err)
	}

	if got := merged["auth_type"]; got != "none" {
		t.Fatalf("merged auth_type = %v, want none", got)
	}
	if _, ok := merged["token"]; ok {
		t.Fatal("merged token present after auth_type=none, want token removed")
	}
}

func TestRedactEditableConnectorCredentialsRemovesSecrets(t *testing.T) {
	plain := []byte(`{"base_url":"https://api.example.com/v1","auth_type":"bearer","token":"secret-token"}`)

	editable, storedSecrets, err := redactEditableConnectorCredentials(model.ConnectorTypeREST, plain)
	if err != nil {
		t.Fatalf("redactEditableConnectorCredentials() error = %v", err)
	}

	if got := editable["base_url"]; got != "https://api.example.com/v1" {
		t.Fatalf("editable base_url = %v, want original base_url", got)
	}
	if got := editable["auth_type"]; got != "bearer" {
		t.Fatalf("editable auth_type = %v, want bearer", got)
	}
	if _, ok := editable["token"]; ok {
		t.Fatal("editable token present, want token redacted")
	}
	if !storedSecrets["token"] {
		t.Fatal("storedSecrets[token] = false, want true")
	}
}