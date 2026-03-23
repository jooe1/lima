package queue

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	// MySQL and SQL Server drivers register themselves via side-effect imports.
	_ "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
	_ "github.com/microsoft/go-mssqldb"
	"go.uber.org/zap"
)

// connectorRow holds the fields we need from the connectors table.
type connectorRow struct {
	id                   string
	connectorType        string
	encryptedCredentials []byte
}

// relationalCreds mirrors the credential shape stored by the API service.
type relationalCreds struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	SSL      bool   `json:"ssl"`
}

// tableColumn holds a single column's metadata.
type tableColumn struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default,omitempty"`
}

// tableSchema holds the columns for one table.
type tableSchema struct {
	Columns []tableColumn `json:"columns"`
}

// handleSchema returns a jobHandler that performs real schema discovery for
// connector jobs. It supports Postgres for the Phase 4 first-pass milestone.
func handleSchema(cfg *config.Config, pool *pgxpool.Pool, log *zap.Logger) jobHandler {
	return func(ctx context.Context, payload []byte) error {
		var p SchemaPayload
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("unmarshal schema payload: %w", err)
		}
		log.Info("schema job started",
			zap.String("connector_id", p.ConnectorID),
			zap.String("workspace_id", p.WorkspaceID),
		)

		if pool == nil {
			return fmt.Errorf("db pool unavailable — cannot run schema discovery")
		}

		// Fetch the connector record from the Lima control-plane DB.
		rec, err := fetchConnectorRecord(ctx, pool, p.ConnectorID, p.WorkspaceID)
		if err != nil {
			return fmt.Errorf("fetch connector %s: %w", p.ConnectorID, err)
		}

		// Decrypt credentials.
		plainCreds, err := cryptoutil.DecryptWithRotation(cfg.CredentialsEncryptionKey, cfg.CredentialsEncryptionKeyPrevious, rec.encryptedCredentials)
		if err != nil {
			return fmt.Errorf("decrypt credentials: %w", err)
		}

		// Dispatch to type-specific discovery.
		var schemaJSON []byte
		switch rec.connectorType {
		case "postgres":
			schemaJSON, err = discoverPostgresSchema(ctx, plainCreds, log)
		case "mysql":
			schemaJSON, err = discoverMySQLSchema(ctx, plainCreds)
		case "mssql":
			schemaJSON, err = discoverMSSQLSchema(ctx, plainCreds)
		case "graphql":
			schemaJSON, err = discoverGraphQLSchema(ctx, plainCreds)
		case "managed":
			schemaJSON, err = discoverManagedTableSchema(ctx, pool, p.ConnectorID)
		default:
			log.Info("schema discovery not supported for type",
				zap.String("type", rec.connectorType),
				zap.String("connector_id", p.ConnectorID),
			)
			return nil
		}
		if err != nil {
			return fmt.Errorf("schema discovery for %s: %w", p.ConnectorID, err)
		}

		// Write the discovered schema back to the control-plane DB.
		if _, err := pool.Exec(ctx,
			`UPDATE connectors
			 SET schema_cache = $2, schema_cached_at = now(), updated_at = now()
			 WHERE id = $1`,
			p.ConnectorID, schemaJSON,
		); err != nil {
			return fmt.Errorf("update schema cache: %w", err)
		}

		log.Info("schema discovery complete",
			zap.String("connector_id", p.ConnectorID),
			zap.Int("schema_bytes", len(schemaJSON)),
		)
		return nil
	}
}

func fetchConnectorRecord(ctx context.Context, pool *pgxpool.Pool, connectorID, workspaceID string) (*connectorRow, error) {
	row := &connectorRow{}
	err := pool.QueryRow(ctx,
		`SELECT id, type, encrypted_credentials
		 FROM connectors
		 WHERE id = $1 AND workspace_id = $2`,
		connectorID, workspaceID,
	).Scan(&row.id, &row.connectorType, &row.encryptedCredentials)
	if err != nil {
		return nil, err
	}
	return row, nil
}

// discoverPostgresSchema connects to the target Postgres instance and queries
// information_schema to build a table→columns map.
func discoverPostgresSchema(ctx context.Context, plainCreds []byte, log *zap.Logger) ([]byte, error) {
	var creds relationalCreds
	if err := json.Unmarshal(plainCreds, &creds); err != nil {
		return nil, fmt.Errorf("parse postgres credentials: %w", err)
	}

	sslmode := "disable"
	if creds.SSL {
		sslmode = "require"
	}
	connStr := fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&connect_timeout=10",
		url.QueryEscape(creds.Username),
		url.QueryEscape(creds.Password),
		creds.Host, creds.Port, creds.Database,
		sslmode,
	)

	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	defer conn.Close(ctx)

	rows, err := conn.Query(ctx, `
		SELECT
			t.table_name,
			c.column_name,
			c.data_type,
			c.is_nullable,
			c.column_default
		FROM information_schema.tables t
		JOIN information_schema.columns c
			ON c.table_schema = t.table_schema
			AND c.table_name = t.table_name
		WHERE t.table_schema = 'public'
		  AND t.table_type = 'BASE TABLE'
		ORDER BY t.table_name, c.ordinal_position
	`)
	if err != nil {
		return nil, fmt.Errorf("query information_schema: %w", err)
	}
	defer rows.Close()

	tables := map[string]*tableSchema{}
	for rows.Next() {
		var tableName, colName, dataType, isNullable string
		var colDefault *string
		if err := rows.Scan(&tableName, &colName, &dataType, &isNullable, &colDefault); err != nil {
			return nil, fmt.Errorf("scan schema row: %w", err)
		}
		if _, ok := tables[tableName]; !ok {
			tables[tableName] = &tableSchema{}
		}
		tables[tableName].Columns = append(tables[tableName].Columns, tableColumn{
			Name:     colName,
			Type:     dataType,
			Nullable: isNullable == "YES",
			Default:  colDefault,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate schema rows: %w", err)
	}

	result := map[string]any{"tables": tables}
	b, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal schema: %w", err)
	}
	return b, nil
}

// ---- MySQL -----------------------------------------------------------------

// discoverMySQLSchema connects to a MySQL/MariaDB instance and queries
// information_schema to build a table→columns map.
func discoverMySQLSchema(ctx context.Context, plainCreds []byte) ([]byte, error) {
	var creds relationalCreds
	if err := json.Unmarshal(plainCreds, &creds); err != nil {
		return nil, fmt.Errorf("parse mysql credentials: %w", err)
	}

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

	rows, err := db.QueryContext(ctx, `
		SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
		ORDER BY TABLE_NAME, ORDINAL_POSITION`)
	if err != nil {
		return nil, fmt.Errorf("query mysql information_schema: %w", err)
	}
	defer rows.Close()

	tables := map[string]*tableSchema{}
	for rows.Next() {
		var tableName, colName, dataType, isNullable string
		var colDefault *string
		if err := rows.Scan(&tableName, &colName, &dataType, &isNullable, &colDefault); err != nil {
			return nil, fmt.Errorf("scan mysql schema row: %w", err)
		}
		if _, ok := tables[tableName]; !ok {
			tables[tableName] = &tableSchema{}
		}
		tables[tableName].Columns = append(tables[tableName].Columns, tableColumn{
			Name:     colName,
			Type:     dataType,
			Nullable: isNullable == "YES",
			Default:  colDefault,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mysql schema rows: %w", err)
	}

	b, err := json.Marshal(map[string]any{"tables": tables})
	if err != nil {
		return nil, fmt.Errorf("marshal mysql schema: %w", err)
	}
	return b, nil
}

// ---- SQL Server (MSSQL) ----------------------------------------------------

// discoverMSSQLSchema connects to a SQL Server instance and queries sys.tables
// and sys.columns to build a table→columns map.
func discoverMSSQLSchema(ctx context.Context, plainCreds []byte) ([]byte, error) {
	var creds relationalCreds
	if err := json.Unmarshal(plainCreds, &creds); err != nil {
		return nil, fmt.Errorf("parse mssql credentials: %w", err)
	}

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

	rows, err := db.QueryContext(ctx, `
		SELECT t.name AS table_name,
		       c.name AS column_name,
		       tp.name AS data_type,
		       c.is_nullable
		FROM sys.tables t
		JOIN sys.columns c ON c.object_id = t.object_id
		JOIN sys.types tp ON tp.user_type_id = c.user_type_id
		WHERE t.is_ms_shipped = 0
		ORDER BY t.name, c.column_id`)
	if err != nil {
		return nil, fmt.Errorf("query mssql sys.tables: %w", err)
	}
	defer rows.Close()

	tables := map[string]*tableSchema{}
	for rows.Next() {
		var tableName, colName, dataType string
		var isNullable bool
		if err := rows.Scan(&tableName, &colName, &dataType, &isNullable); err != nil {
			return nil, fmt.Errorf("scan mssql schema row: %w", err)
		}
		if _, ok := tables[tableName]; !ok {
			tables[tableName] = &tableSchema{}
		}
		tables[tableName].Columns = append(tables[tableName].Columns, tableColumn{
			Name:     colName,
			Type:     dataType,
			Nullable: isNullable,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mssql schema rows: %w", err)
	}

	b, err := json.Marshal(map[string]any{"tables": tables})
	if err != nil {
		return nil, fmt.Errorf("marshal mssql schema: %w", err)
	}
	return b, nil
}

// ---- GraphQL ---------------------------------------------------------------

type graphqlCreds struct {
	Endpoint string `json:"endpoint"`
	AuthType string `json:"auth_type"` // none | bearer
	Token    string `json:"token,omitempty"`
}

// introspectionQuery fetches GraphQL query-type field names via introspection.
var introspectionQuery = `{"query":"{ __schema { queryType { fields { name description args { name type { name kind ofType { name kind } } } type { name kind ofType { name kind } } } } } }"}`

// discoverGraphQLSchema performs a GraphQL introspection query and stores
// the queryType fields as the schema cache.
func discoverGraphQLSchema(ctx context.Context, plainCreds []byte) ([]byte, error) {
	var creds graphqlCreds
	if err := json.Unmarshal(plainCreds, &creds); err != nil {
		return nil, fmt.Errorf("parse graphql credentials: %w", err)
	}
	if creds.Endpoint == "" {
		return nil, fmt.Errorf("graphql endpoint is required")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, creds.Endpoint,
		bytes.NewBufferString(introspectionQuery))
	if err != nil {
		return nil, fmt.Errorf("build graphql introspection request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if creds.AuthType == "bearer" && creds.Token != "" {
		req.Header.Set("Authorization", "Bearer "+creds.Token)
	}

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("graphql introspection request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("read graphql introspection response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("graphql introspection returned HTTP %d: %s", resp.StatusCode, string(body))
	}

	// Parse and re-wrap under a "schema" key to normalise the cache shape.
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse graphql introspection response: %w", err)
	}

	b, err := json.Marshal(map[string]any{
		"type":     "graphql",
		"endpoint": creds.Endpoint,
		"schema":   parsed,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal graphql schema: %w", err)
	}
	return b, nil
}

// ---- Managed (Lima Table) -------------------------------------------------

// discoverManagedTableSchema reads column definitions from managed_table_columns
// and builds a schema_cache blob. No credentials are needed because the data
// lives in Lima's own database.
func discoverManagedTableSchema(ctx context.Context, pool *pgxpool.Pool, connectorID string) ([]byte, error) {
	rows, err := pool.Query(ctx,
		`SELECT name, col_type, nullable FROM managed_table_columns
		 WHERE connector_id = $1 ORDER BY col_order`,
		connectorID,
	)
	if err != nil {
		return nil, fmt.Errorf("query managed columns: %w", err)
	}
	defer rows.Close()

	type col struct {
		Name     string `json:"name"`
		ColType  string `json:"col_type"`
		Nullable bool   `json:"nullable"`
	}
	var cols []col
	for rows.Next() {
		var c col
		if err := rows.Scan(&c.Name, &c.ColType, &c.Nullable); err != nil {
			return nil, fmt.Errorf("scan managed column: %w", err)
		}
		cols = append(cols, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	b, err := json.Marshal(map[string]any{
		"type":    "managed",
		"columns": cols,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal managed schema: %w", err)
	}
	return b, nil
}
