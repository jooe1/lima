package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lima/worker/internal/config"
	"github.com/lima/worker/internal/cryptoutil"
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
		plainCreds, err := cryptoutil.Decrypt(cfg.CredentialsEncryptionKey, rec.encryptedCredentials)
		if err != nil {
			return fmt.Errorf("decrypt credentials: %w", err)
		}

		// Dispatch to type-specific discovery.
		var schemaJSON []byte
		switch rec.connectorType {
		case "postgres":
			schemaJSON, err = discoverPostgresSchema(ctx, plainCreds, log)
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
