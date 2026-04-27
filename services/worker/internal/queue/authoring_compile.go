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

type flatAuthoringRun struct {
	source   flatAuthoringRef
	targetID string
}

type flatAuthoringSet struct {
	targetID string
	key      string
	value    string
}

type flatAuthoringDocument struct {
	nodes                  []flatAuthoringNode
	entitiesByID           map[string]map[string]string
	fieldsByTargetID       map[string][]string
	columnsByTargetID      map[string][]string
	optionsByTargetID      map[string][]string
	setsByTargetID         map[string][]flatAuthoringSet
	binds                  []flatAuthoringBind
	runs                   []flatAuthoringRun
	effects                []flatAuthoringBind
	hasManagedAction       bool
	hasQueryAction         bool
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

func isStandaloneFlatAuthoringWithLine(line string) bool {
	return line == "with" || strings.HasPrefix(line, "with ") || strings.HasPrefix(line, "with\t")
}

func flatAuthoringStatementCanAcceptWith(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	switch tokens[0] {
	case "app", "entity", "page", "stack", "grid", "slot", "widget", "action":
		return true
	default:
		return false
	}
}

func findFlatAuthoringWithMergeTargetIndex(lines []string) int {
	for index := len(lines) - 1; index >= 0; index-- {
		trimmed := strings.TrimSpace(lines[index])
		if trimmed == "" || trimmed == "---" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		tokens := tokenizeFlatAuthoringLine(trimmed)
		if flatAuthoringStatementCanAcceptWith(tokens) {
			return index
		}
		break
	}
	return -1
}

func compileManagedCRUDAuthoringRuntimeDSL(src string, plan *appPlan, connectors []genConnector) (string, []dslEdge, []string, bool, error) {
	if !looksLikeFlatAuthoringAura(src) {
		return src, nil, nil, false, nil
	}

	repairedSrc, repairNotes := repairFlatAuthoringCommonSyntax(src)
	doc, err := parseFlatAuthoringDocument(repairedSrc)
	if err != nil {
		return src, nil, nil, false, err
	}
	if len(doc.unsupportedActionKinds) > 0 {
		return src, nil, nil, false, fmt.Errorf("unsupported flat Aura authoring action kinds in worker: %s; only managed_crud, delete_selected, and query are currently supported", strings.Join(dedupeFields(doc.unsupportedActionKinds), ", "))
	}

	compiled, compilerEdges, err := lowerFlatAuthoringDocument(doc, plan, connectors)
	if err != nil {
		return src, nil, nil, false, err
	}
	note := "compiled flat layout Aura into canonical runtime Aura"
	if doc.hasManagedAction && doc.hasQueryAction {
		note = "compiled flat managed/query authoring Aura into canonical runtime Aura"
	} else if doc.hasManagedAction {
		note = "compiled flat managed CRUD authoring Aura into canonical runtime Aura"
	} else if doc.hasQueryAction {
		note = "compiled flat query authoring Aura into canonical runtime Aura"
	}
	return compiled, compilerEdges, append(repairNotes, note), true, nil
}

func repairFlatAuthoringCommonSyntax(src string) (string, []string) {
	if strings.TrimSpace(src) == "" {
		return src, nil
	}

	rawLines := strings.Split(src, "\n")
	repaired := make([]string, 0, len(rawLines))
	notes := make([]string, 0)

	for index := 0; index < len(rawLines); index++ {
		line := rawLines[index]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == "---" || strings.HasPrefix(trimmed, "#") {
			repaired = append(repaired, line)
			continue
		}

		if isStandaloneFlatAuthoringWithLine(trimmed) {
			mergeTargetIndex := findFlatAuthoringWithMergeTargetIndex(repaired)
			if mergeTargetIndex >= 0 {
				payloadParts := make([]string, 0, 4)
				if inlinePayload := strings.TrimSpace(strings.TrimPrefix(trimmed, "with")); inlinePayload != "" {
					payloadParts = append(payloadParts, inlinePayload)
				}
				for index+1 < len(rawLines) {
					nextLine := strings.TrimSpace(rawLines[index+1])
					if nextLine == "" || nextLine == "---" || strings.HasPrefix(nextLine, "#") {
						break
					}
					nextTokens := tokenizeFlatAuthoringLine(nextLine)
					if len(nextTokens) > 0 && flatAuthoringKeywords[nextTokens[0]] {
						break
					}
					if isStandaloneFlatAuthoringWithLine(nextLine) {
						break
					}
					payloadParts = append(payloadParts, nextLine)
					index++
				}
				if len(payloadParts) > 0 {
					mergeTarget := strings.TrimSpace(repaired[mergeTargetIndex])
					mergeTargetTokens := tokenizeFlatAuthoringLine(mergeTarget)
					repaired[mergeTargetIndex] = mergeTarget + " " + strings.Join(payloadParts, " ")
					notes = append(notes, fmt.Sprintf("merged standalone with clause into %s statement", mergeTargetTokens[0]))
					continue
				}
			}
		}

		tokens := tokenizeFlatAuthoringLine(trimmed)
		if len(tokens) == 0 || !flatAuthoringKeywords[tokens[0]] {
			repaired = append(repaired, line)
			continue
		}

		keyword := tokens[0]
		current := trimmed
		for flatAuthoringLineNeedsContinuation(tokens) {
			if index+1 >= len(rawLines) {
				break
			}
			nextLine := strings.TrimSpace(rawLines[index+1])
			if nextLine == "" || nextLine == "---" || strings.HasPrefix(nextLine, "#") {
				break
			}
			nextTokens := tokenizeFlatAuthoringLine(nextLine)
			if len(nextTokens) > 0 && flatAuthoringKeywords[nextTokens[0]] {
				break
			}
			current = current + " " + nextLine
			tokens = tokenizeFlatAuthoringLine(current)
			index++
			notes = append(notes, fmt.Sprintf("merged split continuation into %s statement", keyword))
		}

		repaired = append(repaired, current)
	}

	return strings.Join(repaired, "\n"), notes
}

func flatAuthoringLineNeedsContinuation(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}

	switch tokens[0] {
	case "app", "entity", "page", "note":
		return len(tokens) < 2
	case "field", "column", "option":
		return len(tokens) < 3
	case "widget":
		if len(tokens) < 4 {
			return true
		}
		if strings.HasPrefix(tokens[3], "@") && tokens[3] != "@" {
			return false
		}
		return len(tokens) < 5 || tokens[3] != "@"
	case "stack", "grid", "slot", "action":
		if len(tokens) < 3 {
			return true
		}
		if strings.HasPrefix(tokens[2], "@") && tokens[2] != "@" {
			return false
		}
		return len(tokens) < 4 || tokens[2] != "@"
	case "bind", "run", "effect":
		return len(tokens) < 4 || tokens[2] != "->"
	case "set":
		return len(tokens) < 3
	default:
		return false
	}
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
		entitiesByID:      map[string]map[string]string{},
		fieldsByTargetID:  map[string][]string{},
		columnsByTargetID: map[string][]string{},
		optionsByTargetID: map[string][]string{},
		setsByTargetID:    map[string][]flatAuthoringSet{},
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
		case "app", "note":
			continue
		case "entity":
			id, attrs, err := parseFlatNamedAttrs(tokens, "entity", 1, 2)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.entitiesByID[id] = attrs
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
			case "query":
				doc.hasQueryAction = true
				doc.nodes = append(doc.nodes, flatAuthoringNode{statementType: "action", element: lowerManagedAuthoringActionElement(kind), id: id, parentID: parentID, attrs: attrs})
			case "":
				return flatAuthoringDocument{}, fmt.Errorf("action %q must declare kind=... in flat Aura authoring", id)
			default:
				doc.unsupportedActionKinds = append(doc.unsupportedActionKinds, kind)
			}
		case "run":
			run, err := parseFlatRun(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.runs = append(doc.runs, run)
		case "effect":
			effect, err := parseFlatBind(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.effects = append(doc.effects, effect)
		case "set":
			setStmt, err := parseFlatSet(tokens)
			if err != nil {
				return flatAuthoringDocument{}, err
			}
			doc.setsByTargetID[setStmt.targetID] = append(doc.setsByTargetID[setStmt.targetID], setStmt)
		default:
			return flatAuthoringDocument{}, fmt.Errorf("unknown flat Aura authoring keyword %q", tokens[0])
		}
	}

	return doc, nil
}

func lowerFlatAuthoringDocument(doc flatAuthoringDocument, plan *appPlan, connectors []genConnector) (string, []dslEdge, error) {
	nodeByID := make(map[string]flatAuthoringNode, len(doc.nodes))
	actionNodeIDs := make(map[string]bool)
	actionKindsByID := make(map[string]string)
	effectiveAttrsByNodeID := make(map[string]map[string]string, len(doc.nodes))
	effectiveStyleByNodeID := make(map[string]map[string]string, len(doc.nodes))
	for _, node := range doc.nodes {
		nodeByID[node.id] = node
		if node.statementType == "action" {
			actionNodeIDs[node.id] = true
			actionKindsByID[node.id] = strings.TrimSpace(node.attrs["kind"])
		}
		attrs := cloneFlatAttrs(node.attrs)
		styleAttrs := map[string]string{}
		applyFlatSetStatements(doc.setsByTargetID[node.id], attrs, styleAttrs)
		if node.statementType == "page" {
			attrs["authoring_type"] = "page"
		}
		effectiveAttrsByNodeID[node.id] = attrs
		effectiveStyleByNodeID[node.id] = styleAttrs
	}

	bindLinesBySourceID := make(map[string][]string)
	compilerEdges := make([]dslEdge, 0)
	compilerEdgeIDs := make(map[string]bool)
	appendCompilerEdge := func(fromNodeID, fromPort, toNodeID, toPort, edgeType string) {
		id := fmt.Sprintf("e_%s_%s_%s_%s", fromNodeID, fromPort, toNodeID, toPort)
		if compilerEdgeIDs[id] {
			return
		}
		compilerEdgeIDs[id] = true
		compilerEdges = append(compilerEdges, dslEdge{
			ID:         id,
			FromNodeID: fromNodeID,
			FromPort:   fromPort,
			ToNodeID:   toNodeID,
			ToPort:     toPort,
			EdgeType:   edgeType,
		})
	}

	for _, node := range doc.nodes {
		if node.statementType != "action" || actionKindsByID[node.id] != "query" {
			continue
		}
		if err := lowerFlatQueryAction(node, doc, nodeByID, effectiveAttrsByNodeID, plan, connectors, appendCompilerEdge); err != nil {
			return "", nil, err
		}
	}

	for _, bind := range doc.binds {
		sourceNode, sourceExists := nodeByID[bind.source.nodeID]
		targetNode, targetExists := nodeByID[bind.target.nodeID]
		if !sourceExists {
			return "", nil, fmt.Errorf("bind source %q not found in flat Aura authoring", bind.source.nodeID)
		}
		if !targetExists {
			return "", nil, fmt.Errorf("bind target %q not found in flat Aura authoring", bind.target.nodeID)
		}
		sourceActionKind := actionKindsByID[bind.source.nodeID]
		targetActionKind := actionKindsByID[bind.target.nodeID]
		if actionNodeIDs[bind.source.nodeID] || actionNodeIDs[bind.target.nodeID] {
			if sourceActionKind != "query" && targetActionKind != "query" {
				continue
			}
			appendCompilerEdge(
				bind.source.nodeID,
				lowerFlatAuthoringEdgeSourcePort(bind.source, sourceActionKind),
				bind.target.nodeID,
				lowerFlatAuthoringEdgeTargetPort(bind.target, targetActionKind),
				lowerFlatAuthoringBindEdgeType(bind.target.nodeID, actionNodeIDs),
			)
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

	for _, run := range doc.runs {
		targetKind := actionKindsByID[run.targetID]
		if targetKind != "query" {
			continue
		}
		sourceNodeID := run.source.nodeID
		if sourceNodeID == "page" {
			if targetNode, ok := nodeByID[run.targetID]; ok {
				sourceNodeID = targetNode.parentID
			}
		}
		appendCompilerEdge(
			sourceNodeID,
			lowerFlatAuthoringEdgeSourcePort(run.source, actionKindsByID[run.source.nodeID]),
			run.targetID,
			"run",
			"async",
		)
	}

	for _, effect := range doc.effects {
		sourceKind := actionKindsByID[effect.source.nodeID]
		targetKind := actionKindsByID[effect.target.nodeID]
		if sourceKind != "query" && targetKind != "query" {
			continue
		}
		appendCompilerEdge(
			effect.source.nodeID,
			lowerFlatAuthoringEdgeSourcePort(effect.source, sourceKind),
			effect.target.nodeID,
			lowerFlatAuthoringEdgeTargetPort(effect.target, targetKind),
			lowerFlatAuthoringEffectEdgeType(effect.target.nodeID, actionNodeIDs),
		)
	}

	statements := make([]string, 0, len(doc.nodes))
	for _, node := range doc.nodes {
		attrs := cloneFlatAttrs(effectiveAttrsByNodeID[node.id])
		styleAttrs := cloneFlatAttrs(effectiveStyleByNodeID[node.id])
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
	return strings.Join(statements, "\n\n"), compilerEdges, nil
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
	if len(tokens) >= 3 && strings.HasPrefix(tokens[2], "@") && tokens[2] != "@" {
		parentID := strings.TrimPrefix(tokens[2], "@")
		attrs, err := parseFlatAttrTokens(tokens, 3)
		if err != nil {
			return "", "", nil, err
		}
		return id, parentID, attrs, nil
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
	parentTokenIndex := 3
	if strings.HasPrefix(widgetType, "type=") {
		widgetType = decodeFlatAuthoringToken(strings.TrimPrefix(widgetType, "type="))
		id, err = flatExpectToken(tokens, 3, "widget")
		if err != nil {
			return "", "", "", nil, err
		}
		parentTokenIndex = 4
	} else if strings.HasPrefix(id, "type=") {
		declaredType := decodeFlatAuthoringToken(strings.TrimPrefix(id, "type="))
		if KnownElement(declaredType) {
			widgetType = declaredType
		}
		id, err = flatExpectToken(tokens, 3, "widget")
		if err != nil {
			return "", "", "", nil, err
		}
		parentTokenIndex = 4
	}
	if len(tokens) > parentTokenIndex && strings.HasPrefix(tokens[parentTokenIndex], "@") && tokens[parentTokenIndex] != "@" {
		parentID := strings.TrimPrefix(tokens[parentTokenIndex], "@")
		attrs, err := parseFlatAttrTokens(tokens, parentTokenIndex+1)
		if err != nil {
			return "", "", "", nil, err
		}
		return widgetType, id, parentID, attrs, nil
	}
	if len(tokens) >= 4 && strings.HasPrefix(tokens[3], "@") && tokens[3] != "@" {
		parentID := strings.TrimPrefix(tokens[3], "@")
		attrs, err := parseFlatAttrTokens(tokens, 4)
		if err != nil {
			return "", "", "", nil, err
		}
		return widgetType, id, parentID, attrs, nil
	}
	if len(tokens) <= parentTokenIndex+1 || tokens[parentTokenIndex] != "@" {
		return "", "", "", nil, fmt.Errorf("widget %q must include '@ parentId'", id)
	}
	parentID, err := flatExpectToken(tokens, parentTokenIndex+1, "widget")
	if err != nil {
		return "", "", "", nil, err
	}
	attrs, err := parseFlatAttrTokens(tokens, parentTokenIndex+2)
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

func parseFlatRun(tokens []string) (flatAuthoringRun, error) {
	if len(tokens) < 4 || tokens[2] != "->" {
		return flatAuthoringRun{}, fmt.Errorf("run must include '->'")
	}
	source, err := parseFlatAuthoringRef(tokens[1])
	if err != nil {
		return flatAuthoringRun{}, err
	}
	targetID, err := flatExpectToken(tokens, 3, "run")
	if err != nil {
		return flatAuthoringRun{}, err
	}
	return flatAuthoringRun{source: source, targetID: targetID}, nil
}

func parseFlatSet(tokens []string) (flatAuthoringSet, error) {
	targetID, err := flatExpectToken(tokens, 1, "set")
	if err != nil {
		return flatAuthoringSet{}, err
	}
	attrs, err := parseFlatAttrTokens(tokens, 2)
	if err != nil {
		return flatAuthoringSet{}, err
	}
	for key, value := range attrs {
		return flatAuthoringSet{targetID: targetID, key: key, value: value}, nil
	}
	return flatAuthoringSet{}, fmt.Errorf("set %q must include a key=value pair", targetID)
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

func applyFlatSetStatements(setStatements []flatAuthoringSet, attrs map[string]string, styleAttrs map[string]string) {
	for _, setStatement := range setStatements {
		if strings.HasPrefix(setStatement.key, "style.") {
			styleAttrs[strings.TrimPrefix(setStatement.key, "style.")] = setStatement.value
			continue
		}
		attrs[setStatement.key] = setStatement.value
	}
}

func lowerManagedAuthoringActionElement(kind string) string {
	switch kind {
	case "managed_crud", "delete_selected":
		return "step:mutation"
	case "query":
		return "step:query"
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

func lowerFlatAuthoringActionSourcePort(port string, kind string) string {
	switch port {
	case "success", "done":
		switch kind {
		case "query", "managed_crud", "delete_selected":
			return "result"
		default:
			return lowerFlatAuthoringSourcePort(port)
		}
	case "error":
		return "result"
	default:
		return lowerFlatAuthoringSourcePort(port)
	}
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

func lowerFlatAuthoringActionTargetPort(port string) string {
	if port == "run" {
		return "run"
	}
	if strings.HasPrefix(port, "params.") {
		return port
	}
	return "params." + port
}

func lowerFlatAuthoringEdgeSourcePort(ref flatAuthoringRef, actionKind string) string {
	if actionKind != "" {
		return lowerFlatAuthoringActionSourcePort(ref.port, actionKind)
	}
	return lowerFlatAuthoringSourcePort(ref.port)
}

func lowerFlatAuthoringEdgeTargetPort(ref flatAuthoringRef, actionKind string) string {
	if actionKind != "" {
		return lowerFlatAuthoringActionTargetPort(ref.port)
	}
	return lowerFlatAuthoringTargetPort(ref.port)
}

func lowerFlatAuthoringBindEdgeType(targetNodeID string, actionNodeIDs map[string]bool) string {
	if actionNodeIDs[targetNodeID] {
		return "binding"
	}
	return "reactive"
}

func lowerFlatAuthoringEffectEdgeType(targetNodeID string, actionNodeIDs map[string]bool) string {
	if actionNodeIDs[targetNodeID] {
		return "async"
	}
	return "reactive"
}

func lowerFlatQueryAction(
	actionNode flatAuthoringNode,
	doc flatAuthoringDocument,
	nodeByID map[string]flatAuthoringNode,
	effectiveAttrsByNodeID map[string]map[string]string,
	plan *appPlan,
	connectors []genConnector,
	appendCompilerEdge func(fromNodeID, fromPort, toNodeID, toPort, edgeType string),
) error {
	actionAttrs := effectiveAttrsByNodeID[actionNode.id]
	sourceEntityID := firstNonEmpty(actionAttrs["source"], actionAttrs["entity"], planEntityForFlatQuery(plan))
	entityAttrs := doc.entitiesByID[sourceEntityID]
	connectorHint := firstNonEmpty(actionAttrs["connector_id"], actionAttrs["connector"], entityAttrs["connector"], planConnectorHintForFlatQuery(plan))
	connector, ok := resolveFlatQueryConnector(plan, connectors, sourceEntityID, connectorHint)
	if !ok {
		return fmt.Errorf("query action %q could not resolve a connector from source/entity %q", actionNode.id, sourceEntityID)
	}
	actionAttrs["connector_id"] = connector.id
	actionAttrs["connectorType"] = connector.cType

	targetID := strings.TrimSpace(actionAttrs["target"])
	if targetID == "" {
		return fmt.Errorf("query action %q must declare target=<widgetId>", actionNode.id)
	}
	targetNode, ok := nodeByID[targetID]
	if !ok || targetNode.statementType != "widget" {
		return fmt.Errorf("query action %q references unknown target widget %q", actionNode.id, targetID)
	}
	widgetAttrs := effectiveAttrsByNodeID[targetID]
	widgetAttrs["queryAction"] = actionNode.id
	availableColumns := flatQueryAvailableColumns(doc, targetID, connector, plan, sourceEntityID)
	if strings.TrimSpace(actionAttrs["resultColumns"]) == "" && len(availableColumns) > 0 {
		actionAttrs["resultColumns"] = strings.Join(availableColumns, ",")
	}
	if strings.TrimSpace(actionAttrs["sql"]) == "" {
		querySQL, err := buildDefaultFlatQuerySQL(connector, sourceEntityID, entityAttrs, availableColumns)
		if err != nil {
			return fmt.Errorf("query action %q: %w", actionNode.id, err)
		}
		actionAttrs["sql"] = querySQL
	}

	switch targetNode.element {
	case "table":
		appendCompilerEdge(actionNode.id, "rows", targetID, "setRows", "reactive")
	case "chart":
		labelCol := strings.TrimSpace(firstNonEmpty(widgetAttrs["labelCol"], widgetAttrs["label_col"]))
		valueCol := strings.TrimSpace(firstNonEmpty(widgetAttrs["valueCol"], widgetAttrs["value_col"]))
		if labelCol == "" || valueCol == "" {
			inferredLabel, inferredValue := inferFlatQueryChartColumns(actionAttrs["profile"], availableColumns)
			if labelCol == "" {
				labelCol = inferredLabel
			}
			if valueCol == "" {
				valueCol = inferredValue
			}
		}
		if labelCol == "" || valueCol == "" {
			return fmt.Errorf("query action %q could not infer chart label/value columns for target %q", actionNode.id, targetID)
		}
		widgetAttrs["labelCol"] = labelCol
		widgetAttrs["valueCol"] = valueCol
		if strings.TrimSpace(widgetAttrs["aggregate"]) == "" && strings.EqualFold(strings.TrimSpace(actionAttrs["profile"]), "time_series") {
			widgetAttrs["aggregate"] = "sum"
		}
		appendCompilerEdge(actionNode.id, "rows", targetID, "setData", "reactive")
	case "kpi":
		_, inferredValue := inferFlatQueryChartColumns(actionAttrs["profile"], availableColumns)
		if inferredValue == "" {
			return fmt.Errorf("query action %q could not infer a KPI value column for target %q", actionNode.id, targetID)
		}
		if strings.TrimSpace(actionAttrs["resultColumns"]) == "" {
			actionAttrs["resultColumns"] = inferredValue
		} else if !strings.Contains(actionAttrs["resultColumns"], inferredValue) {
			actionAttrs["resultColumns"] = strings.Join(dedupeFields([]string{actionAttrs["resultColumns"], inferredValue}), ",")
		}
		appendCompilerEdge(actionNode.id, "firstRow."+inferredValue, targetID, "setValue", "reactive")
	default:
		return fmt.Errorf("query action %q target %q must be a table, chart, or kpi widget", actionNode.id, targetID)
	}

	return nil
}

func planEntityForFlatQuery(plan *appPlan) string {
	if plan == nil {
		return ""
	}
	return strings.TrimSpace(plan.Entity)
}

func planConnectorHintForFlatQuery(plan *appPlan) string {
	if plan == nil {
		return ""
	}
	return strings.TrimSpace(plan.ConnectorID)
}

func resolveFlatQueryConnector(plan *appPlan, connectors []genConnector, sourceEntityID, connectorHint string) (genConnector, bool) {
	if plan != nil && strings.TrimSpace(plan.ConnectorID) != "" {
		if connector, ok := findConnectorByID(connectors, strings.TrimSpace(plan.ConnectorID)); ok {
			return connector, true
		}
	}
	hints := []string{strings.TrimSpace(connectorHint), strings.TrimSpace(sourceEntityID)}
	for _, hint := range hints {
		if hint == "" {
			continue
		}
		if connector, ok := findConnectorByID(connectors, hint); ok {
			return connector, true
		}
		hintSlug := managedCompileSlug(hint)
		for _, connector := range connectors {
			if hintSlug == managedCompileSlug(connector.name) || hintSlug == managedCompileSlug(connector.id) {
				return connector, true
			}
		}
	}
	if len(connectors) == 1 {
		return connectors[0], true
	}
	return genConnector{}, false
}

func flatQueryAvailableColumns(doc flatAuthoringDocument, targetID string, connector genConnector, plan *appPlan, sourceEntityID string) []string {
	columns := make([]string, 0, len(doc.columnsByTargetID[targetID])+len(connector.columns)+len(planTableFieldsForFlatQuery(plan, sourceEntityID)))
	columns = append(columns, doc.columnsByTargetID[targetID]...)
	columns = append(columns, connector.columns...)
	columns = append(columns, planTableFieldsForFlatQuery(plan, sourceEntityID)...)
	return dedupeFields(columns)
}

func planTableFieldsForFlatQuery(plan *appPlan, sourceEntityID string) []string {
	if plan == nil {
		return nil
	}
	if strings.TrimSpace(sourceEntityID) != "" && strings.TrimSpace(plan.Entity) != "" && !strings.EqualFold(strings.TrimSpace(sourceEntityID), strings.TrimSpace(plan.Entity)) {
		return nil
	}
	return dedupeFields(plan.TableFields)
}

func buildDefaultFlatQuerySQL(connector genConnector, sourceEntityID string, entityAttrs map[string]string, preferredColumns []string) (string, error) {
	switch connector.cType {
	case "managed":
		return "", nil
	case "csv":
		selectList := flatQuerySelectList(preferredColumns)
		if selectList == "*" {
			return "SELECT * FROM csv", nil
		}
		return fmt.Sprintf("SELECT %s FROM csv", selectList), nil
	case "rest":
		return "/", nil
	case "postgres", "mysql", "mssql":
		tableName := firstNonEmpty(entityAttrs["table"], entityAttrs["source_table"], entityAttrs["connector"], sourceEntityID)
		tableName = flatQueryIdentifier(tableName)
		if tableName == "" {
			return "", fmt.Errorf("needs an explicit sql=... or entity %q table=... hint for %s connectors", sourceEntityID, connector.cType)
		}
		return fmt.Sprintf("SELECT %s FROM %s", flatQuerySelectList(preferredColumns), tableName), nil
	case "graphql":
		return "", fmt.Errorf("uses an unsupported connector type %q for query authoring", connector.cType)
	default:
		return "", nil
	}
}

func flatQuerySelectList(columns []string) string {
	filtered := make([]string, 0, len(columns))
	for _, column := range columns {
		identifier := flatQueryIdentifier(column)
		if identifier == "" {
			return "*"
		}
		filtered = append(filtered, identifier)
	}
	if len(filtered) == 0 {
		return "*"
	}
	return strings.Join(dedupeFields(filtered), ", ")
}

func flatQueryIdentifier(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	for index, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || (index > 0 && r >= '0' && r <= '9') {
			continue
		}
		return ""
	}
	return raw
}

func inferFlatQueryChartColumns(profile string, availableColumns []string) (string, string) {
	labelPatterns := []string{"name", "label", "status", "category", "type"}
	if strings.EqualFold(strings.TrimSpace(profile), "time_series") {
		labelPatterns = append([]string{"date", "month", "time", "day", "week", "year", "period", "created", "updated"}, labelPatterns...)
	}
	valuePatterns := []string{"amount", "revenue", "total", "value", "count", "sum", "sales", "price", "cost", "qty", "quantity", "score"}
	labelCol := firstMatchingFlatQueryColumn(availableColumns, labelPatterns)
	if labelCol == "" && len(availableColumns) > 0 {
		labelCol = availableColumns[0]
	}
	valueCol := firstMatchingFlatQueryColumnExcluding(availableColumns, valuePatterns, labelCol)
	if valueCol == "" {
		for _, column := range availableColumns {
			if column != labelCol {
				valueCol = column
				break
			}
		}
	}
	if valueCol == "" {
		valueCol = labelCol
	}
	return labelCol, valueCol
}

func firstMatchingFlatQueryColumn(columns []string, patterns []string) string {
	for _, column := range columns {
		lower := strings.ToLower(column)
		for _, pattern := range patterns {
			if strings.Contains(lower, pattern) {
				return column
			}
		}
	}
	return ""
}

func firstMatchingFlatQueryColumnExcluding(columns []string, patterns []string, excluded string) string {
	for _, column := range columns {
		if column == excluded {
			continue
		}
		lower := strings.ToLower(column)
		for _, pattern := range patterns {
			if strings.Contains(lower, pattern) {
				return column
			}
		}
	}
	return ""
}
