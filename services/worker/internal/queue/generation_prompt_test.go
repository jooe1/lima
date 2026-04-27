package queue

import (
	"strings"
	"testing"
)

func TestBuildGraphSystemPrompt_UsesCanonicalAuraSyntax(t *testing.T) {
	t.Parallel()

	prompt := buildGraphSystemPrompt("widget ports go here")

	if strings.Contains(prompt, "[prop") {
		t.Fatalf("buildGraphSystemPrompt() should not include legacy bracket syntax: %q", prompt)
	}
	if strings.Contains(prompt, "[layout") || strings.Contains(prompt, "[on ") || strings.Contains(prompt, "[input ") || strings.Contains(prompt, "[output ") {
		t.Fatalf("buildGraphSystemPrompt() should not include bracketed clause examples: %q", prompt)
	}
	if !strings.Contains(prompt, "container page_shell @ root") {
		t.Fatalf("buildGraphSystemPrompt() should include an explicit top-level container example: %q", prompt)
	}
	if strings.Contains(prompt, "<element>") || strings.Contains(prompt, "<parentId>") || strings.Contains(prompt, "<myOutputPort>") {
		t.Fatalf("buildGraphSystemPrompt() should not include angle-bracket placeholders: %q", prompt)
	}
	if !strings.Contains(prompt, "form order_form @ page_shell") {
		t.Fatalf("buildGraphSystemPrompt() should include an explicit nested form example: %q", prompt)
	}
	if !strings.Contains(prompt, `with fields="OrderID,Date,CustomerName,Product,Category,Amount"`) {
		t.Fatalf("buildGraphSystemPrompt() should teach canonical form field syntax via with fields=...: %q", prompt)
	}
	if !strings.Contains(prompt, "on submitted -> save_order.run") {
		t.Fatalf("buildGraphSystemPrompt() should teach mutation execution via the run port: %q", prompt)
	}
	if strings.Contains(prompt, "save_order.params") {
		t.Fatalf("buildGraphSystemPrompt() should not teach params as the mutation trigger: %q", prompt)
	}
	if !strings.Contains(prompt, "input setRows <- load_orders.rows") {
		t.Fatalf("buildGraphSystemPrompt() should teach the canonical table setRows wiring example: %q", prompt)
	}
	if strings.Contains(prompt, "input rows <- load_orders.result") || strings.Contains(prompt, "orders_table.rows") {
		t.Fatalf("buildGraphSystemPrompt() should not teach stale table port examples: %q", prompt)
	}
	if !strings.Contains(prompt, "Do not emit angle-bracket placeholder tokens anywhere in the DSL.") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly forbid angle-bracket placeholder tokens: %q", prompt)
	}
	if !strings.Contains(prompt, "Do NOT invent standalone clauses such as 'fields ...' or 'columns ...'.") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly forbid invented standalone widget config clauses: %q", prompt)
	}
	if !strings.Contains(prompt, "Top-level nodes must use '@ root' with a space") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly require '@ root' with a space: %q", prompt)
	}
	if !strings.Contains(prompt, "Do NOT emit a \"page\" element") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly forbid a page wrapper node: %q", prompt)
	}
	if !strings.Contains(prompt, "widget text headline @ main") || !strings.Contains(prompt, "Do NOT add a redundant 'type=...' token") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly constrain flat authoring widget header syntax: %q", prompt)
	}
	if !strings.Contains(prompt, "Do NOT emit a standalone 'with ...' clause") {
		t.Fatalf("buildGraphSystemPrompt() should explicitly forbid standalone with clauses inside flat authoring: %q", prompt)
	}
	if !strings.Contains(prompt, "layout-only flat authoring document") {
		t.Fatalf("buildGraphSystemPrompt() should document the layout-only flat-authoring exception: %q", prompt)
	}
	if !strings.Contains(prompt, "managed CRUD plan context explicitly authorizes flat authoring Aura") {
		t.Fatalf("buildGraphSystemPrompt() should document the managed CRUD flat-authoring override: %q", prompt)
	}
	if !strings.Contains(prompt, "read-only dashboard") || !strings.Contains(prompt, "kind=query") {
		t.Fatalf("buildGraphSystemPrompt() should document the flat query-authoring exception: %q", prompt)
	}
	if strings.Contains(prompt, "{{flow:") {
		t.Fatalf("buildGraphSystemPrompt() should not mention legacy flow reference syntax: %q", prompt)
	}
	if strings.Contains(prompt, "```flows") {
		t.Fatalf("buildGraphSystemPrompt() should not tell the model to emit a flows block: %q", prompt)
	}
}

func TestBuildGraphCopilotPrompt_RejectsLegacySyntax(t *testing.T) {
	t.Parallel()

	prompt := buildGraphCopilotPrompt("", "show orders", nil, nil, nil, nil)

	if !strings.Contains(prompt, "Do not use square-bracket metadata") {
		t.Fatalf("buildGraphCopilotPrompt() should forbid bracket metadata syntax: %q", prompt)
	}
	if !strings.Contains(prompt, "do not emit a page wrapper node") {
		t.Fatalf("buildGraphCopilotPrompt() should forbid page wrapper nodes: %q", prompt)
	}
	if !strings.Contains(prompt, "widget text headline @ main") || !strings.Contains(prompt, "type=...") {
		t.Fatalf("buildGraphCopilotPrompt() should explicitly constrain flat authoring widget header syntax: %q", prompt)
	}
	if !strings.Contains(prompt, "standalone 'with ...' clause") {
		t.Fatalf("buildGraphCopilotPrompt() should explicitly forbid standalone with clauses inside flat authoring: %q", prompt)
	}
	if !strings.Contains(prompt, "not legacy flow action references") {
		t.Fatalf("buildGraphCopilotPrompt() should forbid legacy flow action references: %q", prompt)
	}
	if !strings.Contains(prompt, "layout-only screens or widget-to-widget wiring") {
		t.Fatalf("buildGraphCopilotPrompt() should allow the layout-only flat authoring subset: %q", prompt)
	}
}

func TestBuildWorkflowContextBlock_DoesNotTeachActionFlowSyntax(t *testing.T) {
	t.Parallel()

	ctx := buildWorkflowContextBlock([]existingWorkflowInfo{{id: "wf-1", name: "Save Order", triggerType: "form_submit"}})

	if strings.Contains(ctx, "{{flow:") {
		t.Fatalf("buildWorkflowContextBlock() should not mention legacy flow reference syntax: %q", ctx)
	}
	if !strings.Contains(ctx, "inline step:* nodes") {
		t.Fatalf("buildWorkflowContextBlock() should steer generation toward inline step nodes: %q", ctx)
	}
}

func TestBuildPlanContextBlock_DoesNotTeachActionFlowSyntax(t *testing.T) {
	t.Parallel()

	ctx := buildPlanContextBlock(&appPlan{Intent: "crud", WorkflowRef: "saveOrder"})

	if strings.Contains(ctx, "{{flow:") {
		t.Fatalf("buildPlanContextBlock() should not mention legacy flow reference syntax: %q", ctx)
	}
	if !strings.Contains(ctx, "explicit step:* nodes") {
		t.Fatalf("buildPlanContextBlock() should steer generation toward explicit step nodes: %q", ctx)
	}
	if !strings.Contains(ctx, "legacy flow action syntax") {
		t.Fatalf("buildPlanContextBlock() should explicitly reject legacy flow action syntax: %q", ctx)
	}
}

func TestBuildPlanContextBlock_ManagedCRUDUsesCompilerInstruction(t *testing.T) {
	t.Parallel()

	ctx := buildPlanContextBlock(&appPlan{Intent: "crud", ConnectorType: "managed", WorkflowRef: "saveOrder"})

	if !strings.Contains(ctx, "flat managed CRUD authoring subset") {
		t.Fatalf("buildPlanContextBlock() should authorize flat managed CRUD authoring: %q", ctx)
	}
	if !strings.Contains(ctx, "page main title=\"Orders\"") {
		t.Fatalf("buildPlanContextBlock() should include a concrete flat-authoring page example: %q", ctx)
	}
	if !strings.Contains(ctx, "action save_order @ main kind=managed_crud") {
		t.Fatalf("buildPlanContextBlock() should include a concrete flat-authoring action example: %q", ctx)
	}
	if !strings.Contains(ctx, "The worker will synthesize the managed table binding, save behavior, and delete-button wiring.") {
		t.Fatalf("buildPlanContextBlock() should explain managed CRUD compiler ownership: %q", ctx)
	}
	if !strings.Contains(ctx, "place delete/danger buttons where needed") {
		t.Fatalf("buildPlanContextBlock() should steer managed CRUD layouts toward explicit delete buttons: %q", ctx)
	}
	if strings.Contains(ctx, "model it with explicit step:*") {
		t.Fatalf("buildPlanContextBlock() should not ask the model to author managed save steps: %q", ctx)
	}
}

func TestBuildGraphCopilotPrompt_ManagedCRUDAllowsFlatAuthoring(t *testing.T) {
	t.Parallel()

	prompt := buildGraphCopilotPrompt("", "show orders", nil, nil, nil, &appPlan{Intent: "crud", ConnectorType: "managed"})

	if !strings.Contains(prompt, "flat authoring subset with page/widget/field/column/action lines") {
		t.Fatalf("buildGraphCopilotPrompt() should allow the flat managed CRUD authoring subset: %q", prompt)
	}
}

func TestBuildPlanContextBlock_ReadOnlyDashboardUsesQueryCompilerInstruction(t *testing.T) {
	t.Parallel()

	ctx := buildPlanContextBlock(&appPlan{Intent: "dashboard", ConnectorID: "conn_orders", ConnectorType: "managed", Entity: "order"})

	if !strings.Contains(ctx, "flat query authoring subset") {
		t.Fatalf("buildPlanContextBlock() should authorize flat query authoring: %q", ctx)
	}
	if !strings.Contains(ctx, "action load_orders @ main kind=query") {
		t.Fatalf("buildPlanContextBlock() should include a concrete flat query-authoring example: %q", ctx)
	}
	if !strings.Contains(ctx, "target data wiring") {
		t.Fatalf("buildPlanContextBlock() should explain query compiler ownership: %q", ctx)
	}
}

func TestBuildGraphCopilotPrompt_ReadOnlyDashboardAllowsFlatQueryAuthoring(t *testing.T) {
	t.Parallel()

	prompt := buildGraphCopilotPrompt("", "show revenue dashboard", nil, nil, nil, &appPlan{Intent: "dashboard", ConnectorID: "conn_orders", ConnectorType: "managed", Entity: "order"})

	if !strings.Contains(prompt, "flat query authoring subset") {
		t.Fatalf("buildGraphCopilotPrompt() should allow the flat query authoring subset: %q", prompt)
	}
	if !strings.Contains(prompt, "kind=query") {
		t.Fatalf("buildGraphCopilotPrompt() should steer dashboard generation toward query actions: %q", prompt)
	}
}
