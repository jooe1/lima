#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lima-compose-smoke-XXXXXX")"
HTTP_BODY_FILE="${BACKUP_DIR}/http-body.txt"
HTTP_HEADERS_FILE="${BACKUP_DIR}/http-headers.txt"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8080/v1}"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lima-smoke-${GITHUB_RUN_ID:-$$}}"
export PGPASSWORD="${PGPASSWORD:-lima_dev_secret}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5444}"
export PGUSER="${PGUSER:-lima}"
export PGDATABASE="${PGDATABASE:-lima}"

compose() {
    docker compose -f "$COMPOSE_FILE" "$@"
}

log() {
    echo "[compose-smoke] $*" >&2
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "Missing required command: $1"
        exit 1
    fi
}

wait_for_health() {
    local service="$1"
    local timeout="${2:-120}"
    local started_at="$SECONDS"
    local container_id=""
    local status=""

    while (( SECONDS - started_at < timeout )); do
        container_id="$(compose ps -a -q "$service")"
        if [[ -n "$container_id" ]]; then
            status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
            if [[ "$status" == "healthy" ]]; then
                log "$service is healthy"
                return 0
            fi
            if [[ "$status" == "exited" || "$status" == "dead" ]]; then
                break
            fi
        fi
        sleep 2
    done

    log "$service did not become healthy in ${timeout}s"
    compose ps || true
    return 1
}

wait_for_running() {
    local service="$1"
    local timeout="${2:-120}"
    local started_at="$SECONDS"
    local container_id=""
    local status=""

    while (( SECONDS - started_at < timeout )); do
        container_id="$(compose ps -a -q "$service")"
        if [[ -n "$container_id" ]]; then
            status="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
            if [[ "$status" == "running" ]]; then
                log "$service is running"
                return 0
            fi
            if [[ "$status" == "exited" || "$status" == "dead" ]]; then
                break
            fi
        fi
        sleep 2
    done

    log "$service did not stay running in ${timeout}s"
    compose ps || true
    return 1
}

wait_for_successful_exit() {
    local service="$1"
    local timeout="${2:-180}"
    local started_at="$SECONDS"
    local container_id=""
    local status=""
    local exit_code=""

    while (( SECONDS - started_at < timeout )); do
        container_id="$(compose ps -a -q "$service")"
        if [[ -n "$container_id" ]]; then
            status="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
            exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container_id" 2>/dev/null || true)"
            if [[ "$status" == "exited" && "$exit_code" == "0" ]]; then
                log "$service exited successfully"
                return 0
            fi
            if [[ "$status" == "exited" && "$exit_code" != "0" ]]; then
                break
            fi
        fi
        sleep 2
    done

    log "$service did not exit successfully in ${timeout}s"
    compose logs --no-color "$service" || true
    return 1
}

wait_for_http() {
    local url="$1"
    local label="$2"
    local timeout="${3:-180}"
    local started_at="$SECONDS"

    while (( SECONDS - started_at < timeout )); do
        if curl --noproxy '*' --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
            log "$label is ready"
            return 0
        fi
        sleep 3
    done

    log "$label did not respond successfully in ${timeout}s"
    return 1
}

psql_maybe_scalar() {
    local sql="$1"
    local value=""

    value="$(psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --no-password --dbname="$PGDATABASE" -v ON_ERROR_STOP=1 -qtAX -c "$sql")"
    value="${value//$'\r'/}"
    printf '%s' "$value"
}

psql_scalar() {
    local sql="$1"
    local value=""

    value="$(psql_maybe_scalar "$sql")"
    if [[ -z "$value" ]]; then
        log "Query returned no rows: $sql"
        exit 1
    fi
    printf '%s' "$value"
}

wait_for_psql_non_empty() {
    local sql="$1"
    local label="$2"
    local timeout="${3:-120}"
    local started_at="$SECONDS"
    local value=""

    while (( SECONDS - started_at < timeout )); do
        value="$(psql_maybe_scalar "$sql")"
        if [[ -n "$value" ]]; then
            log "$label is ready"
            printf '%s' "$value"
            return 0
        fi
        sleep 2
    done

    log "$label did not become available in ${timeout}s"
    exit 1
}

wait_for_workflow_run_status() {
    local run_id="$1"
    local expected_status="$2"
    local timeout="${3:-120}"
    local started_at="$SECONDS"
    local status=""
    local error_message=""

    while (( SECONDS - started_at < timeout )); do
        status="$(psql_maybe_scalar "SELECT COALESCE(status::text, '') FROM workflow_runs WHERE id = '${run_id}'")"
        if [[ "$status" == "$expected_status" ]]; then
            log "workflow run ${run_id} reached status ${expected_status}"
            return 0
        fi
        if [[ "$status" == "failed" ]]; then
            error_message="$(psql_maybe_scalar "SELECT COALESCE(error_message, '') FROM workflow_runs WHERE id = '${run_id}'")"
            log "workflow run ${run_id} failed while waiting for ${expected_status}: ${error_message}"
            exit 1
        fi
        sleep 2
    done

    log "workflow run ${run_id} did not reach status ${expected_status} in ${timeout}s"
    exit 1
}

api_request() {
    local method="$1"
    local url="$2"
    local token="${3:-}"
    local body="${4:-}"

    : > "$HTTP_BODY_FILE"
    : > "$HTTP_HEADERS_FILE"

    local -a curl_args=(
        --noproxy
        '*'
        --silent
        --show-error
        --max-time 15
        -D "$HTTP_HEADERS_FILE"
        -o "$HTTP_BODY_FILE"
        -w "%{http_code}"
        -X "$method"
        "$url"
    )

    if [[ -n "$token" ]]; then
        curl_args+=( -H "Authorization: Bearer $token" )
    fi
    if [[ -n "$body" ]]; then
        curl_args+=( -H "Content-Type: application/json" --data "$body" )
    fi

    LAST_HTTP_STATUS="$(curl "${curl_args[@]}")"
}

expect_http_status() {
    local expected="$1"
    shift
    local method="$1"
    local url="$2"

    api_request "$@"

    if [[ "$LAST_HTTP_STATUS" != "$expected" ]]; then
        log "Unexpected HTTP status for ${method} ${url}: got ${LAST_HTTP_STATUS}, want ${expected}"
        sed 's/^/[compose-smoke] header: /' "$HTTP_HEADERS_FILE" || true
        sed 's/^/[compose-smoke] body: /' "$HTTP_BODY_FILE" || true
        exit 1
    fi
}

expect_header_contains() {
    local needle="$1"
    if ! grep -Fqi "$needle" "$HTTP_HEADERS_FILE"; then
        log "Expected response headers to contain: ${needle}"
        sed 's/^/[compose-smoke] header: /' "$HTTP_HEADERS_FILE" || true
        exit 1
    fi
}

expect_body_contains() {
    local needle="$1"
    local label="${2:-response body}"
    if ! grep -Fq "$needle" "$HTTP_BODY_FILE"; then
        log "Expected ${label} to contain: ${needle}"
        sed 's/^/[compose-smoke] body: /' "$HTTP_BODY_FILE" || true
        exit 1
    fi
}

expect_body_not_contains() {
    local needle="$1"
    local label="${2:-response body}"
    if grep -Fq "$needle" "$HTTP_BODY_FILE"; then
        log "Expected ${label} to exclude: ${needle}"
        sed 's/^/[compose-smoke] body: /' "$HTTP_BODY_FILE" || true
        exit 1
    fi
}

extract_token_from_body() {
    local token=""
    token="$(grep -o '"token":"[^"]*"' "$HTTP_BODY_FILE" | head -n 1 | cut -d '"' -f 4)"
    if [[ -z "$token" ]]; then
        log "Failed to parse dev-login token from response body"
        sed 's/^/[compose-smoke] body: /' "$HTTP_BODY_FILE" || true
        exit 1
    fi
    printf '%s' "$token"
}

run_workflow_mutation_smoke_checks() {
    local workspace_id="$1"
    local app_id="$2"
    local token="$3"
    local smoke_since="$4"
    local smoke_suffix="$5"
    local connector_name="smoke-postgres-${smoke_suffix}"
    local workflow_name="smoke-approval-mutation-${smoke_suffix}"
    local mutation_marker_id="workflow-marker-${smoke_suffix}"
    local connector_id=""
    local workflow_id=""
    local workflow_step_id=""
    local run_id=""
    local approval_id=""
    local marker_phase=""
    local step_status=""
    local step_rows_affected=""
    local step_approved=""

    log "Publishing tenant workflow app and validating the published runtime endpoint"
    expect_http_status 200 POST "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/publish" "$token"
    expect_body_contains "$app_id" "publish response"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/published" "$token"
    expect_body_contains "$app_id" "published app response"

    log "Preparing workflow mutation target table"
    cat <<SQL | psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --no-password --dbname="$PGDATABASE" -v ON_ERROR_STOP=1
CREATE TABLE IF NOT EXISTS release_readiness_workflow_smoke (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DELETE FROM release_readiness_workflow_smoke WHERE id = '${mutation_marker_id}';
SQL

    log "Creating and testing a workflow connector against the compose Postgres service"
    expect_http_status 201 POST "${API_BASE_URL}/workspaces/${workspace_id}/connectors" "$token" "{\"name\":\"${connector_name}\",\"type\":\"postgres\",\"credentials\":{\"host\":\"postgres\",\"port\":5432,\"database\":\"lima\",\"username\":\"lima\",\"password\":\"${PGPASSWORD}\",\"ssl\":false}}"
    connector_id="$(psql_scalar "SELECT id FROM connectors WHERE workspace_id = '${workspace_id}' AND name = '${connector_name}'")"
    expect_http_status 200 POST "${API_BASE_URL}/workspaces/${workspace_id}/connectors/${connector_id}/test" "$token"
    expect_body_contains '"ok":true' "connector test response"

    log "Creating and activating an approval-gated mutation workflow"
    expect_http_status 201 POST "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/workflows" "$token" "{\"name\":\"${workflow_name}\",\"trigger_type\":\"manual\",\"requires_approval\":true,\"steps\":[{\"name\":\"approved smoke mutation\",\"step_type\":\"mutation\",\"config\":{\"connector_id\":\"${connector_id}\",\"sql\":\"INSERT INTO release_readiness_workflow_smoke (id, phase) VALUES ('${mutation_marker_id}', 'approved-mutation')\"}}]}"
    workflow_id="$(psql_scalar "SELECT id FROM workflows WHERE workspace_id = '${workspace_id}' AND app_id = '${app_id}' AND name = '${workflow_name}'")"
    workflow_step_id="$(psql_scalar "SELECT id FROM workflow_steps WHERE workflow_id = '${workflow_id}' ORDER BY step_order LIMIT 1")"
    expect_http_status 200 POST "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/workflows/${workflow_id}/activate" "$token"
    expect_body_contains '"status":"active"' "workflow activation response"

    log "Triggering the workflow and waiting for the approval gate"
    expect_http_status 201 POST "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/workflows/${workflow_id}/trigger" "$token" "{\"input_data\":{}}"
    run_id="$(psql_scalar "SELECT id FROM workflow_runs WHERE workflow_id = '${workflow_id}' ORDER BY started_at DESC LIMIT 1")"
    wait_for_workflow_run_status "$run_id" "awaiting_approval" 120
    approval_id="$(wait_for_psql_non_empty "SELECT COALESCE(approval_id::text, '') FROM workflow_runs WHERE id = '${run_id}'" "workflow approval id" 60)"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/workflows/${workflow_id}/runs" "$token"
    expect_body_contains "$run_id" "workflow runs while awaiting approval"
    expect_body_contains '"status":"awaiting_approval"' "workflow runs while awaiting approval"
    expect_body_contains "$approval_id" "workflow runs while awaiting approval"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/approvals?status=pending" "$token"
    expect_body_contains "$approval_id" "pending approvals list"
    expect_body_contains '"status":"pending"' "pending approvals list"

    log "Approving the workflow mutation and waiting for worker resume"
    expect_http_status 200 POST "${API_BASE_URL}/workspaces/${workspace_id}/approvals/${approval_id}/approve" "$token"
    expect_body_contains "$approval_id" "approval response"
    expect_body_contains '"status":"approved"' "approval response"
    wait_for_workflow_run_status "$run_id" "completed" 120
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/apps/${app_id}/workflows/${workflow_id}/runs" "$token"
    expect_body_contains "$run_id" "workflow runs after approval"
    expect_body_contains '"status":"completed"' "workflow runs after approval"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/approvals?status=approved" "$token"
    expect_body_contains "$approval_id" "approved approvals list"
    expect_body_contains '"status":"approved"' "approved approvals list"

    log "Verifying mutation execution details and audit evidence"
    marker_phase="$(psql_scalar "SELECT phase FROM release_readiness_workflow_smoke WHERE id = '${mutation_marker_id}'")"
    if [[ "$marker_phase" != "approved-mutation" ]]; then
        log "Unexpected workflow mutation marker phase: ${marker_phase}"
        exit 1
    fi

    step_status="$(psql_maybe_scalar "SELECT COALESCE(output_data->'steps'->'${workflow_step_id}'->>'status', '') FROM workflow_runs WHERE id = '${run_id}'")"
    if [[ "$step_status" != "completed" ]]; then
        log "Workflow mutation step did not complete successfully: ${step_status}"
        exit 1
    fi

    step_approved="$(psql_maybe_scalar "SELECT COALESCE(output_data->'steps'->'${workflow_step_id}'->>'approved', '') FROM workflow_runs WHERE id = '${run_id}'")"
    if [[ "$step_approved" != "true" ]]; then
        log "Workflow mutation step approval flag was not recorded as true: ${step_approved}"
        exit 1
    fi

    step_rows_affected="$(psql_maybe_scalar "SELECT COALESCE(output_data->'steps'->'${workflow_step_id}'->'result'->>'rows_affected', '') FROM workflow_runs WHERE id = '${run_id}'")"
    if [[ "$step_rows_affected" != "1" ]]; then
        log "Workflow mutation step rows_affected was ${step_rows_affected}, want 1"
        exit 1
    fi

    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_id}/audit/export?since=${smoke_since}&limit=200" "$token"
    expect_header_contains "Content-Type: text/csv"
    expect_body_contains "app.published" "workflow smoke audit export"
    expect_body_contains "approval.approved" "workflow smoke audit export"
    expect_body_contains "$app_id" "workflow smoke audit export"
    expect_body_contains "$approval_id" "workflow smoke audit export"
}

run_operational_smoke_checks() {
    local smoke_suffix="${GITHUB_RUN_ID:-$$}"
    local company_a_slug="smoke-company-a-${smoke_suffix}"
    local company_b_slug="smoke-company-b-${smoke_suffix}"
    local workspace_a_slug="smoke-workspace-a-${smoke_suffix}"
    local workspace_b_slug="smoke-workspace-b-${smoke_suffix}"
    local app_a_name="smoke-app-a-${smoke_suffix}"
    local app_b_name="smoke-app-b-${smoke_suffix}"
    local smoke_since="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    local company_a_token=""
    local company_b_token=""
    local company_a_id=""
    local company_b_id=""
    local workspace_a_id=""
    local workspace_b_id=""
    local app_a_id=""
    local app_b_id=""

    log "Creating tenant-scoped auth sessions"
    expect_http_status 200 POST "${API_BASE_URL}/auth/dev/login" "" "{\"email\":\"admin-a-${smoke_suffix}@example.test\",\"name\":\"SmokeAdminA\",\"company_slug\":\"${company_a_slug}\",\"role\":\"workspace_admin\"}"
    company_a_token="$(extract_token_from_body)"
    expect_http_status 200 POST "${API_BASE_URL}/auth/dev/login" "" "{\"email\":\"admin-b-${smoke_suffix}@example.test\",\"name\":\"SmokeAdminB\",\"company_slug\":\"${company_b_slug}\",\"role\":\"workspace_admin\"}"
    company_b_token="$(extract_token_from_body)"

    company_a_id="$(psql_scalar "SELECT id FROM companies WHERE slug = '${company_a_slug}'")"
    company_b_id="$(psql_scalar "SELECT id FROM companies WHERE slug = '${company_b_slug}'")"

    log "Creating per-tenant workspaces"
    expect_http_status 201 POST "${API_BASE_URL}/companies/${company_a_id}/workspaces" "$company_a_token" "{\"name\":\"${workspace_a_slug}\",\"slug\":\"${workspace_a_slug}\"}"
    expect_http_status 201 POST "${API_BASE_URL}/companies/${company_b_id}/workspaces" "$company_b_token" "{\"name\":\"${workspace_b_slug}\",\"slug\":\"${workspace_b_slug}\"}"

    workspace_a_id="$(psql_scalar "SELECT id FROM workspaces WHERE company_id = '${company_a_id}' AND slug = '${workspace_a_slug}'")"
    workspace_b_id="$(psql_scalar "SELECT id FROM workspaces WHERE company_id = '${company_b_id}' AND slug = '${workspace_b_slug}'")"

    log "Creating tenant-local app activity for audit export"
    expect_http_status 201 POST "${API_BASE_URL}/workspaces/${workspace_a_id}/apps" "$company_a_token" "{\"name\":\"${app_a_name}\"}"
    expect_http_status 201 POST "${API_BASE_URL}/workspaces/${workspace_b_id}/apps" "$company_b_token" "{\"name\":\"${app_b_name}\"}"

    app_a_id="$(psql_scalar "SELECT id FROM apps WHERE workspace_id = '${workspace_a_id}' AND name = '${app_a_name}'")"
    app_b_id="$(psql_scalar "SELECT id FROM apps WHERE workspace_id = '${workspace_b_id}' AND name = '${app_b_name}'")"

    log "Verifying multi-tenant isolation through company and workspace routes"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_a_id}/apps" "$company_a_token"
    expect_body_contains "$app_a_id" "tenant A app listing"
    expect_body_not_contains "$app_b_id" "tenant A app listing"
    expect_http_status 403 GET "${API_BASE_URL}/companies/${company_b_id}/workspaces" "$company_a_token"
    expect_http_status 403 GET "${API_BASE_URL}/workspaces/${workspace_b_id}/apps" "$company_a_token"
    expect_http_status 403 GET "${API_BASE_URL}/workspaces/${workspace_a_id}/apps" "$company_b_token"

    log "Verifying audit export output and scoping"
    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_a_id}/audit/export?since=${smoke_since}&limit=100" "$company_a_token"
    expect_header_contains "Content-Type: text/csv"
    expect_body_contains "id,workspace_id,actor_id,event_type,resource_type,resource_id,created_at" "tenant A audit export"
    expect_body_contains "app.created" "tenant A audit export"
    expect_body_contains "$workspace_a_id" "tenant A audit export"
    expect_body_contains "$app_a_id" "tenant A audit export"
    expect_body_not_contains "$workspace_b_id" "tenant A audit export"
    expect_body_not_contains "$app_b_id" "tenant A audit export"

    expect_http_status 200 GET "${API_BASE_URL}/workspaces/${workspace_b_id}/audit/export?since=${smoke_since}&limit=100" "$company_b_token"
    expect_header_contains "Content-Type: text/csv"
    expect_body_contains "app.created" "tenant B audit export"
    expect_body_contains "$workspace_b_id" "tenant B audit export"
    expect_body_contains "$app_b_id" "tenant B audit export"
    expect_body_not_contains "$workspace_a_id" "tenant B audit export"
    expect_body_not_contains "$app_a_id" "tenant B audit export"

    run_workflow_mutation_smoke_checks "$workspace_a_id" "$app_a_id" "$company_a_token" "$smoke_since" "$smoke_suffix"

    expect_http_status 403 GET "${API_BASE_URL}/workspaces/${workspace_b_id}/audit/export?since=${smoke_since}&limit=100" "$company_a_token"
}

cleanup() {
    local exit_code="$?"

    if [[ "$exit_code" -ne 0 ]]; then
        log "Validation failed. Capturing compose status and recent logs."
        compose ps -a || true
        compose logs --no-color --tail=200 || true
    fi

    log "Tearing down compose stack"
    compose down -v --remove-orphans || true
    rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

require_cmd docker
require_cmd curl
require_cmd psql
require_cmd pg_dump

log "Starting compose stack"
compose up -d --build

wait_for_health postgres 120
wait_for_health redis 120
wait_for_successful_exit migrate 180
wait_for_running api 120
wait_for_running worker 120
wait_for_running web 180
wait_for_http "http://127.0.0.1:8080/healthz" "API" 180
wait_for_http "http://127.0.0.1:3000/" "web" 240

run_operational_smoke_checks

log "Preparing round-trip marker data"
cat <<'SQL' | psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --no-password --dbname="$PGDATABASE" -v ON_ERROR_STOP=1
CREATE TABLE IF NOT EXISTS release_readiness_roundtrip (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL
);
TRUNCATE TABLE release_readiness_roundtrip;
INSERT INTO release_readiness_roundtrip (id, phase) VALUES ('backup-marker', 'before-backup');
SQL

log "Creating backup artifact"
bash "${SCRIPT_DIR}/backup.sh" "$BACKUP_DIR"

BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'lima-backup-*.sql.gz' | sort | tail -n 1)"
if [[ -z "$BACKUP_FILE" ]]; then
    log "Backup artifact was not created"
    exit 1
fi

log "Mutating database after backup to prove restore round-trip"
cat <<'SQL' | psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --no-password --dbname="$PGDATABASE" -v ON_ERROR_STOP=1
TRUNCATE TABLE release_readiness_roundtrip;
INSERT INTO release_readiness_roundtrip (id, phase) VALUES ('restore-marker', 'after-backup');
SQL

log "Stopping application services before restore"
compose stop api worker web

log "Restoring backup artifact"
bash "${SCRIPT_DIR}/restore.sh" --yes "$BACKUP_FILE"

log "Restarting application services after restore"
compose start api worker web
wait_for_running api 120
wait_for_running worker 120
wait_for_running web 180
wait_for_http "http://127.0.0.1:8080/healthz" "API after restore" 180
wait_for_http "http://127.0.0.1:3000/" "web after restore" 240

RESTORED_STATE="$(psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --no-password --dbname="$PGDATABASE" -v ON_ERROR_STOP=1 -qtAX -c "SELECT COALESCE(string_agg(id || ':' || phase, ',' ORDER BY id), '') FROM release_readiness_roundtrip;")"
if [[ "$RESTORED_STATE" != "backup-marker:before-backup" ]]; then
    log "Unexpected round-trip state after restore: ${RESTORED_STATE}"
    exit 1
fi

log "Compose smoke validation succeeded"