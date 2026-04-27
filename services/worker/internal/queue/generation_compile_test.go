package queue

import (
	"regexp"
	"strings"
	"testing"
)

func TestCompileManagedCRUDAuthoringRuntimeDSL_LowersFlatCRUDAuthoring(t *testing.T) {
	t.Parallel()

	src := `app order_admin
entity order connector=orders primary_key=OrderID
page main title="Orders"

stack shell @ main direction=column gap=16

widget form order_form @ shell title="Order Form"
field order_form OrderID
field order_form CustomerName
field order_form Amount
field order_form Status

widget table orders @ shell title="Orders"
column orders OrderID
column orders CustomerName
column orders Amount
column orders Status

widget button delete_order @ shell label="Delete" variant=danger

action save_order @ main kind=managed_crud entity=order mode=upsert form=order_form table=orders
action delete_order_action @ main kind=delete_selected entity=order source=orders

bind orders.selected_row -> order_form.values
run order_form.submitted -> save_order
run delete_order.clicked -> delete_order_action
effect save_order.success -> orders.refresh
effect save_order.success -> order_form.reset
effect delete_order_action.success -> orders.refresh`

	runtime, notes, changed, err := compileManagedCRUDAuthoringRuntimeDSL(src)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringRuntimeDSL() error = %v", err)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringRuntimeDSL() changed = false, want true")
	}
	if len(notes) == 0 {
		t.Fatal("compileManagedCRUDAuthoringRuntimeDSL() notes empty, want compiler note")
	}
	if !strings.Contains(runtime, `container main @ root`) {
		t.Fatalf("runtime DSL missing lowered page container:\n%s", runtime)
	}
	if !strings.Contains(runtime, `container shell @ main`) {
		t.Fatalf("runtime DSL missing lowered layout container:\n%s", runtime)
	}
	if !strings.Contains(runtime, `form order_form @ shell`) {
		t.Fatalf("runtime DSL missing lowered form widget:\n%s", runtime)
	}
	if got := mustLastWithValue(t, runtime, "order_form", "fields"); got != "OrderID,CustomerName,Amount,Status" {
		t.Fatalf("effective order_form fields = %q, want %q\nruntime:\n%s", got, "OrderID,CustomerName,Amount,Status", runtime)
	}
	if got := mustLastWithValue(t, runtime, "orders", "columns"); got != "OrderID,CustomerName,Amount,Status" {
		t.Fatalf("effective orders columns = %q, want %q\nruntime:\n%s", got, "OrderID,CustomerName,Amount,Status", runtime)
	}
	if !strings.Contains(runtime, `step:mutation save_order @ main`) {
		t.Fatalf("runtime DSL missing lowered managed action placeholder:\n%s", runtime)
	}
	if !strings.Contains(runtime, `step:mutation delete_order_action @ main`) {
		t.Fatalf("runtime DSL missing lowered delete action placeholder:\n%s", runtime)
	}
	if err := validateDSL(runtime); err != nil {
		t.Fatalf("validateDSL(runtime) error = %v\nruntime:\n%s", err, runtime)
	}

	plan := &appPlan{
		Intent:          "crud",
		ConnectorID:     "conn_orders",
		ConnectorType:   "managed",
		Entity:          "order",
		FormFields:      []string{"OrderID", "CustomerName", "Amount", "Status"},
		TableFields:     []string{"OrderID", "CustomerName", "Amount", "Status"},
		CRUDMode:        "upsert",
		PrimaryKeyField: "OrderID",
		WorkflowName:    "Save Order",
		WorkflowRef:     "saveOrder",
	}
	connectors := []genConnector{{
		id:      "conn_orders",
		name:    "Orders",
		cType:   "managed",
		columns: []string{"OrderID", "CustomerName", "Amount", "Status"},
	}}

	compiled, edges, _, compiledManaged, err := compileManagedCRUDAuthoringDSL(runtime, plan, connectors)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringDSL(runtime) error = %v", err)
	}
	if !compiledManaged {
		t.Fatal("compileManagedCRUDAuthoringDSL(runtime) changed = false, want true")
	}
	if !hasInlineLink(compiled, "orders", "output", "selectedRow", "order_form", "setValues") {
		t.Fatalf("compiled DSL missing deterministic selectedRow -> form.setValues wiring:\n%s", compiled)
	}
	if !hasInlineLink(compiled, "order_form", "on", "submitted", "managed_has_order_key", "value") {
		t.Fatalf("compiled DSL missing deterministic submit -> upsert condition wiring:\n%s", compiled)
	}
	if !hasBindingEdge(edges, "orders", "selectedRow.OrderID", "managed_delete_order", "bind:where:0") {
		t.Fatalf("compiler edges missing selected row -> delete binding:\n%+v", edges)
	}
	if err := validateDSL(compiled); err != nil {
		t.Fatalf("validateDSL(compiled) error = %v\ncompiled:\n%s", err, compiled)
	}
}

func TestCompileManagedCRUDAuthoringRuntimeDSL_RejectsUnsupportedActionKinds(t *testing.T) {
	t.Parallel()

	src := `page main title="Revenue Dashboard"
widget chart revenue_chart @ main title="Revenue"
action load_revenue @ main kind=query source=order target=revenue_chart
run page.loaded -> load_revenue`

	compiled, notes, changed, err := compileManagedCRUDAuthoringRuntimeDSL(src)
	if err == nil {
		t.Fatal("compileManagedCRUDAuthoringRuntimeDSL() error = nil, want unsupported action kind error")
	}
	if changed {
		t.Fatalf("compileManagedCRUDAuthoringRuntimeDSL() changed = true, want false\ncompiled:\n%s", compiled)
	}
	if len(notes) != 0 {
		t.Fatalf("compileManagedCRUDAuthoringRuntimeDSL() notes = %q, want empty on failure", notes)
	}
	if !strings.Contains(err.Error(), "managed_crud and delete_selected") {
		t.Fatalf("error = %q, want managed CRUD support message", err.Error())
	}
}

func TestCompileManagedCRUDAuthoringRuntimeDSL_LowersWidgetBindsForLayoutOnlyAuthoring(t *testing.T) {
	t.Parallel()

	src := `page main title="Dashboard"
widget filter status_filter @ main label="Status"
option status_filter Open value=open
option status_filter Closed value=closed
widget table orders @ main title="Orders"
column orders OrderID
column orders Status
widget form order_form @ main title="Order Form"
field order_form Status
bind status_filter.value -> orders.filter.Status
bind orders.selected_row.Status -> order_form.values.Status`

	runtime, notes, changed, err := compileManagedCRUDAuthoringRuntimeDSL(src)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringRuntimeDSL() error = %v", err)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringRuntimeDSL() changed = false, want true")
	}
	if len(notes) == 0 {
		t.Fatal("compileManagedCRUDAuthoringRuntimeDSL() notes empty, want compiler note")
	}
	if !strings.Contains(runtime, `options: "open,closed";`) {
		t.Fatalf("runtime DSL missing lowered filter options style:\n%s", runtime)
	}
	if !hasInlineLink(runtime, "status_filter", "output", "value", "orders", "setFilter.Status") {
		t.Fatalf("runtime DSL missing lowered filter binding:\n%s", runtime)
	}
	if !hasInlineLink(runtime, "orders", "output", "selectedRow.Status", "order_form", "setValues.Status") {
		t.Fatalf("runtime DSL missing lowered table-to-form binding:\n%s", runtime)
	}
	if err := validateDSL(runtime); err != nil {
		t.Fatalf("validateDSL(runtime) error = %v\nruntime:\n%s", err, runtime)
	}
}

func TestCompileManagedCRUDAuthoringDSL_InjectsManagedBindingAndInsertStep(t *testing.T) {
	t.Parallel()

	src := `container page_shell @ root
  layout direction="column" gap="16"
;

form order_form @ page_shell
  text "Order Form"
  with fields="OrderID,CustomerName,Amount"
  on submitted -> save_order.params
;

table orders_table @ page_shell
  with columns="OrderID,CustomerName,Amount"
  input setRows <- load_orders.rows
;

step:mutation save_order @ root
  text "Save Order"
;`

	plan := &appPlan{
		Intent:        "crud",
		ConnectorID:   "conn_orders",
		ConnectorType: "managed",
		Entity:        "order",
		FormFields:    []string{"OrderID", "CustomerName", "Amount"},
		TableFields:   []string{"OrderID", "CustomerName", "Amount"},
		CRUDMode:      "insert",
		WorkflowName:  "Save Order",
		WorkflowRef:   "saveOrder",
	}
	connectors := []genConnector{{
		id:      "conn_orders",
		name:    "Orders",
		cType:   "managed",
		columns: []string{"OrderID", "CustomerName", "Amount"},
	}}

	compiled, edges, notes, changed, err := compileManagedCRUDAuthoringDSL(src, plan, connectors)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringDSL() error = %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("compiler edges = %d, want 0 for insert-only layout\n%+v", len(edges), edges)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringDSL() changed = false, want true")
	}
	if len(notes) == 0 {
		t.Fatal("compileManagedCRUDAuthoringDSL() notes empty, want compiler note")
	}
	if strings.Contains(compiled, "save_order.params") {
		t.Fatalf("compiled DSL kept legacy mutation params trigger:\n%s", compiled)
	}
	if strings.Contains(compiled, "step:mutation save_order @ root") {
		t.Fatalf("compiled DSL kept AI-authored mutation step instead of replacing it:\n%s", compiled)
	}
	if !strings.Contains(compiled, `with columns="OrderID,CustomerName,Amount"`) {
		t.Fatalf("compiled DSL lost table columns config:\n%s", compiled)
	}
	if !strings.Contains(compiled, `connector="conn_orders" connectorType="managed" sql="SELECT \"OrderID\", \"CustomerName\", \"Amount\" FROM Orders"`) {
		t.Fatalf("compiled DSL missing managed table binding:\n%s", compiled)
	}
	if !strings.Contains(compiled, `on submitted -> managed_save_order.run`) {
		t.Fatalf("compiled DSL missing canonical mutation trigger:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_save_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized mutation step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `with connector_id="conn_orders" sql="INSERT INTO Orders (\"OrderID\", \"CustomerName\", \"Amount\") VALUES ('{{OrderID}}', '{{CustomerName}}', '{{Amount}}')"`) {
		t.Fatalf("compiled DSL missing concrete managed insert SQL:\n%s", compiled)
	}
	if !hasInlineLink(compiled, "orders_table", "output", "selectedRow", "order_form", "setValues") {
		t.Fatalf("compiled DSL missing table selection wiring into the form:\n%s", compiled)
	}
	if !strings.Contains(compiled, `output result -> orders_table.refresh`) {
		t.Fatalf("compiled DSL missing table refresh wiring:\n%s", compiled)
	}
	if !strings.Contains(compiled, `output result -> order_form.reset`) {
		t.Fatalf("compiled DSL missing form reset wiring:\n%s", compiled)
	}
	if err := validateDSL(compiled); err != nil {
		t.Fatalf("validateDSL(compiled) error = %v\ncompiled:\n%s", err, compiled)
	}
}

func TestCompileManagedCRUDAuthoringDSL_InferManagedPlanFromGeneratedAura(t *testing.T) {
	t.Parallel()

	src := `container page_shell @ root
  layout direction="column" gap="16"
;

form order_form @ page_shell
  text "Order Form"
  with fields="OrderID,CustomerName,Amount"
  on submitted -> save_order.params
;

table orders_table @ page_shell
  with columns="OrderID,CustomerName,Amount"
  input setRows <- load_orders.rows
;

step:query load_orders @ root
  text "Load Orders"
;

step:mutation save_order @ root
  text "Save Order"
;`

	connectors := []genConnector{{
		id:      "conn_orders",
		name:    "Orders",
		cType:   "managed",
		columns: []string{"OrderID", "CustomerName", "Amount"},
	}}

	compiled, edges, notes, changed, err := compileManagedCRUDAuthoringDSL(src, nil, connectors)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringDSL() error = %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("compiler edges = %d, want 0 for inferred insert-only layout\n%+v", len(edges), edges)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringDSL() changed = false, want true")
	}
	if !strings.Contains(strings.Join(notes, "\n"), "inferred the managed CRUD contract") {
		t.Fatalf("compileManagedCRUDAuthoringDSL() notes = %q, want inferred-plan note", notes)
	}
	if strings.Contains(compiled, "step:query load_orders @ root") || strings.Contains(compiled, "step:mutation save_order @ root") {
		t.Fatalf("compiled DSL kept raw AI-authored managed step nodes:\n%s", compiled)
	}
	if !strings.Contains(compiled, `connector="conn_orders" connectorType="managed" sql="SELECT \"OrderID\", \"CustomerName\", \"Amount\" FROM Orders"`) {
		t.Fatalf("compiled DSL missing inferred managed table binding:\n%s", compiled)
	}
	if !strings.Contains(compiled, `on submitted -> managed_has_order_key.value`) {
		t.Fatalf("compiled DSL missing canonical inferred submit trigger:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:condition managed_has_order_key @ root`) {
		t.Fatalf("compiled DSL missing synthesized inferred upsert condition step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_update_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized inferred update step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_insert_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized inferred insert step:\n%s", compiled)
	}
	if err := validateDSL(compiled); err != nil {
		t.Fatalf("validateDSL(compiled) error = %v\ncompiled:\n%s", err, compiled)
	}
}

func TestCompileManagedCRUDAuthoringDSL_NormalizesFormAndTableContract(t *testing.T) {
	t.Parallel()

	src := `container page_shell @ root
  layout direction="column" gap="16"
;

form order_form @ page_shell
  text "Order Form"
  with fields="Name"
;

table orders_table @ page_shell
  with columns="Name"
  input setRows <- ai_load.rows
;`

	plan := &appPlan{
		Intent:          "crud",
		ConnectorID:     "conn_orders",
		ConnectorType:   "managed",
		Entity:          "order",
		FormFields:      []string{"OrderID", "CustomerName", "Amount"},
		TableFields:     []string{"OrderID", "CustomerName", "Amount", "Status"},
		CRUDMode:        "upsert",
		PrimaryKeyField: "OrderID",
		WorkflowName:    "Save Order",
		WorkflowRef:     "saveOrder",
	}
	connectors := []genConnector{{
		id:      "conn_orders",
		name:    "Orders",
		cType:   "managed",
		columns: []string{"OrderID", "CustomerName", "Amount", "Status"},
	}}

	compiled, edges, _, changed, err := compileManagedCRUDAuthoringDSL(src, plan, connectors)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringDSL() error = %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("compiler edges = %d, want 0 when no delete flow is synthesized\n%+v", len(edges), edges)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringDSL() changed = false, want true")
	}
	if got := mustLastWithValue(t, compiled, "order_form", "fields"); got != "OrderID,CustomerName,Amount" {
		t.Fatalf("effective order_form fields = %q, want %q\ncompiled:\n%s", got, "OrderID,CustomerName,Amount", compiled)
	}
	if got := mustLastWithValue(t, compiled, "orders_table", "columns"); got != "OrderID,CustomerName,Amount,Status" {
		t.Fatalf("effective orders_table columns = %q, want %q\ncompiled:\n%s", got, "OrderID,CustomerName,Amount,Status", compiled)
	}
	if !hasInlineLink(compiled, "orders_table", "output", "selectedRow", "order_form", "setValues") {
		t.Fatalf("compiled DSL missing deterministic selectedRow -> form.setValues wiring:\n%s", compiled)
	}
	if !hasInlineLink(compiled, "order_form", "on", "submitted", "managed_has_order_key", "value") {
		t.Fatalf("compiled DSL missing deterministic submit -> upsert condition wiring:\n%s", compiled)
	}
	if !hasInlineLink(compiled, "managed_has_order_key", "output", "trueBranch", "managed_update_order", "run") {
		t.Fatalf("compiled DSL missing deterministic true branch -> update wiring:\n%s", compiled)
	}
	if !hasInlineLink(compiled, "managed_has_order_key", "output", "falseBranch", "managed_insert_order", "run") {
		t.Fatalf("compiled DSL missing deterministic false branch -> insert wiring:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:condition managed_has_order_key @ root`) {
		t.Fatalf("compiled DSL missing synthesized upsert condition step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_update_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized update step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `with connector_id="conn_orders" sql="UPDATE Orders SET \"CustomerName\"='{{CustomerName}}', \"Amount\"='{{Amount}}' WHERE \"OrderID\"='{{OrderID}}'"`) {
		t.Fatalf("compiled DSL missing concrete managed update SQL:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_insert_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized insert step for upsert fallback:\n%s", compiled)
	}
	if err := validateDSL(compiled); err != nil {
		t.Fatalf("validateDSL(compiled) error = %v\ncompiled:\n%s", err, compiled)
	}
}

func TestCompileManagedCRUDAuthoringDSL_SynthesizesDeleteFlowFromDeleteButton(t *testing.T) {
	t.Parallel()

	src := `container page_shell @ root
  layout direction="column" gap="16"
;

table orders_table @ page_shell
  with columns="CustomerName,Amount"
;

button delete_order @ page_shell
  text "Delete order"
  style {
    variant: "danger";
  }
;`

	plan := &appPlan{
		Intent:          "crud",
		ConnectorID:     "conn_orders",
		ConnectorType:   "managed",
		Entity:          "order",
		TableFields:     []string{"CustomerName", "Amount"},
		CRUDMode:        "update",
		PrimaryKeyField: "OrderID",
		WorkflowName:    "Save Order",
		WorkflowRef:     "saveOrder",
	}
	connectors := []genConnector{{
		id:      "conn_orders",
		name:    "Orders",
		cType:   "managed",
		columns: []string{"OrderID", "CustomerName", "Amount"},
	}}

	compiled, edges, notes, changed, err := compileManagedCRUDAuthoringDSL(src, plan, connectors)
	if err != nil {
		t.Fatalf("compileManagedCRUDAuthoringDSL() error = %v", err)
	}
	if !changed {
		t.Fatal("compileManagedCRUDAuthoringDSL() changed = false, want true")
	}
	if len(notes) == 0 {
		t.Fatal("compileManagedCRUDAuthoringDSL() notes empty, want compiler note")
	}
	if got := mustLastWithValue(t, compiled, "orders_table", "columns"); got != "CustomerName,Amount,OrderID" {
		t.Fatalf("effective orders_table columns = %q, want %q\ncompiled:\n%s", got, "CustomerName,Amount,OrderID", compiled)
	}
	if !hasInlineLink(compiled, "delete_order", "on", "clicked", "managed_delete_order", "run") {
		t.Fatalf("compiled DSL missing deterministic delete button wiring:\n%s", compiled)
	}
	if !strings.Contains(compiled, `step:mutation managed_delete_order @ root`) {
		t.Fatalf("compiled DSL missing synthesized delete step:\n%s", compiled)
	}
	if !strings.Contains(compiled, `with connector_id="conn_orders" sql="DELETE FROM Orders WHERE \"OrderID\"='{{slot.where.0}}'"`) {
		t.Fatalf("compiled DSL missing concrete managed delete SQL:\n%s", compiled)
	}
	if !hasBindingEdge(edges, "orders_table", "selectedRow.OrderID", "managed_delete_order", "bind:where:0") {
		t.Fatalf("compiler edges missing selected row -> delete binding:\n%+v", edges)
	}
	if err := validateDSL(compiled); err != nil {
		t.Fatalf("validateDSL(compiled) error = %v\ncompiled:\n%s", err, compiled)
	}
}

func mustLastWithValue(t *testing.T, src, nodeID, key string) string {
	t.Helper()
	stmts, _, err := parseDSLStatements(src)
	if err != nil {
		t.Fatalf("parseDSLStatements() error = %v", err)
	}
	stmt, ok := stmts[nodeID]
	if !ok {
		t.Fatalf("node %q not found in DSL:\n%s", nodeID, src)
	}
	re := regexp.MustCompile(regexp.QuoteMeta(key) + `="((?:[^"\\]|\\.)*)"`)
	matches := re.FindAllStringSubmatch(stmt, -1)
	if len(matches) == 0 {
		t.Fatalf("node %q missing %s entry in with clause:\n%s", nodeID, key, stmt)
	}
	return matches[len(matches)-1][1]
}

func hasInlineLink(src, nodeID, direction, myPort, targetNodeID, targetPort string) bool {
	stmts, err := parseDSLStatementsStructured(src)
	if err != nil {
		return false
	}
	for _, stmt := range stmts {
		if stmt.ID != nodeID {
			continue
		}
		for _, link := range stmt.InlineLinks {
			if link.Direction == direction && link.MyPort == myPort && link.TargetNodeID == targetNodeID && link.TargetPort == targetPort {
				return true
			}
		}
	}
	return false
}

func hasBindingEdge(edges []dslEdge, fromNodeID, fromPort, toNodeID, toPort string) bool {
	for _, edge := range edges {
		if edge.EdgeType == "binding" && edge.FromNodeID == fromNodeID && edge.FromPort == fromPort && edge.ToNodeID == toNodeID && edge.ToPort == toPort {
			return true
		}
	}
	return false
}
