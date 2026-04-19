package queue

import (
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

// widgetCatalog mirrors packages/widget-catalog/src/index.ts WIDGET_REGISTRY.
// Keep this in sync with the TypeScript source; the test in widgetcatalog_test.go
// will fail if a widget type is added to the TS source but not here.
var widgetCatalog = []widgetEntry{
	{
		typeName:    "table",
		displayName: "Table",
		ports: []portEntry{
			{name: "selectedRow", dir: portDirOutput, dataType: "object", description: "Currently selected row object", expandable: true},
			{name: "rows", dir: portDirOutput, dataType: "array", description: "All rows currently displayed in the table"},
			{name: "selectedRowIndex", dir: portDirOutput, dataType: "number", description: "Zero-based index of the selected row"},
			{name: "refresh", dir: portDirInput, dataType: "trigger", description: "Trigger a data refresh"},
			{name: "setRows", dir: portDirInput, dataType: "array", description: "Override the displayed rows"},
			{name: "setFilter", dir: portDirInput, dataType: "object", description: "Apply a filter object to the table", expandable: true},
		},
	},
	{
		typeName:    "form",
		displayName: "Form",
		ports: []portEntry{
			{name: "values", dir: portDirOutput, dataType: "object", description: "Current form field values as an object"},
			{name: "submitted", dir: portDirOutput, dataType: "trigger", description: "Fires the form values object when the user clicks Submit"},
			{name: "*", dir: portDirOutput, dataType: "string", description: "One output port per form field, keyed by field name", dynamic: true},
			{name: "reset", dir: portDirInput, dataType: "trigger", description: "Reset the form to initial values"},
			{name: "setValues", dir: portDirInput, dataType: "object", description: "Populate form fields programmatically", expandable: true},
			{name: "setErrors", dir: portDirInput, dataType: "object", description: "Set validation error messages on fields", expandable: true},
		},
	},
	{
		typeName:    "text",
		displayName: "Text",
		ports: []portEntry{
			{name: "content", dir: portDirOutput, dataType: "string", description: "Current rendered text content"},
			{name: "setContent", dir: portDirInput, dataType: "string", description: "Override the displayed text content"},
		},
	},
	{
		typeName:    "button",
		displayName: "Button",
		ports: []portEntry{
			{name: "clicked", dir: portDirOutput, dataType: "trigger", description: "Triggered when the button is clicked"},
			{name: "clickedAt", dir: portDirOutput, dataType: "date", description: "Timestamp of the last click"},
			{name: "setDisabled", dir: portDirInput, dataType: "boolean", description: "Enable or disable the button"},
			{name: "setLabel", dir: portDirInput, dataType: "string", description: "Override the button label text"},
		},
	},
	{
		typeName:    "chart",
		displayName: "Chart",
		ports: []portEntry{
			{name: "selectedPoint", dir: portDirOutput, dataType: "object", description: "Currently selected chart data point", expandable: true},
			{name: "setData", dir: portDirInput, dataType: "array", description: "Override the chart data array"},
			{name: "refresh", dir: portDirInput, dataType: "trigger", description: "Trigger a data refresh"},
		},
	},
	{
		typeName:    "kpi",
		displayName: "KPI Tile",
		ports: []portEntry{
			{name: "value", dir: portDirOutput, dataType: "number", description: "Current KPI numeric value"},
			{name: "setValue", dir: portDirInput, dataType: "number", description: "Override the KPI value"},
			{name: "setTrend", dir: portDirInput, dataType: "string", description: "Override the trend indicator value"},
		},
	},
	{
		typeName:    "filter",
		displayName: "Filter",
		ports: []portEntry{
			{name: "value", dir: portDirOutput, dataType: "string", description: "Current filter input value"},
			{name: "selectedValue", dir: portDirOutput, dataType: "string", description: "Currently selected option value"},
			{name: "setOptions", dir: portDirInput, dataType: "array", description: "Populate the dropdown options list"},
			{name: "setValue", dir: portDirInput, dataType: "string", description: "Set the current filter value programmatically"},
		},
	},
	{
		typeName:    "container",
		displayName: "Container",
		ports: []portEntry{
			{name: "children", dir: portDirInput, dataType: "array", description: "Child widget slot (layout only)"},
		},
	},
	{
		typeName:    "modal",
		displayName: "Modal",
		ports: []portEntry{
			{name: "closed", dir: portDirOutput, dataType: "trigger", description: "Triggered when the modal is closed"},
			{name: "open", dir: portDirInput, dataType: "trigger", description: "Trigger to open the modal"},
			{name: "close", dir: portDirInput, dataType: "trigger", description: "Trigger to close the modal"},
		},
	},
	{
		typeName:    "tabs",
		displayName: "Tabs",
		ports: []portEntry{
			{name: "activeTab", dir: portDirOutput, dataType: "string", description: "Label of the currently active tab"},
			{name: "activeTabIndex", dir: portDirOutput, dataType: "number", description: "Zero-based index of the active tab"},
			{name: "setActiveTab", dir: portDirInput, dataType: "string", description: "Programmatically set the active tab by label"},
		},
	},
	{
		typeName:    "markdown",
		displayName: "Markdown",
		ports: []portEntry{
			{name: "setContent", dir: portDirInput, dataType: "string", description: "Override the markdown content"},
		},
	},
}

// stepCatalog mirrors packages/widget-catalog/src/index.ts STEP_NODE_REGISTRY.
var stepCatalog = []stepEntry{
	{
		typeName:    "step:query",
		displayName: "Query",
		ports: []portEntry{
			{name: "params", dir: portDirInput, dataType: "object", description: "SQL parameters (one dynamic port per parameter)", dynamic: true},
			{name: "result", dir: portDirOutput, dataType: "object", description: "Query result object { rows, rowCount }"},
			{name: "rows", dir: portDirOutput, dataType: "array", description: "Array of result rows"},
			{name: "firstRow", dir: portDirOutput, dataType: "object", description: "First result row", expandable: true},
			{name: "rowCount", dir: portDirOutput, dataType: "number", description: "Number of rows returned"},
		},
	},
	{
		typeName:    "step:mutation",
		displayName: "Mutation",
		ports: []portEntry{
			{name: "run", dir: portDirInput, dataType: "trigger", description: "Trigger execution of this mutation step"},
			{name: "params", dir: portDirInput, dataType: "object", description: "SQL parameters (one dynamic port per parameter)", dynamic: true},
			{name: "result", dir: portDirOutput, dataType: "object", description: "Full mutation result object"},
			{name: "affectedRows", dir: portDirOutput, dataType: "number", description: "Number of rows affected"},
		},
	},
	{
		typeName:    "step:condition",
		displayName: "Condition",
		ports: []portEntry{
			{name: "value", dir: portDirInput, dataType: "object", description: "Value to test"},
			{name: "compareTo", dir: portDirInput, dataType: "object", description: "Value to compare against"},
			{name: "trueBranch", dir: portDirOutput, dataType: "trigger", description: "Triggered when condition is true"},
			{name: "falseBranch", dir: portDirOutput, dataType: "trigger", description: "Triggered when condition is false"},
		},
	},
	{
		typeName:    "step:approval_gate",
		displayName: "Approval Gate",
		ports: []portEntry{
			{name: "approved", dir: portDirOutput, dataType: "trigger", description: "Triggered when the gate is approved"},
			{name: "rejected", dir: portDirOutput, dataType: "trigger", description: "Triggered when the gate is rejected"},
		},
	},
	{
		typeName:    "step:notification",
		displayName: "Notification",
		ports: []portEntry{
			{name: "message", dir: portDirInput, dataType: "string", description: "Notification message body"},
			{name: "channel", dir: portDirInput, dataType: "string", description: "Target channel or recipient"},
			{name: "sent", dir: portDirOutput, dataType: "trigger", description: "Triggered after the notification is sent"},
			{name: "failed", dir: portDirOutput, dataType: "trigger", description: "Triggered when delivery fails"},
		},
	},
	{
		typeName:    "step:transform",
		displayName: "Transform",
		ports: []portEntry{
			{name: "input", dir: portDirInput, dataType: "object", description: "Data to transform"},
			{name: "output", dir: portDirOutput, dataType: "object", description: "Transformed result", expandable: true},
		},
	},
	{
		typeName:    "step:http",
		displayName: "HTTP Request",
		ports: []portEntry{
			{name: "body", dir: portDirInput, dataType: "object", description: "Request body (JSON)"},
			{name: "responseBody", dir: portDirOutput, dataType: "object", description: "Parsed JSON response body", expandable: true},
			{name: "status", dir: portDirOutput, dataType: "number", description: "HTTP response status code"},
			{name: "ok", dir: portDirOutput, dataType: "trigger", description: "Triggered on 2xx response"},
			{name: "error", dir: portDirOutput, dataType: "trigger", description: "Triggered on non-2xx or network error"},
		},
	},
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
