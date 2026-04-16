package queue

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"
)

func TestMutationSQLForStep(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		config  map[string]any
		input   map[string]any
		want    string
		wantErr bool
	}{
		{
			name:    "missing sql",
			config:  map[string]any{},
			wantErr: true,
		},
		{
			name:    "empty sql",
			config:  map[string]any{"sql": "   "},
			wantErr: true,
		},
		{
			name:    "select rejected",
			config:  map[string]any{"sql": "SELECT * FROM users"},
			wantErr: true,
		},
		{
			name:   "insert accepted",
			config: map[string]any{"sql": "INSERT INTO users(name) VALUES ('Ada');"},
			want:   "INSERT INTO users(name) VALUES ('Ada')",
		},
		{
			name:   "cte mutation accepted",
			config: map[string]any{"sql": "WITH changed AS (UPDATE users SET active = true RETURNING id) SELECT id FROM changed"},
			want:   "WITH changed AS (UPDATE users SET active = true RETURNING id) SELECT id FROM changed",
		},
		{
			name:   "nested input interpolation accepted",
			config: map[string]any{"sql": "UPDATE users SET active = {{input.user.active}} WHERE id = {{input.user.id}};"},
			input: map[string]any{
				"user": map[string]any{
					"id":     42,
					"active": true,
				},
			},
			want: "UPDATE users SET active = true WHERE id = 42",
		},
		{
			name:    "exact placeholder resolving to non string rejected",
			config:  map[string]any{"sql": "{{input.statement}}"},
			input:   map[string]any{"statement": map[string]any{"raw": "UPDATE users SET active = true"}},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			step := wfStep{name: "mutate", config: tc.config}
			got, err := mutationSQLForStep(step, tc.input, nil)
			if tc.wantErr {
				if err == nil {
					t.Fatal("mutationSQLForStep() error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("mutationSQLForStep() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("mutationSQLForStep() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveWorkflowHelpersHandleNestedInput(t *testing.T) {
	t.Parallel()

	inputData := map[string]any{
		"connector": map[string]any{"id": "rest-users"},
		"user": map[string]any{
			"id":     42,
			"active": true,
			"profile": map[string]any{
				"name": "Ada",
			},
		},
	}

	resolvedAny := resolveWorkflowValue(map[string]any{
		"connector_id": "{{input.connector.id}}",
		"path":         "/v1/users/{{input.user.id}}",
		"body": map[string]any{
			"name":    "{{input.user.profile.name}}",
			"active":  "{{input.user.active}}",
			"user_id": "{{input.user.id}}",
			"labels":  []any{"user-{{input.user.id}}", "{{input.user.profile.name}}"},
		},
	}, inputData, nil)

	resolved, ok := resolvedAny.(map[string]any)
	if !ok {
		t.Fatalf("resolved type = %T, want map[string]any", resolvedAny)
	}
	if got := resolveWorkflowString(resolved["connector_id"], inputData, nil); got != "rest-users" {
		t.Fatalf("connector_id = %q, want rest-users", got)
	}
	if got := resolved["path"]; got != "/v1/users/42" {
		t.Fatalf("path = %#v, want /v1/users/42", got)
	}

	body, ok := resolved["body"].(map[string]any)
	if !ok {
		t.Fatalf("body type = %T, want map[string]any", resolved["body"])
	}
	if got := body["name"]; got != "Ada" {
		t.Fatalf("body.name = %#v, want Ada", got)
	}
	if got := body["active"]; got != true {
		t.Fatalf("body.active = %#v, want true", got)
	}
	if got := body["user_id"]; got != 42 {
		t.Fatalf("body.user_id = %#v, want 42", got)
	}
	labels, ok := body["labels"].([]any)
	if !ok {
		t.Fatalf("body.labels type = %T, want []any", body["labels"])
	}
	if len(labels) != 2 {
		t.Fatalf("len(body.labels) = %d, want 2", len(labels))
	}
	if got := labels[0]; got != "user-42" {
		t.Fatalf("body.labels[0] = %#v, want user-42", got)
	}
	if got := labels[1]; got != "Ada" {
		t.Fatalf("body.labels[1] = %#v, want Ada", got)
	}
	if got := resolveWorkflowString(map[string]any{"bad": true}, inputData, nil); got != "" {
		t.Fatalf("resolveWorkflowString(map) = %q, want empty string", got)
	}
}

func TestRunRESTMutationStep(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path != "/v1/users/42" {
			t.Errorf("path = %s, want /v1/users/42", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer rest-token" {
			t.Errorf("authorization = %q, want bearer token", got)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := payload["name"]; got != "Ada" {
			t.Errorf("name = %#v, want Ada", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := payload["active"]; got != true {
			t.Errorf("active = %#v, want true", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Location", "/v1/users/42")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"42","created":true}`))
	}))
	defer server.Close()

	step := wfStep{
		name: "create user",
		config: map[string]any{
			"method": "POST",
			"path":   "/v1/users/{{input.user_id}}",
			"body": map[string]any{
				"name":   "{{input.name}}",
				"active": "{{input.active}}",
			},
		},
	}
	resultAny, err := runRESTMutationStep(context.Background(), restCreds{
		BaseURL:  server.URL,
		AuthType: "bearer",
		Token:    "rest-token",
	}, step, map[string]any{
		"user_id": 42,
		"name":    "Ada",
		"active":  true,
	}, zap.NewNop(), nil)
	if err != nil {
		t.Fatalf("runRESTMutationStep() error = %v", err)
	}

	result, ok := resultAny.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", resultAny)
	}
	if got := result["status_code"]; got != http.StatusCreated {
		t.Fatalf("status_code = %#v, want %d", got, http.StatusCreated)
	}
	response, ok := result["response"].(map[string]any)
	if !ok {
		t.Fatalf("response type = %T, want map[string]any", result["response"])
	}
	if got := response["id"]; got != "42" {
		t.Fatalf("response.id = %#v, want 42", got)
	}
}

func TestRunRESTMutationStepRejectsNonMutatingMethod(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name: "bad rest mutation",
		config: map[string]any{
			"method": "GET",
			"path":   "/v1/users",
		},
	}
	if _, err := runRESTMutationStep(context.Background(), restCreds{BaseURL: "https://example.com"}, step, nil, zap.NewNop(), nil); err == nil {
		t.Fatal("runRESTMutationStep() error = nil, want fail-closed error")
	}
}

func TestRunRESTMutationStepRejectsMalformedConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		step    wfStep
		input   map[string]any
		wantErr string
	}{
		{
			name: "missing method",
			step: wfStep{
				name:   "rest missing method",
				config: map[string]any{"path": "/v1/users", "body": map[string]any{"ok": true}},
			},
			wantErr: "missing method",
		},
		{
			name: "path resolves to composite value",
			step: wfStep{
				name: "rest composite path",
				config: map[string]any{
					"method": "POST",
					"path":   "{{input.path}}",
					"body":   map[string]any{"ok": true},
				},
			},
			input:   map[string]any{"path": map[string]any{"bad": true}},
			wantErr: "missing path",
		},
		{
			name: "empty body after interpolation",
			step: wfStep{
				name: "rest empty body",
				config: map[string]any{
					"method": "POST",
					"path":   "/v1/users",
					"body":   "{{input.payload}}",
				},
			},
			input:   map[string]any{"payload": "   "},
			wantErr: "missing body",
		},
		{
			name: "absolute path rejected",
			step: wfStep{
				name: "rest absolute path",
				config: map[string]any{
					"method": "POST",
					"path":   "{{input.path}}",
					"body":   map[string]any{"ok": true},
				},
			},
			input:   map[string]any{"path": "https://evil.example/users"},
			wantErr: "request path must be relative",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := runRESTMutationStep(context.Background(), restCreds{BaseURL: "https://api.example.com"}, tc.step, tc.input, zap.NewNop(), nil)
			if err == nil {
				t.Fatal("runRESTMutationStep() error = nil, want error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("runRESTMutationStep() error = %q, want substring %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestRunRESTMutationStepReturnsNon2xxError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"duplicate user"}`))
	}))
	defer server.Close()

	step := wfStep{
		name: "rest error",
		config: map[string]any{
			"method": "POST",
			"path":   "/v1/users",
			"body":   map[string]any{"name": "Ada"},
		},
	}

	_, err := runRESTMutationStep(context.Background(), restCreds{BaseURL: server.URL}, step, nil, zap.NewNop(), nil)
	if err == nil {
		t.Fatal("runRESTMutationStep() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "HTTP 409") {
		t.Fatalf("runRESTMutationStep() error = %q, want HTTP 409", err.Error())
	}
	if !strings.Contains(err.Error(), `{"error":"duplicate user"}`) {
		t.Fatalf("runRESTMutationStep() error = %q, want response body summary", err.Error())
	}
}

func TestRunGraphQLMutationStep(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer gql-token" {
			t.Errorf("authorization = %q, want bearer token", got)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if got := r.Header.Get("X-Trace-ID"); got != "trace-123" {
			t.Errorf("X-Trace-ID = %q, want trace-123", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode graphql body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		query, _ := payload["query"].(string)
		if !strings.HasPrefix(query, "mutation") {
			t.Errorf("query = %q, want mutation", query)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		variables, ok := payload["variables"].(map[string]any)
		if !ok {
			t.Errorf("variables type = %T, want map[string]any", payload["variables"])
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := variables["name"]; got != "Ada" {
			t.Errorf("variables.name = %#v, want Ada", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"createUser":{"id":"1"}}}`))
	}))
	defer server.Close()

	step := wfStep{
		name: "graphql create user",
		config: map[string]any{
			"body": map[string]any{
				"query":     "mutation CreateUser($name: String!) { createUser(name: $name) { id } }",
				"variables": map[string]any{"name": "{{input.name}}"},
			},
		},
	}
	resultAny, err := runGraphQLMutationStep(context.Background(), graphqlMutationCreds{
		Endpoint: server.URL,
		AuthType: "bearer",
		Token:    "gql-token",
		Headers:  map[string]string{"X-Trace-ID": "trace-123"},
	}, step, map[string]any{"name": "Ada"}, zap.NewNop(), nil)
	if err != nil {
		t.Fatalf("runGraphQLMutationStep() error = %v", err)
	}

	result, ok := resultAny.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", resultAny)
	}
	if got := result["status_code"]; got != http.StatusOK {
		t.Fatalf("status_code = %#v, want %d", got, http.StatusOK)
	}
	data, ok := result["data"].(map[string]any)
	if !ok {
		t.Fatalf("data type = %T, want map[string]any", result["data"])
	}
	createUser, ok := data["createUser"].(map[string]any)
	if !ok {
		t.Fatalf("createUser type = %T, want map[string]any", data["createUser"])
	}
	if got := createUser["id"]; got != "1" {
		t.Fatalf("createUser.id = %#v, want 1", got)
	}
}

func TestRunGraphQLMutationStepRejectsNonMutationBody(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name: "graphql query body",
		config: map[string]any{
			"body": "{ users { id } }",
		},
	}
	if _, err := runGraphQLMutationStep(context.Background(), graphqlMutationCreds{Endpoint: "https://example.com/graphql"}, step, nil, zap.NewNop(), nil); err == nil {
		t.Fatal("runGraphQLMutationStep() error = nil, want fail-closed error")
	}
}

func TestRunGraphQLMutationStepRejectsMalformedConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		creds   graphqlMutationCreds
		step    wfStep
		input   map[string]any
		wantErr string
	}{
		{
			name:    "missing endpoint",
			creds:   graphqlMutationCreds{},
			step:    wfStep{name: "graphql missing endpoint", config: map[string]any{"body": map[string]any{"query": "mutation { ping }"}}},
			wantErr: "missing endpoint",
		},
		{
			name:  "unsupported method",
			creds: graphqlMutationCreds{Endpoint: "https://example.com/graphql"},
			step: wfStep{
				name: "graphql wrong method",
				config: map[string]any{
					"method": "GET",
					"body":   map[string]any{"query": "mutation { ping }"},
				},
			},
			wantErr: `method "GET" is not supported`,
		},
		{
			name:    "missing body",
			creds:   graphqlMutationCreds{Endpoint: "https://example.com/graphql"},
			step:    wfStep{name: "graphql missing body", config: map[string]any{}},
			wantErr: "missing body",
		},
		{
			name:  "absolute path rejected",
			creds: graphqlMutationCreds{Endpoint: "https://example.com/graphql"},
			step: wfStep{
				name: "graphql absolute path",
				config: map[string]any{
					"path": "{{input.path}}",
					"body": map[string]any{"query": "mutation { ping }"},
				},
			},
			input:   map[string]any{"path": "https://evil.example/graphql"},
			wantErr: "request path must be relative",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := runGraphQLMutationStep(context.Background(), tc.creds, tc.step, tc.input, zap.NewNop(), nil)
			if err == nil {
				t.Fatal("runGraphQLMutationStep() error = nil, want error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("runGraphQLMutationStep() error = %q, want substring %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestRunGraphQLMutationStepReturnsHTTPError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`upstream unavailable`))
	}))
	defer server.Close()

	step := wfStep{
		name: "graphql upstream failure",
		config: map[string]any{
			"body": map[string]any{"query": "mutation { ping }"},
		},
	}

	_, err := runGraphQLMutationStep(context.Background(), graphqlMutationCreds{Endpoint: server.URL}, step, nil, zap.NewNop(), nil)
	if err == nil {
		t.Fatal("runGraphQLMutationStep() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("runGraphQLMutationStep() error = %q, want HTTP 502", err.Error())
	}
	if !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("runGraphQLMutationStep() error = %q, want upstream error body", err.Error())
	}
}

func TestRunGraphQLMutationStepReturnsErrorsPayload(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":null,"errors":[{"message":"permission denied"}]}`))
	}))
	defer server.Close()

	step := wfStep{
		name: "graphql errors payload",
		config: map[string]any{
			"body": map[string]any{"query": "mutation { ping }"},
		},
	}

	_, err := runGraphQLMutationStep(context.Background(), graphqlMutationCreds{Endpoint: server.URL}, step, nil, zap.NewNop(), nil)
	if err == nil {
		t.Fatal("runGraphQLMutationStep() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "returned errors") {
		t.Fatalf("runGraphQLMutationStep() error = %q, want graphql errors failure", err.Error())
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("runGraphQLMutationStep() error = %q, want graphql error payload", err.Error())
	}
}

func TestNormalizeGraphQLMutationBodyRejectsInvalidPayloads(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		body    any
		wantErr string
	}{
		{
			name:    "missing query",
			body:    map[string]any{"variables": map[string]any{"name": "Ada"}},
			wantErr: "missing query",
		},
		{
			name:    "non mutation operation",
			body:    `{"query":"query { users { id } }"}`,
			wantErr: "must contain a mutation operation",
		},
		{
			name:    "array payload rejected",
			body:    []any{"mutation { ping }"},
			wantErr: "must be a JSON object or string",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := normalizeGraphQLMutationBody(tc.body)
			if err == nil {
				t.Fatal("normalizeGraphQLMutationBody() error = nil, want error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("normalizeGraphQLMutationBody() error = %q, want substring %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestCollectTriggeredOutputBindings(t *testing.T) {
	t.Parallel()

	def := &wfDefinition{
		outputBindings: []outputBinding{
			{TriggerStepID: "__workflow_complete__", WidgetID: "w-complete", Port: "data", PageID: "p-1"},
			{TriggerStepID: "step-a", WidgetID: "w-step-a", Port: "rows", PageID: "p-1"},
			{TriggerStepID: "step-b", WidgetID: "w-step-b", Port: "data", PageID: "p-2"},
		},
	}

	stepResults := map[string]any{
		"step-a": map[string]any{"status": "completed", "result": []any{}},
		// step-b is absent — its binding must not fire
	}

	t.Run("workflow_complete and completed-step bindings included on clean run", func(t *testing.T) {
		t.Parallel()
		triggered := collectTriggeredOutputBindings(def, stepResults, false)
		if len(triggered) != 2 {
			t.Fatalf("len(triggered) = %d, want 2", len(triggered))
		}
		if triggered[0].TriggerStepID != "__workflow_complete__" {
			t.Fatalf("triggered[0].TriggerStepID = %q, want __workflow_complete__", triggered[0].TriggerStepID)
		}
		if triggered[1].TriggerStepID != "step-a" {
			t.Fatalf("triggered[1].TriggerStepID = %q, want step-a", triggered[1].TriggerStepID)
		}
	})

	t.Run("workflow_complete binding excluded when run completed with error", func(t *testing.T) {
		t.Parallel()
		triggered := collectTriggeredOutputBindings(def, stepResults, true)
		if len(triggered) != 1 {
			t.Fatalf("len(triggered) = %d, want 1", len(triggered))
		}
		if triggered[0].TriggerStepID != "step-a" {
			t.Fatalf("triggered[0].TriggerStepID = %q, want step-a", triggered[0].TriggerStepID)
		}
	})

	t.Run("only workflow_complete fires when no steps ran", func(t *testing.T) {
		t.Parallel()
		triggered := collectTriggeredOutputBindings(def, map[string]any{}, false)
		if len(triggered) != 1 {
			t.Fatalf("len(triggered) = %d, want 1", len(triggered))
		}
		if triggered[0].TriggerStepID != "__workflow_complete__" {
			t.Fatalf("triggered[0].TriggerStepID = %q, want __workflow_complete__", triggered[0].TriggerStepID)
		}
	})

	t.Run("no bindings when def has none", func(t *testing.T) {
		t.Parallel()
		triggered := collectTriggeredOutputBindings(&wfDefinition{}, stepResults, false)
		if triggered != nil {
			t.Fatalf("triggered = %v, want nil", triggered)
		}
	})

	t.Run("step binding not fired when step status is not completed", func(t *testing.T) {
		t.Parallel()
		failedResults := map[string]any{
			"step-a": map[string]any{"status": "failed", "error": "something went wrong"},
		}
		triggered := collectTriggeredOutputBindings(def, failedResults, true)
		// completedWithError=true excludes __workflow_complete__; step-a is failed so excluded
		if len(triggered) != 0 {
			t.Fatalf("len(triggered) = %d, want 0", len(triggered))
		}
	})
}

// ---- evaluateCondition tests ------------------------------------------------

func TestEvaluateConditionEqNeq(t *testing.T) {
	t.Parallel()

	input := map[string]any{"status": "active"}

	got := evaluateCondition(map[string]any{"left": "{{input.status}}", "op": "eq", "right": "active"}, input, nil)
	m, _ := got.(map[string]any)
	if m["result"] != true {
		t.Fatalf("eq active == active: result = %v, want true", m["result"])
	}

	got = evaluateCondition(map[string]any{"left": "{{input.status}}", "op": "eq", "right": "inactive"}, input, nil)
	m, _ = got.(map[string]any)
	if m["result"] != false {
		t.Fatalf("eq active == inactive: result = %v, want false", m["result"])
	}

	got = evaluateCondition(map[string]any{"left": "{{input.status}}", "op": "neq", "right": "inactive"}, input, nil)
	m, _ = got.(map[string]any)
	if m["result"] != true {
		t.Fatalf("neq active != inactive: result = %v, want true", m["result"])
	}
}

func TestEvaluateConditionNumericComparisons(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		left  any
		op    string
		right string
		want  bool
	}{
		{name: "gt true", left: 10, op: "gt", right: "5", want: true},
		{name: "gt false", left: 3, op: "gt", right: "5", want: false},
		{name: "gt equal", left: 5, op: "gt", right: "5", want: false},
		{name: "lt true", left: 3, op: "lt", right: "5", want: true},
		{name: "lt false", left: 10, op: "lt", right: "5", want: false},
		{name: "lt equal", left: 5, op: "lt", right: "5", want: false},
		{name: "gte equal", left: 5, op: "gte", right: "5", want: true},
		{name: "gte greater", left: 6, op: "gte", right: "5", want: true},
		{name: "gte less", left: 4, op: "gte", right: "5", want: false},
		{name: "lte equal", left: 5, op: "lte", right: "5", want: true},
		{name: "lte less", left: 4, op: "lte", right: "5", want: true},
		{name: "lte greater", left: 6, op: "lte", right: "5", want: false},
		{name: "float gt", left: 1.5, op: "gt", right: "1.2", want: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			input := map[string]any{"val": tc.left}
			got := evaluateCondition(
				map[string]any{"left": "{{input.val}}", "op": tc.op, "right": tc.right},
				input, nil,
			)
			m, _ := got.(map[string]any)
			if m["result"] != tc.want {
				t.Fatalf("op=%s left=%v right=%s: result = %v, want %v",
					tc.op, tc.left, tc.right, m["result"], tc.want)
			}
		})
	}
}

func TestEvaluateConditionUnknownOpReturnsFalse(t *testing.T) {
	t.Parallel()

	got := evaluateCondition(
		map[string]any{"left": "{{input.x}}", "op": "contains", "right": "foo"},
		map[string]any{"x": "foobar"}, nil,
	)
	m, _ := got.(map[string]any)
	if m["result"] != false {
		t.Fatalf("unknown op: result = %v, want false", m["result"])
	}
	if _, hasNote := m["note"]; !hasNote {
		t.Fatal("unknown op: expected a 'note' field in result")
	}
}

// ---- executeTransformStep tests --------------------------------------------

func TestExecuteTransformStep(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name: "reshape",
		config: map[string]any{
			"mapping": map[string]any{
				"full_name": "{{input.first}} {{input.last}}",
				"user_id":   "{{input.id}}",
				"active":    "{{input.active}}",
			},
		},
	}
	input := map[string]any{"first": "Ada", "last": "Lovelace", "id": 42, "active": true}

	result, err := executeTransformStep(step, input, nil)
	if err != nil {
		t.Fatalf("executeTransformStep() error = %v", err)
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", result)
	}
	if got := m["full_name"]; got != "Ada Lovelace" {
		t.Fatalf("full_name = %#v, want Ada Lovelace", got)
	}
	if got := m["user_id"]; got != 42 {
		t.Fatalf("user_id = %#v, want 42", got)
	}
	if got := m["active"]; got != true {
		t.Fatalf("active = %#v, want true", got)
	}
}

func TestExecuteTransformStepMissingMapping(t *testing.T) {
	t.Parallel()

	step := wfStep{name: "bad-transform", config: map[string]any{}}
	if _, err := executeTransformStep(step, nil, nil); err == nil {
		t.Fatal("executeTransformStep() error = nil, want error for missing mapping")
	}
}

func TestExecuteTransformStepNonObjectMapping(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name:   "bad-transform",
		config: map[string]any{"mapping": "just a string"},
	}
	if _, err := executeTransformStep(step, nil, nil); err == nil {
		t.Fatal("executeTransformStep() error = nil, want error for non-object mapping")
	}
}

func TestExecuteTransformStepUsesStepResults(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name: "enrich",
		config: map[string]any{
			"mapping": map[string]any{
				"rows": "{{step.query1.result.rows}}",
			},
		},
	}
	stepResults := map[string]any{
		"query1": map[string]any{
			"status": "completed",
			"result": map[string]any{"rows": []any{map[string]any{"id": 1}}},
		},
	}
	result, err := executeTransformStep(step, nil, stepResults)
	if err != nil {
		t.Fatalf("executeTransformStep() error = %v", err)
	}
	m, _ := result.(map[string]any)
	rows, ok := m["rows"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("rows = %#v, want slice of length 1", m["rows"])
	}
}

// ---- executeHTTPStep tests -------------------------------------------------

func TestExecuteHTTPStep(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("X-Trace-ID"); got != "trace-42" {
			t.Errorf("X-Trace-ID = %q, want trace-42", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if payload["name"] != "Ada" {
			t.Errorf("name = %#v, want Ada", payload["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"created":true}`))
	}))
	defer server.Close()

	step := wfStep{
		name: "call-api",
		config: map[string]any{
			"url":    server.URL + "/v1/users",
			"method": "POST",
			"headers": map[string]any{
				"X-Trace-ID": "{{input.trace_id}}",
			},
			"body": map[string]any{
				"name": "{{input.name}}",
			},
		},
	}
	input := map[string]any{"name": "Ada", "trace_id": "trace-42"}

	result, err := executeHTTPStep(context.Background(), zap.NewNop(), step, input, nil)
	if err != nil {
		t.Fatalf("executeHTTPStep() error = %v", err)
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", result)
	}
	if got := m["status_code"]; got != http.StatusOK {
		t.Fatalf("status_code = %#v, want %d", got, http.StatusOK)
	}
	body, ok := m["response_body"].(map[string]any)
	if !ok {
		t.Fatalf("response_body type = %T, want map[string]any", m["response_body"])
	}
	if body["created"] != true {
		t.Fatalf("response_body.created = %#v, want true", body["created"])
	}
}

func TestExecuteHTTPStepGetNoBody(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer server.Close()

	step := wfStep{
		name:   "list",
		config: map[string]any{"url": server.URL + "/v1/items"},
	}
	result, err := executeHTTPStep(context.Background(), zap.NewNop(), step, nil, nil)
	if err != nil {
		t.Fatalf("executeHTTPStep() error = %v", err)
	}
	m, _ := result.(map[string]any)
	if got := m["status_code"]; got != http.StatusOK {
		t.Fatalf("status_code = %v, want 200", got)
	}
}

func TestExecuteHTTPStepFailsOnNon2xx(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"validation failed"}`))
	}))
	defer server.Close()

	step := wfStep{
		name:   "bad-call",
		config: map[string]any{"url": server.URL + "/v1/things", "method": "POST", "body": map[string]any{"x": 1}},
	}
	_, err := executeHTTPStep(context.Background(), zap.NewNop(), step, nil, nil)
	if err == nil {
		t.Fatal("executeHTTPStep() error = nil, want error on 422")
	}
	if !strings.Contains(err.Error(), "HTTP 422") {
		t.Fatalf("error = %q, want HTTP 422", err.Error())
	}
}

func TestExecuteHTTPStepMissingURL(t *testing.T) {
	t.Parallel()

	step := wfStep{name: "no-url", config: map[string]any{}}
	if _, err := executeHTTPStep(context.Background(), zap.NewNop(), step, nil, nil); err == nil {
		t.Fatal("executeHTTPStep() error = nil, want error for missing url")
	}
}

func TestExecuteHTTPStepRejectsNonHTTPScheme(t *testing.T) {
	t.Parallel()

	step := wfStep{
		name:   "file-scheme",
		config: map[string]any{"url": "file:///etc/passwd"},
	}
	_, err := executeHTTPStep(context.Background(), zap.NewNop(), step, nil, nil)
	if err == nil {
		t.Fatal("executeHTTPStep() error = nil, want error for file:// url")
	}
	if !strings.Contains(err.Error(), "http or https") {
		t.Fatalf("error = %q, want http or https scheme error", err.Error())
	}
}
