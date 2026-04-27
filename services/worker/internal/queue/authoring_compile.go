package queue

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type flatAuthoringNode struct {
	statementType string
	element       string
	id            string
	parentID      string
	attrs         map[string]string
}

type flatAuthoringRef struct {
	nodeID string
	port   string
}

type flatAuthoringBind struct {
	source flatAuthoringRef
	target flatAuthoringRef
}

type flatAuthoringDocument struct {
	nodes                  []flatAuthoringNode
	fieldsByTargetID       map[string][]string
	columnsByTargetID      map[string][]string
	optionsByTargetID      map[string][]string
	binds                  []flatAuthoringBind
	hasManagedAction       bool
	hasUnsupportedBehavior bool
	unsupportedActionKinds []string
}

var flatAuthoringKeywords = map[string]bool{
	"app":    true,
	"entity": true,
	"page":   true,
	"stack":  true,
	"grid":   true,
	"slot":   true,
	"widget": true,
	"field":  true,
	"column": true,
	"option": true,
	"action": true,
	"bind":   true,
	"run":    true,
	"effect": true,
	"set":    true,
	"note":   true,
}

func compileManagedCRUDAuthoringRuntimeDSL(src string) (string, []string, bool, error) {
	if !looksLikeFlatAuthoringAura(src) {
		return src, nil, false, nil
	}

	doc, err := parseFlatAuthoringDocument(src)
	if err != nil {
		return src, nil, false, err
	}
	if len(doc.unsupportedActionKinds) > 0 {
		return src, nil, false, fmt.Errorf("unsupported flat Aura authoring action kinds in worker: %s; only managed_crud and delete_selected are currently supported", strings.Join(dedupeFields(doc.unsupportedActionKinds), ", "))
	}
	if doc.hasUnsupportedBehavior && !doc.hasManagedAction {
		return src, nil, false, fmt.Errorf("unsupported flat Aura authoring behaviors in worker; only layout-only documents, widget binds, and managed CRUD authoring are currently supported")
	}

	compiled, err := lowerFlatAuthoringDocument(doc)
	if err != nil {
		return src, nil, false, err
	}
	note := "compiled flat layout Aura into canonical runtime Aura"
	if doc.hasManagedAction {
		note = "compiled flat managed CRUD authoring Aura into canonical runtime Aura"
	}
	return compiled, []string{note}, true, nil
}

func looksLikeFlatAuthoringAura(src string) bool {
	for _, rawLine := range strings.Split(src, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || line == "---" || strings.HasPrefix(line, "#") {
			continue
		}
		tokens := tokenizeFlatAuthoringLine(line)
		if len(tokens) == 0 {
			continue
		}
		return flatAuthoringKeywords[tokens[0]]
	}
	return false
}

func parseFlatAuthoringDocument(src string) (flatAuthoringDocument, error) {
	doc := flatAuthoringDocument{
		fieldsByTargetID:  map[string][]string{},
		columnsByTargetID: map[string][]string{},
		optionsByTargetID: map[string][]string{},
	}

	for _, rawLine := range strings.Split(src, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || line == "---" || strings.HasPrefix(line, "#") {
			continue
		}
		tokens := tokenizeFlatAuthoringLine(line)
		if len(tokens) == 0 {
			continue
		}

		switch tokens[0] {
		case "app", "entity", "note":
			continue
		case "page":
			id, attrs, err := parseFlatNamedAttrs(tokens, "page", 1, 2)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.nodes = append(doc.nodes, flatAuthoringNode{statementType: "page", element: "container", id: id, parentID: "root", attrs: attrs})
		case "stack", "grid", "slot":
			id, parentID, attrs, err := parseFlatParentedAttrs(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.nodes = append(doc.nodes, flatAuthoringNode{statementType: "layout", element: "container", id: id, parentID: parentID, attrs: attrs})
		case "widget":
			widgetType, id, parentID, attrs, err := parseFlatWidget(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			if !KnownElement(widgetType) {
				return flatAuthoringDocument{}, fmt.Errorf("unknown flat Aura widget type %q", widgetType)
			}
			doc.nodes = append(doc.nodes, flatAuthoringNode{statementType: "widget", element: widgetType, id: id, parentID: parentID, attrs: attrs})
		case "field":
			targetID, value, err := parseFlatValueLine(tokens, "field")
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.fieldsByTargetID[targetID] = append(doc.fieldsByTargetID[targetID], value)
		case "column":
			targetID, value, err := parseFlatValueLine(tokens, "column")
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.columnsByTargetID[targetID] = append(doc.columnsByTargetID[targetID], value)
		case "bind":
			bind, err := parseFlatBind(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.binds = append(doc.binds, bind)
		case "option":
			targetID, value, err := parseFlatOption(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.optionsByTargetID[targetID] = append(doc.optionsByTargetID[targetID], value)
		case "action":
			id, parentID, attrs, err := parseFlatParentedAttrs(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			kind := strings.TrimSpace(attrs["kind"])
			switch kind {
			case "managed_crud", "delete_selected":
				doc.hasManagedAction = true
				doc.nodes = append(doc.nodes, flatAuthoringNode{statementType: "action", element: lowerManagedAuthoringActionElement(kind), id: id, parentID: parentID, attrs: attrs})
			case "":
				return flatAuthoringDocument{}, fmt.Errorf("action %q must declare kind=... in flat Aura authoring", id)
			default:
				doc.unsupportedActionKinds = append(doc.unsupportedActionKinds, kind)
			}
		case "run", "effect":
			doc.hasUnsupportedBehavior = true
		case "set":
			return flatAuthoringDocument{}, fmt.Errorf("unsupported flat Aura authoring keyword %q in worker compiler", tokens[0])
		default:
			return flatAuthoringDocument{}, fmt.Errorf("unknown flat Aura authoring keyword %q", tokens[0])
		}
	}

	return doc, nil
}

func lowerFlatAuthoringDocument(doc flatAuthoringDocument) (string, error) {
	nodeByID := make(map[string]flatAuthoringNode, len(doc.nodes))
	actionNodeIDs := make(map[string]bool)
	for _, node := range doc.nodes {
		nodeByID[node.id] = node
		if node.statementType == "action" {
			actionNodeIDs[node.id] = true
		}
	}

	bindLinesBySourceID := make(map[string][]string)
	for _, bind := range doc.binds {
		sourceNode, sourceExists := nodeByID[bind.source.nodeID]
		targetNode, targetExists := nodeByID[bind.target.nodeID]
		if !sourceExists {
			return "", fmt.Errorf("bind source %q not found in flat Aura authoring", bind.source.nodeID)
		}
		if !targetExists {
			return "", fmt.Errorf("bind target %q not found in flat Aura authoring", bind.target.nodeID)
		}
		if actionNodeIDs[bind.source.nodeID] || actionNodeIDs[bind.target.nodeID] {
			continue
		}
		bindLinesBySourceID[bind.source.nodeID] = append(bindLinesBySourceID[bind.source.nodeID], fmt.Sprintf(
			"  output %s -> %s.%s",
			lowerFlatAuthoringSourcePort(bind.source.port),
			targetNode.id,
			lowerFlatAuthoringTargetPort(bind.target.port),
		))
		_ = sourceNode
	}

	statements := make([]string, 0, len(doc.nodes))
	for _, node := range doc.nodes {
		attrs := cloneFlatAttrs(node.attrs)
		styleAttrs := map[string]string{}
		if node.statementType == "widget" && node.element == "form" {
			if fields := csvFieldList(doc.fieldsByTargetID[node.id]); fields != "" {
				attrs["fields"] = fields
			}
		}
		if node.statementType == "widget" && node.element == "table" {
			if columns := csvFieldList(doc.columnsByTargetID[node.id]); columns != "" {
				attrs["columns"] = columns
			}
		}
		if node.statementType == "widget" && node.element == "filter" {
			if options := csvFieldList(doc.optionsByTargetID[node.id]); options != "" {
				styleAttrs["options"] = options
			}
		}
		text := firstNonEmpty(attrs["title"], attrs["label"], attrs["content"])
		if node.statementType == "action" && text == "" {
			text = titleCaseIdentifier(node.id)
		}
		statements = append(statements, buildFlatRuntimeStatement(node.element, node.id, node.parentID, text, attrs, styleAttrs, bindLinesBySourceID[node.id]))
	}
	return strings.Join(statements, "\n\n"), nil
}

func parseFlatNamedAttrs(tokens []string, keyword string, idIndex, attrsIndex int) (string, map[string]string, error) {
	id, err := flatExpectToken(tokens, idIndex, keyword)
	if err != nil {
		return "", nil, err
	}
	attrs, err := parseFlatAttrTokens(tokens, attrsIndex)
	if err != nil {
		return "", nil, err
	}
	return id, attrs, nil
}

func parseFlatParentedAttrs(tokens []string) (string, string, map[string]string, error) {
	keyword := tokens[0]
	id, err := flatExpectToken(tokens, 1, keyword)
	if err != nil {
		return "", "", nil, err
	}
	if len(tokens) < 4 || tokens[2] != "@" {
		return "", "", nil, fmt.Errorf("%s %q must include '@ parentId'", keyword, id)
	}
	parentID, err := flatExpectToken(tokens, 3, keyword)
	if err != nil {
		return "", "", nil, err
	}
	attrs, err := parseFlatAttrTokens(tokens, 4)
	if err != nil {
		return "", "", nil, err
	}
	return id, parentID, attrs, nil
}

func parseFlatWidget(tokens []string) (string, string, string, map[string]string, error) {
	widgetType, err := flatExpectToken(tokens, 1, "widget")
	if err != nil {
		return "", "", "", nil, err
	}
	id, err := flatExpectToken(tokens, 2, "widget")
	if err != nil {
		return "", "", "", nil, err
	}
	if len(tokens) < 5 || tokens[3] != "@" {
		return "", "", "", nil, fmt.Errorf("widget %q must include '@ parentId'", id)
	}
	parentID, err := flatExpectToken(tokens, 4, "widget")
	if err != nil {
		return "", "", "", nil, err
	}
	attrs, err := parseFlatAttrTokens(tokens, 5)
	if err != nil {
		return "", "", "", nil, err
	}
	return widgetType, id, parentID, attrs, nil
}

func parseFlatValueLine(tokens []string, keyword string) (string, string, error) {
	targetID, err := flatExpectToken(tokens, 1, keyword)
	if err != nil {
		return "", "", err
	}
	value, err := flatExpectToken(tokens, 2, keyword)
	if err != nil {
		return "", "", err
	}
	return targetID, decodeFlatAuthoringToken(value), nil
}

func parseFlatBind(tokens []string) (flatAuthoringBind, error) {
	if len(tokens) < 4 || tokens[2] != "->" {
		return flatAuthoringBind{}, fmt.Errorf("bind must include '->'")
	}
	source, err := parseFlatAuthoringRef(tokens[1])
	if err != nil {
		return flatAuthoringBind{}, err
	}
	target, err := parseFlatAuthoringRef(tokens[3])
	if err != nil {
		return flatAuthoringBind{}, err
	}
	return flatAuthoringBind{source: source, target: target}, nil
}

func parseFlatOption(tokens []string) (string, string, error) {
	targetID, err := flatExpectToken(tokens, 1, "option")
	if err != nil {
		return "", "", err
	}
	label, err := flatExpectToken(tokens, 2, "option")
	if err != nil {
		return "", "", err
	}
	attrs, err := parseFlatAttrTokens(tokens, 3)
	if err != nil {
		return "", "", err
	}
	if explicitValue := strings.TrimSpace(attrs["value"]); explicitValue != "" {
		return targetID, explicitValue, nil
	}
	return targetID, decodeFlatAuthoringToken(label), nil
}

func parseFlatAuthoringRef(raw string) (flatAuthoringRef, error) {
	dotIndex := strings.Index(raw, ".")
	if dotIndex <= 0 || dotIndex == len(raw)-1 {
		return flatAuthoringRef{}, fmt.Errorf("expected ref in the form id.port, got %q", raw)
	}
	return flatAuthoringRef{nodeID: raw[:dotIndex], port: raw[dotIndex+1:]}, nil
}

func flatExpectToken(tokens []string, index int, keyword string) (string, error) {
	if index >= len(tokens) || strings.TrimSpace(tokens[index]) == "" {
		return "", fmt.Errorf("%s is missing required tokens", keyword)
	}
	return tokens[index], nil
}

func parseFlatAttrTokens(tokens []string, startIndex int) (map[string]string, error) {
	attrs := map[string]string{}
	for index := startIndex; index < len(tokens); index++ {
		token := tokens[index]
		eqIndex := strings.Index(token, "=")
		if eqIndex == -1 {
			return nil, fmt.Errorf("expected key=value token, got %q", token)
		}
		attrs[token[:eqIndex]] = decodeFlatAuthoringToken(token[eqIndex+1:])
	}
	return attrs, nil
}

func tokenizeFlatAuthoringLine(line string) []string {
	tokens := []string{}
	current := ""
	var quote rune
	escaped := false

	for _, char := range line {
		if escaped {
			current += string(char)
			escaped = false
			continue
		}
		if char == '\\' {
			current += string(char)
			escaped = true
			continue
		}
		if quote != 0 {
			current += string(char)
			if char == quote {
				quote = 0
			}
			continue
		}
		if char == '"' || char == '\'' {
			current += string(char)
			quote = char
			continue
		}
		if char == ' ' || char == '\t' {
			if current != "" {
				tokens = append(tokens, current)
				current = ""
			}
			continue
		}
		current += string(char)
	}
	if current != "" {
		tokens = append(tokens, current)
	}
	return tokens
}

func decodeFlatAuthoringToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		return decodeAuraQuotedString(raw)
	}
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		quoted := `"` + strings.ReplaceAll(strings.ReplaceAll(raw[1:len(raw)-1], `\"`, `"`), `"`, `\\"`) + `"`
		unquoted, err := strconv.Unquote(quoted)
		if err == nil {
			return unquoted
		}
		return raw[1 : len(raw)-1]
	}
	return raw
}

func buildFlatRuntimeStatement(element, id, parentID, text string, attrs map[string]string, styleAttrs map[string]string, clauseLines []string) string {
	lines := []string{fmt.Sprintf("%s %s @ %s", element, id, parentID)}
	if text != "" {
		lines = append(lines, fmt.Sprintf(`  text "%s"`, escapeAuraString(text)))
	}
	if len(attrs) > 0 {
		lines = append(lines, "  with "+formatWithEntries(flatAttrsToEntries(attrs)))
	}
	if len(styleAttrs) > 0 {
		lines = append(lines, formatFlatStyleBlock(styleAttrs)...)
	}
	lines = append(lines, clauseLines...)
	lines = append(lines, ";")
	return strings.Join(lines, "\n")
}

func formatFlatStyleBlock(styleAttrs map[string]string) []string {
	keys := make([]string, 0, len(styleAttrs))
	for key := range styleAttrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	lines := []string{"  style {"}
	for _, key := range keys {
		lines = append(lines, fmt.Sprintf(`    %s: "%s";`, key, escapeAuraString(styleAttrs[key])))
	}
	lines = append(lines, "  }")
	return lines
}

func flatAttrsToEntries(attrs map[string]string) []withEntry {
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]withEntry, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, withEntry{key: key, value: attrs[key]})
	}
	return entries
}

func cloneFlatAttrs(attrs map[string]string) map[string]string {
	if len(attrs) == 0 {
		return map[string]string{}
	}
	clone := make(map[string]string, len(attrs))
	for key, value := range attrs {
		clone[key] = value
	}
	return clone
}

func lowerManagedAuthoringActionElement(kind string) string {
	switch kind {
	case "managed_crud", "delete_selected":
		return "step:mutation"
	default:
		return "step:transform"
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func titleCaseIdentifier(id string) string {
	parts := strings.FieldsFunc(id, func(r rune) bool {
		return r == '_' || r == '-'
	})
	for index, part := range parts {
		if part == "" {
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func lowerFlatAuthoringSourcePort(port string) string {
	if port == "selected_row" {
		return "selectedRow"
	}
	if strings.HasPrefix(port, "selected_row.") {
		return "selectedRow." + strings.TrimPrefix(port, "selected_row.")
	}
	if port == "selected_row_index" {
		return "selectedRowIndex"
	}
	if port == "clicked_at" {
		return "clickedAt"
	}
	return port
}

func lowerFlatAuthoringTargetPort(port string) string {
	if port == "values" {
		return "setValues"
	}
	if strings.HasPrefix(port, "values.") {
		return "setValues." + strings.TrimPrefix(port, "values.")
	}
	if port == "content" {
		return "setContent"
	}
	if port == "disabled" {
		return "setDisabled"
	}
	if port == "label" {
		return "setLabel"
	}
	if port == "value" {
		return "setValue"
	}
	if port == "rows" {
		return "setRows"
	}
	if strings.HasPrefix(port, "filter.") {
		return "setFilter." + strings.TrimPrefix(port, "filter.")
	}
	return port
}
