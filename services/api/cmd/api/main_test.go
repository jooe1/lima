package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/lima/api/internal/config"
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
