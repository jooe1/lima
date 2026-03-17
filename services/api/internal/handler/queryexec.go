package handler

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	// MySQL and SQL Server drivers register themselves via side-effect imports.
	_ "github.com/go-sql-driver/mysql"
	"github.com/lima/api/internal/model"
	_ "github.com/microsoft/go-mssqldb"
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
