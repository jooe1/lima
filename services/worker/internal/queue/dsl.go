package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// nodeMeta mirrors model.NodeMeta from the api service.
// It is defined here to avoid a cross-module import dependency.
type nodeMeta struct {
	ManuallyEdited bool `json:"manuallyEdited"`
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

// validateDSL checks that src is syntactically well-formed Aura DSL.
// Returns the first structural error found, or nil if the document is valid.
// An empty document is considered valid.
func validateDSL(src string) error {
	if strings.TrimSpace(src) == "" {
		return nil
	}
	_, _, err := parseDSLStatements(src)
	return err
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
type dslEdge struct {
	ID         string `json:"id"`
	FromNodeID string `json:"from_node_id"`
	FromPort   string `json:"from_port"`
	ToNodeID   string `json:"to_node_id"`
	ToPort     string `json:"to_port"`
	EdgeType   string `json:"edge_type"`
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
