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
	"github.com/lima/api/internal/store"
)

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

// executeManagedMutation parses DML SQL for a Lima Table connector and calls
// the appropriate store method. Currently only INSERT is supported.
func executeManagedMutation(
	ctx context.Context,
	s *store.Store,
	connectorID, sqlText, userID string,
) (int64, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(sqlText), ";")
	upper := strings.ToUpper(trimmed)

	switch {
	case strings.HasPrefix(upper, "INSERT"):
		return executeManagedInsert(ctx, s, connectorID, trimmed, userID)
	default:
		verb := strings.Fields(upper)
		if len(verb) == 0 {
			return 0, fmt.Errorf("empty SQL")
		}
		return 0, fmt.Errorf("only INSERT is supported for managed connectors; got %s", verb[0])
	}
}

// insertValuesRe matches a single-row INSERT INTO t (cols) VALUES (vals).
var insertValuesRe = regexp.MustCompile(`(?i)INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$`)

func executeManagedInsert(
	ctx context.Context,
	s *store.Store,
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

// splitSQLList splits a comma-separated SQL identifier/column list and strips
// surrounding whitespace and identifier quotes.
func splitSQLList(s string) []string {
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		t = strings.Trim(t, `"`+"`")
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
	var vals []string
	var curr strings.Builder
	inQuote := false

	for i := 0; i < len(s); i++ {
		ch := s[i]
		if inQuote {
			if ch == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					// SQL '' escape within a quoted string.
					curr.WriteByte('\'')
					i++
				} else {
					inQuote = false
				}
			} else {
				curr.WriteByte(ch)
			}
		} else {
			switch ch {
			case '\'':
				inQuote = true
			case ',':
				vals = append(vals, coerceSQLLiteral(strings.TrimSpace(curr.String())))
				curr.Reset()
			default:
				curr.WriteByte(ch)
			}
		}
	}
	// Flush the last value.
	vals = append(vals, coerceSQLLiteral(strings.TrimSpace(curr.String())))
	return vals
}

// coerceSQLLiteral converts an unquoted SQL literal (NULL, number, etc.) to a
// string. NULL becomes an empty string.
func coerceSQLLiteral(s string) string {
	if strings.EqualFold(s, "null") {
		return ""
	}
	return s
}
