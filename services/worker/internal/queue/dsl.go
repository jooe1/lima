package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// nodeMeta mirrors model.NodeMeta from the api service.
// It is defined here to avoid a cross-module import dependency.
type nodeMeta struct {
	ManuallyEdited bool `json:"manuallyEdited"`
}

var quotedLiteralClauseParentSuffixPattern = regexp.MustCompile(`^(text|value|if|transform|formFields)\s+("([^"\\]|\\.)*")\s+@\s+\S+\s*$`)

func isForbiddenPlaceholderToken(token string) bool {
	if strings.HasPrefix(token, "[") {
		return true
	}
	if token == "<-" {
		return false
	}
	return strings.HasPrefix(token, "<") && strings.Contains(token, ">")
}

// parseDSLStatements splits an Aura DSL source string into an ordered map of
// node id → full statement text (including its trailing semicolon).
//
// It correctly handles semicolons inside `style { ... }` blocks and inside
// double-quoted strings, so only top-level `;` are treated as statement
// terminators.
//
// Returns (stmts, order, err) where stmts maps id → statement text and order
// preserves document order.
func parseDSLStatements(src string) (stmts map[string]string, order []string, err error) {
	stmts = make(map[string]string)

	var cur strings.Builder
	braceDepth := 0
	inString := false
	escape := false

	flush := func() error {
		text := strings.TrimSpace(cur.String())
		cur.Reset()
		if text == "" {
			return nil
		}
		// Minimum valid statement: <element> <id> @ <parentId>
		fields := strings.Fields(text)
		if len(fields) < 4 {
			return fmt.Errorf("malformed DSL statement (need ≥4 tokens): %.80q", text)
		}
		if fields[2] != "@" {
			return fmt.Errorf("malformed DSL statement (expected '@' at position 2): %.80q", text)
		}
		// Reject prompt-placeholder / bracket metadata syntax that the TypeScript
		// parser will reject, but allow the valid Aura input arrow token "<-".
		for _, f := range fields {
			if isForbiddenPlaceholderToken(f) {
				return fmt.Errorf("malformed DSL statement (bracket/XML attribute syntax not allowed): %.80q", text)
			}
		}
		id := fields[1]
		if _, dup := stmts[id]; dup {
			return fmt.Errorf("duplicate node id %q in DSL", id)
		}
		stmts[id] = text + "\n;"
		order = append(order, id)
		return nil
	}

	for _, ch := range src {
		if escape {
			cur.WriteRune(ch)
			escape = false
			continue
		}
		if inString && ch == '\\' {
			cur.WriteRune(ch)
			escape = true
			continue
		}
		if ch == '"' {
			inString = !inString
			cur.WriteRune(ch)
			continue
		}
		if inString {
			cur.WriteRune(ch)
			continue
		}
		switch ch {
		case '{':
			braceDepth++
			cur.WriteRune(ch)
		case '}':
			braceDepth--
			cur.WriteRune(ch)
		case ';':
			if braceDepth > 0 {
				// Inside a style block — keep as property separator.
				cur.WriteRune(ch)
			} else {
				if ferr := flush(); ferr != nil {
					return nil, nil, ferr
				}
			}
		default:
			cur.WriteRune(ch)
		}
	}

	// Any remaining non-whitespace indicates an unterminated statement.
	if remaining := strings.TrimSpace(cur.String()); remaining != "" {
		return nil, nil, fmt.Errorf("unterminated DSL statement: %.80q", remaining)
	}

	return stmts, order, nil
}

// repairGeneratedDSLCommonSyntax applies narrowly-scoped repairs for common
// model mistakes that are mechanically recoverable without guessing intent.
//
// Current repairs:
//  1. Missing top-level parent on a node header:
//     container page_shell      -> container page_shell @ root
//  2. Compact parent token:
//     form order_form @root     -> form order_form @ root
//  3. Parent split across its own line:
//     table orders_table
//     @ page_shell            -> table orders_table @ page_shell
func repairGeneratedDSLCommonSyntax(src string) (string, []string) {
	if strings.TrimSpace(src) == "" {
		return src, nil
	}

	parts := splitDSLStatementsLoose(src)
	if len(parts) == 0 {
		return src, nil
	}

	repaired := make([]string, 0, len(parts))
	var notes []string
	for _, stmt := range parts {
		fixed, note := repairDSLStatementHeader(stmt)
		repaired = append(repaired, fixed)
		if note != "" {
			notes = append(notes, note)
		}
	}

	var out strings.Builder
	for i, stmt := range repaired {
		if i > 0 {
			out.WriteString("\n")
		}
		out.WriteString(strings.TrimSpace(stmt))
		out.WriteString("\n;")
	}
	return out.String(), notes
}

func splitDSLStatementsLoose(src string) []string {
	var parts []string
	var cur strings.Builder
	braceDepth := 0
	inString := false
	escape := false

	flush := func() {
		text := strings.TrimSpace(cur.String())
		cur.Reset()
		if text != "" {
			parts = append(parts, text)
		}
	}

	for _, ch := range src {
		if escape {
			cur.WriteRune(ch)
			escape = false
			continue
		}
		if inString && ch == '\\' {
			cur.WriteRune(ch)
			escape = true
			continue
		}
		if ch == '"' {
			inString = !inString
			cur.WriteRune(ch)
			continue
		}
		if inString {
			cur.WriteRune(ch)
			continue
		}
		switch ch {
		case '{':
			braceDepth++
			cur.WriteRune(ch)
		case '}':
			braceDepth--
			cur.WriteRune(ch)
		case ';':
			if braceDepth > 0 {
				cur.WriteRune(ch)
			} else {
				flush()
			}
		default:
			cur.WriteRune(ch)
		}
	}
	flush()
	return parts
}

func repairDSLStatementHeader(stmt string) (string, string) {
	lines := strings.Split(stmt, "\n")
	headerIndex := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		headerIndex = i
		break
	}
	if headerIndex == -1 {
		return stmt, ""
	}

	headerLine := lines[headerIndex]
	trimmedHeader := strings.TrimSpace(headerLine)
	fields := strings.Fields(trimmedHeader)
	if len(fields) == 0 || !KnownElement(fields[0]) {
		return stmt, ""
	}

	element := fields[0]
	indentWidth := len(headerLine) - len(strings.TrimLeft(headerLine, " \t"))
	indent := headerLine[:indentWidth]

	if len(fields) >= 3 && strings.HasPrefix(fields[2], "@") && fields[2] != "@" {
		parentID := strings.TrimPrefix(fields[2], "@")
		if parentID != "" {
			rebuilt := append([]string{fields[0], fields[1], "@", parentID}, fields[3:]...)
			lines[headerIndex] = indent + strings.Join(rebuilt, " ")
			return strings.Join(lines, "\n"), fmt.Sprintf("split compact parent token on node %q to '@ %s'", fields[1], parentID)
		}
	}

	if len(fields) == 2 {
		if parentID, parentLineIndex, ok := extractSplitParentLine(lines, headerIndex+1); ok {
			lines[headerIndex] = indent + fields[0] + " " + fields[1] + " @ " + parentID
			lines[parentLineIndex] = ""
			return strings.Join(lines, "\n"), fmt.Sprintf("merged split parent line on node %q to '@ %s'", fields[1], parentID)
		}
		lines[headerIndex] = indent + trimmedHeader + " @ root"
		return strings.Join(lines, "\n"), fmt.Sprintf("added missing '@ root' parent to node %q", fields[1])
	}

	for i := headerIndex + 1; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if fixed, note, ok := repairDSLStatementClause(lines, i, element, line); ok {
			return fixed, note
		}
	}

	return stmt, ""
}

func extractSplitParentLine(lines []string, startIndex int) (string, int, bool) {
	for i := startIndex; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "@" && len(fields) >= 2 {
			return fields[1], i, true
		}
		if strings.HasPrefix(fields[0], "@") && len(fields[0]) > 1 {
			return strings.TrimPrefix(fields[0], "@"), i, true
		}
		return "", 0, false
	}
	return "", 0, false
}

func repairDSLStatementClause(lines []string, lineIndex int, element, line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	indentWidth := len(line) - len(strings.TrimLeft(line, " \t"))
	indent := line[:indentWidth]
	nodeID := strings.Fields(strings.TrimSpace(lines[0]))[1]

	if matches := quotedLiteralClauseParentSuffixPattern.FindStringSubmatch(trimmed); matches != nil {
		lines[lineIndex] = indent + matches[1] + " " + matches[2]
		return strings.Join(lines, "\n"), fmt.Sprintf("removed stray parent suffix from %s clause on node %q", matches[1], nodeID), true
	}

	if element == "form" && strings.HasPrefix(trimmed, "fields ") {
		value := strings.TrimSpace(strings.TrimPrefix(trimmed, "fields "))
		if value == "" {
			return "", "", false
		}
		lines[lineIndex] = indent + `with fields="` + value + `"`
		return strings.Join(lines, "\n"), fmt.Sprintf("rewrote invalid form clause 'fields ...' to 'with fields=...' on node %q", nodeID), true
	}

	return "", "", false
}

// validateDSL checks that src is syntactically and semantically well-formed
// Aura DSL. It verifies:
//  1. Syntax: all statements are well-formed (via parseDSLStatements).
//  2. Semantics: every inline link references a node that exists in the
//     document, and the source/target ports are valid for known element types.
//
// Unknown element types are treated as pass-through (not rejected) so that
// newly added element types do not break existing validators.
// An empty document is considered valid.
func validateDSL(src string) error {
	if strings.TrimSpace(src) == "" {
		return nil
	}
	stmts, order, err := parseDSLStatements(src)
	if err != nil {
		return err
	}
	for _, id := range order {
		if err := validateDSLStatementClauses(id, stmts[id]); err != nil {
			return err
		}
	}

	// Build set of known node IDs from the syntax pass.
	nodeIDs := map[string]bool{}
	for _, id := range order {
		nodeIDs[id] = true
	}

	// Semantic pass: extract structured statements for inline-link validation.
	structured, structErr := parseDSLStatementsStructured(src)
	if structErr != nil {
		// Non-fatal: partial structured info, skip semantic checks.
		structured = nil
	}

	// Build element map: node id → element type.
	elementOf := map[string]string{}
	for _, s := range structured {
		elementOf[s.ID] = s.Element
	}

	// portOK returns true when portName is valid for the given port set.
	// It passes if the set is empty (dynamic-only element), if the element is
	// unknown (ok=false), or if "*" is present as a wildcard.
	portOK := func(set map[string]bool, portName string) bool {
		if len(set) == 0 || set[portName] || set["*"] {
			return true
		}
		if dot := strings.Index(portName, "."); dot > 0 {
			return set[portName[:dot]] || set["*"]
		}
		return false
	}

	for _, s := range structured {
		srcInputs, srcOutputs, srcKnown := PortsForElement(s.Element)
		for _, link := range s.InlineLinks {
			// Check that the target node exists in the document.
			if !nodeIDs[link.TargetNodeID] {
				return fmt.Errorf("node %q references unknown target node %q", s.ID, link.TargetNodeID)
			}
			tgtInputs, tgtOutputs, tgtKnown := PortsForElement(elementOf[link.TargetNodeID])

			switch link.Direction {
			case "on":
				// on <myOutputPort> -> <target>.<targetInputPort>
				if srcKnown && !portOK(srcOutputs, link.MyPort) {
					return fmt.Errorf("node %q (element %q) has no output port %q", s.ID, s.Element, link.MyPort)
				}
				if tgtKnown && !portOK(tgtInputs, link.TargetPort) {
					return fmt.Errorf("node %q (element %q) has no input port %q", link.TargetNodeID, elementOf[link.TargetNodeID], link.TargetPort)
				}
			case "input":
				// input <myInputPort> <- <source>.<sourceOutputPort>
				if srcKnown && !portOK(srcInputs, link.MyPort) {
					return fmt.Errorf("node %q (element %q) has no input port %q", s.ID, s.Element, link.MyPort)
				}
				if tgtKnown && !portOK(tgtOutputs, link.TargetPort) {
					return fmt.Errorf("node %q (element %q) has no output port %q", link.TargetNodeID, elementOf[link.TargetNodeID], link.TargetPort)
				}
			case "output":
				// output <myOutputPort> -> <target>.<targetInputPort>
				if srcKnown && !portOK(srcOutputs, link.MyPort) {
					return fmt.Errorf("node %q (element %q) has no output port %q", s.ID, s.Element, link.MyPort)
				}
				if tgtKnown && !portOK(tgtInputs, link.TargetPort) {
					return fmt.Errorf("node %q (element %q) has no input port %q", link.TargetNodeID, elementOf[link.TargetNodeID], link.TargetPort)
				}
			}
		}
	}

	_ = stmts // used for syntax check above
	return nil
}

func validateDSLStatementClauses(nodeID, stmt string) error {
	lines := strings.Split(stmt, "\n")
	headerSeen := false
	styleDepth := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == ";" {
			continue
		}
		if !headerSeen {
			headerSeen = true
			continue
		}
		if styleDepth > 0 {
			styleDepth += countRune(trimmed, '{') - countRune(trimmed, '}')
			continue
		}

		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		clause := fields[0]
		if !isKnownDSLClauseKeyword(clause) {
			return fmt.Errorf("malformed DSL statement (unknown clause '%s' in node '%s'): %.80q", clause, nodeID, trimmed)
		}
		if clause == "style" {
			styleDepth = countRune(trimmed, '{') - countRune(trimmed, '}')
		}
	}

	if styleDepth > 0 {
		return fmt.Errorf("malformed DSL statement (unterminated style block in node '%s')", nodeID)
	}
	return nil
}

func isKnownDSLClauseKeyword(token string) bool {
	switch token {
	case "text", "value", "forEach", "key", "if", "with", "transform", "action", "formRef", "formFields", "widget_bindings", "output_bindings", "on", "input", "output", "layout", "style":
		return true
	default:
		return false
	}
}

func countRune(s string, target rune) int {
	count := 0
	for _, ch := range s {
		if ch == target {
			count++
		}
	}
	return count
}

// applyProtectedDiff applies the LLM-generated candidate revision on top of
// the current document, preserving any node whose nodeMetadata entry has
// ManuallyEdited == true (unless forceOverwrite is true).
//
// Algorithm:
//  1. Parse current and candidate into ordered id→statement maps.
//  2. Walk the candidate order; for each node:
//     - New (not in current): include the candidate version.
//     - In current and protected (!forceOverwrite): include the current version.
//     - Otherwise: include the candidate version.
//  3. Append current nodes removed by the LLM that are still protected.
//
// Returns the resulting DSL string, or an error if candidate is malformed.
func applyProtectedDiff(current, candidate string, nodeMetadata map[string]nodeMeta, forceOverwrite bool) (string, error) {
	// Empty current document: no nodes to protect; accept candidate as-is.
	if strings.TrimSpace(current) == "" {
		return candidate, nil
	}

	currentStmts, currentOrder, err := parseDSLStatements(current)
	if err != nil {
		// Stored document is somehow malformed; accept candidate without filtering.
		return candidate, nil
	}

	candidateStmts, candidateOrder, err := parseDSLStatements(candidate)
	if err != nil {
		return "", fmt.Errorf("candidate DSL is malformed: %w", err)
	}

	resultParts := make([]string, 0, len(candidateOrder))
	included := make(map[string]bool, len(candidateOrder))

	for _, id := range candidateOrder {
		included[id] = true
		if currentText, inCurrent := currentStmts[id]; inCurrent {
			meta := nodeMetadata[id]
			if meta.ManuallyEdited && !forceOverwrite {
				// Protected node: keep the current (human-edited) version.
				resultParts = append(resultParts, currentText)
				continue
			}
		}
		resultParts = append(resultParts, candidateStmts[id])
	}

	// Preserve protected nodes that the LLM dropped.
	for _, id := range currentOrder {
		if included[id] {
			continue
		}
		meta := nodeMetadata[id]
		if meta.ManuallyEdited && !forceOverwrite {
			resultParts = append(resultParts, currentStmts[id])
		}
		// Unprotected removed nodes are intentionally omitted.
	}

	return strings.Join(resultParts, "\n"), nil
}

// ---- DSL step-graph helpers -------------------------------------------------

// dslEdge mirrors model.AuraEdge locally to avoid cross-module imports.
// JSON keys use camelCase to match the TypeScript AuraEdge interface.
type dslEdge struct {
	ID         string `json:"id"`
	FromNodeID string `json:"fromNodeId"`
	FromPort   string `json:"fromPort"`
	ToNodeID   string `json:"toNodeId"`
	ToPort     string `json:"toPort"`
	EdgeType   string `json:"edgeType"`
	Transform  string `json:"transform,omitempty"`
}

// getAppDSLForWorkflow fetches the app's dsl_source, dsl_edges, and dsl_version
// by joining workflows → apps.
// Returns (dslSource, edges, dslVersion, appID, err).
func getAppDSLForWorkflow(ctx context.Context, pool *pgxpool.Pool, workflowID string) (string, []dslEdge, int, string, error) {
	var dslSource string
	var edgesBytes []byte
	var dslVersion int
	var appID string

	err := pool.QueryRow(ctx, `
		SELECT a.dsl_source, a.dsl_edges, a.dsl_version, a.id
		FROM apps a
		JOIN workflows w ON w.app_id = a.id
		WHERE w.id = $1`,
		workflowID,
	).Scan(&dslSource, &edgesBytes, &dslVersion, &appID)
	if err != nil {
		return "", nil, 0, "", fmt.Errorf("no app found for workflow %s", workflowID)
	}

	if strings.TrimSpace(dslSource) == "" {
		return "", nil, 0, "", fmt.Errorf("no app found for workflow %s", workflowID)
	}

	var edges []dslEdge
	if len(edgesBytes) > 0 {
		if unmarshalErr := json.Unmarshal(edgesBytes, &edges); unmarshalErr != nil {
			return "", nil, 0, "", fmt.Errorf("unmarshal dsl_edges for workflow %s: %w", workflowID, unmarshalErr)
		}
	}

	return dslSource, edges, dslVersion, appID, nil
}

// parseWithFromStatement parses the key=value pairs from a single DSL `with`
// clause. Returns an empty map and nil error when no `with` clause is present.
func parseWithFromStatement(stmt string) (map[string]string, error) {
	withIdx := strings.Index(stmt, "with ")
	if withIdx == -1 {
		return map[string]string{}, nil
	}

	// Extract everything after "with " and strip trailing whitespace / semicolons.
	rest := strings.TrimRight(stmt[withIdx+5:], " \t\n\r;")
	result := make(map[string]string)
	i, n := 0, len(rest)

	for i < n {
		// Skip whitespace between pairs.
		for i < n && (rest[i] == ' ' || rest[i] == '\t' || rest[i] == '\n' || rest[i] == '\r') {
			i++
		}
		if i >= n {
			break
		}

		// Collect key until '=' (stop also at whitespace — keys never contain spaces).
		keyStart := i
		for i < n && rest[i] != '=' && rest[i] != ' ' && rest[i] != '\t' && rest[i] != '\n' && rest[i] != '\r' {
			i++
		}
		key := rest[keyStart:i]

		// If no '=' follows the key, this token is not a valid pair — stop.
		if i >= n || rest[i] != '=' {
			break
		}
		i++ // skip '='

		if key == "" {
			break
		}

		var value string
		if i < n && rest[i] == '"' {
			// Quoted value: scan to closing '"'; do NOT unescape sequences.
			i++ // skip opening '"'
			valStart := i
			for i < n && rest[i] != '"' {
				i++
			}
			value = rest[valStart:i]
			if i < n {
				i++ // skip closing '"'
			}
		} else {
			// Bare value: terminate at whitespace.
			valStart := i
			for i < n && rest[i] != ' ' && rest[i] != '\t' && rest[i] != '\n' && rest[i] != '\r' {
				i++
			}
			value = rest[valStart:i]
		}

		result[key] = value
	}

	return result, nil
}

// buildStepsFromDSL parses the step:* nodes from dslSource and builds a
// []wfStep topologically sorted by the async step-to-step edges in dslEdges.
// workflowID is set on every returned wfStep.
func buildStepsFromDSL(workflowID, dslSource string, edges []dslEdge) ([]wfStep, error) {
	// 1. Split on ---edges--- delimiter; use only the node section.
	nodeSection := dslSource
	if idx := strings.Index(dslSource, "---edges---"); idx >= 0 {
		nodeSection = dslSource[:idx]
	}

	// 2. Parse all DSL statements in the node section.
	stmts, order, err := parseDSLStatements(nodeSection)
	if err != nil {
		return nil, fmt.Errorf("parse DSL for workflow %s: %w", workflowID, err)
	}

	// 3. Filter to step:* nodes and build wfStep entries.
	stepMap := make(map[string]*wfStep)
	var stepIDs []string // document order

	for _, id := range order {
		stmt := stmts[id]
		fields := strings.Fields(stmt)
		if len(fields) == 0 {
			continue
		}
		element := fields[0]
		if !strings.HasPrefix(element, "step:") {
			continue
		}

		stepType := workflowStepType(strings.TrimPrefix(element, "step:"))

		withMap, parseErr := parseWithFromStatement(stmt)
		if parseErr != nil {
			return nil, fmt.Errorf("parse with clause for step %s: %w", id, parseErr)
		}

		config := make(map[string]any, len(withMap))
		for k, v := range withMap {
			config[k] = v
		}

		stepMap[id] = &wfStep{
			id:         id,
			workflowID: workflowID,
			name:       id,
			stepType:   stepType,
			config:     config,
			stepOrder:  0,
		}
		stepIDs = append(stepIDs, id)
	}

	// 4. Filter to async edges where both endpoints are step nodes.
	stepIDSet := make(map[string]bool, len(stepIDs))
	for _, id := range stepIDs {
		stepIDSet[id] = true
	}

	var asyncEdges []dslEdge
	for _, e := range edges {
		if e.EdgeType == "async" && stepIDSet[e.FromNodeID] && stepIDSet[e.ToNodeID] {
			asyncEdges = append(asyncEdges, e)
		}
	}

	// 5. Topological sort (Kahn's BFS).
	outNextIDs := make(map[string][]string, len(stepIDs))
	inDegree := make(map[string]int, len(stepIDs))
	for _, id := range stepIDs {
		outNextIDs[id] = nil
		inDegree[id] = 0
	}
	for _, e := range asyncEdges {
		outNextIDs[e.FromNodeID] = append(outNextIDs[e.FromNodeID], e.ToNodeID)
		inDegree[e.ToNodeID]++
	}

	queue := make([]string, 0, len(stepIDs))
	for _, id := range stepIDs {
		if inDegree[id] == 0 {
			queue = append(queue, id)
		}
	}

	sorted := make([]string, 0, len(stepIDs))
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		sorted = append(sorted, curr)
		for _, next := range outNextIDs[curr] {
			inDegree[next]--
			if inDegree[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	if len(sorted) < len(stepIDs) {
		return nil, fmt.Errorf("cycle in step graph for workflow %s", workflowID)
	}

	// 6. Assign stepOrder from topo-sort position.
	for i, id := range sorted {
		stepMap[id].stepOrder = i
	}

	// 7. Set nextStepID / falseBranchStepID using ported edge info.
	type portedEdge struct {
		toID     string
		fromPort string
	}
	stepOutEdges := make(map[string][]portedEdge, len(stepIDs))
	for _, e := range asyncEdges {
		stepOutEdges[e.FromNodeID] = append(stepOutEdges[e.FromNodeID],
			portedEdge{toID: e.ToNodeID, fromPort: e.FromPort})
	}

	for _, id := range stepIDs {
		step := stepMap[id]
		outgoing := stepOutEdges[id]

		if step.stepType == stepTypeCondition {
			for _, pe := range outgoing {
				toID := pe.toID
				switch pe.fromPort {
				case "trueBranch":
					step.nextStepID = &toID
				case "falseBranch":
					step.falseBranchStepID = &toID
				}
			}
			// Fallback: if no named ports matched, use first outgoing as nextStepID.
			if step.nextStepID == nil && step.falseBranchStepID == nil && len(outgoing) > 0 {
				toID := outgoing[0].toID
				step.nextStepID = &toID
			}
		} else {
			if len(outgoing) == 1 {
				toID := outgoing[0].toID
				step.nextStepID = &toID
			}
		}
	}

	// 8. Return steps in topo-sorted order.
	result := make([]wfStep, len(sorted))
	for i, id := range sorted {
		result[i] = *stepMap[id]
	}
	return result, nil
}
