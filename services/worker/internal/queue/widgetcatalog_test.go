package queue

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestWidgetCatalogCoversAllTSTypes reads packages/widget-catalog/src/index.ts
// and verifies that every WidgetType listed in the TypeScript union is present
// in the Go widgetCatalog. This test fails when a new widget type is added to
// the TS source without updating widgetcatalog.go.
func TestWidgetCatalogCoversAllTSTypes(t *testing.T) {
	t.Helper()

	// Locate the TS file relative to this test file's package directory.
	// go test runs with cwd = package directory, so we navigate up from
	// services/worker/internal/queue to the repo root.
	tsPath := "../../../../packages/widget-catalog/src/index.ts"
	data, err := os.ReadFile(tsPath)
	if err != nil {
		t.Fatalf("cannot read widget-catalog TS source at %q: %v", tsPath, err)
	}

	// Extract the WidgetType union body:
	//   export type WidgetType =
	//     | 'table'
	//     | 'form'
	//     ...
	// We capture everything between "export type WidgetType =" and the next blank line.
	src := string(data)
	unionRe := regexp.MustCompile(`(?s)export type WidgetType\s*=\s*((?:\s*\|\s*'[^']+'\s*)+)`)
	m := unionRe.FindStringSubmatch(src)
	if len(m) < 2 {
		t.Fatal("could not find WidgetType union in widget-catalog source")
	}

	memberRe := regexp.MustCompile(`'([^']+)'`)
	tsTypes := memberRe.FindAllStringSubmatch(m[1], -1)

	goTypes := make(map[string]bool, len(widgetCatalog))
	for _, w := range widgetCatalog {
		goTypes[w.typeName] = true
	}

	for _, ts := range tsTypes {
		name := ts[1]
		if !goTypes[name] {
			t.Errorf("widget type %q is in the TypeScript WidgetType union but missing from widgetCatalog in widgetcatalog.go", name)
		}
	}
}

// TestBuildPortManifestContainsKeyPorts is a smoke test that verifies the
// manifest string contains expected widget and step identifiers.
func TestBuildPortManifestContainsKeyPorts(t *testing.T) {
	manifest := BuildPortManifest()

	checks := []string{
		"table",
		"selectedRow",
		"setValues",
		"step:mutation",
		"affectedRows",
		"step:condition",
		"trueBranch",
	}
	for _, want := range checks {
		if !strings.Contains(manifest, want) {
			t.Errorf("BuildPortManifest() output does not contain %q", want)
		}
	}
}

// TestBuildPortManifestFlowStageExpectations verifies that the manifest
// contains the specific port names required by the flow-wiring generation stage.
func TestBuildPortManifestFlowStageExpectations(t *testing.T) {
	manifest := BuildPortManifest()

	expected := []string{
		"table",
		"selectedRow",
		"setValues",
		"step:mutation",
		"step:condition",
	}
	for _, want := range expected {
		if !strings.Contains(manifest, want) {
			t.Errorf("BuildPortManifest() output does not contain %q (required by flow stage)", want)
		}
	}
}
