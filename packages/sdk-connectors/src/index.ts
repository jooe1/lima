/**
 * Lima connector SDK — shared interfaces consumed by services/api,
 * services/worker, and eventually third-party connector implementations.
 *
 * Design principles:
 *  - Schema/metadata discovery is always allowed (read-only, safe by default)
 *  - Query execution is read-only by default; mutations require an approved
 *    WorkflowAction routed through the approval queue (FR-14, FR-15)
 *  - Credentials are never returned to the caller after creation
 */

// ---- Connector type registry -----------------------------------------------

export type ConnectorType = 'postgres' | 'mysql' | 'mssql' | 'rest' | 'graphql' | 'csv'

// ---- Credential models (never returned after write) ------------------------

export interface RelationalCredentials {
  host: string
  port: number
  database: string
  username: string
  /** Stored encrypted; redacted in API responses */
  password: string
  ssl: boolean
}

export interface RestCredentials {
  baseUrl: string
  authType: 'none' | 'bearer' | 'basic' | 'api_key'
  token?: string
  username?: string
  password?: string
  apiKeyHeader?: string
  apiKeyValue?: string
}

export interface GraphQLCredentials {
  endpoint: string
  authType: 'none' | 'bearer'
  token?: string
  useIntrospection: boolean
}

export interface CsvCredentials {
  /** Storage key of the uploaded file (S3-compatible object key) */
  objectKey: string
  hasHeader: boolean
}

export type ConnectorCredentials =
  | RelationalCredentials
  | RestCredentials
  | GraphQLCredentials
  | CsvCredentials

// ---- Schema / metadata types -----------------------------------------------

export interface ColumnMeta {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  foreignKey?: { table: string; column: string }
}

export interface TableMeta {
  schema: string
  name: string
  columns: ColumnMeta[]
  rowCountEstimate?: number
}

export interface RelationalSchema {
  tables: TableMeta[]
}

export interface RestEndpoint {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  description?: string
  parameters?: Array<{ name: string; in: 'query' | 'path' | 'header' | 'body'; required: boolean }>
}

export interface RestSchema {
  baseUrl: string
  endpoints: RestEndpoint[]
}

export interface GraphQLField {
  name: string
  type: string
  args: Array<{ name: string; type: string }>
}

export interface GraphQLSchema {
  queryFields: GraphQLField[]
  mutationFields: GraphQLField[]
}

export interface CsvSchema {
  columns: Array<{ name: string; inferredType: 'string' | 'number' | 'boolean' | 'date' }>
  rowCount: number
}

export type ConnectorSchema = RelationalSchema | RestSchema | GraphQLSchema | CsvSchema

// ---- Query and action contracts --------------------------------------------

export interface QueryRequest {
  /** SQL string for relational connectors; URL path for REST; GQL query body for GraphQL */
  query: string
  params?: Record<string, unknown>
  /** Maximum rows returned in a preview context */
  limit?: number
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  totalCount?: number
}

/**
 * MutationRequest is only dispatched after an explicit human approval
 * (enforced in the approval queue — FR-15). The approvalId ties this
 * mutation to the approval record in the database.
 */
export interface MutationRequest {
  approvalId: string
  query: string
  params?: Record<string, unknown>
}

export interface MutationResult {
  affectedRows: number
}

// ---- Connector interface ---------------------------------------------------

/**
 * IConnector is the contract every connector driver must satisfy.
 * Implementations live in services/api and services/worker.
 */
export interface IConnector {
  readonly type: ConnectorType
  /** Test the connection and return an error message, or null if healthy */
  testConnection(): Promise<string | null>
  /** Return schema/metadata — no data rows, safe to call freely */
  discoverSchema(): Promise<ConnectorSchema>
  /** Execute a read-only query; preview data only, never raw production writes */
  query(req: QueryRequest): Promise<QueryResult>
  /**
   * Execute a pre-approved mutation. Must only be called from the worker
   * after an approval record has been confirmed. Never call directly from
   * API handlers.
   */
  mutate(req: MutationRequest): Promise<MutationResult>
}

// ---- Connector config (stored in DB, credentials encrypted at rest) --------

export interface ConnectorConfig {
  id: string
  workspaceId: string
  name: string
  type: ConnectorType
  /** Encrypted blob stored in the database; decrypted at runtime by the service */
  encryptedCredentials: string
  createdAt: string
  updatedAt: string
}

export interface ConnectorChatResponse {
  conversationId: string;
  message: string;
  done: boolean;
  connectorId?: string;
  authType?: string;
}
