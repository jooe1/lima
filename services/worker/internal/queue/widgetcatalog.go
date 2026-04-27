package queue

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// portDir is the direction of a port.
type portDir string

const (
	portDirInput  portDir = "input"
	portDirOutput portDir = "output"
)

// portEntry describes one port on a widget or step node.
type portEntry struct {
	name        string
	dir         portDir
	dataType    string
	description string
	dynamic     bool // true → one port per configured field (e.g. form fields)
	expandable  bool // true → object port with per-key child ports
}

// widgetEntry describes one widget type for AI prompt context.
type widgetEntry struct {
	typeName    string
	displayName string
	ports       []portEntry
}

// stepEntry describes one step node type for AI prompt context.
type stepEntry struct {
	typeName    string
	displayName string
	ports       []portEntry
}

//go:embed port-manifest.json
var portManifestJSON []byte

// widgetCatalog mirrors packages/widget-catalog/src/index.ts WIDGET_REGISTRY.
// Populated at startup from the embedded port-manifest.json via init().
var widgetCatalog []widgetEntry

// stepCatalog mirrors packages/widget-catalog/src/index.ts STEP_NODE_REGISTRY.
// Populated at startup from the embedded port-manifest.json via init().
var stepCatalog []stepEntry

// jsonPortDef, jsonWidgetDef, jsonStepDef, jsonManifest are private helpers used
// by init() to unmarshal port-manifest.json.
type jsonPortDef struct {
	Name       string `json:"name"`
	Direction  string `json:"direction"`
	DataType   string `json:"dataType"`
	Desc       string `json:"description"`
	Dynamic    bool   `json:"dynamic"`
	Expandable bool   `json:"expandable"`
}

type jsonWidgetDef struct {
	Type        string        `json:"type"`
	DisplayName string        `json:"displayName"`
	Ports       []jsonPortDef `json:"ports"`
}

type jsonStepDef struct {
	Type        string        `json:"type"`
	DisplayName string        `json:"displayName"`
	Ports       []jsonPortDef `json:"ports"`
}

type jsonManifest struct {
	Widgets []jsonWidgetDef `json:"widgets"`
	Steps   []jsonStepDef   `json:"steps"`
}

func init() {
	var m jsonManifest
	if err := json.Unmarshal(portManifestJSON, &m); err != nil {
		panic("widgetcatalog: failed to parse port-manifest.json: " + err.Error())
	}

	widgetCatalog = make([]widgetEntry, 0, len(m.Widgets))
	for _, w := range m.Widgets {
		ports := make([]portEntry, 0, len(w.Ports))
		for _, p := range w.Ports {
			dir := portDirOutput
			if p.Direction == "input" {
				dir = portDirInput
			}
			ports = append(ports, portEntry{
				name:        p.Name,
				dir:         dir,
				dataType:    p.DataType,
				description: p.Desc,
				dynamic:     p.Dynamic,
				expandable:  p.Expandable,
			})
		}
		widgetCatalog = append(widgetCatalog, widgetEntry{
			typeName:    w.Type,
			displayName: w.DisplayName,
			ports:       ports,
		})
	}

	stepCatalog = make([]stepEntry, 0, len(m.Steps))
	for _, s := range m.Steps {
		ports := make([]portEntry, 0, len(s.Ports))
		for _, p := range s.Ports {
			dir := portDirOutput
			if p.Direction == "input" {
				dir = portDirInput
			}
			ports = append(ports, portEntry{
				name:        p.Name,
				dir:         dir,
				dataType:    p.DataType,
				description: p.Desc,
				dynamic:     p.Dynamic,
				expandable:  p.Expandable,
			})
		}
		stepCatalog = append(stepCatalog, stepEntry{
			typeName:    s.Type,
			displayName: s.DisplayName,
			ports:       ports,
		})
	}
}

// BuildPortManifest returns a multi-line string describing every widget and
// step node type with their ports. Inject this into AI prompts that need to
// reason about widget-to-widget or widget-to-step wiring.
func BuildPortManifest() string {
	var sb strings.Builder

	sb.WriteString("## Widget port reference\n\n")
	for _, w := range widgetCatalog {
		fmt.Fprintf(&sb, "### %s (`%s`)\n", w.displayName, w.typeName)
		inputs, outputs := splitPorts(w.ports)
		if len(outputs) > 0 {
			sb.WriteString("**Output ports** (values this widget fires):\n")
			for _, p := range outputs {
				suffix := ""
				if p.dynamic {
					suffix = " _(one per configured field)_"
				} else if p.expandable {
					suffix = " _(expandable: one child port per column/field)_"
				}
				fmt.Fprintf(&sb, "- `%s` — %s (`%s`)%s\n", p.name, p.description, p.dataType, suffix)
			}
		}
		if len(inputs) > 0 {
			sb.WriteString("**Input ports** (values this widget receives):\n")
			for _, p := range inputs {
				suffix := ""
				if p.dynamic {
					suffix = " _(one per configured field)_"
				} else if p.expandable {
					suffix = " _(expandable: one child port per column/field)_"
				}
				fmt.Fprintf(&sb, "- `%s` — %s (`%s`)%s\n", p.name, p.description, p.dataType, suffix)
			}
		}
		sb.WriteString("\n")
	}

	sb.WriteString("## Step node port reference\n\n")
	for _, s := range stepCatalog {
		fmt.Fprintf(&sb, "### %s (`%s`)\n", s.displayName, s.typeName)
		inputs, outputs := splitPorts(s.ports)
		if len(inputs) > 0 {
			sb.WriteString("**Input ports**:\n")
			for _, p := range inputs {
				suffix := ""
				if p.dynamic {
					suffix = " _(one per SQL parameter)_"
				}
				fmt.Fprintf(&sb, "- `%s` — %s (`%s`)%s\n", p.name, p.description, p.dataType, suffix)
			}
		}
		if len(outputs) > 0 {
			sb.WriteString("**Output ports**:\n")
			for _, p := range outputs {
				fmt.Fprintf(&sb, "- `%s` — %s (`%s`)\n", p.name, p.description, p.dataType)
			}
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

func splitPorts(ports []portEntry) (inputs, outputs []portEntry) {
	for _, p := range ports {
		if p.dir == portDirInput {
			inputs = append(inputs, p)
		} else {
			outputs = append(outputs, p)
		}
	}
	return
}

// PortsForElement returns the set of port names for the given element type.
// element is like "form", "table", "button", "step:query", etc.
// Returns (inputPorts, outputPorts, ok). ok=false if element type is unknown.
//
// Dynamic ports contribute a "*" wildcard entry to their direction's set,
// meaning any port name in that direction is considered valid. Unknown element
// types (ok=false) are treated as pass-through by callers.
func PortsForElement(element string) (inputs map[string]bool, outputs map[string]bool, ok bool) {
	inputs = map[string]bool{}
	outputs = map[string]bool{}

	addPorts := func(ports []portEntry) {
		for _, p := range ports {
			if p.dynamic {
				// Dynamic port acts as a wildcard: any port name is valid in this direction.
				if p.dir == portDirInput {
					inputs["*"] = true
				} else {
					outputs["*"] = true
				}
			} else {
				if p.dir == portDirInput {
					inputs[p.name] = true
				} else {
					outputs[p.name] = true
				}
			}
		}
	}

	for _, w := range widgetCatalog {
		if w.typeName == element {
			addPorts(w.ports)
			return inputs, outputs, true
		}
	}

	for _, s := range stepCatalog {
		if s.typeName == element {
			addPorts(s.ports)
			return inputs, outputs, true
		}
	}

	return inputs, outputs, false
}

// KnownElement returns true if element is a known widget or step type.
func KnownElement(element string) bool {
	for _, w := range widgetCatalog {
		if w.typeName == element {
			return true
		}
	}
	for _, s := range stepCatalog {
		if s.typeName == element {
			return true
		}
	}
	return false
}
