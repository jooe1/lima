package handler

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lima/api/internal/model"
)

type managedMutationStore interface {
	InsertManagedTableRow(ctx context.Context, connectorID, createdBy string, data map[string]any) (*model.ManagedTableRow, error)
	ListManagedTableRows(ctx context.Context, connectorID string) ([]model.ManagedTableRow, error)
	UpdateManagedTableRow(ctx context.Context, connectorID, rowID string, data map[string]any) (*model.ManagedTableRow, error)
	DeleteManagedTableRow(ctx context.Context, connectorID, rowID string) error
}

type managedWhereClause struct {
	column string
	value  string
}

// sqlDMLRe validates that a SQL statement starts with a DML keyword.
// Only INSERT, UPDATE, and DELETE are permitted in the mutation endpoint.
var sqlDMLRe = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE)\s`)

// MutationResult is the JSON response body for RunMutation.
type MutationResult struct {
	AffectedRows int64 `json:"affected_rows"`
}

// executeRelationalMutation executes a DML statement against a relational
// connector and returns the number of affected rows.
func executeRelationalMutation(
	ctx context.Context,
	connType model.ConnectorType,
	creds model.RelationalCredentials,
	sqlText string,
) (int64, error) {
	switch connType {
	case model.ConnectorTypePostgres:
		return runPostgresMutation(ctx, creds, sqlText)
	case model.ConnectorTypeMySQL:
		return runMySQLMutation(ctx, creds, sqlText)
	case model.ConnectorTypeMSSQL:
		return runMSSQLMutation(ctx, creds, sqlText)
	default:
		return 0, fmt.Errorf("executeRelationalMutation: unsupported connector type %q", connType)
	}
}

func runPostgresMutation(ctx context.Context, creds model.RelationalCredentials, sqlText string) (int64, error) {
	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=5",
		url.QueryEscape(creds.Username),
		url.QueryEscape(creds.Password),
		creds.Host, creds.Port, creds.Database,
		sslmode,
	)
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return 0, fmt.Errorf("connect postgres: %w", err)
	}
	defer conn.Close(ctx)

	tag, err := conn.Exec(ctx, strings.TrimRight(strings.TrimSpace(sqlText), ";"))
	if err != nil {
		return 0, fmt.Errorf("postgres mutation: %w", err)
	}
	return tag.RowsAffected(), nil
}

func runMySQLMutation(ctx context.Context, creds model.RelationalCredentials, sqlText string) (int64, error) {
	tls := "false"
	if creds.SSL {
		tls = "skip-verify"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?tls=%s&timeout=10s",
		creds.Username, creds.Password, creds.Host, creds.Port, creds.Database, tls,
	)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return 0, fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	result, err := db.ExecContext(ctx, strings.TrimRight(strings.TrimSpace(sqlText), ";"))
	if err != nil {
		return 0, fmt.Errorf("mysql mutation: %w", err)
	}
	return result.RowsAffected()
}

func runMSSQLMutation(ctx context.Context, creds model.RelationalCredentials, sqlText string) (int64, error) {
	u := &url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(creds.Username, creds.Password),
		Host:   fmt.Sprintf("%s:%d", creds.Host, creds.Port),
	}
	q := u.Query()
	q.Set("database", creds.Database)
	q.Set("connection timeout", "10")
	if !creds.SSL {
		q.Set("encrypt", "disable")
	}
	u.RawQuery = q.Encode()

	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		return 0, fmt.Errorf("open mssql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	result, err := db.ExecContext(ctx, strings.TrimRight(strings.TrimSpace(sqlText), ";"))
	if err != nil {
		return 0, fmt.Errorf("mssql mutation: %w", err)
	}
	return result.RowsAffected()
}

// executeManagedMutation parses simple DML SQL for a Lima Table connector and
// maps it onto the managed row store.
func executeManagedMutation(
	ctx context.Context,
	s managedMutationStore,
	connectorID, sqlText, userID string,
) (int64, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(sqlText), ";")
	upper := strings.ToUpper(trimmed)

	switch {
	case strings.HasPrefix(upper, "INSERT"):
		return executeManagedInsert(ctx, s, connectorID, trimmed, userID)
	case strings.HasPrefix(upper, "UPDATE"):
		return executeManagedUpdate(ctx, s, connectorID, trimmed)
	case strings.HasPrefix(upper, "DELETE"):
		return executeManagedDelete(ctx, s, connectorID, trimmed)
	default:
		verb := strings.Fields(upper)
		if len(verb) == 0 {
			return 0, fmt.Errorf("empty SQL")
		}
		return 0, fmt.Errorf("managed connectors only support INSERT, UPDATE, and DELETE; got %s", verb[0])
	}
}

// insertValuesRe matches a single-row INSERT INTO t (cols) VALUES (vals).
var insertValuesRe = regexp.MustCompile(`(?i)INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$`)
var updateStatementRe = regexp.MustCompile(`(?is)^UPDATE\s+\S+\s+SET\s+(.+?)\s+WHERE\s+(.+)\s*$`)
var deleteStatementRe = regexp.MustCompile(`(?is)^DELETE\s+FROM\s+\S+\s+WHERE\s+(.+)\s*$`)

func executeManagedInsert(
	ctx context.Context,
	s managedMutationStore,
	connectorID, sqlText, userID string,
) (int64, error) {
	m := insertValuesRe.FindStringSubmatch(sqlText)
	if m == nil {
		return 0, fmt.Errorf("cannot parse INSERT statement: %q", sqlText)
	}

	cols := splitSQLList(m[1])
	vals := parseSQLValues(m[2])
	if len(cols) == 0 || len(cols) != len(vals) {
		return 0, fmt.Errorf("column count (%d) does not match value count (%d)", len(cols), len(vals))
	}

	data := make(map[string]any, len(cols))
	for i, col := range cols {
		data[col] = vals[i]
	}

	_, err := s.InsertManagedTableRow(ctx, connectorID, userID, data)
	if err != nil {
		return 0, fmt.Errorf("insert managed row: %w", err)
	}
	return 1, nil
}

func executeManagedUpdate(
	ctx context.Context,
	s managedMutationStore,
	connectorID, sqlText string,
) (int64, error) {
	assignments, where, err := parseManagedUpdateStatement(sqlText)
	if err != nil {
		return 0, err
	}
	rows, err := s.ListManagedTableRows(ctx, connectorID)
	if err != nil {
		return 0, fmt.Errorf("list managed rows: %w", err)
	}

	var affected int64
	for _, row := range rows {
		if !managedRowMatches(row, where) {
			continue
		}
		nextData := cloneManagedRowData(row.Data)
		for key, value := range assignments {
			nextData[key] = value
		}
		if _, err := s.UpdateManagedTableRow(ctx, connectorID, row.ID, nextData); err != nil {
			return 0, fmt.Errorf("update managed row: %w", err)
		}
		affected++
	}
	return affected, nil
}

func executeManagedDelete(
	ctx context.Context,
	s managedMutationStore,
	connectorID, sqlText string,
) (int64, error) {
	where, err := parseManagedDeleteStatement(sqlText)
	if err != nil {
		return 0, err
	}
	rows, err := s.ListManagedTableRows(ctx, connectorID)
	if err != nil {
		return 0, fmt.Errorf("list managed rows: %w", err)
	}

	var affected int64
	for _, row := range rows {
		if !managedRowMatches(row, where) {
			continue
		}
		if err := s.DeleteManagedTableRow(ctx, connectorID, row.ID); err != nil {
			return 0, fmt.Errorf("delete managed row: %w", err)
		}
		affected++
	}
	return affected, nil
}

func parseManagedUpdateStatement(sqlText string) (map[string]string, managedWhereClause, error) {
	m := updateStatementRe.FindStringSubmatch(strings.TrimSpace(sqlText))
	if m == nil {
		return nil, managedWhereClause{}, fmt.Errorf("managed UPDATE statements must look like UPDATE table SET col = value WHERE col = value")
	}
	assignments, err := parseManagedSetAssignments(m[1])
	if err != nil {
		return nil, managedWhereClause{}, err
	}
	where, err := parseManagedWhereClause(m[2])
	if err != nil {
		return nil, managedWhereClause{}, err
	}
	return assignments, where, nil
}

func parseManagedDeleteStatement(sqlText string) (managedWhereClause, error) {
	m := deleteStatementRe.FindStringSubmatch(strings.TrimSpace(sqlText))
	if m == nil {
		return managedWhereClause{}, fmt.Errorf("managed DELETE statements must look like DELETE FROM table WHERE col = value")
	}
	return parseManagedWhereClause(m[1])
}

func parseManagedSetAssignments(clause string) (map[string]string, error) {
	parts := splitSQLCSV(clause)
	if len(parts) == 0 {
		return nil, fmt.Errorf("managed UPDATE requires at least one SET assignment")
	}
	assignments := make(map[string]string, len(parts))
	for _, part := range parts {
		pieces := strings.SplitN(part, "=", 2)
		if len(pieces) != 2 {
			return nil, fmt.Errorf("managed UPDATE only supports simple SET clauses of the form col = value")
		}
		column := trimSQLIdentifier(pieces[0])
		if column == "" {
			return nil, fmt.Errorf("managed UPDATE SET clause is missing a column name")
		}
		value, err := parseSingleSQLValue(pieces[1])
		if err != nil {
			return nil, err
		}
		assignments[column] = value
	}
	return assignments, nil
}

func parseManagedWhereClause(clause string) (managedWhereClause, error) {
	if hasUnsupportedWhereOperators(clause) {
		return managedWhereClause{}, fmt.Errorf("managed UPDATE/DELETE only support a single equality WHERE clause: column = value")
	}
	pieces := strings.SplitN(clause, "=", 2)
	if len(pieces) != 2 {
		return managedWhereClause{}, fmt.Errorf("managed UPDATE/DELETE only support WHERE clauses of the form column = value")
	}
	column := trimSQLIdentifier(pieces[0])
	if column == "" {
		return managedWhereClause{}, fmt.Errorf("managed WHERE clause is missing a column name")
	}
	value, err := parseSingleSQLValue(pieces[1])
	if err != nil {
		return managedWhereClause{}, err
	}
	return managedWhereClause{column: column, value: value}, nil
}

func hasUnsupportedWhereOperators(clause string) bool {
	upper := strings.ToUpper(clause)
	return strings.Contains(upper, " AND ") || strings.Contains(upper, " OR ")
}

func parseSingleSQLValue(raw string) (string, error) {
	parts := splitSQLCSV(raw)
	if len(parts) != 1 {
		return "", fmt.Errorf("managed SQL values must be a single literal")
	}
	return decodeSQLLiteral(parts[0]), nil
}

func managedRowMatches(row model.ManagedTableRow, where managedWhereClause) bool {
	return managedComparableValue(row.Data[where.column]) == where.value
}

func managedComparableValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func cloneManagedRowData(data map[string]any) map[string]any {
	out := make(map[string]any, len(data))
	for key, value := range data {
		out[key] = value
	}
	return out
}

// splitSQLList splits a comma-separated SQL identifier/column list and strips
// surrounding whitespace and identifier quotes.
func splitSQLList(s string) []string {
	parts := splitSQLCSV(s)
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		t := trimSQLIdentifier(p)
		if t != "" {
			result = append(result, t)
		}
	}
	return result
}

// parseSQLValues parses the inner content of a VALUES clause (without the
// surrounding parentheses) into a slice of string values.
//
// Single-quoted string literals are unquoted; ” inside a string is treated as
// an escaped single quote. NULL and unquoted identifiers are passed through as
// strings.
func parseSQLValues(s string) []string {
	parts := splitSQLCSV(s)
	vals := make([]string, 0, len(parts))
	for _, part := range parts {
		vals = append(vals, decodeSQLLiteral(part))
	}
	return vals
}

func splitSQLCSV(s string) []string {
	var parts []string
	var curr strings.Builder
	inQuote := false

	flush := func() {
		parts = append(parts, strings.TrimSpace(curr.String()))
		curr.Reset()
	}

	for i := 0; i < len(s); i++ {
		ch := s[i]
		if inQuote {
			if ch == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					curr.WriteByte('\'')
					i++
					continue
				}
				inQuote = false
			}
			curr.WriteByte(ch)
			continue
		}
		switch ch {
		case '\'':
			inQuote = true
			curr.WriteByte(ch)
		case ',':
			flush()
		default:
			curr.WriteByte(ch)
		}
	}
	flush()
	return parts
}

func trimSQLIdentifier(s string) string {
	return strings.Trim(strings.TrimSpace(s), `"`+"`")
}

func decodeSQLLiteral(s string) string {
	trimmed := strings.TrimSpace(s)
	if len(trimmed) >= 2 && trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'' {
		return strings.ReplaceAll(trimmed[1:len(trimmed)-1], "''", "'")
	}
	return coerceSQLLiteral(trimmed)
}

// coerceSQLLiteral converts an unquoted SQL literal (NULL, number, etc.) to a
// string. NULL becomes an empty string.
func coerceSQLLiteral(s string) string {
	if strings.EqualFold(s, "null") {
		return ""
	}
	return s
}
