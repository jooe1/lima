package queue

import (
	"fmt"
	"strings"
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
