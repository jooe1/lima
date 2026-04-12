package model_test

import (
	"encoding/json"
	"testing"

	"github.com/lima/api/internal/model"
)

func TestAuraEdgeJSONRoundTrip(t *testing.T) {
	edge := model.AuraEdge{
		ID:         "e1",
		FromNodeID: "table1",
		FromPort:   "selectedRow",
		ToNodeID:   "text1",
		ToPort:     "setContent",
		EdgeType:   "reactive",
		Transform:  "$.name",
	}

	data, err := json.Marshal(edge)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var got model.AuraEdge
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if got.ID != edge.ID {
		t.Errorf("ID mismatch: got %q, want %q", got.ID, edge.ID)
	}
	if got.EdgeType != edge.EdgeType {
		t.Errorf("EdgeType mismatch: got %q, want %q", got.EdgeType, edge.EdgeType)
	}
	if got.Transform != edge.Transform {
		t.Errorf("Transform mismatch: got %q, want %q", got.Transform, edge.Transform)
	}
}

func TestAuraEdgeTransformOmittedWhenEmpty(t *testing.T) {
	edge := model.AuraEdge{
		ID:         "e2",
		FromNodeID: "form1",
		FromPort:   "submitted",
		ToNodeID:   "step_create",
		ToPort:     "params",
		EdgeType:   "async",
	}

	data, err := json.Marshal(edge)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal to map failed: %v", err)
	}

	if _, ok := m["transform"]; ok {
		t.Error("expected 'transform' to be omitted from JSON when empty, but it was present")
	}
}
