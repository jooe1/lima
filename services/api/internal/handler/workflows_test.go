package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/model"
	"go.uber.org/zap"
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

func TestNormalizeWorkflowTriggerConfigRejectsInvalidCron(t *testing.T) {
	_, err := normalizeWorkflowTriggerConfig(model.TriggerSchedule, map[string]any{"cron": "0 * *"})
	if err == nil {
		t.Fatal("normalizeWorkflowTriggerConfig() error = nil, want cron validation error")
	}
	if !strings.Contains(err.Error(), "five cron fields") {
		t.Fatalf("normalizeWorkflowTriggerConfig() error = %v, want five cron fields message", err)
	}
}

func TestNormalizeWorkflowTriggerConfigRejectsUnexpectedKeys(t *testing.T) {
	_, err := normalizeWorkflowTriggerConfig(model.TriggerManual, map[string]any{"cron": "0 * * * *"})
	if err == nil {
		t.Fatal("normalizeWorkflowTriggerConfig() error = nil, want unexpected key error")
	}
	if !strings.Contains(err.Error(), "unsupported trigger_config fields") {
		t.Fatalf("normalizeWorkflowTriggerConfig() error = %v, want unexpected key message", err)
	}
}

func TestNormalizeWorkflowTriggerConfigAcceptsWebhookSecret(t *testing.T) {
	config, err := normalizeWorkflowTriggerConfig(model.TriggerWebhook, map[string]any{"secret_token_hash": "whsec_12345678"})
	if err != nil {
		t.Fatalf("normalizeWorkflowTriggerConfig() error = %v, want nil", err)
	}
	if got := config["secret_token_hash"]; got != "whsec_12345678" {
		t.Fatalf("normalizeWorkflowTriggerConfig() secret = %v, want %q", got, "whsec_12345678")
	}
}

// ---- end_user trigger path tests --------------------------------------------

// endUserTriggerStoreStub is a test double for endUserTriggerStore.
type endUserTriggerStoreStub struct {
	wf       *model.WorkflowWithSteps
	wfErr    error
	grantMap map[string]bool // connectorID → has grant (all actions)
	// grantByAction overrides grantMap for a specific action: key is "connID:action".
	grantByAction map[string]bool
	grantErr      error

	run         *model.WorkflowRun
	runErr      error
	updateErr   error
	approval    *model.Approval
	approvalErr error
	setErr      error
	deleteErr   error

	createdRun    bool
	setApprovalID string
	deletedRunIDs []string
}

func (s *endUserTriggerStoreStub) GetWorkflowWithSteps(_ context.Context, _, _ string) (*model.WorkflowWithSteps, error) {
	return s.wf, s.wfErr
}

func (s *endUserTriggerStoreStub) HasResourceGrant(_ context.Context, _, _, connID, _, _, action string) (bool, error) {
	if s.grantErr != nil {
		return false, s.grantErr
	}
	key := connID + ":" + action
	if v, ok := s.grantByAction[key]; ok {
		return v, nil
	}
	return s.grantMap[connID], nil
}

func (s *endUserTriggerStoreStub) CreateWorkflowRun(_ context.Context, _, _ string, _ *string, _ map[string]any) (*model.WorkflowRun, error) {
	s.createdRun = true
	return s.run, s.runErr
}

func (s *endUserTriggerStoreStub) UpdateWorkflowRunStatus(_ context.Context, _ string, _ model.WorkflowRunStatus) error {
	return s.updateErr
}

func (s *endUserTriggerStoreStub) CreateApproval(_ context.Context, _ string, _ *string, _ *string, _ string, _ []byte, _ string) (*model.Approval, error) {
	return s.approval, s.approvalErr
}

func (s *endUserTriggerStoreStub) SetWorkflowRunApproval(_ context.Context, _ string, approvalID string) error {
	s.setApprovalID = approvalID
	return s.setErr
}

func (s *endUserTriggerStoreStub) DeleteWorkflowRun(_ context.Context, _, runID string) error {
	s.deletedRunIDs = append(s.deletedRunIDs, runID)
	return s.deleteErr
}

// TestTriggerEndUserWorkflowRunMutateGrantAlwaysGated verifies that even when the
// caller has a mutate grant on every mutation-step connector, end users are always
// approval-gated: status=awaiting_approval with a linked approval record.
func TestTriggerEndUserWorkflowRunMutateGrantAlwaysGated(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-1"}},
			{StepType: model.StepTypeQuery, Config: map[string]any{"connector_id": "conn-no-check"}},
		},
	}
	run := &model.WorkflowRun{ID: "run-1", Status: model.RunStatusPending}
	approval := &model.Approval{ID: "apv-1"}
	stub := &endUserTriggerStoreStub{
		wf:       wf,
		grantMap: map[string]bool{"conn-1": true},
		run:      run,
		approval: approval,
	}

	got, err := triggerEndUserWorkflowRun(
		context.Background(), stub, "test-enc-key",
		"company-1", "ws-1", "wf-1", "user-1", map[string]any{"k": "v"},
	)
	if err != nil {
		t.Fatalf("triggerEndUserWorkflowRun() error = %v, want nil", err)
	}
	if got.Status != model.RunStatusAwaitingApproval {
		t.Errorf("run.Status = %q, want %q (end users are always approval-gated)", got.Status, model.RunStatusAwaitingApproval)
	}
	if got.ApprovalID == nil || *got.ApprovalID != "apv-1" {
		t.Errorf("run.ApprovalID = %v, want \"apv-1\"", got.ApprovalID)
	}
	if len(stub.deletedRunIDs) != 0 {
		t.Errorf("DeleteWorkflowRun called unexpectedly: %v", stub.deletedRunIDs)
	}
}

// TestTriggerEndUserWorkflowRunQueryOnlyGrant verifies that when the caller has
// only a query (read) grant — but not mutate — on a mutation-step connector, the
// submit is rejected with errMutateGrantRequired (403). A run must not be created.
func TestTriggerEndUserWorkflowRunQueryOnlyGrant(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-1"}},
		},
	}
	stub := &endUserTriggerStoreStub{
		wf: wf,
		// conn-1 has query access but NOT mutate access.
		grantByAction: map[string]bool{
			"conn-1:mutate": false,
			"conn-1:query":  true,
		},
	}

	_, err := triggerEndUserWorkflowRun(
		context.Background(), stub, "test-enc-key",
		"company-1", "ws-1", "wf-1", "user-1", map[string]any{"k": "v"},
	)
	if err == nil {
		t.Fatal("triggerEndUserWorkflowRun() error = nil, want *errMutateGrantRequired")
	}
	var grantErr *errMutateGrantRequired
	if !errors.As(err, &grantErr) {
		t.Fatalf("error type = %T, want *errMutateGrantRequired", err)
	}
	if grantErr.ConnectorID != "conn-1" {
		t.Errorf("ConnectorID = %q, want \"conn-1\"", grantErr.ConnectorID)
	}
	if stub.createdRun {
		t.Error("CreateWorkflowRun must not be called when mutate grant is missing")
	}
}

// TestTriggerEndUserWorkflowRunNoMutationSteps verifies that a workflow with no
// mutation steps (read-only) always produces an immediately-pending run without
// any grant or approval checks.
func TestTriggerEndUserWorkflowRunNoMutationSteps(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeQuery, Config: map[string]any{"connector_id": "conn-1"}},
		},
	}
	run := &model.WorkflowRun{ID: "run-1", Status: model.RunStatusPending}
	stub := &endUserTriggerStoreStub{
		wf:  wf,
		run: run,
		// No grant entries at all — grant check should never be reached.
	}

	got, err := triggerEndUserWorkflowRun(
		context.Background(), stub, "test-enc-key",
		"company-1", "ws-1", "wf-1", "user-1", map[string]any{},
	)
	if err != nil {
		t.Fatalf("triggerEndUserWorkflowRun() error = %v, want nil", err)
	}
	if got.Status != model.RunStatusPending {
		t.Errorf("run.Status = %q, want %q (read-only workflow should run immediately)", got.Status, model.RunStatusPending)
	}
	if got.ApprovalID != nil {
		t.Errorf("run.ApprovalID = %v, want nil", got.ApprovalID)
	}
}

// TestTriggerEndUserWorkflowRunMissingGrant verifies that when the caller has no
// grant at all (neither mutate nor query) on a mutation-step connector, the helper
// returns *errMutateGrantRequired and does NOT create a run.
func TestTriggerEndUserWorkflowRunMissingGrant(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-secret"}},
		},
	}
	stub := &endUserTriggerStoreStub{
		wf: wf,
		// No grant at all — both mutate and query checks return false.
		grantByAction: map[string]bool{
			"conn-secret:mutate": false,
			"conn-secret:query":  false,
		},
	}

	_, err := triggerEndUserWorkflowRun(
		context.Background(), stub, "test-enc-key",
		"company-1", "ws-1", "wf-1", "user-no-grant", map[string]any{},
	)
	if err == nil {
		t.Fatal("triggerEndUserWorkflowRun() error = nil, want *errMutateGrantRequired")
	}
	var grantErr *errMutateGrantRequired
	if !errors.As(err, &grantErr) {
		t.Fatalf("triggerEndUserWorkflowRun() error = %T %v, want *errMutateGrantRequired", err, err)
	}
	if grantErr.ConnectorID != "conn-secret" {
		t.Errorf("errMutateGrantRequired.ConnectorID = %q, want \"conn-secret\"", grantErr.ConnectorID)
	}
	if stub.createdRun {
		t.Error("CreateWorkflowRun must not be called when a grant check fails")
	}
}

// ---- TriggerWorkflow HTTP handler tests ------------------------------------

// triggerWorkflowStoreStub combines endUserTriggerStoreStub with a GetMemberRole
// implementation, satisfying the triggerWorkflowStore interface.
type triggerWorkflowStoreStub struct {
	endUserTriggerStoreStub
	memberRole    model.WorkspaceRole
	memberRoleErr error
}

func (s *triggerWorkflowStoreStub) GetMemberRole(_ context.Context, _, _ string) (model.WorkspaceRole, error) {
	return s.memberRole, s.memberRoleErr
}

// buildTriggerTestRouter builds a minimal chi router that wires TriggerWorkflow
// with a stub store and a no-op logger.  The testJWTSecret from testhelpers_test.go
// is used for JWT authentication.
func buildTriggerTestRouter(t *testing.T, cfg *config.Config, stub *triggerWorkflowStoreStub) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Use(Authenticate(testJWTSecret))
	r.Post("/workspaces/{workspaceID}/workflows/{workflowID}/trigger",
		TriggerWorkflow(cfg, stub, nil, zap.NewNop()))
	return r
}

// TestTriggerWorkflow_EndUserWithMutateGrant verifies that an end_user who has a
// mutate grant on a mutation-step connector receives HTTP 202 with
// status=awaiting_approval — end users are always approval-gated.
func TestTriggerWorkflow_EndUserWithMutateGrant(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-1"}},
		},
	}
	run := &model.WorkflowRun{ID: "run-1", Status: model.RunStatusPending}
	approval := &model.Approval{ID: "apv-1"}

	stub := &triggerWorkflowStoreStub{
		memberRole: model.RoleEndUser,
		endUserTriggerStoreStub: endUserTriggerStoreStub{
			wf: wf,
			grantByAction: map[string]bool{
				"conn-1:mutate": true,
			},
			run:      run,
			approval: approval,
		},
	}

	cfg := &config.Config{CredentialsEncryptionKey: testJWTSecret}
	h := buildTriggerTestRouter(t, cfg, stub)

	body := bytes.NewBufferString(`{"input_data":{"key":"val"}}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-1/workflows/wf-1/trigger", body)
	req.Header.Set("Authorization", "Bearer "+makeTestJWT(t, "user-1", "company-1"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Errorf("status = %d, want %d (202 Accepted)", w.Code, http.StatusAccepted)
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["status"]; got != string(model.RunStatusAwaitingApproval) {
		t.Errorf("run.status = %v, want %q", got, model.RunStatusAwaitingApproval)
	}
	if got := resp["approval_id"]; got != "apv-1" {
		t.Errorf("run.approval_id = %v, want \"apv-1\"", got)
	}
}

// TestTriggerWorkflow_EndUserWithQueryOnlyGrant verifies that an end_user who has
// only a query (read) grant — but not mutate — on a mutation-step connector
// receives HTTP 403 with error=mutate_grant_required.
func TestTriggerWorkflow_EndUserWithQueryOnlyGrant(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-1"}},
		},
	}

	stub := &triggerWorkflowStoreStub{
		memberRole: model.RoleEndUser,
		endUserTriggerStoreStub: endUserTriggerStoreStub{
			wf: wf,
			grantByAction: map[string]bool{
				"conn-1:mutate": false,
				"conn-1:query":  true,
			},
		},
	}

	cfg := &config.Config{CredentialsEncryptionKey: testJWTSecret}
	h := buildTriggerTestRouter(t, cfg, stub)

	body := bytes.NewBufferString(`{"input_data":{"key":"val"}}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-1/workflows/wf-1/trigger", body)
	req.Header.Set("Authorization", "Bearer "+makeTestJWT(t, "user-1", "company-1"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d (403 Forbidden)", w.Code, http.StatusForbidden)
	}
	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["error"]; got != "mutate_grant_required" {
		t.Errorf("error = %v, want \"mutate_grant_required\"", got)
	}
	if stub.createdRun {
		t.Error("CreateWorkflowRun must not be called when a grant check fails")
	}
}

// TestTriggerWorkflow_EndUserWithoutAnyGrant verifies that an end_user who has no
// grant at all on a mutation-step connector receives HTTP 403 with error=mutate_grant_required.
func TestTriggerWorkflow_EndUserWithoutAnyGrant(t *testing.T) {
	wf := &model.WorkflowWithSteps{
		Workflow: model.Workflow{ID: "wf-1", AppID: "app-1"},
		Steps: []model.WorkflowStep{
			{StepType: model.StepTypeMutation, Config: map[string]any{"connector_id": "conn-locked"}},
		},
	}

	stub := &triggerWorkflowStoreStub{
		memberRole: model.RoleEndUser,
		endUserTriggerStoreStub: endUserTriggerStoreStub{
			wf: wf,
			grantByAction: map[string]bool{
				"conn-locked:mutate": false,
				"conn-locked:query":  false,
			},
		},
	}

	cfg := &config.Config{CredentialsEncryptionKey: testJWTSecret}
	h := buildTriggerTestRouter(t, cfg, stub)

	body := bytes.NewBufferString(`{}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-1/workflows/wf-1/trigger", body)
	req.Header.Set("Authorization", "Bearer "+makeTestJWT(t, "user-1", "company-1"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d (403 Forbidden)", w.Code, http.StatusForbidden)
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["error"]; got != "mutate_grant_required" {
		t.Errorf("error = %v, want \"mutate_grant_required\"", got)
	}
	if got := resp["connector_id"]; got != "conn-locked" {
		t.Errorf("connector_id = %v, want \"conn-locked\"", got)
	}
	if stub.createdRun {
		t.Error("CreateWorkflowRun must not be called when a grant check fails")
	}
}
