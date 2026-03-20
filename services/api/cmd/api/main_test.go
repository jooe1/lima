package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/db"
	"go.uber.org/zap"
)

func TestRunMaintenanceSkipsDBForSubcommandHelp(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantOutput string
	}{
		{
			name:       "reencrypt connector secrets help",
			args:       []string{"reencrypt-connector-secrets", "--help"},
			wantOutput: "reencrypt-connector-secrets",
		},
		{
			name:       "prune audit events help",
			args:       []string{"prune-audit-events", "--help"},
			wantOutput: "prune-audit-events",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var err error
			output := captureStdout(t, func() {
				err = runMaintenance(testConfig(), zap.NewNop(), tt.args)
			})
			if err != nil {
				t.Fatalf("runMaintenance() error = %v, want nil", err)
			}
			if !strings.Contains(output, tt.wantOutput) {
				t.Fatalf("runMaintenance() output = %q, want substring %q", output, tt.wantOutput)
			}
		})
	}
}

func TestRunMaintenanceSkipsDBForUnknownAction(t *testing.T) {
	err := runMaintenance(testConfig(), zap.NewNop(), []string{"not-a-real-action"})
	if err == nil {
		t.Fatal("runMaintenance() error = nil, want error")
	}
	if !strings.Contains(err.Error(), `unknown maintenance action "not-a-real-action"`) {
		t.Fatalf("runMaintenance() error = %q, want unknown maintenance action", err.Error())
	}
	if strings.Contains(err.Error(), "db connect failed") {
		t.Fatalf("runMaintenance() error = %q, unexpectedly attempted DB connect", err.Error())
	}
}

func TestRunMaintenanceSkipsDBForUnexpectedArguments(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{
			name:    "reencrypt connector secrets",
			args:    []string{"reencrypt-connector-secrets", "extra"},
			wantErr: "unexpected arguments for reencrypt-connector-secrets: [extra]",
		},
		{
			name:    "prune audit events",
			args:    []string{"prune-audit-events", "extra"},
			wantErr: "unexpected arguments for prune-audit-events: [extra]",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := runMaintenance(testConfig(), zap.NewNop(), tt.args)
			if err == nil {
				t.Fatal("runMaintenance() error = nil, want error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("runMaintenance() error = %q, want substring %q", err.Error(), tt.wantErr)
			}
			if strings.Contains(err.Error(), "db connect failed") {
				t.Fatalf("runMaintenance() error = %q, unexpectedly attempted DB connect", err.Error())
			}
		})
	}
}

func TestOpenDBPoolWithRetriesRetriesUntilSuccess(t *testing.T) {
	var attempts int
	var sleeps []time.Duration

	pool, err := openDBPoolWithRetries(
		&config.Config{DatabaseURL: "postgres://example.test/lima"},
		zap.NewNop(),
		func(dbConfig db.ConnConfig) (*pgxpool.Pool, error) {
			attempts++
			if dbConfig.URL != "postgres://example.test/lima" {
				t.Fatalf("dbConfig.URL = %q, want original DATABASE_URL", dbConfig.URL)
			}
			if attempts < 3 {
				return nil, fmt.Errorf("db unavailable")
			}
			return nil, nil
		},
		func(delay time.Duration) {
			sleeps = append(sleeps, delay)
		},
	)
	if err != nil {
		t.Fatalf("openDBPoolWithRetries() error = %v, want nil", err)
	}
	if pool != nil {
		t.Fatal("openDBPoolWithRetries() pool != nil, want nil stub pool")
	}
	if attempts != 3 {
		t.Fatalf("openDBPoolWithRetries() attempts = %d, want 3", attempts)
	}
	if len(sleeps) != 2 {
		t.Fatalf("openDBPoolWithRetries() sleep calls = %d, want 2", len(sleeps))
	}
	if sleeps[0] != time.Second || sleeps[1] != 2*time.Second {
		t.Fatalf("openDBPoolWithRetries() sleeps = %v, want [1s 2s]", sleeps)
	}
}

func TestOpenDBPoolWithRetriesReturnsLastError(t *testing.T) {
	var attempts int

	_, err := openDBPoolWithRetries(
		&config.Config{DatabaseURL: "postgres://example.test/lima"},
		zap.NewNop(),
		func(db.ConnConfig) (*pgxpool.Pool, error) {
			attempts++
			return nil, fmt.Errorf("still unavailable")
		},
		func(time.Duration) {},
	)
	if err == nil {
		t.Fatal("openDBPoolWithRetries() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "after 10 attempts") {
		t.Fatalf("openDBPoolWithRetries() error = %q, want retry exhaustion details", err.Error())
	}
	if attempts != 10 {
		t.Fatalf("openDBPoolWithRetries() attempts = %d, want 10", attempts)
	}
}

func testConfig() *config.Config {
	return &config.Config{DatabaseURL: "%"}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()

	oldStdout := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe() error = %v", err)
	}
	os.Stdout = writer
	defer func() {
		os.Stdout = oldStdout
	}()

	fn()

	if err := writer.Close(); err != nil {
		t.Fatalf("writer.Close() error = %v", err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("reader.Close() error = %v", err)
	}
	return string(output)
}
