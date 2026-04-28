# Aura Authoring Language

**Status:** Draft

**Last Updated:** April 27, 2026

---

## 1. Purpose

Define a higher-level, flat Aura authoring grammar for AI-first app generation.

The goal is to preserve the strengths of Aura over JSON:
- flat, line-oriented syntax
- local edits without deep tree rewrites
- streaming-friendly output
- human readability

At the same time, the new grammar should remove low-level graph mechanics from the model's first-generation target. Agents should describe intent, bindings, triggers, and effects. A compiler should lower that intent into the runtime graph.

---

## 2. Problem Statement

The current Aura surface asks the model to generate something too close to an execution graph:
- layout structure
- widget configuration
- workflow step graph
- trigger wiring
- value-slot wiring
- SQL details
- post-run effects

This is too much for a single first-generation pass.

Nested JSON is not the right answer. Agents are often worse at deeply nested structures than at flat repeated statements. The better direction is a flatter Aura that is more semantic and less mechanical.

---

## 3. Design Goals

The Aura Authoring language SHALL:

1. Stay flat and line-oriented.
2. Avoid nested JSON and nested child blocks.
3. Use repeated statements instead of array-valued object fields when possible.
4. Let agents express semantic intent instead of runtime graph internals.
5. Use stable, human-readable IDs and references.
6. Compile deterministically into runtime-safe Aura graph structures.
7. Preserve an escape hatch for advanced cases without making them the default.

The Aura Authoring language SHALL NOT:

1. Require the model to author raw edge IDs.
2. Require the model to author bind slot indexes directly.
3. Require the model to write nested config maps for common cases.
4. Require raw SQL for common CRUD and dashboard scaffolds.

---

## 4. Two-Layer Model

This proposal introduces two distinct representations:

1. **Aura Authoring**
   The language emitted by AI during first generation and used for high-level editing.

2. **Aura Runtime**
   The lower-level compiled representation used by the existing builder canvas, runtime renderer, and worker execution system.

Pipeline:

`natural language -> planner -> Aura Authoring -> compiler -> Aura Runtime -> builder/runtime`

Aura Runtime may remain the persisted canonical form initially. If the new model succeeds, Aura Authoring can later become the primary source and Aura Runtime can become an internal compiled form.

---

## 5. Core Design Principle

The authoring language should describe:
- what exists
- what is connected
- what should happen

It should not describe:
- how to index mutation slots
- how to encode reactive versus async edge details
- how to expand dynamic runtime port names
- how to materialize internal step nodes for common patterns

Example of the desired authoring level:

```aura
app order_admin
entity order connector=orders primary_key=OrderID
page main title="Orders"

stack shell @ main direction=column gap=16

widget form order_form @ shell title="Order Form"
field order_form OrderID
field order_form CustomerName
field order_form Amount

widget table orders @ shell title="Orders"
column orders OrderID
column orders CustomerName
column orders Amount
column orders Status

action create_order @ main kind=create_record entity=order form=order_form

bind orders.selected_row -> order_form.values
run order_form.submitted -> create_order
effect create_order.success -> orders.refresh
effect create_order.success -> order_form.reset
```

---

## 6. Syntax Overview

### 6.1 General shape

Each statement occupies one line.

General forms:

```text
keyword id [key=value ...]
keyword id @ parent [key=value ...]
keyword source -> target [key=value ...]
```

Rules:
- IDs use `lower_snake_case`.
- String values are quoted only when needed.
- Numbers and booleans are unquoted.
- Repeated statements represent lists.
- No nested blocks are used in the authoring layer.

### 6.2 Grammar sketch

```text
document      := statement* ;

statement     := app_stmt
               | entity_stmt
               | page_stmt
               | layout_stmt
               | widget_stmt
               | field_stmt
               | column_stmt
               | option_stmt
               | action_stmt
               | bind_stmt
               | run_stmt
               | effect_stmt
               | set_stmt
               | note_stmt ;

app_stmt      := "app" id attr* ;
entity_stmt   := "entity" id attr* ;
page_stmt     := "page" id attr* ;
layout_stmt   := ("stack" | "grid" | "slot") id "@" id attr* ;
widget_stmt   := "widget" widget_type id "@" id attr* ;
field_stmt    := "field" id value attr* ;
column_stmt   := "column" id value attr* ;
option_stmt   := "option" id value attr* ;
action_stmt   := "action" id "@" id attr* ;
bind_stmt     := "bind" ref "->" ref attr* ;
run_stmt      := "run" ref "->" id attr* ;
effect_stmt   := "effect" ref "->" ref attr* ;
set_stmt      := "set" id key_value ;
note_stmt     := "note" id text ;

ref           := id "." port_name ;
attr          := key_value ;
key_value     := key "=" scalar ;
```

---

## 7. Statement Types

### 7.1 App and page

```aura
app order_admin name="Order Admin"
page main title="Orders"
```

Purpose:
- declare the app root
- declare a page surface the compiler can target

### 7.2 Entities

```aura
entity order connector=orders primary_key=OrderID
entity approval connector=purchase_requests primary_key=request_id
```

Purpose:
- provide semantic business objects
- allow compiler-selected scaffolds for CRUD, list, detail, and approval patterns

### 7.3 Layout containers

```aura
stack shell @ main direction=column gap=16
grid dashboard @ main columns=12 gap=16
slot sidebar @ dashboard span=3
slot content @ dashboard span=9
```

Purpose:
- retain flat parent references
- keep layout semantic and easy to rearrange

### 7.4 Widgets

```aura
widget form order_form @ shell title="Order Form"
widget table orders @ shell title="Orders"
widget chart revenue_chart @ content title="Revenue"
widget text headline @ shell content="Order Operations"
widget button delete_order @ shell label="Delete" variant=danger
widget filter status_filter @ sidebar label="Status"
```

Purpose:
- declare visible UI elements
- avoid stuffing full configuration maps into a single line

### 7.5 Repeated child statements for lists

Use repeated statements instead of nested arrays.

Examples:

```aura
field order_form OrderID
field order_form CustomerName
field order_form Amount

column orders OrderID
column orders CustomerName
column orders Amount
column orders Status

option status_filter Open value=open
option status_filter Closed value=closed
```

Benefits:
- easier for agents to add one item at a time
- no comma bookkeeping
- no nested JSON arrays
- stable diffs

### 7.6 Actions

```aura
action create_order @ main kind=create_record entity=order form=order_form
action update_order @ main kind=update_record entity=order form=order_form source=orders_table
action delete_order_action @ main kind=delete_selected entity=order source=orders
action load_revenue @ main kind=query source=revenue_chart profile=time_series
action approve_request @ main kind=approval entity=approval source=request_form
```

Purpose:
- represent business behavior at a semantic level
- let the compiler choose the runtime graph shape

Preferred `kind` values for first generation:
- `create_record` — always inserts a new row using form values; a PK field in the form is permitted and used directly
- `update_record` — updates the row currently selected in `source` table; WHERE uses the selected row's PK identity, not form field values
- `delete_selected` — deletes the row currently selected in `source` table
- `managed_crud` (**deprecated** — use `create_record` or `update_record` instead; `mode=upsert` is no longer generated)
- `query`
- `approval`
- `notify`
- `http_request`

### 7.6a Create vs Update Distinction

The `action` kind declares the author's **explicit intent**. Form field values are never inspected at compile time to infer whether a row is new or existing.

- Use `create_record` when the user is adding a new row. The compiler always lowers to INSERT. It is acceptable for the form to contain a user-entered PK field — it will be inserted as-is.
- Use `update_record source=<table_id>` when the user is editing the row currently selected in the named table. The compiler lowers to UPDATE with `WHERE <pk> = {{slot.where.0}}`, where `{{slot.where.0}}` is bound to `<table_id>.selectedRow.<pk>`. The form fields determine the SET clause.

**Why explicit intent matters:** An heuristic that inspects whether a PK form field is non-empty to choose INSERT vs UPDATE will silently fail when the PK field carries a value from a previous selection but the user intends a fresh row. Explicit intent removes this ambiguity entirely.

**Authoring pattern for apps that need both create and update:**

```aura
action create_order @ main kind=create_record entity=order form=order_form
action update_order @ main kind=update_record entity=order form=order_form source=orders_table

widget button add_btn @ shell label="Add New"
widget button save_btn @ shell label="Save Changes"
run add_btn.clicked -> create_order
run save_btn.clicked -> update_order
bind orders_table.selected_row -> order_form.values
effect create_order.success -> orders_table.refresh
effect create_order.success -> order_form.reset
effect update_order.success -> orders_table.refresh
```

### 7.7 Bindings

Bindings move values, not control.

```aura
bind orders.selected_row -> order_form.values
bind status_filter.value -> orders.filter.status
bind orders.selected_row.OrderID -> delete_order_action.record_id
```

Purpose:
- connect semantic outputs to semantic inputs
- avoid exposing low-level slot handles such as `bind:set:0`

### 7.8 Triggers

Triggers start actions.

```aura
run order_form.submitted -> save_order
run delete_order.clicked -> delete_order_action
run page.loaded -> load_revenue
```

Purpose:
- separate execution triggers from value bindings
- avoid requiring the model to know about `.run` ports

### 7.9 Effects

Effects describe what happens after an action event.

```aura
effect save_order.success -> orders.refresh
effect save_order.success -> order_form.reset
effect delete_order_action.success -> orders.refresh
effect approve_request.error -> approval_notice.show
```

Purpose:
- declare post-run UI behavior directly
- avoid requiring explicit low-level output edge authoring

### 7.10 Escape hatch via `set`

For uncommon properties, use flat dotted keys.

```aura
set revenue_chart metric.aggregate=sum
set revenue_chart metric.value_field=amount
set load_revenue sql.profile=time_series
set approve_request approval.role=finance_admin
```

Purpose:
- preserve flexibility without nested config blocks
- keep advanced settings flat and diffable

---

## 8. Port and Event Vocabulary

The authoring layer should use a stable semantic vocabulary that is easier for agents than the current runtime port names.

### 8.1 Widget outputs

Preferred authoring outputs:
- `submitted`
- `clicked`
- `value`
- `values`
- `rows`
- `selected_row`
- `selected_row.<field>`

### 8.2 Widget inputs

Preferred authoring inputs:
- `values`
- `refresh`
- `reset`
- `content`
- `disabled`
- `label`
- `filter.<field>`

### 8.3 Action events

Preferred action events:
- `success`
- `error`
- `done`
- `approved`
- `rejected`

Compiler mapping examples:
- `selected_row` -> `selectedRow`
- `values` on form input side -> `setValues`
- `clicked` trigger -> async edge into runtime `run`
- `success` -> compiler-selected output event from generated graph

---

## 9. Lowering Rules

The compiler SHALL translate Aura Authoring into Aura Runtime deterministically.

### 9.1 Widget declaration lowering

```aura
widget form order_form @ shell title="Order Form"
field order_form OrderID
field order_form CustomerName
```

Lowers to:
- one runtime `form` node
- `with fields="OrderID,CustomerName"`
- layout/container metadata derived from parent chain

### 9.2 Binding lowering

```aura
bind orders.selected_row -> order_form.values
```

Lowers to:
- one reactive edge from table `selectedRow` to form `setValues`

```aura
bind orders.selected_row.OrderID -> delete_order_action.record_id
```

Lowers to either:
- a runtime binding edge into a generated slot/input, or
- a generated action config that resolves `record_id` from the selected row

The authoring language MUST NOT require the model to choose between these two representations.

### 9.3 Trigger lowering

```aura
run order_form.submitted -> save_order
```

Lowers to:
- one async edge from form `submitted` to the generated action entry point

### 9.4 Effect lowering

```aura
effect save_order.success -> orders.refresh
effect save_order.success -> order_form.reset
```

Lowers to:
- runtime output edges from the generated action success event to table `refresh` and form `reset`

### 9.5 Managed action lowering (deprecated)

```aura
# deprecated — use create_record or update_record instead
action save_order @ main kind=managed_crud entity=order form=order_form table=orders
```

`managed_crud` with `mode=upsert` is no longer generated. Existing authoring that uses `managed_crud` will continue to compile, but the heuristic upsert output is not correct when the form contains a PK field for a new row. Use `create_record` or `update_record` with explicit intent instead.

### 9.6 create_record lowering

```aura
action create_order @ main kind=create_record entity=order form=order_form
```

Lowers to:
- a single `step:mutation` node with INSERT SQL derived from the entity definition and the declared form fields
- no condition step; insertion is unconditional

### 9.7 update_record lowering

```aura
action update_order @ main kind=update_record entity=order form=order_form source=orders_table
```

Lowers to:
- a single `step:mutation` node with UPDATE SQL derived from the entity definition and the declared form fields
- WHERE clause uses `{{slot.where.0}}`, bound to `orders_table.selectedRow.<pk>` via a compiler-synthesized binding edge
- no condition step; the WHERE binding is the only guard

The compiler synthesizes the binding edge `orders_table.selectedRow.<pk> -> update_order.slot.where.0` automatically. The author does not need to declare it explicitly.

---

## 10. Examples

### 10.1 CRUD page

```aura
app order_admin
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

widget button add_btn @ shell label="Add New"
widget button save_btn @ shell label="Save Changes"
widget button delete_order @ shell label="Delete" variant=danger

action create_order @ main kind=create_record entity=order form=order_form
action update_order @ main kind=update_record entity=order form=order_form source=orders
action delete_order_action @ main kind=delete_selected entity=order source=orders

bind orders.selected_row -> order_form.values
run add_btn.clicked -> create_order
run save_btn.clicked -> update_order
run delete_order.clicked -> delete_order_action
effect create_order.success -> orders.refresh
effect create_order.success -> order_form.reset
effect update_order.success -> orders.refresh
effect delete_order_action.success -> orders.refresh
```

### 10.2 Dashboard page

```aura
app revenue_dashboard
entity order connector=orders primary_key=OrderID
page main title="Revenue Dashboard"

grid dashboard @ main columns=12 gap=16
slot sidebar @ dashboard span=3
slot content @ dashboard span=9

widget filter status_filter @ sidebar label="Status"
option status_filter Open value=open
option status_filter Closed value=closed

widget chart revenue_chart @ content title="Revenue by Month"
widget table orders @ content title="Recent Orders"
column orders OrderID
column orders CustomerName
column orders Amount
column orders Status

action load_revenue @ main kind=query source=order profile=time_series target=revenue_chart
action load_orders @ main kind=query source=order profile=list target=orders

bind status_filter.value -> revenue_chart.filter.status
bind status_filter.value -> orders.filter.status
run page.loaded -> load_revenue
run page.loaded -> load_orders
effect load_revenue.success -> revenue_chart.refresh
effect load_orders.success -> orders.refresh
```

---

## 11. Why This Is Better For Agents

Compared with nested JSON:
- no brace balancing
- no deeply nested shape completion
- no array/object rewriting for small edits
- fewer quoting errors

Compared with current low-level Aura graph authoring:
- no raw edge IDs
- no `bind:set:0` / `bind:where:0` authoring
- no need to choose runtime port casing
- no need to invent internal step graph topology for common patterns
- no need to write raw SQL for standard CRUD scaffolds

Compared with direct runtime graph generation:
- first generation becomes classification plus filling a scaffold
- compiler owns correctness-sensitive expansion
- tests can target compiler semantics instead of prompt luck

---

## 12. Validation Rules

The Aura Authoring validator SHOULD enforce:

1. IDs are unique within their statement namespace.
2. Parents referenced by `@ parent` exist.
3. `field`, `column`, and `option` targets exist and are compatible widget types.
4. `bind` source and target references use known authoring vocabulary.
5. `run` targets refer to declared actions.
6. `effect` sources refer to valid action events.
7. `action kind=create_record` has compatible `entity` and `form` references. `action kind=update_record` has compatible `entity`, `form`, and `source` (table) references. `action kind=managed_crud` is deprecated; a warning is emitted and the author is advised to migrate to `create_record` or `update_record`.
8. Unknown advanced `set` keys are warnings, not fatal errors, unless they conflict with reserved keys.

---

## 13. Migration Strategy

Recommended rollout:

1. Keep current Aura Runtime unchanged.
2. Introduce Aura Authoring as an AI-only generation target.
3. Build a compiler from Aura Authoring to Aura Runtime.
4. Run both validators: authoring validation before lowering, runtime validation after lowering.
5. Benchmark first-generation success on a fixed prompt suite.
6. Only after stability is proven, consider making Aura Authoring the persisted source of truth.

---

## 14. Open Questions

1. Should Aura Authoring become the persisted canonical source, or remain an AI-facing source that compiles into persisted Aura Runtime?
2. Should page-bound actions and standalone workflows share the same `action` syntax, or should standalone flows retain a separate lower-level workflow DSL?
3. How much raw SQL should remain available in first-generation authoring, if at all?
4. Should authoring references standardize on `snake_case` ports even when runtime ports remain `camelCase`?
5. Should compiler-generated artifacts be hidden from the builder by default, with a toggle to inspect the lowered graph?

---

## 15. Recommendation

Do not replace Aura with nested JSON.

Instead:
- keep Aura flat
- raise its semantic level
- represent lists as repeated statements
- move graph mechanics into a compiler

This keeps the original reason Aura exists while making first-generation AI output substantially easier to produce correctly.