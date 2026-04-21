package queue

import (
	"strings"
	"testing"
)

func TestParsePlanResponse_upsertAddsPrimaryKeyToFormFields(t *testing.T) {
	t.Parallel()

	plan, err := parsePlanResponse(`{
		"intent": "crud",
		"connector_id": "conn_orders",
		"connector_type": "managed",
		"entity": "order",
		"form_fields": ["customer", "amount"],
		"table_fields": ["id", "customer", "amount"],
		"crud_mode": "upsert",
		"primary_key_field": "id",
		"workflow_name": "Save Order",
		"workflow_ref": "saveOrder"
	}`)
	if err != nil {
		t.Fatalf("parsePlanResponse() error = %v", err)
	}
	if len(plan.FormFields) != 3 {
		t.Fatalf("len(form_fields) = %d, want 3 (%v)", len(plan.FormFields), plan.FormFields)
	}
	if plan.FormFields[0] != "id" {
		t.Fatalf("form_fields[0] = %q, want id (%v)", plan.FormFields[0], plan.FormFields)
	}
}

func TestApplyPlanToFlows_managedUpsertExpandsSingleMutation(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:         "saveOrder",
			Name:        "Save Order",
			TriggerType: "form_submit",
			Steps: []genWorkflowStep{{
				Name:     "Upsert order row",
				StepType: "mutation",
				Config:   map[string]any{},
			}},
		},
	}
	plan := &appPlan{
		Intent:          "crud",
		ConnectorID:     "conn_orders",
		ConnectorType:   "managed",
		FormFields:      []string{"id", "customer", "amount"},
		CRUDMode:        "upsert",
		PrimaryKeyField: "id",
	}

	applyPlanToFlows(flows, plan)

	if len(flows[0].Steps) != 3 {
		t.Fatalf("len(steps) = %d, want 3", len(flows[0].Steps))
	}
	cond := flows[0].Steps[0]
	if cond.StepType != "condition" {
		t.Fatalf("step0 type = %q, want condition", cond.StepType)
	}
	if cond.Config["left"] != "{{input.id}}" || cond.Config["op"] != "neq" {
		t.Fatalf("condition config = %+v, want left={{input.id}} op=neq", cond.Config)
	}
	if cond.NextStepRef == "" || cond.FalseBranchStepRef == "" {
		t.Fatalf("condition branches missing: %+v", cond)
	}
	updateStep := flows[0].Steps[1]
	if got, _ := updateStep.Config["operation"].(string); got != "update" {
		t.Fatalf("update operation = %q, want update", got)
	}
	if got, _ := updateStep.Config["row_id"].(string); got != "{{input.id}}" {
		t.Fatalf("update row_id = %q, want {{input.id}}", got)
	}
	insertStep := flows[0].Steps[2]
	if got, _ := insertStep.Config["operation"].(string); got != "insert" {
		t.Fatalf("insert operation = %q, want insert", got)
	}
	if _, ok := insertStep.Config["row_id"]; ok {
		t.Fatalf("insert step should not include row_id: %+v", insertStep.Config)
	}
}

// ---- extractFlows -----------------------------------------------------------

func TestExtractFlows_noBlock(t *testing.T) {
	t.Parallel()

	content := "Here is your updated app.\n\n```aura\ntext hello @ root\n  text \"Hello\"\n;\n```"
	flows, err := extractFlows(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if flows != nil {
		t.Fatalf("expected nil flows, got %v", flows)
	}
}

func TestBuildFlowNodesAndEdges_conditionBranchesUseRefs(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:         "saveOrder",
			Name:        "Save Order",
			TriggerType: "form_submit",
			Steps: []genWorkflowStep{
				{
					Ref:                "hasExistingRow",
					Name:               "Existing row?",
					StepType:           "condition",
					Config:             map[string]any{"left": "{{input.id}}", "op": "neq", "right": ""},
					NextStepRef:        "updateOrder",
					FalseBranchStepRef: "insertOrder",
				},
				{Ref: "updateOrder", Name: "Update row", StepType: "mutation", Config: map[string]any{"operation": "update"}},
				{Ref: "insertOrder", Name: "Insert row", StepType: "mutation", Config: map[string]any{"operation": "insert"}},
			},
		},
	}
	refToID := map[string]string{"saveOrder": "uuid-wf"}

	_, edges := buildFlowNodesAndEdges(flows, refToID, "")

	if len(edges) != 3 {
		t.Fatalf("expected 3 edges, got %d: %+v", len(edges), edges)
	}
	if edges[0].FromPort != "trueBranch" || edges[0].ToNodeID != "saveOrder_step1" {
		t.Fatalf("true branch edge = %+v, want trueBranch -> saveOrder_step1", edges[0])
	}
	if edges[1].FromPort != "falseBranch" || edges[1].ToNodeID != "saveOrder_step2" {
		t.Fatalf("false branch edge = %+v, want falseBranch -> saveOrder_step2", edges[1])
	}
}

func TestExtractFlows_emptyBlock(t *testing.T) {
	t.Parallel()

	content := "```flows\n[]\n```"
	flows, err := extractFlows(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if flows != nil {
		t.Fatalf("expected nil for empty array, got %v", flows)
	}
}

func TestExtractFlows_singleWorkflow(t *testing.T) {
	t.Parallel()

	content := "Updated layout.\n\n```flows\n[\n  {\n    \"ref\": \"submitOrder\",\n    \"name\": \"Submit Order\",\n    \"trigger_type\": \"form_submit\",\n    \"trigger_widget_ref\": \"orderForm\",\n    \"requires_approval\": true,\n    \"steps\": [\n      {\n        \"name\": \"Insert row\",\n        \"step_type\": \"mutation\",\n        \"config\": { \"connector_id\": \"abc\", \"query\": \"INSERT INTO orders (x) VALUES (:x)\", \"params\": {} }\n      }\n    ]\n  }\n]\n```"
	flows, err := extractFlows(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(flows) != 1 {
		t.Fatalf("expected 1 flow, got %d", len(flows))
	}
	f := flows[0]
	if f.Ref != "submitOrder" {
		t.Errorf("ref = %q, want %q", f.Ref, "submitOrder")
	}
	if f.TriggerType != "form_submit" {
		t.Errorf("trigger_type = %q, want %q", f.TriggerType, "form_submit")
	}
	if f.TriggerWidgetRef != "orderForm" {
		t.Errorf("trigger_widget_ref = %q, want %q", f.TriggerWidgetRef, "orderForm")
	}
	if !f.RequiresApproval {
		t.Error("requires_approval should be true")
	}
	if len(f.Steps) != 1 {
		t.Fatalf("expected 1 step, got %d", len(f.Steps))
	}
	if f.Steps[0].StepType != "mutation" {
		t.Errorf("step_type = %q, want %q", f.Steps[0].StepType, "mutation")
	}
}

func TestExtractFlows_invalidJSON(t *testing.T) {
	t.Parallel()

	content := "```flows\nnot-json\n```"
	_, err := extractFlows(content)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

// ---- substituteFlowRefs -----------------------------------------------------

func TestSubstituteFlowRefs_replacesPlaceholders(t *testing.T) {
	t.Parallel()

	dsl := `form orderForm @ root
  with fields="name,amount"
       onSubmit="{{flow:submitOrder}}"
  style { gridX: "0"; gridY: "0"; gridW: "8"; gridH: "10" }
;`
	refToID := map[string]string{"submitOrder": "550e8400-e29b-41d4-a716-446655440000"}
	got := substituteFlowRefs(dsl, refToID)
	if strings.Contains(got, "{{flow:") {
		t.Errorf("placeholder not replaced; got:\n%s", got)
	}
	if !strings.Contains(got, "550e8400-e29b-41d4-a716-446655440000") {
		t.Errorf("real UUID not present in result; got:\n%s", got)
	}
}

func TestSubstituteFlowRefs_noOp(t *testing.T) {
	t.Parallel()

	dsl := `table myTable @ root
  with connector="abc" connectorType="csv" sql="SELECT * FROM csv"
  style { gridX: "0"; gridY: "0"; gridW: "24"; gridH: "14" }
;`
	got := substituteFlowRefs(dsl, map[string]string{"submitOrder": "uuid-1"})
	if got != dsl {
		t.Errorf("dsl should be unchanged when no placeholder present; got:\n%s", got)
	}
}

func TestSubstituteFlowRefs_multipleFlows(t *testing.T) {
	t.Parallel()

	dsl := `form f1 @ root
  with fields="a" onSubmit="{{flow:flowA}}"
;
button b1 @ root
  text "Delete"
  with onClick="{{flow:flowB}}"
;`
	refToID := map[string]string{
		"flowA": "uuid-aaa",
		"flowB": "uuid-bbb",
	}
	got := substituteFlowRefs(dsl, refToID)
	if strings.Contains(got, "{{flow:") {
		t.Errorf("not all placeholders replaced; got:\n%s", got)
	}
	if !strings.Contains(got, "uuid-aaa") || !strings.Contains(got, "uuid-bbb") {
		t.Errorf("one or both UUIDs missing; got:\n%s", got)
	}
}

func TestReconcileGeneratedFlowTriggerRefs_fromLayoutAction(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{{Ref: "placeOrder", Name: "Place Order", TriggerType: "form_submit"}}
	dsl := `form orderForm @ root
  action {{flow:placeOrder}}
;`

	reconcileGeneratedFlowTriggerRefs(flows, dsl)

	if flows[0].TriggerWidgetRef != "orderForm" {
		t.Fatalf("trigger_widget_ref = %q, want orderForm", flows[0].TriggerWidgetRef)
	}
}

// ---- extractEdges -----------------------------------------------------------

func TestExtractEdges_noBlock(t *testing.T) {
	t.Parallel()

	edges, err := extractEdges("Here is your app.\n```aura\ntext x @ root;\n```")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("expected nil/empty, got %v", edges)
	}
}

func TestExtractEdges_valid(t *testing.T) {
	t.Parallel()

	content := "```edges\n[\n  {\n    \"id\": \"edge_tbl_selectedRow_frm_setValues\",\n    \"fromNodeId\": \"tbl\",\n    \"fromPort\": \"selectedRow\",\n    \"toNodeId\": \"frm\",\n    \"toPort\": \"setValues\",\n    \"edgeType\": \"reactive\"\n  }\n]\n```"
	edges, err := extractEdges(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	if e.ID != "edge_tbl_selectedRow_frm_setValues" {
		t.Errorf("id = %q", e.ID)
	}
	if e.FromNodeID != "tbl" || e.FromPort != "selectedRow" {
		t.Errorf("from = %q.%q", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "frm" || e.ToPort != "setValues" {
		t.Errorf("to = %q.%q", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "reactive" {
		t.Errorf("edgeType = %q", e.EdgeType)
	}
}

func TestExtractEdges_autoAssignsID(t *testing.T) {
	t.Parallel()

	content := "```edges\n[\n  {\n    \"fromNodeId\": \"a\",\n    \"fromPort\": \"clicked\",\n    \"toNodeId\": \"b\",\n    \"toPort\": \"reset\",\n    \"edgeType\": \"reactive\"\n  }\n]\n```"
	edges, err := extractEdges(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if edges[0].ID == "" {
		t.Error("expected auto-assigned ID, got empty string")
	}
	if !strings.Contains(edges[0].ID, "a") || !strings.Contains(edges[0].ID, "b") {
		t.Errorf("auto ID = %q, expected to contain node IDs", edges[0].ID)
	}
}

func TestExtractEdges_malformed(t *testing.T) {
	t.Parallel()

	_, err := extractEdges("```edges\nnot json\n```")
	if err == nil {
		t.Error("expected error for malformed edges block")
	}
}

// ---- buildFlowNodesAndEdges -------------------------------------------------

func TestBuildFlowNodesAndEdges_singleStepForm(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:              "placeOrder",
			Name:             "Place Order",
			TriggerType:      "form_submit",
			TriggerWidgetRef: "orderForm",
			RequiresApproval: true,
			Steps: []genWorkflowStep{
				{Name: "Insert row", StepType: "mutation", Config: map[string]any{"connector_id": "abc"}},
			},
		},
	}
	refToID := map[string]string{"placeOrder": "uuid-wf"}

	dsl, edges := buildFlowNodesAndEdges(flows, refToID, "")

	// DSL should contain a flow:group and a step:mutation
	if !strings.Contains(dsl, "flow:group placeOrder_group") {
		t.Errorf("expected flow:group node; got:\n%s", dsl)
	}
	if !strings.Contains(dsl, "step:mutation placeOrder_step0") {
		t.Errorf("expected step:mutation node; got:\n%s", dsl)
	}
	// Group parent must be root
	if !strings.Contains(dsl, "flow:group placeOrder_group @ root") {
		t.Errorf("flow group parent should be @ root; got:\n%s", dsl)
	}
	// Step parent stays root; group membership is carried in style.parentGroupId.
	if !strings.Contains(dsl, "step:mutation placeOrder_step0 @ root") {
		t.Errorf("step parent should be @ root; got:\n%s", dsl)
	}
	if !strings.Contains(dsl, `parentGroupId: "placeOrder_group"`) {
		t.Errorf("step style should reference placeOrder_group; got:\n%s", dsl)
	}

	// Trigger edge: orderForm.values → placeOrder_step0.run
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d: %+v", len(edges), edges)
	}
	e := edges[0]
	if e.FromNodeID != "orderForm" || e.FromPort != "values" {
		t.Errorf("trigger edge from = %q.%q, want orderForm.values", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "placeOrder_step0" || e.ToPort != "run" {
		t.Errorf("trigger edge to = %q.%q, want placeOrder_step0.run", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "async" {
		t.Errorf("edge type = %q, want async", e.EdgeType)
	}
}

func TestBuildFlowNodesAndEdges_multiStepButton(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:              "deleteRecord",
			Name:             "Delete Record",
			TriggerType:      "button_click",
			TriggerWidgetRef: "deleteBtn",
			RequiresApproval: false,
			Steps: []genWorkflowStep{
				{Name: "Check permission", StepType: "condition"},
				{Name: "Delete row", StepType: "mutation"},
			},
		},
	}
	refToID := map[string]string{"deleteRecord": "uuid-wf2"}

	dsl, edges := buildFlowNodesAndEdges(flows, refToID, "")

	// Both step nodes
	if !strings.Contains(dsl, "step:condition deleteRecord_step0") {
		t.Errorf("expected step:condition; got:\n%s", dsl)
	}
	if !strings.Contains(dsl, "step:mutation deleteRecord_step1") {
		t.Errorf("expected step:mutation; got:\n%s", dsl)
	}

	// 3 edges: trigger + step0→step1 + (none for step1)
	if len(edges) != 2 {
		t.Fatalf("expected 2 edges (trigger + step chain), got %d: %+v", len(edges), edges)
	}
	// Trigger edge: deleteBtn.clicked → deleteRecord_step0.run
	trigger := edges[1] // trigger is appended after step chain
	if trigger.FromPort != "clicked" {
		t.Errorf("button trigger fromPort = %q, want clicked", trigger.FromPort)
	}
	// Step-to-step edge: deleteRecord_step0.output → deleteRecord_step1.run
	chain := edges[0]
	if chain.FromNodeID != "deleteRecord_step0" || chain.ToNodeID != "deleteRecord_step1" {
		t.Errorf("chain edge = %q→%q, want step0→step1", chain.FromNodeID, chain.ToNodeID)
	}
	if chain.FromPort != "trueBranch" {
		t.Errorf("chain fromPort = %q, want trueBranch", chain.FromPort)
	}
}

func TestBuildFlowNodesAndEdges_missingTriggerUsesLayoutAction(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:         "placeOrder",
			Name:        "Place Order",
			TriggerType: "form_submit",
			Steps: []genWorkflowStep{
				{Name: "Insert row", StepType: "mutation"},
			},
		},
	}
	refToID := map[string]string{"placeOrder": "uuid-wf"}
	layoutDSL := `form orderForm @ root
  action uuid-wf
;`

	_, edges := buildFlowNodesAndEdges(flows, refToID, layoutDSL)

	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d: %+v", len(edges), edges)
	}
	if edges[0].FromNodeID != "orderForm" || edges[0].FromPort != "values" {
		t.Fatalf("trigger edge = %q.%q, want orderForm.values", edges[0].FromNodeID, edges[0].FromPort)
	}
}

func TestBuildFlowNodesAndEdges_noRefInMap(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{Ref: "unknownRef", Name: "X", Steps: []genWorkflowStep{{StepType: "query"}}},
	}
	// refToID does not contain "unknownRef"
	dsl, edges := buildFlowNodesAndEdges(flows, map[string]string{}, "")
	if dsl != "" {
		t.Errorf("expected empty DSL when ref not in map, got: %q", dsl)
	}
	if len(edges) != 0 {
		t.Errorf("expected no edges, got %d", len(edges))
	}
}

func TestBuildFlowNodesAndEdges_invalidStepTypeDefaultsToQuery(t *testing.T) {
	t.Parallel()

	flows := []genWorkflow{
		{
			Ref:  "wf",
			Name: "WF",
			Steps: []genWorkflowStep{
				{Name: "Bad step", StepType: "invalid_type"},
			},
		},
	}
	refToID := map[string]string{"wf": "uuid"}

	dsl, _ := buildFlowNodesAndEdges(flows, refToID, "")
	if !strings.Contains(dsl, "step:query wf_step0") {
		t.Errorf("invalid step type should fall back to query; got:\n%s", dsl)
	}
}

func TestBuildWorkflowContextBlock_empty(t *testing.T) {
	t.Parallel()

	got := buildWorkflowContextBlock(nil)
	if !strings.Contains(got, "No workflows") {
		t.Errorf("expected 'No workflows' in empty result, got: %q", got)
	}
}

func TestBuildWorkflowContextBlock_withWorkflows(t *testing.T) {
	t.Parallel()

	wfs := []existingWorkflowInfo{
		{id: "uuid-1", name: "Submit Order", triggerType: "form_submit"},
		{id: "uuid-2", name: "Delete Record", triggerType: "button_click"},
	}
	got := buildWorkflowContextBlock(wfs)
	if !strings.Contains(got, "uuid-1") || !strings.Contains(got, "uuid-2") {
		t.Errorf("UUIDs not present in context block: %q", got)
	}
	if !strings.Contains(got, "Submit Order") {
		t.Errorf("workflow name not present: %q", got)
	}
}
