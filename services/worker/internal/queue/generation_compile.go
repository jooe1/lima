package queue

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type withEntry struct {
	key   string
	value string
}

type dslStatementHeaderInfo struct {
	Element  string
	ID       string
	ParentID string
}

type compiledStatement struct {
	header dslStatementHeaderInfo
	text   string
}

var managedCompileNonWordRe = regexp.MustCompile(`\W+`)

func compileManagedCRUDAuthoringDSL(src string, plan *appPlan, connectors []genConnector) (string, []dslEdge, []string, bool, error) {
	effectivePlan, inferredPlan, err := deriveManagedCompilePlan(src, plan, connectors)
	if err != nil {
		return src, nil, nil, false, err
	}
	if effectivePlan == nil {
		return src, nil, nil, false, nil
	}

	connector, ok := findConnectorByID(connectors, effectivePlan.ConnectorID)
	if !ok || connector.cType != "managed" {
		return src, nil, nil, false, nil
	}

	stmts, order, err := parseDSLStatements(src)
	if err != nil {
		return src, nil, nil, false, err
	}

	existingIDs := make(map[string]bool, len(order))
	compiled := make([]compiledStatement, 0, len(order)+1)
	formIndex := -1
	tableIndex := -1
	deleteButtonIndexes := []int{}

	for _, id := range order {
		stmt := stmts[id]
		header, ok := parseStatementHeaderInfo(stmt)
		if !ok {
			compiled = append(compiled, compiledStatement{text: stmt})
			continue
		}
		if strings.HasPrefix(header.Element, "step:") || header.Element == "flow:group" {
			continue
		}
		existingIDs[header.ID] = true
		if header.Element == "form" && formIndex == -1 {
			formIndex = len(compiled)
		}
		if header.Element == "table" && tableIndex == -1 {
			tableIndex = len(compiled)
		}
		if isManagedDeleteButtonStatement(header, stmt) {
			deleteButtonIndexes = append(deleteButtonIndexes, len(compiled))
		}
		compiled = append(compiled, compiledStatement{header: header, text: stmt})
	}

	if formIndex == -1 && tableIndex == -1 && len(deleteButtonIndexes) == 0 {
		return src, nil, nil, false, nil
	}

	formID := ""
	if formIndex != -1 {
		formID = compiled[formIndex].header.ID
	}
	tableID := ""
	if tableIndex != -1 {
		tableID = compiled[tableIndex].header.ID
	}
	hasDeleteFlow := tableID != "" && strings.TrimSpace(effectivePlan.PrimaryKeyField) != "" && len(deleteButtonIndexes) > 0

	notes := []string{"compiled managed authoring Aura into runtime-safe table binding and save flow"}
	if inferredPlan {
		notes = append(notes, "inferred the managed CRUD contract from generated Aura and available connectors")
	}
	if formID != "" || tableID != "" {
		notes = append(notes, "normalized managed CRUD layout to the planned form/table contract")
	}
	compilerEdges := []dslEdge{}

	if formIndex != -1 {
		formFields := csvFieldList(effectivePlan.FormFields)
		if formFields != "" {
			compiled[formIndex].text = appendWithEntries(compiled[formIndex].text,
				withEntry{key: "fields", value: formFields},
			)
		}
	}

	tableFields := firstNonEmptyFields(effectivePlan.TableFields, connector.columns)
	if hasDeleteFlow {
		tableFields = ensureField(tableFields, effectivePlan.PrimaryKeyField)
	}

	if tableIndex != -1 {
		selectSQL := buildManagedSelectSQL(connector.name, tableFields, connector.columns)
		compiled[tableIndex].text = stripStatementClauses(compiled[tableIndex].text, "input", "output")
		tableEntries := []withEntry{
			{key: "connector", value: effectivePlan.ConnectorID},
			{key: "connectorType", value: "managed"},
			{key: "sql", value: selectSQL},
		}
		if tableColumns := csvFieldList(tableFields); tableColumns != "" {
			tableEntries = append(tableEntries, withEntry{key: "columns", value: tableColumns})
		}
		compiled[tableIndex].text = appendWithEntries(compiled[tableIndex].text, tableEntries...)
		if formID != "" {
			compiled[tableIndex].text = appendClauseLine(compiled[tableIndex].text, fmt.Sprintf("output selectedRow -> %s.setValues", formID))
		}
	}

	if formIndex != -1 && len(effectivePlan.FormFields) > 0 {
		compiled[formIndex].text = stripStatementClauses(compiled[formIndex].text, "on", "input", "output", "action")
		saveStatements, saveEdges, triggerTarget, saveNotes := buildManagedSaveStatements(existingIDs, connector, effectivePlan, tableID, formID)
		notes = append(notes, saveNotes...)
		compilerEdges = append(compilerEdges, saveEdges...)
		if triggerTarget != "" {
			compiled[formIndex].text = appendClauseLine(compiled[formIndex].text, fmt.Sprintf("on submitted -> %s", triggerTarget))
		}
		compiled = append(compiled, saveStatements...)
	}

	if hasDeleteFlow {
		deleteButtonIDs := make([]string, 0, len(deleteButtonIndexes))
		for _, idx := range deleteButtonIndexes {
			deleteButtonIDs = append(deleteButtonIDs, compiled[idx].header.ID)
		}
		deleteStatements, deleteEdges, deleteNotes := buildManagedDeleteArtifacts(existingIDs, connector, effectivePlan, tableID, formID, deleteButtonIDs)
		notes = append(notes, deleteNotes...)
		compilerEdges = append(compilerEdges, deleteEdges...)
		compiled = append(compiled, deleteStatements...)
		if len(deleteStatements) > 0 {
			for _, idx := range deleteButtonIndexes {
				compiled[idx].text = stripStatementClauses(compiled[idx].text, "on", "input", "output", "action")
				compiled[idx].text = appendClauseLine(compiled[idx].text, fmt.Sprintf("on clicked -> %s.run", deleteStatements[0].header.ID))
			}
		}
	}

	var builder strings.Builder
	for i, stmt := range compiled {
		if i > 0 {
			builder.WriteString("\n\n")
		}
		builder.WriteString(strings.TrimSpace(stmt.text))
	}

	return builder.String(), compilerEdges, notes, true, nil
}

func deriveManagedCompilePlan(src string, plan *appPlan, connectors []genConnector) (*appPlan, bool, error) {
	managedConnectors := managedConnectors(connectors)
	if len(managedConnectors) == 0 {
		if plan != nil && plan.isCRUD() && strings.EqualFold(plan.ConnectorType, "managed") {
			return nil, false, nil
		}
		return nil, false, nil
	}

	stmts, order, err := parseDSLStatements(src)
	if err != nil {
		return nil, false, err
	}

	var firstFormStmt string
	var firstTableStmt string
	hasMutationStep := false
	hasDeleteButton := false
	hintedConnectorID := ""

	for _, id := range order {
		stmt := stmts[id]
		header, ok := parseStatementHeaderInfo(stmt)
		if !ok {
			continue
		}
		switch header.Element {
		case "form":
			if firstFormStmt == "" {
				firstFormStmt = stmt
			}
		case "table":
			if firstTableStmt == "" {
				firstTableStmt = stmt
			}
		case "button":
			if isManagedDeleteButtonStatement(header, stmt) {
				hasDeleteButton = true
			}
		case "step:mutation":
			hasMutationStep = true
		}
		if hintedConnectorID == "" {
			for _, key := range []string{"connector", "connector_id"} {
				value := statementWithValue(stmt, key)
				if value == "" {
					continue
				}
				if connector, ok := findConnectorByID(connectors, value); ok && connector.cType == "managed" {
					hintedConnectorID = connector.id
					break
				}
			}
		}
	}

	planNeedsFallback := plan == nil || !plan.isCRUD() || strings.TrimSpace(plan.ConnectorID) == "" || !strings.EqualFold(plan.ConnectorType, "managed") || len(plan.FormFields) == 0 || len(plan.TableFields) == 0
	hasCRUDSignal := hasMutationStep || hasDeleteButton || (plan != nil && plan.isCRUD())
	hasLayoutSignal := firstFormStmt != "" || firstTableStmt != "" || hasDeleteButton
	if !hasCRUDSignal || !hasLayoutSignal {
		if plan != nil && plan.isCRUD() && strings.TrimSpace(plan.ConnectorID) != "" && strings.EqualFold(plan.ConnectorType, "managed") {
			clone := *plan
			normalizeAppPlan(&clone)
			return &clone, false, nil
		}
		return nil, false, nil
	}

	connector, ok := resolveManagedCompileConnector(plan, hintedConnectorID, managedConnectors)
	if !ok {
		return nil, false, nil
	}

	effective := &appPlan{}
	if plan != nil {
		*effective = *plan
	}
	effective.Intent = "crud"
	effective.ConnectorID = connector.id
	effective.ConnectorType = "managed"
	if len(effective.FormFields) == 0 {
		effective.FormFields = parseCSVFields(statementWithValue(firstFormStmt, "fields"))
	}
	if len(effective.TableFields) == 0 {
		effective.TableFields = parseCSVFields(statementWithValue(firstTableStmt, "columns"))
	}
	if effective.Entity == "" {
		effective.Entity = inferManagedEntityName(connector)
	}
	if effective.PrimaryKeyField == "" {
		effective.PrimaryKeyField = inferManagedPrimaryKeyField(effective.FormFields, effective.TableFields, connector.columns)
	}
	if effective.CRUDMode == "" {
		effective.CRUDMode = "insert" // default is always insert; never infer upsert
	}
	if effective.WorkflowName == "" && effective.Entity != "" {
		effective.WorkflowName = "Save " + strings.Title(effective.Entity)
	}
	if effective.WorkflowRef == "" && effective.Entity != "" {
		effective.WorkflowRef = "save_" + managedCompileSlug(effective.Entity)
	}
	normalizeAppPlan(effective)
	return effective, planNeedsFallback, nil
}

func managedConnectors(connectors []genConnector) []genConnector {
	result := make([]genConnector, 0, len(connectors))
	for _, connector := range connectors {
		if connector.cType == "managed" {
			result = append(result, connector)
		}
	}
	return result
}

func resolveManagedCompileConnector(plan *appPlan, hintedConnectorID string, connectors []genConnector) (genConnector, bool) {
	if plan != nil && strings.TrimSpace(plan.ConnectorID) != "" {
		if connector, ok := findConnectorByID(connectors, plan.ConnectorID); ok && connector.cType == "managed" {
			return connector, true
		}
	}
	if hintedConnectorID != "" {
		if connector, ok := findConnectorByID(connectors, hintedConnectorID); ok && connector.cType == "managed" {
			return connector, true
		}
	}
	if plan != nil {
		entitySlug := managedCompileSlug(plan.Entity)
		if entitySlug != "" {
			matches := make([]genConnector, 0, len(connectors))
			for _, connector := range connectors {
				if connector.cType != "managed" {
					continue
				}
				if strings.Contains(managedCompileSlug(connector.name), entitySlug) || strings.Contains(managedCompileSlug(connector.id), entitySlug) {
					matches = append(matches, connector)
				}
			}
			if len(matches) == 1 {
				return matches[0], true
			}
		}
	}
	if len(connectors) == 1 {
		return connectors[0], true
	}
	return genConnector{}, false
}

func parseCSVFields(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		result = append(result, trimmed)
	}
	return dedupeFields(result)
}

func inferManagedEntityName(connector genConnector) string {
	entity := strings.TrimSpace(strings.ToLower(connector.name))
	if entity == "" {
		entity = strings.TrimSpace(strings.ToLower(connector.id))
	}
	if strings.HasSuffix(entity, "s") && len(entity) > 1 {
		entity = strings.TrimSuffix(entity, "s")
	}
	return entity
}

func inferManagedPrimaryKeyField(fieldSets ...[]string) string {
	candidates := make([]string, 0)
	for _, fields := range fieldSets {
		candidates = append(candidates, dedupeFields(fields)...)
	}
	var suffixMatch string
	for _, candidate := range dedupeFields(candidates) {
		lower := strings.ToLower(strings.TrimSpace(candidate))
		switch {
		case lower == "id":
			return candidate
		case lower == "row_id":
			return candidate
		case strings.HasSuffix(lower, "_id"):
			if suffixMatch == "" {
				suffixMatch = candidate
			}
		case strings.HasSuffix(lower, "id"):
			if suffixMatch == "" {
				suffixMatch = candidate
			}
		}
	}
	return suffixMatch
}

func findConnectorByID(connectors []genConnector, id string) (genConnector, bool) {
	for _, connector := range connectors {
		if connector.id == id {
			return connector, true
		}
	}
	return genConnector{}, false
}

func parseStatementHeaderInfo(stmt string) (dslStatementHeaderInfo, bool) {
	for _, line := range strings.Split(stmt, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == ";" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 4 || fields[2] != "@" {
			return dslStatementHeaderInfo{}, false
		}
		return dslStatementHeaderInfo{Element: fields[0], ID: fields[1], ParentID: fields[3]}, true
	}
	return dslStatementHeaderInfo{}, false
}

func stripStatementClauses(stmt string, clausePrefixes ...string) string {
	prefixes := make(map[string]bool, len(clausePrefixes))
	for _, prefix := range clausePrefixes {
		prefixes[prefix] = true
	}
	lines := statementBodyLines(stmt)
	filtered := make([]string, 0, len(lines))
	for i, line := range lines {
		if i == 0 {
			filtered = append(filtered, line)
			continue
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			filtered = append(filtered, line)
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) > 0 && prefixes[fields[0]] {
			continue
		}
		filtered = append(filtered, line)
	}
	return rebuildStatement(filtered)
}

func appendWithEntries(stmt string, entries ...withEntry) string {
	if len(entries) == 0 {
		return stmt
	}
	lines := statementBodyLines(stmt)
	headerIndex := firstStatementLineIndex(lines)
	if headerIndex == -1 {
		return stmt
	}
	clauseIndent := detectClauseIndent(lines)
	withIndex := -1
	for i := headerIndex + 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "with" {
			withIndex = i
			break
		}
	}
	formatted := formatWithEntries(entries)
	if withIndex == -1 {
		lines = insertLine(lines, headerIndex+1, clauseIndent+"with "+formatted)
		return rebuildStatement(lines)
	}
	trimmedWith := strings.TrimSpace(lines[withIndex])
	if trimmedWith == "with" {
		lines[withIndex] = clauseIndent + "with " + formatted
	} else {
		lines[withIndex] = lines[withIndex] + " " + formatted
	}
	return rebuildStatement(lines)
}

func appendClauseLine(stmt, clause string) string {
	lines := statementBodyLines(stmt)
	lines = append(lines, detectClauseIndent(lines)+clause)
	return rebuildStatement(lines)
}

func statementBodyLines(stmt string) []string {
	raw := strings.Split(strings.TrimRight(stmt, "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		if strings.TrimSpace(line) == ";" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func rebuildStatement(lines []string) string {
	trimmed := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed = append(trimmed, strings.TrimRight(line, "\r"))
	}
	return strings.Join(trimmed, "\n") + "\n;"
}

func firstStatementLineIndex(lines []string) int {
	for i, line := range lines {
		if strings.TrimSpace(line) != "" {
			return i
		}
	}
	return -1
}

func detectClauseIndent(lines []string) string {
	headerIndex := firstStatementLineIndex(lines)
	if headerIndex == -1 {
		return "  "
	}
	for i := headerIndex + 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		indentWidth := len(line) - len(strings.TrimLeft(line, " \t"))
		return line[:indentWidth]
	}
	header := lines[headerIndex]
	headerIndentWidth := len(header) - len(strings.TrimLeft(header, " \t"))
	return header[:headerIndentWidth] + "  "
}

func insertLine(lines []string, index int, line string) []string {
	if index < 0 {
		index = 0
	}
	if index > len(lines) {
		index = len(lines)
	}
	result := make([]string, 0, len(lines)+1)
	result = append(result, lines[:index]...)
	result = append(result, line)
	result = append(result, lines[index:]...)
	return result
}

func formatWithEntries(entries []withEntry) string {
	parts := make([]string, 0, len(entries))
	for _, entry := range entries {
		parts = append(parts, fmt.Sprintf(`%s="%s"`, entry.key, escapeAuraString(entry.value)))
	}
	return strings.Join(parts, " ")
}

func buildManagedDeleteArtifacts(existingIDs map[string]bool, connector genConnector, plan *appPlan, tableID, formID string, buttonIDs []string) ([]compiledStatement, []dslEdge, []string) {
	if tableID == "" || strings.TrimSpace(plan.PrimaryKeyField) == "" || len(buttonIDs) == 0 {
		return nil, nil, nil
	}
	stepID := uniqueNodeID(existingIDs, "managed_delete_"+managedCompileSlug(plan.Entity, plan.WorkflowRef, plan.ConnectorID))
	statement := compiledStatement{
		header: dslStatementHeaderInfo{Element: "step:mutation", ID: stepID, ParentID: "root"},
		text:   buildManagedDeleteStepStatement(stepID, connector, plan, tableID != "", tableID, formID),
	}
	edges := []dslEdge{{
		ID:         fmt.Sprintf("e_%s_%s_%s_%s", tableID, "selectedRow."+plan.PrimaryKeyField, stepID, "bind:where:0"),
		FromNodeID: tableID,
		FromPort:   "selectedRow." + plan.PrimaryKeyField,
		ToNodeID:   stepID,
		ToPort:     "bind:where:0",
		EdgeType:   "binding",
	}}
	return []compiledStatement{statement}, edges, []string{"synthesized managed delete flow from delete button and selected table row"}
}

func buildManagedSaveStatements(existingIDs map[string]bool, connector genConnector, plan *appPlan, tableID, formID string) ([]compiledStatement, []dslEdge, string, []string) {
	slug := managedCompileSlug(plan.Entity, plan.WorkflowRef, plan.ConnectorID)
	mode := strings.TrimSpace(plan.CRUDMode)
	if mode == "" {
		mode = "insert"
	}
	hasPrimaryKey := strings.TrimSpace(plan.PrimaryKeyField) != ""
	if (mode == "update" || mode == "upsert") && !hasPrimaryKey {
		mode = "insert"
		return buildManagedSaveStatements(existingIDs, connector, &appPlan{
			Intent:          plan.Intent,
			ConnectorID:     plan.ConnectorID,
			ConnectorType:   plan.ConnectorType,
			Entity:          plan.Entity,
			FormFields:      plan.FormFields,
			TableFields:     plan.TableFields,
			CRUDMode:        mode,
			PrimaryKeyField: plan.PrimaryKeyField,
			WorkflowName:    plan.WorkflowName,
			WorkflowRef:     plan.WorkflowRef,
		}, tableID, formID)
	}

	switch mode {
	case "update":
		// Single UPDATE step using slot.where.0 for WHERE (bound from table selection)
		stepID := uniqueNodeID(existingIDs, "managed_update_"+slug)
		var edges []dslEdge
		if tableID != "" && hasPrimaryKey {
			edges = []dslEdge{{
				ID:         fmt.Sprintf("e_%s_%s_%s_%s", tableID, "selectedRow."+plan.PrimaryKeyField, stepID, "bind:where:0"),
				FromNodeID: tableID,
				FromPort:   "selectedRow." + plan.PrimaryKeyField,
				ToNodeID:   stepID,
				ToPort:     "bind:where:0",
				EdgeType:   "binding",
			}}
		}
		return []compiledStatement{{text: buildManagedUpdateStepStatement(stepID, connector, plan, tableID != "", tableID, formID)}}, edges, stepID + ".run", nil

	case "insert_and_update":
		// Two separate steps: one insert (for new records) + one update (for editing selected)
		insertID := uniqueNodeID(existingIDs, "managed_insert_"+slug)
		updateID := uniqueNodeID(existingIDs, "managed_update_"+slug)
		var edges []dslEdge
		if tableID != "" && hasPrimaryKey {
			edges = []dslEdge{{
				ID:         fmt.Sprintf("e_%s_%s_%s_%s", tableID, "selectedRow."+plan.PrimaryKeyField, updateID, "bind:where:0"),
				FromNodeID: tableID,
				FromPort:   "selectedRow." + plan.PrimaryKeyField,
				ToNodeID:   updateID,
				ToPort:     "bind:where:0",
				EdgeType:   "binding",
			}}
		}
		return []compiledStatement{
			{text: buildManagedInsertStepStatement(insertID, connector, plan, tableID != "", tableID, formID)},
			{text: buildManagedUpdateStepStatement(updateID, connector, plan, tableID != "", tableID, formID)},
		}, edges, insertID + ".run", nil

	case "upsert":
		// Backward compat only: treat as insert. Do NOT synthesize condition branch.
		stepID := uniqueNodeID(existingIDs, "managed_save_"+slug)
		return []compiledStatement{{text: buildManagedInsertStepStatement(stepID, connector, plan, tableID != "", tableID, formID)}}, nil, stepID + ".run", nil

	default: // "insert" or anything else
		stepID := uniqueNodeID(existingIDs, "managed_save_"+slug)
		return []compiledStatement{{text: buildManagedInsertStepStatement(stepID, connector, plan, tableID != "", tableID, formID)}}, nil, stepID + ".run", nil
	}
}

func buildManagedInsertStepStatement(stepID string, connector genConnector, plan *appPlan, hasTable bool, tableID, formID string) string {
	label := managedSaveLabel("insert", plan)
	insertSQL := buildManagedInsertSQL(connector.name, plan.FormFields)
	lines := []string{
		fmt.Sprintf("step:mutation %s @ root", stepID),
		fmt.Sprintf("  text %q", label),
		"  with " + formatWithEntries([]withEntry{
			{key: "connector_id", value: plan.ConnectorID},
			{key: "sql", value: insertSQL},
		}),
	}
	if hasTable && tableID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.refresh", tableID))
	}
	if formID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.reset", formID))
	}
	lines = append(lines,
		`  style { flowX: "520"; flowY: "80" }`,
		";",
	)
	return strings.Join(lines, "\n")
}

func buildManagedUpdateStepStatement(stepID string, connector genConnector, plan *appPlan, hasTable bool, tableID, formID string) string {
	updateSQL := buildManagedUpdateSQL(connector.name, plan.FormFields, plan.PrimaryKeyField)
	lines := []string{
		fmt.Sprintf("step:mutation %s @ root", stepID),
		fmt.Sprintf("  text %q", managedSaveLabel("update", plan)),
		"  with " + formatWithEntries([]withEntry{
			{key: "connector_id", value: plan.ConnectorID},
			{key: "sql", value: updateSQL},
		}),
	}
	if hasTable && tableID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.refresh", tableID))
	}
	if formID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.reset", formID))
	}
	lines = append(lines,
		`  style { flowX: "520"; flowY: "120" }`,
		";",
	)
	return strings.Join(lines, "\n")
}

func buildManagedDeleteStepStatement(stepID string, connector genConnector, plan *appPlan, hasTable bool, tableID, formID string) string {
	deleteSQL := buildManagedDeleteSQL(connector.name, plan.PrimaryKeyField)
	lines := []string{
		fmt.Sprintf("step:mutation %s @ root", stepID),
		fmt.Sprintf("  text %q", managedSaveLabel("delete", plan)),
		"  with " + formatWithEntries([]withEntry{
			{key: "connector_id", value: plan.ConnectorID},
			{key: "sql", value: deleteSQL},
		}),
	}
	if hasTable && tableID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.refresh", tableID))
	}
	if formID != "" {
		lines = append(lines, fmt.Sprintf("  output result -> %s.reset", formID))
	}
	lines = append(lines,
		`  style { flowX: "520"; flowY: "160" }`,
		";",
	)
	return strings.Join(lines, "\n")
}

func managedSaveLabel(kind string, plan *appPlan) string {
	entity := strings.TrimSpace(plan.Entity)
	if entity == "" {
		entity = "record"
	}
	switch kind {
	case "update":
		return "Update " + strings.Title(entity)
	case "delete":
		return "Delete " + strings.Title(entity)
	default:
		if label := strings.TrimSpace(plan.WorkflowName); label != "" {
			return label
		}
		return "Save " + strings.Title(entity)
	}
}

func buildManagedSelectSQL(connectorName string, preferredColumns, fallbackColumns []string) string {
	columns := dedupeFields(preferredColumns)
	if len(columns) == 0 {
		columns = dedupeFields(fallbackColumns)
	}
	selectList := "*"
	if len(columns) > 0 {
		quoted := make([]string, 0, len(columns))
		for _, column := range columns {
			quoted = append(quoted, quoteSQLIdentifier(column))
		}
		selectList = strings.Join(quoted, ", ")
	}
	return fmt.Sprintf("SELECT %s FROM %s", selectList, managedRuntimeTableName(connectorName))
}

func buildManagedInsertSQL(connectorName string, fields []string) string {
	filtered := dedupeFields(fields)
	columns := make([]string, 0, len(filtered))
	values := make([]string, 0, len(filtered))
	for _, field := range filtered {
		columns = append(columns, quoteSQLIdentifier(field))
		values = append(values, fmt.Sprintf("'{{%s}}'", field))
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", managedRuntimeTableName(connectorName), strings.Join(columns, ", "), strings.Join(values, ", "))
}

func buildManagedDeleteSQL(connectorName, primaryKeyField string) string {
	return fmt.Sprintf("DELETE FROM %s WHERE %s='{{slot.where.0}}'", managedRuntimeTableName(connectorName), quoteSQLIdentifier(primaryKeyField))
}

func buildManagedUpdateSQL(connectorName string, fields []string, primaryKeyField string) string {
	filtered := dedupeFields(fields)
	assignments := make([]string, 0, len(filtered))
	for _, field := range filtered {
		if field == primaryKeyField {
			continue
		}
		assignments = append(assignments, fmt.Sprintf("%s='{{%s}}'", quoteSQLIdentifier(field), field))
	}
	if len(assignments) == 0 && strings.TrimSpace(primaryKeyField) != "" {
		assignments = append(assignments, fmt.Sprintf("%s='{{%s}}'", quoteSQLIdentifier(primaryKeyField), primaryKeyField))
	}
	return fmt.Sprintf("UPDATE %s SET %s WHERE %s='{{slot.where.0}}'", managedRuntimeTableName(connectorName), strings.Join(assignments, ", "), quoteSQLIdentifier(primaryKeyField))
}

func dedupeFields(fields []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		trimmed := strings.TrimSpace(field)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	return result
}

func firstNonEmptyFields(primary, fallback []string) []string {
	if fields := dedupeFields(primary); len(fields) > 0 {
		return fields
	}
	return dedupeFields(fallback)
}

func ensureField(fields []string, field string) []string {
	field = strings.TrimSpace(field)
	if field == "" {
		return dedupeFields(fields)
	}
	result := dedupeFields(fields)
	for _, existing := range result {
		if existing == field {
			return result
		}
	}
	return append(result, field)
}

func csvFieldList(fields []string) string {
	return strings.Join(dedupeFields(fields), ",")
}

func isManagedDeleteButtonStatement(header dslStatementHeaderInfo, stmt string) bool {
	if header.Element != "button" {
		return false
	}
	if variant, ok := statementStyleValue(stmt, "variant"); ok && strings.EqualFold(variant, "danger") {
		return true
	}
	for _, candidate := range []string{header.ID, statementTextValue(stmt), statementWithValue(stmt, "label"), statementStyleValueOrEmpty(stmt, "label")} {
		if isDeleteLikeText(candidate) {
			return true
		}
	}
	return false
}

func isDeleteLikeText(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return false
	}
	for _, token := range []string{"delete", "remove", "trash"} {
		if strings.Contains(value, token) {
			return true
		}
	}
	return false
}

func statementTextValue(stmt string) string {
	for _, line := range strings.Split(stmt, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "text ") {
			continue
		}
		return decodeAuraQuotedString(strings.TrimSpace(strings.TrimPrefix(trimmed, "text ")))
	}
	return ""
}

func statementWithValue(stmt, key string) string {
	for _, line := range strings.Split(stmt, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "with ") {
			continue
		}
		if value, ok := extractKeyedValue(trimmed, key); ok {
			return value
		}
	}
	return ""
}

func statementStyleValue(stmt, key string) (string, bool) {
	inStyle := false
	for _, line := range strings.Split(stmt, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "style {") {
			inStyle = true
			continue
		}
		if !inStyle {
			continue
		}
		if trimmed == "}" {
			break
		}
		if !strings.HasPrefix(trimmed, key+":") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(trimmed, key+":"))
		value = strings.TrimSuffix(value, ";")
		return decodeAuraQuotedString(value), true
	}
	return "", false
}

func statementStyleValueOrEmpty(stmt, key string) string {
	value, _ := statementStyleValue(stmt, key)
	return value
}

func extractKeyedValue(line, key string) (string, bool) {
	needle := key + `="`
	idx := strings.Index(line, needle)
	if idx == -1 {
		return "", false
	}
	start := idx + len(needle) - 1
	quoted, ok := extractQuotedToken(line[start:])
	if !ok {
		return "", false
	}
	return decodeAuraQuotedString(quoted), true
}

func extractQuotedToken(raw string) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	escape := false
	for i := 1; i < len(raw); i++ {
		if escape {
			escape = false
			continue
		}
		if raw[i] == '\\' {
			escape = true
			continue
		}
		if raw[i] == '"' {
			return raw[:i+1], true
		}
	}
	return "", false
}

func decodeAuraQuotedString(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	decoded, err := strconv.Unquote(raw)
	if err == nil {
		return decoded
	}
	return strings.Trim(raw, `"`)
}

func managedRuntimeTableName(name string) string {
	s := managedCompileNonWordRe.ReplaceAllString(name, "_")
	s = strings.Trim(s, "_")
	if s == "" {
		s = "data"
	}
	if s[0] >= '0' && s[0] <= '9' {
		s = "_" + s
	}
	return s
}

func managedCompileSlug(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		slug := strings.ToLower(managedCompileNonWordRe.ReplaceAllString(trimmed, "_"))
		slug = strings.Trim(slug, "_")
		if slug == "" {
			continue
		}
		if slug[0] >= '0' && slug[0] <= '9' {
			slug = "managed_" + slug
		}
		return slug
	}
	return "managed"
}

func uniqueNodeID(existing map[string]bool, base string) string {
	id := base
	if id == "" {
		id = "managed"
	}
	for suffix := 2; existing[id]; suffix++ {
		id = fmt.Sprintf("%s_%d", base, suffix)
	}
	existing[id] = true
	return id
}

func quoteSQLIdentifier(name string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(name), `"`, `""`) + `"`
}

func escapeAuraString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}
