package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/lima/api/internal/model"
)

type workflowRunCleanupStoreStub struct {
	deleteErr error
	updateErr error

	deleteCalls      int
	updateCalls      int
	deletedWorkspace string
	deletedRunID     string
	updatedRunID     string
	updatedRunStatus model.WorkflowRunStatus
}

func (s *workflowRunCleanupStoreStub) DeleteWorkflowRun(_ context.Context, workspaceID, runID string) error {
	s.deleteCalls++
	s.deletedWorkspace = workspaceID
	s.deletedRunID = runID
	return s.deleteErr
}

func (s *workflowRunCleanupStoreStub) UpdateWorkflowRunStatus(_ context.Context, runID string, status model.WorkflowRunStatus) error {
	s.updateCalls++
	s.updatedRunID = runID
	s.updatedRunStatus = status
	return s.updateErr
}

func TestEnqueueWorkflowJobRetriesUntilSuccess(t *testing.T) {
	attempts := 0
	err := enqueueWorkflowJob(context.Background(), 3, 0, func(context.Context) error {
		attempts++
		if attempts < 3 {
			return errors.New("redis unavailable")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("enqueueWorkflowJob() error = %v, want nil", err)
	}
	if attempts != 3 {
		t.Fatalf("enqueueWorkflowJob() attempts = %d, want 3", attempts)
	}
}

func TestEnqueueWorkflowJobFailsAfterRetries(t *testing.T) {
	attempts := 0
	wantErr := errors.New("redis unavailable")
	err := enqueueWorkflowJob(context.Background(), 3, 0, func(context.Context) error {
		attempts++
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("enqueueWorkflowJob() error = %v, want %v", err, wantErr)
	}
	if attempts != 3 {
		t.Fatalf("enqueueWorkflowJob() attempts = %d, want 3", attempts)
	}
}

func TestCleanupTriggeredWorkflowRunDeletesPendingRun(t *testing.T) {
	stub := &workflowRunCleanupStoreStub{}
	err := cleanupTriggeredWorkflowRun(context.Background(), stub, "ws-1", "run-1")
	if err != nil {
		t.Fatalf("cleanupTriggeredWorkflowRun() error = %v, want nil", err)
	}
	if stub.deleteCalls != 1 {
		t.Fatalf("DeleteWorkflowRun calls = %d, want 1", stub.deleteCalls)
	}
	if stub.deletedWorkspace != "ws-1" || stub.deletedRunID != "run-1" {
		t.Fatalf("DeleteWorkflowRun args = (%q, %q), want (%q, %q)", stub.deletedWorkspace, stub.deletedRunID, "ws-1", "run-1")
	}
	if stub.updateCalls != 0 {
		t.Fatalf("UpdateWorkflowRunStatus calls = %d, want 0", stub.updateCalls)
	}
}

func TestCleanupTriggeredWorkflowRunFallsBackToFailedStatus(t *testing.T) {
	stub := &workflowRunCleanupStoreStub{deleteErr: errors.New("delete failed")}
	err := cleanupTriggeredWorkflowRun(context.Background(), stub, "ws-1", "run-1")
	if err != nil {
		t.Fatalf("cleanupTriggeredWorkflowRun() error = %v, want nil", err)
	}
	if stub.updateCalls != 1 {
		t.Fatalf("UpdateWorkflowRunStatus calls = %d, want 1", stub.updateCalls)
	}
	if stub.updatedRunID != "run-1" || stub.updatedRunStatus != model.RunStatusFailed {
		t.Fatalf("UpdateWorkflowRunStatus args = (%q, %q), want (%q, %q)", stub.updatedRunID, stub.updatedRunStatus, "run-1", model.RunStatusFailed)
	}
}

func TestCleanupTriggeredWorkflowRunReturnsErrorWhenCleanupFails(t *testing.T) {
	deleteErr := errors.New("delete failed")
	updateErr := errors.New("update failed")
	stub := &workflowRunCleanupStoreStub{deleteErr: deleteErr, updateErr: updateErr}
	err := cleanupTriggeredWorkflowRun(context.Background(), stub, "ws-1", "run-1")
	if !errors.Is(err, deleteErr) {
		t.Fatalf("cleanupTriggeredWorkflowRun() error = %v, want delete error", err)
	}
	if !errors.Is(err, updateErr) {
		t.Fatalf("cleanupTriggeredWorkflowRun() error = %v, want update error", err)
	}
}
