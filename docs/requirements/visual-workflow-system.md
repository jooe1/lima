# Visual Workflow System

**Status:** Draft

**Last Updated:** March 24, 2026

---

## 1. Purpose

Define the required behaviour for a redesigned workflow system that introduces two distinct workflow types — page-bound and standalone — and replaces the current full-screen workflow editor with a context-aware, split-view overlay for page-bound workflows.

The central goal is to allow non-technical builders to create, configure, and connect workflows to their app's widgets without writing SQL template strings, remembering widget IDs, or navigating away from the page they are building.

---

## 2. Background and Motivation

### 2.1 Current state

The existing workflow system provides:
- A separate full-screen canvas editor (WorkflowCanvas) opened from a widget's Inspector or from the ⚡ Workflows tab.
- Step types: query, mutation, condition, approval\_gate, notification.
- Input binding via string templates: `{{input.fieldname}}` manually typed into config fields.
- No visual connection between widgets on the builder canvas and steps in the workflow graph.

### 2.2 Problems with the current model

- The full-screen canvas removes the builder from their page context. They cannot see which form they came from, what fields it has, or what table sits next to it while editing the workflow.
- `{{input.fieldname}}` syntax is invisible to non-technical users and must be memorised or looked up.
- There is no way to visually express that a workflow's output should refresh a table or update a text widget after completion.
- Standalone (schedule/webhook) workflows share the same UI as page-bound workflows, creating a confusing mixed experience.

### 2.3 The desired model

Two entry points, two workflow types:

1. **Page-bound workflows** — triggered by a button click or form submit on a specific page. Edited via a split-view overlay that keeps the page visible and exposes widget ports as draggable sources.
2. **Standalone workflows** — triggered by a schedule, webhook, or manual run. Edited via the full-screen canvas (already implemented). No page context.

---

## 3. Definitions

| Term | Meaning |
|------|---------|
| **Page-bound workflow** | A workflow whose trigger is `button_click` or `form_submit` and which is permanently scoped to one page of one app. |
| **Standalone workflow** | A workflow whose trigger is `manual`, `schedule`, or `webhook`. Not scoped to any page. |
| **Widget port** | A named data output or input slot on a widget. Output ports produce values (form field values, selected table row). Input ports accept values (table refresh, text widget display value). |
| **Port card** | A compact UI panel representing a widget's available ports, shown in the port tray during workflow editing. |
| **Port tray** | The left-hand panel in the split-view overlay that lists all widgets on the current page as port cards. |
| **Widget binding** | A saved reference from a workflow step input to a specific widget ID and port name, replacing `{{input.fieldname}}` template strings for page-bound workflows. |
| **Split-view overlay** | The UI mode entered when a builder opens a page-bound workflow. The page is shown on the left (ghosted, read-only), the workflow graph is shown on the right. |

---

## 4. Functional Requirements

### 4.1 Workflow type separation

**WF-01** The system SHALL distinguish between page-bound workflows (`trigger_type IN ('button_click', 'form_submit')`) and standalone workflows (`trigger_type IN ('manual', 'schedule', 'webhook')`).

**WF-02** The ⚡ Workflows tab SHALL display both page-bound and standalone workflows in separate sections, clearly labelled.

**WF-03** Creating a workflow from the ⚡ Workflows tab SHALL only offer `manual`, `schedule`, and `webhook` as trigger types. Page-bound workflows can only be created from a widget's Inspector.

**WF-04** A page-bound workflow SHALL always carry a reference to the page and widget it was created from (`source_widget_id`, `source_page_id`). These fields are set at creation and are immutable.

**WF-05** Deleting the source widget SHALL mark the associated page-bound workflow as `orphaned`. Orphaned workflows SHALL be shown with a warning in the ⚡ Workflows tab and SHALL NOT be activatable.

---

### 4.2 Split-view overlay (page-bound workflow editor)

**WF-06** When a builder opens a page-bound workflow (from the Inspector's WorkflowCard or from the ⚡ tab), the builder page SHALL enter split-view mode:
- Left pane: the builder canvas at ~40% width, ghosted and read-only.
- Right pane: the workflow graph at ~60% width, pannable/zoomable via React Flow.
- A draggable divider between the two panes allows the builder to resize the split.

**WF-07** In split-view mode, the left pane SHALL display a port tray across the bottom of the left pane (or as a collapsible left sidebar within the pane) listing all widgets on the current page as port cards.

**WF-08** Each port card SHALL display:
- The widget's display name and type icon.
- All available output ports (e.g. form fields, table selected row columns) as draggable chips.
- All available input ports (e.g. "refresh", "set value") as drop targets.

**WF-09** The builder SHALL be able to drag an output port chip from a port card and drop it onto a step node in the workflow graph. This action SHALL create a widget binding from that step's input field to the source widget and port.

**WF-10** When a widget binding exists on a step input, the config panel SHALL display the binding as a badge (e.g. `form1 → first_name`) instead of the raw `{{input.first_name}}` string. The builder SHALL be able to remove the binding and return to manual text entry.

**WF-11** The builder SHALL be able to drag an input port chip (e.g. table "refresh on complete") from a port card and drop it onto the End node or any step node in the workflow graph. This action SHALL create an output binding that triggers the widget update when that step completes.

**WF-12** The split-view overlay SHALL include a header bar with: workflow name (editable), status badge, Save button, Activate button (admins only), and a "Generate with AI" button. These behave identically to the current full-screen canvas header.

**WF-13** The split-view overlay SHALL be dismissible via a Back button, returning the builder to the normal canvas view without entering the full edit mode.

**WF-14** The split-view overlay SHALL support a "Pop out" button that converts the workflow graph pane into a floating, draggable, resizable panel positioned over the page, giving the builder access to the full page canvas while editing the workflow.

---

### 4.3 Widget ports — output ports (inputs to the workflow)

**WF-15** The following output ports SHALL be available per widget type:

| Widget type | Output ports |
|-------------|-------------|
| Form | One port per field, named after the field's label/id. |
| Button | `clicked_at` (timestamp of the triggering click). |
| Table | `selected_row.*` — one port per column of the currently selected row. |
| Text input | `value` — current text content. |
| Select / Dropdown | `selected_value`, `selected_label`. |

**WF-16** Output port chips SHALL display the field name and a type indicator (text, number, date, boolean).

**WF-17** Dragging an output port chip onto a step node SHALL open the step's config panel with the target field pre-focused and the binding applied.

---

### 4.4 Widget ports — input ports (outputs from the workflow)

**WF-18** The following input ports SHALL be available per widget type:

| Widget type | Input ports |
|-------------|------------|
| Table | `refresh` — reload the table's data query after a step completes. |
| Text | `set_value` — update the displayed text with a value from a step result. |
| Form | `reset` — clear all fields after the workflow completes successfully. |
| Notification toast | `show` — display a transient success or error message. |

**WF-19** An input port binding SHALL record: the widget ID, the port name, and the triggering step ID (or "on\_workflow\_complete" for end-of-run bindings).

**WF-20** At runtime, when a workflow step or the overall run completes, the Lima runtime shell SHALL process input port bindings and apply the corresponding widget updates on the page (refresh query, set value, reset form, show notification).

---

### 4.5 Widget binding data model

**WF-21** The `workflow_step_config` JSON object SHALL support a new optional field `input_bindings`: a map of config key → widget binding object. Example:

```json
{
  "connector_id": "abc-123",
  "table": "contacts",
  "input_bindings": {
    "field_mapping.first_name.value": {
      "widget_id": "form1",
      "port":      "first_name",
      "page_id":   "page_main"
    }
  }
}
```

**WF-22** The `workflow` record SHALL support a new optional JSON column `output_bindings`: an array of output binding objects. Example:

```json
[
  {
    "trigger_step_id": "__workflow_complete__",
    "widget_id":       "contacts_table",
    "port":            "refresh",
    "page_id":         "page_main"
  },
  {
    "trigger_step_id": "__workflow_complete__",
    "widget_id":       "form1",
    "port":            "reset",
    "page_id":         "page_main"
  }
]
```

**WF-23** At worker execution time, `input_bindings` SHALL be resolved against `run.inputData` using the existing `{{input.*}}` resolution path. The binding's `port` name SHALL map directly to the `inputData` key sent by the runtime when the widget triggers the workflow run.

**WF-24** The worker SHALL NOT need to know about widget IDs. Widget binding resolution is a build-time concern (the builder generates the correct `{{input.*}}` keys from the binding) and a runtime-shell concern (the shell applies output bindings after receiving the run completion event).

**WF-25** The Aura DSL SHALL be extended to represent widget bindings as a typed construct so the validator can detect references to non-existent widget IDs or deleted ports.

---

### 4.6 Validation and integrity

**WF-26** When a widget is renamed, the system SHALL update all `widget_id` references in `input_bindings` and `output_bindings` across all workflows in the same app.

**WF-27** When a widget is deleted, the system SHALL mark any bindings referencing it as `broken`. Broken bindings SHALL be shown as errors in the workflow graph (the bound port chip displays in red with a tooltip explaining the issue).

**WF-28** A workflow with broken bindings SHALL NOT be activatable. The Activate button SHALL be disabled with a tooltip listing the broken bindings.

**WF-29** Changing a form field's name or ID SHALL be treated as a rename and SHALL trigger WF-26.

---

### 4.7 Standalone workflow editor (unchanged from current)

**WF-30** Standalone workflows (`manual`, `schedule`, `webhook`) SHALL continue to use the full-screen canvas editor (WorkflowCanvas) with no split-view or port tray.

**WF-31** Standalone workflows SHALL NOT display a port tray and SHALL NOT support widget bindings. Their step config fields remain purely text/template driven.

**WF-32** The ⚡ Workflows tab SHALL provide the entry point for creating and managing standalone workflows, as currently implemented.

---

### 4.8 Floating panel mode

**WF-33** The pop-out floating panel SHALL be draggable by its header bar anywhere on the screen.

**WF-34** The floating panel SHALL be resizable via a resize handle on its bottom-right corner.

**WF-35** The floating panel SHALL remember its last position and size within the browser session (stored in `sessionStorage`).

**WF-36** The floating panel SHALL be collapsible to a compact title bar so the builder can peek at the page underneath.

**WF-37** A "Snap back" button in the floating panel SHALL return the editor to split-view mode.

---

## 5. Non-Functional Requirements

**WF-NFR-01** The split-view overlay transition SHALL animate in under 200ms to avoid making the page feel broken.

**WF-NFR-02** The port tray SHALL render within 100ms of the overlay opening. Port card content (field names) SHALL be derived from the in-memory Aura DSL document already in the builder — no additional API call required.

**WF-NFR-03** The React Flow canvas inside the workflow pane SHALL support at least 50 nodes without visible frame-rate degradation.

**WF-NFR-04** Widget binding resolution in the worker SHALL add no measurable latency over the existing `{{input.*}}` template resolution, since bindings are resolved to simple key lookups at build time.

---

## 6. Out of Scope

The following are explicitly not part of this requirements document:

- **Reactive/formula bindings** — where a text widget's displayed value is a live expression derived from another widget's value without a workflow run (e.g. `price * quantity`). This is a separate Inspector-level feature.
- **Cross-page widget references** — a workflow may only reference widgets on the same page as its source widget.
- **REST/GraphQL mutation support** — mutation steps continue to be SQL-only in this phase, consistent with the existing scope.
- **Workflow run history UI** — out of scope for this document; already tracked separately.
- **Mobile/responsive builder** — the split-view layout targets desktop builders only.

---

## 7. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | Should output bindings be stored on the `workflow` record or in the Aura DSL document? Storing in DSL would make them part of the app export/import, which is probably correct. | Architecture | Open |
| 2 | When a table widget is refreshed via an output binding, should it use its existing query or should it be possible to pass new query parameters from the workflow result? | Product | Open |
| 3 | Should widget port metadata (field names, column names) be derived purely from the Aura DSL document (design-time schema) or from live connector schema? | Engineering | Open |
| 4 | What is the right behaviour when a workflow's source widget is on a page that the current user does not have access to? | Product/Security | Open |
| 5 | Should the floating panel position be persisted per-workflow or globally per-user? | Product | Open |
