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
