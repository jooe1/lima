package queue

import (
	"strings"
	"testing"
)

// ---- parseWithFromStatement -------------------------------------------------

func TestParseWithFromStatement_basic(t *testing.T) {
	t.Parallel()

	stmt := "step:mutation s @ root\n  with connector=\"pg\" sql=\"INSERT INTO t (a) VALUES (1)\"\n;"
	got, err := parseWithFromStatement(stmt)
	if err != nil {
		t.Fatalf("parseWithFromStatement() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2; map = %v", len(got), got)
	}
	if got["connector"] != "pg" {
		t.Fatalf("connector = %q, want %q", got["connector"], "pg")
	}
	if got["sql"] != "INSERT INTO t (a) VALUES (1)" {
		t.Fatalf("sql = %q, want %q", got["sql"], "INSERT INTO t (a) VALUES (1)")
	}
}

func TestParseWithFromStatement_noWith(t *testing.T) {
	t.Parallel()

	stmt := "step:query s @ root\n;"
	got, err := parseWithFromStatement(stmt)
	if err != nil {
		t.Fatalf("parseWithFromStatement() error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}
}

func TestParseWithFromStatement_bareValue(t *testing.T) {
	t.Parallel()

	stmt := "step:action s @ root\n  with action=run_query\n;"
	got, err := parseWithFromStatement(stmt)
	if err != nil {
		t.Fatalf("parseWithFromStatement() error = %v", err)
	}
	if got["action"] != "run_query" {
		t.Fatalf("action = %q, want %q", got["action"], "run_query")
	}
}

// ---- buildStepsFromDSL ------------------------------------------------------

func TestBuildStepsFromDSL_linearChain(t *testing.T) {
	t.Parallel()

	dsl := "step:query stepA @ root\n  with connector=\"pg\" sql=\"SELECT 1\"\n;\n" +
		"step:mutation stepB @ root\n  with connector=\"pg\" sql=\"INSERT INTO t VALUES (1)\"\n;"

	edges := []dslEdge{
		{ID: "e1", FromNodeID: "stepA", ToNodeID: "stepB", EdgeType: "async"},
	}

	steps, err := buildStepsFromDSL("wf1", dsl, edges)
	if err != nil {
		t.Fatalf("buildStepsFromDSL() error = %v", err)
	}
	if len(steps) != 2 {
		t.Fatalf("len(steps) = %d, want 2", len(steps))
	}
	if steps[0].id != "stepA" {
		t.Fatalf("steps[0].id = %q, want stepA", steps[0].id)
	}
	if steps[0].nextStepID == nil || *steps[0].nextStepID != "stepB" {
		t.Fatalf("steps[0].nextStepID = %v, want &\"stepB\"", steps[0].nextStepID)
	}
	if steps[0].stepOrder != 0 {
		t.Fatalf("steps[0].stepOrder = %d, want 0", steps[0].stepOrder)
	}
	if steps[1].id != "stepB" {
		t.Fatalf("steps[1].id = %q, want stepB", steps[1].id)
	}
	if steps[1].nextStepID != nil {
		t.Fatalf("steps[1].nextStepID = %v, want nil", steps[1].nextStepID)
	}
}

func TestBuildStepsFromDSL_conditionBranch(t *testing.T) {
	t.Parallel()

	dsl := "step:condition cond @ root\n  with expr=\"x > 0\"\n;\n" +
		"step:query stepA @ root\n  with connector=\"pg\" sql=\"SELECT 1\"\n;\n" +
		"step:query stepB @ root\n  with connector=\"pg\" sql=\"SELECT 2\"\n;"

	edges := []dslEdge{
		{ID: "e1", FromNodeID: "cond", ToNodeID: "stepA", FromPort: "trueBranch", EdgeType: "async"},
		{ID: "e2", FromNodeID: "cond", ToNodeID: "stepB", FromPort: "falseBranch", EdgeType: "async"},
	}

	steps, err := buildStepsFromDSL("wf1", dsl, edges)
	if err != nil {
		t.Fatalf("buildStepsFromDSL() error = %v", err)
	}
	if len(steps) != 3 {
		t.Fatalf("len(steps) = %d, want 3", len(steps))
	}

	first := steps[0]
	if first.id != "cond" {
		t.Fatalf("steps[0].id = %q, want cond", first.id)
	}
	if first.nextStepID == nil || *first.nextStepID != "stepA" {
		t.Fatalf("steps[0].nextStepID = %v, want &\"stepA\"", first.nextStepID)
	}
	if first.falseBranchStepID == nil || *first.falseBranchStepID != "stepB" {
		t.Fatalf("steps[0].falseBranchStepID = %v, want &\"stepB\"", first.falseBranchStepID)
	}
}

func TestBuildStepsFromDSL_cycle(t *testing.T) {
	t.Parallel()

	dsl := "step:query stepA @ root\n;\nstep:query stepB @ root\n;"

	edges := []dslEdge{
		{ID: "e1", FromNodeID: "stepA", ToNodeID: "stepB", EdgeType: "async"},
		{ID: "e2", FromNodeID: "stepB", ToNodeID: "stepA", EdgeType: "async"},
	}

	_, err := buildStepsFromDSL("wf1", dsl, edges)
	if err == nil {
		t.Fatal("buildStepsFromDSL() error = nil, want cycle error")
	}
	if !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("error = %q, want it to contain \"cycle\"", err.Error())
	}
}

func TestBuildStepsFromDSL_noEdges(t *testing.T) {
	t.Parallel()

	dsl := "step:query stepA @ root\n  with connector=\"pg\" sql=\"SELECT 1\"\n;\n" +
		"step:mutation stepB @ root\n  with connector=\"pg\" sql=\"INSERT INTO t VALUES (1)\"\n;"

	steps, err := buildStepsFromDSL("wf1", dsl, nil)
	if err != nil {
		t.Fatalf("buildStepsFromDSL() error = %v", err)
	}
	if len(steps) != 2 {
		t.Fatalf("len(steps) = %d, want 2", len(steps))
	}
	for _, s := range steps {
		if s.nextStepID != nil {
			t.Fatalf("step %q: nextStepID = %v, want nil", s.id, s.nextStepID)
		}
		if s.falseBranchStepID != nil {
			t.Fatalf("step %q: falseBranchStepID = %v, want nil", s.id, s.falseBranchStepID)
		}
	}
}

// ---- repairGeneratedDSLCommonSyntax ----------------------------------------

func TestRepairGeneratedDSLCommonSyntax_AddsRootParent(t *testing.T) {
	t.Parallel()

	raw := "container root\n" +
		"  layout direction=\"column\" gap=\"16\"\n" +
		";\n" +
		"form order_form\n" +
		"  text \"Order Form\"\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 2 {
		t.Fatalf("len(notes) = %d, want 2; notes=%v", len(notes), notes)
	}
	if !strings.Contains(repaired, "container root @ root") {
		t.Fatalf("repaired DSL missing container root parent: %q", repaired)
	}
	if !strings.Contains(repaired, "form order_form @ root") {
		t.Fatalf("repaired DSL missing form root parent: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

func TestRepairGeneratedDSLCommonSyntax_SplitsCompactParentToken(t *testing.T) {
	t.Parallel()

	raw := "form order_form @root\n" +
		"  text \"Order Form\"\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 1 {
		t.Fatalf("len(notes) = %d, want 1; notes=%v", len(notes), notes)
	}
	if !strings.Contains(repaired, "form order_form @ root") {
		t.Fatalf("repaired DSL missing split parent token: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

func TestRepairGeneratedDSLCommonSyntax_RewritesFormFieldsClause(t *testing.T) {
	t.Parallel()

	raw := "form order_form @ right_panel\n" +
		"  fields OrderID, Date, CustomerName, Product, Category\n" +
		"  on submitted -> save_order.params\n" +
		";\n" +
		"step:mutation save_order @ root\n" +
		"  with connector=\"orders\" operation=\"insert\"\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 1 {
		t.Fatalf("len(notes) = %d, want 1; notes=%v", len(notes), notes)
	}
	if !strings.Contains(repaired, `with fields="OrderID, Date, CustomerName, Product, Category"`) {
		t.Fatalf("repaired DSL missing rewritten with fields clause: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

func TestRepairGeneratedDSLCommonSyntax_MergesSplitParentLine(t *testing.T) {
	t.Parallel()

	raw := "table orders_table\n" +
		"  @ page_shell\n" +
		"  with columns=\"OrderID,Date\"\n" +
		";\n" +
		"container page_shell @ root\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 1 {
		t.Fatalf("len(notes) = %d, want 1; notes=%v", len(notes), notes)
	}
	if !strings.Contains(repaired, "table orders_table @ page_shell") {
		t.Fatalf("repaired DSL missing merged split parent line: %q", repaired)
	}
	if strings.Contains(repaired, "\n  @ page_shell") {
		t.Fatalf("repaired DSL still contains stray split parent line: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

func TestRepairGeneratedDSLCommonSyntax_DoesNotTreatTextClauseAsHeader(t *testing.T) {
	t.Parallel()

	raw := "table orders_table @ content_row\n" +
		"  text \"Orders\"\n" +
		"  with columns=\"OrderID,Date\"\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 0 {
		t.Fatalf("len(notes) = %d, want 0; notes=%v", len(notes), notes)
	}
	if strings.Contains(repaired, `text "Orders" @ root`) {
		t.Fatalf("repaired DSL incorrectly promoted a text clause into a header: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

func TestRepairGeneratedDSLCommonSyntax_StripsStrayParentSuffixFromTextClause(t *testing.T) {
	t.Parallel()

	raw := "table orders_table @ content_row\n" +
		"  text \"Orders\" @ root\n" +
		"  with columns=\"OrderID,Date\"\n" +
		";"

	repaired, notes := repairGeneratedDSLCommonSyntax(raw)
	if len(notes) != 1 {
		t.Fatalf("len(notes) = %d, want 1; notes=%v", len(notes), notes)
	}
	if !strings.Contains(repaired, `text "Orders"`) || strings.Contains(repaired, `text "Orders" @ root`) {
		t.Fatalf("repaired DSL should strip the stray parent suffix from the text clause: %q", repaired)
	}
	if err := validateDSL(repaired); err != nil {
		t.Fatalf("validateDSL(repaired) unexpected error = %v; repaired=%q", err, repaired)
	}
}

// ---- validateDSL (semantic inline-link checks) ------------------------------

// TestValidateDSL_validInlineLink verifies that a form node wired to a
// step:query via "on submitted" passes validation. step:query accepts any
// input port name because its only input ("params") is dynamic.
func TestValidateDSL_validInlineLink(t *testing.T) {
	t.Parallel()

	dsl := "form form1 @ root\n" +
		"  on submitted -> step1.run\n" +
		";\n" +
		"step:query step1 @ root\n" +
		"  with connector=\"pg\" sql=\"SELECT 1\"\n" +
		";"

	if err := validateDSL(dsl); err != nil {
		t.Fatalf("validateDSL() unexpected error = %v", err)
	}
}

func TestValidateDSL_validInputClause(t *testing.T) {
	t.Parallel()

	dsl := "table orders_table @ root\n" +
		"  input setRows <- load_orders.result\n" +
		";\n" +
		"step:query load_orders @ root\n" +
		"  with connector=\"pg\" sql=\"SELECT 1\"\n" +
		";"

	if err := validateDSL(dsl); err != nil {
		t.Fatalf("validateDSL() unexpected error = %v", err)
	}
}

// TestValidateDSL_unknownTargetNode verifies that a link to a node not present
// in the DSL source returns an error.
func TestValidateDSL_unknownTargetNode(t *testing.T) {
	t.Parallel()

	dsl := "form form1 @ root\n" +
		"  on submitted -> ghostNode.run\n" +
		";"

	err := validateDSL(dsl)
	if err == nil {
		t.Fatal("validateDSL() error = nil, want unknown target node error")
	}
	if !strings.Contains(err.Error(), "ghostNode") {
		t.Fatalf("error = %q, expected it to mention %q", err.Error(), "ghostNode")
	}
}

func TestValidateDSL_placeholderHeaderRejected(t *testing.T) {
	t.Parallel()

	dsl := "<element> <id> @ <parentId>\n;"

	err := validateDSL(dsl)
	if err == nil {
		t.Fatal("validateDSL() error = nil, want placeholder token rejection")
	}
	if !strings.Contains(err.Error(), "bracket/XML attribute syntax not allowed") {
		t.Fatalf("error = %q, expected placeholder-token rejection", err.Error())
	}
}

func TestValidateDSL_placeholderInputClauseRejected(t *testing.T) {
	t.Parallel()

	dsl := "table orders_table @ root\n" +
		"  input <myInputPort> <- <sourceNodeId>.<sourceOutputPort>\n" +
		";"

	err := validateDSL(dsl)
	if err == nil {
		t.Fatal("validateDSL() error = nil, want placeholder token rejection")
	}
	if !strings.Contains(err.Error(), "bracket/XML attribute syntax not allowed") {
		t.Fatalf("error = %q, expected placeholder-token rejection", err.Error())
	}
}

func TestValidateDSL_unknownClauseRejected(t *testing.T) {
	t.Parallel()

	dsl := "table orders_table @ root\n" +
		"  @ page_shell\n" +
		"  with columns=\"OrderID\"\n" +
		";"

	err := validateDSL(dsl)
	if err == nil {
		t.Fatal("validateDSL() error = nil, want unknown clause rejection")
	}
	if !strings.Contains(err.Error(), "unknown clause '@' in node 'orders_table'") {
		t.Fatalf("error = %q, expected unknown clause rejection", err.Error())
	}
}

// TestValidateDSL_wrongPortName verifies that using a port name that does not
// exist on a known element (with no dynamic wildcard) returns an error.
func TestValidateDSL_wrongPortName(t *testing.T) {
	t.Parallel()

	// button has only "clicked" and "clickedAt" outputs — no dynamic ports.
	dsl := "button btn1 @ root\n" +
		"  on noSuchPort -> step1.run\n" +
		";\n" +
		"step:mutation step1 @ root\n" +
		"  with connector=\"pg\" sql=\"INSERT INTO t VALUES (1)\"\n" +
		";"

	err := validateDSL(dsl)
	if err == nil {
		t.Fatal("validateDSL() error = nil, want wrong port error")
	}
	if !strings.Contains(err.Error(), "noSuchPort") {
		t.Fatalf("error = %q, expected it to mention %q", err.Error(), "noSuchPort")
	}
}

// TestValidateDSL_dynamicWildcardPort verifies that using "*" as a port name
// is accepted when the element exposes a dynamic output port.
func TestValidateDSL_dynamicWildcardPort(t *testing.T) {
	t.Parallel()

	// form has a dynamic output port named "*" (one port per form field).
	// step:mutation has "run" as a static input port.
	dsl := "form form1 @ root\n" +
		"  on * -> step1.run\n" +
		";\n" +
		"step:mutation step1 @ root\n" +
		"  with connector=\"pg\" sql=\"INSERT INTO t VALUES (1)\"\n" +
		";"

	if err := validateDSL(dsl); err != nil {
		t.Fatalf("validateDSL() unexpected error = %v", err)
	}
}

// TestValidateDSL_unknownElementPassthrough verifies that nodes with an
// unrecognised element type are not rejected — future elements must not break
// the validator.
func TestValidateDSL_unknownElementPassthrough(t *testing.T) {
	t.Parallel()

	dsl := "future:widget w1 @ root\n" +
		"  on someEvent -> step1.run\n" +
		";\n" +
		"step:mutation step1 @ root\n" +
		"  with connector=\"pg\" sql=\"INSERT INTO t VALUES (1)\"\n" +
		";"

	if err := validateDSL(dsl); err != nil {
		t.Fatalf("validateDSL() unexpected error = %v", err)
	}
}
