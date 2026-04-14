package queue

import (
	"context"
	"testing"
)

func TestResolveInputRefWidgetPort(t *testing.T) {
	t.Parallel()

	got := resolveInputRef("{{form1.first_name}}", map[string]any{"form1.first_name": "Alice"}, nil)
	if got != "Alice" {
		t.Fatalf("resolveInputRef() = %#v, want \"Alice\"", got)
	}
}

func TestResolveInputRefWidgetPortNotFound(t *testing.T) {
	t.Parallel()

	expr := "{{form1.email}}"
	got := resolveInputRef(expr, map[string]any{"form1.first_name": "Alice"}, nil)
	if got != expr {
		t.Fatalf("resolveInputRef() = %#v, want %q (unchanged)", got, expr)
	}
}

func TestResolveInputRefInputPreserved(t *testing.T) {
	t.Parallel()

	got := resolveInputRef("{{input.first_name}}", map[string]any{"first_name": "Alice"}, nil)
	if got != "Alice" {
		t.Fatalf("resolveInputRef() = %#v, want \"Alice\"", got)
	}
}

func TestHydrateDSLStepsV1NoOp(t *testing.T) {
	t.Parallel()

	def := &wfDefinition{
		dslVersion: 1,
		steps:      []wfStep{{id: "s1"}},
	}
	if err := hydrateDSLSteps(context.Background(), nil, def); err != nil {
		t.Fatalf("hydrateDSLSteps() error = %v, want nil", err)
	}
	if len(def.steps) != 1 {
		t.Fatalf("len(def.steps) = %d, want 1", len(def.steps))
	}
}
