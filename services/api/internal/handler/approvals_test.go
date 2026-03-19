package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
)

type approvalWorkflowResumeStoreStub struct {
	run       *model.WorkflowRun
	getErr    error
	updateErr error

	getCalls         int
	updateCalls      int
	lastApprovalID   string
	updatedRunID     string
	updatedRunStatus model.WorkflowRunStatus
}

func (s *approvalWorkflowResumeStoreStub) GetWorkflowRunByApproval(_ context.Context, approvalID string) (*model.WorkflowRun, error) {
	s.getCalls++
	s.lastApprovalID = approvalID
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.run, nil
}

func (s *approvalWorkflowResumeStoreStub) UpdateWorkflowRunStatus(_ context.Context, runID string, status model.WorkflowRunStatus) error {
	s.updateCalls++
	s.updatedRunID = runID
	s.updatedRunStatus = status
	return s.updateErr
}

type workflowResumeEnqueuerStub struct {
	err       error
	failUntil int

	calls       int
	lastPayload model.WorkflowResumePayload
}

func (e *workflowResumeEnqueuerStub) EnqueueWorkflowResume(_ context.Context, payload model.WorkflowResumePayload) error {
	e.calls++
	e.lastPayload = payload
	if e.calls <= e.failUntil {
		return e.err
	}
	return nil
}

func TestResumeWorkflowRunAfterApprovalDecisionRetriesUntilSuccess(t *testing.T) {
	storeStub := &approvalWorkflowResumeStoreStub{
		run: &model.WorkflowRun{ID: "run-1"},
	}
	enqStub := &workflowResumeEnqueuerStub{
		err:       errors.New("redis unavailable"),
		failUntil: 2,
	}

	err := resumeWorkflowRunAfterApprovalDecisionWithRetry(context.Background(), storeStub, enqStub, "approval-1", true, 3, 0)
	if err != nil {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want nil", err)
	}
	if storeStub.getCalls != 1 {
		t.Fatalf("GetWorkflowRunByApproval calls = %d, want 1", storeStub.getCalls)
	}
	if enqStub.calls != 3 {
		t.Fatalf("EnqueueWorkflowResume calls = %d, want 3", enqStub.calls)
	}
	if enqStub.lastPayload.RunID != "run-1" || enqStub.lastPayload.ApprovalID != "approval-1" || !enqStub.lastPayload.Approved {
		t.Fatalf("EnqueueWorkflowResume payload = %+v, want run-1/approval-1/true", enqStub.lastPayload)
	}
	if storeStub.updateCalls != 0 {
		t.Fatalf("UpdateWorkflowRunStatus calls = %d, want 0", storeStub.updateCalls)
	}
}

func TestResumeWorkflowRunAfterApprovalDecisionIgnoresUnlinkedApproval(t *testing.T) {
	storeStub := &approvalWorkflowResumeStoreStub{getErr: store.ErrNotFound}

	err := resumeWorkflowRunAfterApprovalDecisionWithRetry(context.Background(), storeStub, nil, "approval-1", false, 3, 0)
	if err != nil {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want nil", err)
	}
	if storeStub.updateCalls != 0 {
		t.Fatalf("UpdateWorkflowRunStatus calls = %d, want 0", storeStub.updateCalls)
	}
}

func TestResumeWorkflowRunAfterApprovalDecisionFailsClosedWhenQueueUnavailable(t *testing.T) {
	queueErr := errors.New("redis unavailable")
	storeStub := &approvalWorkflowResumeStoreStub{
		run: &model.WorkflowRun{ID: "run-1"},
	}
	enqStub := &workflowResumeEnqueuerStub{
		err:       queueErr,
		failUntil: 3,
	}

	err := resumeWorkflowRunAfterApprovalDecisionWithRetry(context.Background(), storeStub, enqStub, "approval-1", false, 3, 0)
	if !errors.Is(err, errWorkflowQueueUnavailable) {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want queue unavailable", err)
	}
	if !errors.Is(err, queueErr) {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want enqueue error", err)
	}
	if enqStub.calls != 3 {
		t.Fatalf("EnqueueWorkflowResume calls = %d, want 3", enqStub.calls)
	}
	if storeStub.updateCalls != 1 {
		t.Fatalf("UpdateWorkflowRunStatus calls = %d, want 1", storeStub.updateCalls)
	}
	if storeStub.updatedRunID != "run-1" || storeStub.updatedRunStatus != model.RunStatusFailed {
		t.Fatalf("UpdateWorkflowRunStatus args = (%q, %q), want (%q, %q)", storeStub.updatedRunID, storeStub.updatedRunStatus, "run-1", model.RunStatusFailed)
	}
}

func TestResumeWorkflowRunAfterApprovalDecisionReturnsStatusUpdateError(t *testing.T) {
	queueErr := errors.New("redis unavailable")
	statusErr := errors.New("update failed")
	storeStub := &approvalWorkflowResumeStoreStub{
		run:       &model.WorkflowRun{ID: "run-1"},
		updateErr: statusErr,
	}
	enqStub := &workflowResumeEnqueuerStub{
		err:       queueErr,
		failUntil: 3,
	}

	err := resumeWorkflowRunAfterApprovalDecisionWithRetry(context.Background(), storeStub, enqStub, "approval-1", true, 3, 0)
	if !errors.Is(err, errWorkflowQueueUnavailable) {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want queue unavailable", err)
	}
	if !errors.Is(err, queueErr) {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want enqueue error", err)
	}
	if !errors.Is(err, statusErr) {
		t.Fatalf("resumeWorkflowRunAfterApprovalDecisionWithRetry() error = %v, want status update error", err)
	}
}
