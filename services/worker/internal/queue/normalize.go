package queue

import (
	"fmt"
	"strings"
)

// InlineLink is a parsed on/input/output clause extracted from a DSL node.
// Mirrors InlineLink in packages/aura-dsl/src/index.ts.
//
//	on     <myPort> -> <targetId>.<targetPort>   — async edge
//	output <myPort> -> <targetId>.<targetPort>   — async (step target) or reactive (widget target)
//	input  <myPort> <- <sourceId>.<sourcePort>   — reactive edge (source → this node)
type InlineLink struct {
	Direction    string // "on", "input", "output"
	MyPort       string
	TargetNodeID string
	TargetPort   string
}

// dslStatement is a structured representation of a parsed Aura DSL node,
// carrying the node ID, element type, and any inline link clauses.
type dslStatement struct {
	ID          string
	Element     string
	InlineLinks []InlineLink
}

// parseDSLStatementsStructured builds a []dslStatement from DSL source by
// calling parseDSLStatements and then extracting inline link clauses from the
// raw statement text.
func parseDSLStatementsStructured(src string) ([]dslStatement, error) {
	stmts, order, err := parseDSLStatements(src)
	if err != nil {
		return nil, err
	}
	result := make([]dslStatement, 0, len(order))
	for _, id := range order {
		raw := stmts[id]
		fields := strings.Fields(raw)
		element := ""
		if len(fields) > 0 {
			element = fields[0]
		}
		result = append(result, dslStatement{
			ID:          id,
			Element:     element,
			InlineLinks: parseInlineLinkClauses(raw),
		})
	}
	return result, nil
}

// parseInlineLinkClauses scans each line of a raw DSL statement for
// on/input/output clauses and returns the parsed InlineLink entries.
func parseInlineLinkClauses(stmt string) []InlineLink {
	var links []InlineLink
	for _, line := range strings.Split(stmt, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "on "):
			if link, ok := parseOnClause(trimmed); ok {
				links = append(links, link)
			}
		case strings.HasPrefix(trimmed, "output "):
			if link, ok := parseOutputClause(trimmed); ok {
				links = append(links, link)
			}
		case strings.HasPrefix(trimmed, "input "):
			if link, ok := parseInputClause(trimmed); ok {
				links = append(links, link)
			}
		}
	}
	return links
}

// parseOnClause parses "on <myPort> -> <targetId>.<targetPort>".
func parseOnClause(s string) (InlineLink, bool) {
	rest := strings.TrimPrefix(s, "on ")
	return parseForwardLink("on", rest)
}

// parseOutputClause parses "output <myPort> -> <targetId>.<targetPort>".
func parseOutputClause(s string) (InlineLink, bool) {
	rest := strings.TrimPrefix(s, "output ")
	return parseForwardLink("output", rest)
}

// parseForwardLink handles the common "<myPort> -> <targetId>.<targetPort>"
// portion shared by on and output clauses.
func parseForwardLink(direction, rest string) (InlineLink, bool) {
	parts := strings.SplitN(rest, "->", 2)
	if len(parts) != 2 {
		return InlineLink{}, false
	}
	myPort := strings.TrimSpace(parts[0])
	return parseDotExpr(direction, myPort, strings.TrimSpace(parts[1]))
}

// parseInputClause parses "input <myPort> <- <sourceId>.<sourcePort>".
func parseInputClause(s string) (InlineLink, bool) {
	rest := strings.TrimPrefix(s, "input ")
	parts := strings.SplitN(rest, "<-", 2)
	if len(parts) != 2 {
		return InlineLink{}, false
	}
	myPort := strings.TrimSpace(parts[0])
	return parseDotExpr("input", myPort, strings.TrimSpace(parts[1]))
}

// parseDotExpr splits "<nodeId>.<portName>" on the first dot.
// The port name may itself contain dots (e.g. "firstRow.name").
func parseDotExpr(direction, myPort, dotExpr string) (InlineLink, bool) {
	dotIdx := strings.Index(dotExpr, ".")
	if dotIdx <= 0 {
		return InlineLink{}, false
	}
	targetNodeID := dotExpr[:dotIdx]
	targetPort := dotExpr[dotIdx+1:]
	if myPort == "" || targetPort == "" {
		return InlineLink{}, false
	}
	return InlineLink{
		Direction:    direction,
		MyPort:       myPort,
		TargetNodeID: targetNodeID,
		TargetPort:   targetPort,
	}, true
}

// normalizeInlineLinksGo extracts inline link clauses (on/input/output) from
// dslStatements and converts them into dslEdge entries.
//
// Edge type rules (mirrors TypeScript normalizeInlineLinks):
//
//	on      → async
//	output  → async if target is a step:* node, else reactive
//	input   → reactive (edge runs from source → this node)
//
// Deduplicates by edge ID: e_{fromNodeId}_{fromPort}_{toNodeId}_{toPort}.
// existingEdges are included first; inline-link edges that would produce a
// duplicate ID are silently dropped.
//
// Returns: (merged edges, warnings). Warnings are emitted for unknown target
// node IDs but the edge is still included — validateDSL catches dangling refs.
func normalizeInlineLinksGo(statements []dslStatement, existingEdges []dslEdge) ([]dslEdge, []string) {
	// Build lookup sets.
	nodeIDs := make(map[string]bool, len(statements))
	stepNodes := make(map[string]bool, len(statements))
	for _, s := range statements {
		nodeIDs[s.ID] = true
		if strings.HasPrefix(s.Element, "step:") {
			stepNodes[s.ID] = true
		}
	}

	// Seed result with existing edges, preserving order and deduplicating.
	edgeByID := make(map[string]dslEdge, len(existingEdges))
	edgeOrder := make([]string, 0, len(existingEdges)+8)
	for _, e := range existingEdges {
		if _, dup := edgeByID[e.ID]; !dup {
			edgeByID[e.ID] = e
			edgeOrder = append(edgeOrder, e.ID)
		}
	}

	var warnings []string

	addEdge := func(e dslEdge) {
		if _, exists := edgeByID[e.ID]; !exists {
			edgeByID[e.ID] = e
			edgeOrder = append(edgeOrder, e.ID)
		}
	}

	for _, stmt := range statements {
		for _, link := range stmt.InlineLinks {
			var (
				fromNodeID string
				fromPort   string
				toNodeID   string
				toPort     string
				edgeType   string
			)

			switch link.Direction {
			case "input":
				// input myPort <- sourceId.sourcePort
				// Edge direction: source → this node, always reactive.
				fromNodeID = link.TargetNodeID
				fromPort = link.TargetPort
				toNodeID = stmt.ID
				toPort = link.MyPort
				edgeType = "reactive"
				if !nodeIDs[link.TargetNodeID] {
					warnings = append(warnings, fmt.Sprintf(
						"normalizeInlineLinksGo: node %q input links from unknown node %q",
						stmt.ID, link.TargetNodeID,
					))
				}

			case "on":
				// on myPort -> targetId.targetPort — always async.
				fromNodeID = stmt.ID
				fromPort = link.MyPort
				toNodeID = link.TargetNodeID
				toPort = link.TargetPort
				edgeType = "async"
				if !nodeIDs[link.TargetNodeID] {
					warnings = append(warnings, fmt.Sprintf(
						"normalizeInlineLinksGo: node %q links to unknown node %q",
						stmt.ID, link.TargetNodeID,
					))
				}

			case "output":
				// output myPort -> targetId.targetPort
				// async if target is step:*, else reactive.
				// Conservative default for unknown targets: async (matches TS).
				fromNodeID = stmt.ID
				fromPort = link.MyPort
				toNodeID = link.TargetNodeID
				toPort = link.TargetPort
				if !nodeIDs[link.TargetNodeID] {
					warnings = append(warnings, fmt.Sprintf(
						"normalizeInlineLinksGo: node %q links to unknown node %q",
						stmt.ID, link.TargetNodeID,
					))
					edgeType = "async"
				} else if stepNodes[link.TargetNodeID] {
					edgeType = "async"
				} else {
					edgeType = "reactive"
				}

			default:
				continue
			}

			edgeID := fmt.Sprintf("e_%s_%s_%s_%s", fromNodeID, fromPort, toNodeID, toPort)
			addEdge(dslEdge{
				ID:         edgeID,
				FromNodeID: fromNodeID,
				FromPort:   fromPort,
				ToNodeID:   toNodeID,
				ToPort:     toPort,
				EdgeType:   edgeType,
			})
		}
	}

	result := make([]dslEdge, 0, len(edgeOrder))
	for _, id := range edgeOrder {
		result = append(result, edgeByID[id])
	}
	return result, warnings
}
