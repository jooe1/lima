package handler

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	// MySQL and SQL Server drivers register themselves via side-effect imports.
	_ "github.com/go-sql-driver/mysql"
	"github.com/lima/api/internal/model"
	_ "github.com/microsoft/go-mssqldb"
	// Pure-Go SQLite driver used for in-memory managed-table query execution.
	_ "modernc.org/sqlite"
)

// executeRelationalQuery dispatches a parameterized read-only SQL query to the
// appropriate relational backend based on connector type. It builds the DSN from
// the supplied credentials, enforces a row-count cap, and returns structured rows.
//
// Supported types: postgres (via runPostgresQuery in connectors.go), mysql, mssql.
//
// Security: callers MUST reject mutation SQL via sqlMutationRe before invoking
// this function. Credentials are never logged.
func executeRelationalQuery(
	ctx context.Context,
	connType model.ConnectorType,
	creds model.RelationalCredentials,
	query string,
	params []any,
	limit int,
) (*model.DashboardQueryResponse, error) {
	switch connType {
	case model.ConnectorTypePostgres:
		return runPostgresQuery(ctx, creds, query, params, limit)
	case model.ConnectorTypeMySQL:
		return runMySQLQuery(ctx, creds, query, params, limit)
	case model.ConnectorTypeMSSQL:
		return runMSSQLQuery(ctx, creds, query, params, limit)
	default:
		return nil, fmt.Errorf("executeRelationalQuery: unsupported connector type %q", connType)
	}
}

// runMySQLQuery opens a short-lived MySQL/MariaDB connection, executes the
// query inside a read-only transaction, and returns rows as a DashboardQueryResponse.
//
// SQL placeholders must use MySQL-style '?' markers.
// Rows are capped by appending "LIMIT N" when no LIMIT clause is detected.
func runMySQLQuery(
	ctx context.Context,
	creds model.RelationalCredentials,
	query string,
	params []any,
	limit int,
) (*model.DashboardQueryResponse, error) {
	tls := "false"
	if creds.SSL {
		tls = "skip-verify"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?tls=%s&timeout=10s&parseTime=true",
		creds.Username, creds.Password, creds.Host, creds.Port, creds.Database, tls,
	)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin read-only mysql tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	trimmed := strings.TrimRight(strings.TrimSpace(query), ";")
	if !strings.Contains(strings.ToUpper(trimmed), " LIMIT ") {
		trimmed = fmt.Sprintf("%s LIMIT %d", trimmed, limit)
	}

	rows, err := tx.QueryContext(ctx, trimmed, params...)
	if err != nil {
		return nil, fmt.Errorf("mysql query: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("mysql columns: %w", err)
	}

	var result []map[string]any
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("mysql scan: %w", err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			// MySQL driver returns []byte for string columns; convert to string.
			if b, ok := vals[i].([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = vals[i]
			}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mysql rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	return &model.DashboardQueryResponse{
		Columns:  cols,
		Rows:     result,
		RowCount: len(result),
	}, nil
}

// runMSSQLQuery opens a short-lived SQL Server connection, executes the query,
// and returns rows as a DashboardQueryResponse.
//
// SQL placeholders may use '?' or '@pN' style markers; go-mssqldb supports both.
// Rows are capped using a SELECT TOP N wrapper when no TOP or FETCH clause is present.
func runMSSQLQuery(
	ctx context.Context,
	creds model.RelationalCredentials,
	query string,
	params []any,
	limit int,
) (*model.DashboardQueryResponse, error) {
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
		return nil, fmt.Errorf("open mssql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(15 * time.Second)

	trimmed := strings.TrimRight(strings.TrimSpace(query), ";")
	upperQ := strings.ToUpper(trimmed)
	if !strings.Contains(upperQ, "TOP ") && !strings.Contains(upperQ, " FETCH ") {
		// Wrap in a subquery with TOP to cap rows; MSSQL uses TOP instead of LIMIT.
		trimmed = fmt.Sprintf("SELECT TOP %d * FROM (%s) AS _lq", limit, trimmed)
	}

	rows, err := db.QueryContext(ctx, trimmed, params...)
	if err != nil {
		return nil, fmt.Errorf("mssql query: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("mssql columns: %w", err)
	}

	var result []map[string]any
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("mssql scan: %w", err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = vals[i]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mssql rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	return &model.DashboardQueryResponse{
		Columns:  cols,
		Rows:     result,
		RowCount: len(result),
	}, nil
}

// testMySQLConn opens a MySQL connection, pings the server, and closes the connection.
// Used by the TestConnector handler to verify live connectivity.
func testMySQLConn(ctx context.Context, creds model.RelationalCredentials) error {
	tls := "false"
	if creds.SSL {
		tls = "skip-verify"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?tls=%s&timeout=5s",
		creds.Username, creds.Password, creds.Host, creds.Port, creds.Database, tls,
	)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}
	defer db.Close()
	db.SetConnMaxLifetime(8 * time.Second)
	return db.PingContext(ctx)
}

// runManagedQuery loads managed-table rows into an ephemeral in-memory SQLite
// database and executes the caller-supplied SQL against it. This gives the
// developer query tester full SELECT support (WHERE, ORDER BY, GROUP BY, LIMIT,
// DISTINCT, aggregate functions, etc.) without any external database connection.
//
// tableName must already be a safe SQL identifier (use managedTableName first).
// The caller is responsible for blocking mutations via sqlMutationRe.
func runManagedQuery(
	ctx context.Context,
	tableName string,
	cols []model.ManagedTableColumn,
	rows []map[string]any,
	sqlText string,
	limit int,
) (*model.DashboardQueryResponse, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("open in-memory sqlite: %w", err)
	}
	defer db.Close()

	// Build CREATE TABLE.
	colDefs := make([]string, len(cols))
	for i, c := range cols {
		colDefs[i] = fmt.Sprintf("%q %s", c.Name, managedColTypeToSQLite(c.ColType))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %q (%s)", tableName, strings.Join(colDefs, ", "))
	if _, err := db.ExecContext(ctx, createSQL); err != nil {
		return nil, fmt.Errorf("create table: %w", err)
	}

	// Insert rows using a prepared statement.
	if len(rows) > 0 && len(cols) > 0 {
		quotedCols := make([]string, len(cols))
		placeholders := make([]string, len(cols))
		for i, c := range cols {
			quotedCols[i] = fmt.Sprintf("%q", c.Name)
			placeholders[i] = "?"
		}
		insertSQL := fmt.Sprintf(
			"INSERT INTO %q (%s) VALUES (%s)",
			tableName,
			strings.Join(quotedCols, ", "),
			strings.Join(placeholders, ", "),
		)
		stmt, err := db.PrepareContext(ctx, insertSQL)
		if err != nil {
			return nil, fmt.Errorf("prepare insert: %w", err)
		}
		defer stmt.Close()

		for _, row := range rows {
			vals := make([]any, len(cols))
			for i, c := range cols {
				vals[i] = row[c.Name]
			}
			if _, err := stmt.ExecContext(ctx, vals...); err != nil {
				return nil, fmt.Errorf("insert row: %w", err)
			}
		}
	}

	// Append LIMIT if the query has none.
	trimmed := strings.TrimRight(strings.TrimSpace(sqlText), ";")
	if !strings.Contains(strings.ToUpper(trimmed), " LIMIT ") {
		trimmed = fmt.Sprintf("%s LIMIT %d", trimmed, limit)
	}

	qrows, err := db.QueryContext(ctx, trimmed)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer qrows.Close()

	resultCols, err := qrows.Columns()
	if err != nil {
		return nil, fmt.Errorf("columns: %w", err)
	}

	rawVals := make([]any, len(resultCols))
	ptrs := make([]any, len(resultCols))
	for i := range ptrs {
		ptrs[i] = &rawVals[i]
	}

	var result []map[string]any
	for qrows.Next() {
		if err := qrows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		row := make(map[string]any, len(resultCols))
		for i, col := range resultCols {
			row[col] = rawVals[i]
		}
		result = append(result, row)
	}
	if err := qrows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}
	if result == nil {
		result = []map[string]any{}
	}
	return &model.DashboardQueryResponse{
		Columns:  resultCols,
		Rows:     result,
		RowCount: len(result),
	}, nil
}

// managedColTypeToSQLite maps Lima col_type values to SQLite type affinities.
func managedColTypeToSQLite(colType string) string {
	switch colType {
	case "number":
		return "REAL"
	case "boolean":
		return "INTEGER"
	default: // "text", "date", and anything unknown
		return "TEXT"
	}
}

// managedTableName converts a connector name to a safe, unquoted SQL identifier
// so users can type it directly in their queries.
// Non-word characters are collapsed to underscores; a leading digit gets a
// leading underscore prepended.
var nonWordRe = regexp.MustCompile(`\W+`)

func managedTableName(name string) string {
	s := nonWordRe.ReplaceAllString(name, "_")
	s = strings.Trim(s, "_")
	if s == "" {
		s = "data"
	}
	if s[0] >= '0' && s[0] <= '9' {
		s = "_" + s
	}
	return s
}

// testMSSQLConn opens a SQL Server connection, pings the server, and closes it.
// Used by the TestConnector handler to verify live connectivity.
func testMSSQLConn(ctx context.Context, creds model.RelationalCredentials) error {
	u := &url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(creds.Username, creds.Password),
		Host:   fmt.Sprintf("%s:%d", creds.Host, creds.Port),
	}
	q := u.Query()
	q.Set("database", creds.Database)
	q.Set("connection timeout", "5")
	if !creds.SSL {
		q.Set("encrypt", "disable")
	}
	u.RawQuery = q.Encode()

	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		return fmt.Errorf("open mssql: %w", err)
	}
	defer db.Close()
	return db.PingContext(ctx)
}
