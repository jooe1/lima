# Widget Inline Editing Implementation Plan

**Objective:** Improve widget layout control with inline double-click text editing and internal form field management UI.

**Scope:** Approach 1 + Approach 3
- Approach 1: Double-click text editing for text, button, and KPI widgets
- Approach 3: Widget-internal field management UI for forms, tables, and charts with duplicate detection

---

## Phase 1: Foundation & Data Structure

### Commit 1.1: Allow Empty Forms in Widget Catalog
**File:** `packages/widget-catalog/src/index.ts`  
**Changes:**
- Remove `required: true` from form `fields` prop
- Set sensible default: `default: ''` (empty)
- Update description: "Comma-separated field names (can be empty; add fields using the + button)"
- Add deprecation note for comma-separated format (migrate to array in Phase 3)

**Impact:**
- Forms can now be created without initial fields
- Enable workflow-driven population

---

### Commit 1.2: Add Form Validation Utilities
**File:** `apps/web/lib/formValidation.ts` (new)  
**Changes:**
- Export `parseFormFields(fieldsStr: string): string[]`
  - Split on comma, trim, filter empty
  - Return unique field names (duplicates removed on parse)
- Export `validateFormFields(fields: string[]): { valid: boolean; duplicates: string[] }`
  - Returns duplicates array for UI highlighting
  - Used by both Inspector and canvas preview
- Export `formatFormFields(fields: string[]): string`
  - Join with comma + space for consistency

**Rationale:** Centralize field parsing logic so it's testable and shared between Inspector, WidgetRenderer, and upcoming field editor.

---

## Phase 2: Form Widget Canvas Enhancements

### Commit 2.1: Add Field Editor Component to WidgetRenderer
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- Import new `FormFieldEditor` component (to be created in 2.2)
- In the `form` case of `renderBody()`:
  - Check for `showFieldEditor` state (local to component)
  - If `showFieldEditor === true`, render `<FormFieldEditor ... />`
  - If `false`, render current preview (but now clickable)
- Add empty state: if fields empty, show "Click + to add fields" placeholder
- Keep the simple preview for non-edit mode

**Component State:**
- Local state: `showFieldEditor: boolean` (default: false)
- Toggled by `useCallback` when user clicks "edit" or interacts with preview

---

### Commit 2.2: Create FormFieldEditor Component
**File:** `apps/web/app/builder/[appId]/widgets/FormFieldEditor.tsx` (new)  
**Changes:**
- Props:
  ```tsx
  interface FormFieldEditorProps {
    fieldsStr: string  // current comma-separated fields
    onSave: (newFieldsStr: string) => void  // callback to update node
    onCancel: () => void
  }
  ```
- UI:
  - Header: "Edit form fields"
  - List of current fields with:
    - Field name (read-only or inline editable)
    - Remove button (×) with confirmation
    - Drag handle (optional, for reorder)
  - Duplicate detection: highlight duplicates in red with warning
  - Add field row: empty input field + "Add" button (or + icon)
  - Buttons: "Save" / "Cancel"
- Validation:
  - Prevent adding empty field names
  - Show count of fields
  - Warn if duplicates detected before save
- On save:
  - Deduplicate and format field string
  - Call `onSave(newFieldsStr)`

**Styling:** Match existing form preview (compact, dark theme, 0.75rem base font)

---

### Commit 2.3: Integrate FormFieldEditor into WidgetRenderer Form Preview
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- Update `form` case in `renderBody()`:
  - Wrap current preview in a clickable container
  - Show edit button (pencil icon) or make the entire preview clickable
  - Track local state: `const [editingFormFields, setEditingFormFields] = useState(false)`
  - When `editingFormFields === true`:
    ```tsx
    <FormFieldEditor
      fieldsStr={node.style?.fields ?? node.with?.fields ?? ''}
      onSave={(newFields) => {
        // Update node via parent callback
        // Close editor
      }}
      onCancel={() => setEditingFormFields(false)}
    />
    ```
  - When `editingFormFields === false`:
    - Render preview with edit button
    - If no fields, show: "📝 Click to add fields"
    - Otherwise list fields + button
- Ensure state resets when widget is deselected

---

## Phase 3: Text Widget Double-Click Editing

### Commit 3.1: Add Double-Click Handler to WidgetRenderer
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- In the `text` case of `renderBody()`:
  - Wrap the text display in a `<div>` with:
    - `onDoubleClick` handler
    - `cursor: 'text'` CSS
    - `border: '1px dashed transparent'` (hover: solid)
  - On double-click:
    - Set local state: `setEditingTextContent(true)`
    - Render inline text input instead of display

---

### Commit 3.2: Add Inline Text Editor
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- Add local state: `const [editingTextContent, setEditingTextContent] = useState(false)`
- Add local state: `const [tempTextValue, setTempTextValue] = useState('')`
- In `text` case, add two modes:
  - **Display mode** (default):
    ```tsx
    <div onDoubleClick={() => {
      setEditingTextContent(true)
      setTempTextValue(node.text ?? '')
    }} style={{ cursor: 'text', ... }}>
      {content}
    </div>
    ```
  - **Edit mode** (when `editingTextContent === true`):
    ```tsx
    <input
      autoFocus
      type="text"
      value={tempTextValue}
      onChange={(e) => setTempTextValue(e.target.value)}
      onBlur={() => {
        // Save and exit
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Save and exit
        } else if (e.key === 'Escape') {
          // Cancel
        }
      }}
      style={inputStyle}
    />
    ```
- On save/blur: Call parent callback `onUpdate(setPropValue(node, 'text', tempTextValue))`

---

### Commit 3.3: Extend Double-Click Editing to Button Label
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- Apply same double-click + inline edit pattern to `button` case
- Edit `node.text` (the button label)
- Only allow editing, not removal (allow empty string for flow-driven labels)

---

## Phase 4: Table & Chart Enhancements

### Commit 4.1: Create ColumnEditor Component
**File:** `apps/web/app/builder/[appId]/widgets/ColumnEditor.tsx` (new)  
**Changes:**
- Reusable component for managing data columns (used by table and chart)
- Props:
  ```tsx
  interface ColumnEditorProps {
    columnsStr: string  // current comma-separated columns
    onSave: (newColumnsStr: string) => void
    onCancel: () => void
    sourceColumns?: string[]  // optional: available columns to suggest
  }
  ```
- UI similar to `FormFieldEditor`:
  - List current columns with remove button
  - Add column row (text input or dropdown if `sourceColumns` provided)
  - Duplicate detection
  - Save/Cancel buttons
- On save: deduplicate, format, call `onSave(newColumnsStr)`

---

### Commit 4.2: Integrate ColumnEditor into Table Preview
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- In `table` case in `renderBody()`:
  - Add edit button or make preview clickable
  - Track: `const [editingTableColumns, setEditingTableColumns] = useState(false)`
  - Render `<ColumnEditor ... />` when editing
  - Show preview when not editing
  - If no columns, show: "📊 Click to add columns"

---

### Commit 4.3: Integrate ColumnEditor into Chart Preview
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx`  
**Changes:**
- In `chart` case in `renderBody()`:
  - Similar pattern to table (commit 4.2)
  - Show: "📈 Click to add columns"

---

## Phase 5: Inspector Updates & Validation

### Commit 5.1: Add Duplicate Detection to Inspector PropField
**File:** `apps/web/app/builder/[appId]/Inspector.tsx`  
**Changes:**
- Update `PropField` component:
  - Add optional prop: `duplicates?: string[]`
  - When rendering form `fields` field:
    - Call `validateFormFields()` from `lib/formValidation.ts`
    - Pass `duplicates` array to PropField
    - If duplicates exist, show warning message below input:
      ```
      ⚠️ Duplicate fields: name, email
      ```
    - Highlight duplicate field names inline (subtle background color)
- In main Inspector, detect form widget:
  - For `form` element, after parsing fields:
    - Call `validateFormFields()` and show any duplicates
    - Suggest auto-fix: "Remove duplicates?"

---

### Commit 5.2: Update Form Fields PropField in Inspector
**File:** `apps/web/app/builder/[appId]/Inspector.tsx`  
**Changes:**
- Enhance `PropField` for `form.fields` to show inline help:
  - Description updated: "Comma-separated field names (can be empty; use + button on canvas to manage)"
  - Add button: "Open canvas editor" that scrolls canvas into view
  - Hint: "Pro tip: Double-click the form on canvas to manage fields"

---

## Phase 6: Testing & Polish

### Commit 6.1: Add Unit Tests for Form Validation
**File:** `apps/web/lib/formValidation.test.ts` (new)  
**Changes:**
- Test `parseFormFields()`:
  - Basic parsing: `"a, b, c"` → `["a", "b", "c"]`
  - Trimming: `" x , y , z "` → `["x", "y", "z"]`
  - Empty fields: `"a,,b"` → `["a", "b"]`
  - Deduplication: `"a, b, a"` → `["a", "b"]` (optional; test behavior)
- Test `validateFormFields()`:
  - No duplicates: `{valid: true, duplicates: []}`
  - With duplicates: `{valid: true, duplicates: ["name", "email"]}` (still valid DSL, but noted)
- Test `formatFormFields()`:
  - Array to string: `["a", "b"]` → `"a, b"`

---

### Commit 6.2: Add Interaction Tests (E2E)
**File:** `apps/web/tests/e2e/widget-inline-editing.spec.ts` (new)  
**Changes:**
- Test double-click text editing:
  1. Create text widget with content "Hello"
  2. Double-click on preview
  3. Input should appear
  4. Change to "World"
  5. Press Enter
  6. Widget should update
  7. Preview should show "World"
- Test form field management:
  1. Create form widget (empty)
  2. Click edit or + button
  3. Add fields: "name", "email"
  4. Try adding duplicate: "name" → show warning
  5. Remove one field
  6. Save
  7. Canvas should update
- Test table column management:
  1. Similar flow as form

---

### Commit 6.3: Polish & Edge Cases
**File:** `apps/web/app/builder/[appId]/widgets/WidgetRenderer.tsx` + component files  
**Changes:**
- Handle undo/redo correctly:
  - Reset local editing state when `node` prop changes
  - Use `useEffect` with dependency on `node.id`
- Handle field reordering (optional stretch goal):
  - Add drag handles to FormFieldEditor
  - Allow arrow keys (↑↓) to reorder
- Improve UX:
  - Keyboard shortcuts: Escape to cancel, Enter to save
  - Focus management: auto-focus input on edit mode
  - Empty state messaging: "Start by adding a field"
  - Success feedback: Brief highlight on save

---

## Implementation Order

| Phase | Commits | Est. LOC | Notes |
|-------|---------|---------|-------|
| 1     | 1.1–1.2 | 100–150 | Foundation; no UI changes |
| 2     | 2.1–2.3 | 400–600 | Core form editing feature |
| 3     | 3.1–3.3 | 200–300 | Text/button double-click |
| 4     | 4.1–4.3 | 300–400 | Table/chart columns (reuse from Phase 2) |
| 5     | 5.1–5.2 | 150–200 | Inspector enhancements |
| 6     | 6.1–6.3 | 200–300 | Testing + polish |

**Total:** ~1500–2000 LOC over 12 commits  
**Est. Timeline:** 2–3 days (if implementing sequentially)

---

## Key Decisions

1. **Local State Management:** Use component-local state (`useState`) for edit mode toggles to avoid polluting the AuraNode with UI state.
2. **Backward Compatibility:** Comma-separated fields remain; no DSL changes. Array format is future-proofing (Phase 3+).
3. **Empty Widgets:** Allow empty forms/tables/charts initially; users populate via canvas UI or flows.
4. **Duplicate Handling:** Deduplicate on parse; show warning in UI but allow save (user choice to fix).
5. **Drag-to-Reorder:** Optional; start with + / × buttons; add drag later if UX testing shows demand.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Double-click conflicts with canvas selection | Add guard: only enable in non-drag mode; disable during canvas pan/zoom |
| Field editor modal takes focus; hard to see changes | Keep editor inline or small; refresh preview in real-time as user types |
| Duplicate field names cause runtime errors | Deduplicate on save; add server-side validation in workflows |
| Undo/redo state gets out of sync | Always reset local editing state when node changes; test undo flow |

---

## Success Criteria

✅ Users can add/remove form fields from canvas (no panel visit needed)  
✅ Users can edit text widget content via double-click  
✅ Duplicate fields are detected and highlighted  
✅ Empty forms/tables/charts can be created and populated later  
✅ All changes persist to Aura DSL correctly  
✅ E2E tests pass (double-click, field add/remove, duplicates)  
✅ Zero regression in existing Inspector or canvas interactions
