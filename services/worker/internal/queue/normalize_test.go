package queue

import (
	"strings"
	"testing"
)

// helpers ----------------------------------------------------------------

func makeStmts(nodes ...dslStatement) []dslStatement { return nodes }
func noEdges() []dslEdge                             { return nil }

// ---- normalizeInlineLinksGo --------------------------------------------

// Case 1: button on clicked -> mutation_step.run → async edge
func TestNormalizeInlineLinksGo_case1_buttonOnClicked(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "btn1", Element: "button", InlineLinks: []InlineLink{
			{Direction: "on", MyPort: "clicked", TargetNodeID: "mut1", TargetPort: "run"},
		}},
		dslStatement{ID: "mut1", Element: "step:mutation"},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	if e.ID != "e_btn1_clicked_mut1_run" {
		t.Errorf("ID = %q, want e_btn1_clicked_mut1_run", e.ID)
	}
	if e.FromNodeID != "btn1" || e.FromPort != "clicked" {
		t.Errorf("from = %s.%s, want btn1.clicked", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "mut1" || e.ToPort != "run" {
		t.Errorf("to = %s.%s, want mut1.run", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "async" {
		t.Errorf("edgeType = %q, want async", e.EdgeType)
	}
}

// Case 2: form on submitted -> mut.run → async edge
func TestNormalizeInlineLinksGo_case2_formOnSubmitted(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "form1", Element: "form", InlineLinks: []InlineLink{
			{Direction: "on", MyPort: "submitted", TargetNodeID: "mut1", TargetPort: "run"},
		}},
		dslStatement{ID: "mut1", Element: "step:mutation"},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	if e.FromNodeID != "form1" || e.FromPort != "submitted" {
		t.Errorf("from = %s.%s, want form1.submitted", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "mut1" || e.ToPort != "run" {
		t.Errorf("to = %s.%s, want mut1.run", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "async" {
		t.Errorf("edgeType = %q, want async", e.EdgeType)
	}
}

// Case 3: step output result -> table (widget) → reactive edge
func TestNormalizeInlineLinksGo_case3_outputToWidget(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "sq1", Element: "step:query", InlineLinks: []InlineLink{
			{Direction: "output", MyPort: "result", TargetNodeID: "table1", TargetPort: "setRows"},
		}},
		dslStatement{ID: "table1", Element: "table"},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	if e.FromNodeID != "sq1" || e.FromPort != "result" {
		t.Errorf("from = %s.%s, want sq1.result", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "table1" || e.ToPort != "setRows" {
		t.Errorf("to = %s.%s, want table1.setRows", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "reactive" {
		t.Errorf("edgeType = %q, want reactive", e.EdgeType)
	}
}

// Case 4: step output result -> next step:query → async edge
func TestNormalizeInlineLinksGo_case4_outputToStep(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "sq1", Element: "step:query", InlineLinks: []InlineLink{
			{Direction: "output", MyPort: "result", TargetNodeID: "sq2", TargetPort: "run"},
		}},
		dslStatement{ID: "sq2", Element: "step:query"},
	)
	edges, _ := normalizeInlineLinksGo(stmts, noEdges())

	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	if e.FromNodeID != "sq1" || e.FromPort != "result" {
		t.Errorf("from = %s.%s, want sq1.result", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "sq2" || e.ToPort != "run" {
		t.Errorf("to = %s.%s, want sq2.run", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "async" {
		t.Errorf("edgeType = %q, want async", e.EdgeType)
	}
}

// Case 5: condition trueBranch + falseBranch → two async edges
func TestNormalizeInlineLinksGo_case5_conditionBranches(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "cond1", Element: "step:condition", InlineLinks: []InlineLink{
			{Direction: "output", MyPort: "trueBranch", TargetNodeID: "approveStep", TargetPort: "run"},
			{Direction: "output", MyPort: "falseBranch", TargetNodeID: "rejectStep", TargetPort: "run"},
		}},
		dslStatement{ID: "approveStep", Element: "step:mutation"},
		dslStatement{ID: "rejectStep", Element: "step:mutation"},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(edges) != 2 {
		t.Fatalf("expected 2 edges, got %d", len(edges))
	}
	if edges[0].FromPort != "trueBranch" || edges[0].ToNodeID != "approveStep" || edges[0].EdgeType != "async" {
		t.Errorf("edge[0] = %+v; want trueBranch→approveStep async", edges[0])
	}
	if edges[1].FromPort != "falseBranch" || edges[1].ToNodeID != "rejectStep" || edges[1].EdgeType != "async" {
		t.Errorf("edge[1] = %+v; want falseBranch→rejectStep async", edges[1])
	}
}

// Case 6: input content <- q.firstRow.name → reactive edge q.firstRow.name → txt1.content
func TestNormalizeInlineLinksGo_case6_inputWithCompositePort(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "txt1", Element: "text", InlineLinks: []InlineLink{
			{Direction: "input", MyPort: "content", TargetNodeID: "q", TargetPort: "firstRow.name"},
		}},
		dslStatement{ID: "q", Element: "step:query"},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(edges))
	}
	e := edges[0]
	// Edge ID uses the composite port name as-is.
	if e.ID != "e_q_firstRow.name_txt1_content" {
		t.Errorf("ID = %q, want e_q_firstRow.name_txt1_content", e.ID)
	}
	if e.FromNodeID != "q" || e.FromPort != "firstRow.name" {
		t.Errorf("from = %s.%s, want q.firstRow.name", e.FromNodeID, e.FromPort)
	}
	if e.ToNodeID != "txt1" || e.ToPort != "content" {
		t.Errorf("to = %s.%s, want txt1.content", e.ToNodeID, e.ToPort)
	}
	if e.EdgeType != "reactive" {
		t.Errorf("edgeType = %q, want reactive", e.EdgeType)
	}
}

// Case 7: unknown target node ID → warning emitted, edge still present
func TestNormalizeInlineLinksGo_case7_unknownTargetWarning(t *testing.T) {
	t.Parallel()

	stmts := makeStmts(
		dslStatement{ID: "btn1", Element: "button", InlineLinks: []InlineLink{
			{Direction: "on", MyPort: "clicked", TargetNodeID: "ghost_node", TargetPort: "run"},
		}},
	)
	edges, warnings := normalizeInlineLinksGo(stmts, noEdges())

	if len(warnings) == 0 {
		t.Fatal("expected at least one warning for unknown target node")
	}
	if !strings.Contains(warnings[0], "ghost_node") {
		t.Errorf("warning %q should mention ghost_node", warnings[0])
	}
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge (dangling), got %d", len(edges))
	}
	e := edges[0]
	if e.FromNodeID != "btn1" || e.ToNodeID != "ghost_node" {
		t.Errorf("edge = %+v; want btn1→ghost_node", e)
	}
}

// Deduplication: existing edge with same ID is not duplicated
func TestNormalizeInlineLinksGo_deduplication(t *testing.T) {
	t.Parallel()

	existing := []dslEdge{{
		ID:         "e_btn1_clicked_mut1_run",
		FromNodeID: "btn1", FromPort: "clicked",
		ToNodeID: "mut1", ToPort: "run",
		EdgeType: "async",
	}}
	stmts := makeStmts(
		dslStatement{ID: "btn1", Element: "button", InlineLinks: []InlineLink{
			{Direction: "on", MyPort: "clicked", TargetNodeID: "mut1", TargetPort: "run"},
		}},
		dslStatement{ID: "mut1", Element: "step:mutation"},
	)
	edges, _ := normalizeInlineLinksGo(stmts, existing)

	if len(edges) != 1 {
		t.Fatalf("expected 1 edge (no dup), got %d", len(edges))
	}
}

// parseInlineLinkClauses round-trip: DSL text → InlineLink structs
func TestParseInlineLinkClauses_onClause(t *testing.T) {
	t.Parallel()

	stmt := "button btn1 @ root\n  on clicked -> mut1.run\n;"
	links := parseInlineLinkClauses(stmt)

	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	l := links[0]
	if l.Direction != "on" || l.MyPort != "clicked" || l.TargetNodeID != "mut1" || l.TargetPort != "run" {
		t.Errorf("link = %+v; want on clicked->mut1.run", l)
	}
}

func TestParseInlineLinkClauses_inputClause(t *testing.T) {
	t.Parallel()

	stmt := "text txt1 @ root\n  input content <- q.firstRow.name\n;"
	links := parseInlineLinkClauses(stmt)

	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	l := links[0]
	if l.Direction != "input" || l.MyPort != "content" || l.TargetNodeID != "q" || l.TargetPort != "firstRow.name" {
		t.Errorf("link = %+v; want input content<-q.firstRow.name", l)
	}
}

func TestParseInlineLinkClauses_outputClause(t *testing.T) {
	t.Parallel()

	stmt := "step:query sq1 @ root\n  output result -> table1.setRows\n;"
	links := parseInlineLinkClauses(stmt)

	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	l := links[0]
	if l.Direction != "output" || l.MyPort != "result" || l.TargetNodeID != "table1" || l.TargetPort != "setRows" {
		t.Errorf("link = %+v; want output result->table1.setRows", l)
	}
}
