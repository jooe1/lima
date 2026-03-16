# Upgrading Lima

This document describes how to safely upgrade an existing Lima installation
(Docker Compose or Kubernetes/Helm) from one version to the next.

---

## General upgrade process

1. **Read the release notes** for every version between your current version and
   the target.  Each version section below lists breaking changes, required
   secret rotations, and migration notes.
2. **Back up the database** before every upgrade.
3. **Run database migrations** — the migration job is idempotent; re-running it is
   safe.
4. **Roll out services** — API first, then worker, then web.  The API is always the
   migration gate; do not route traffic to a new web build before the API is
   healthy.

---

## Docker Compose upgrades

```bash
# 1. Pull the latest images
docker compose pull

# 2. Back up Postgres
cd deploy/docker-compose
PGPASSWORD=<your-password> ./backup.sh ./backups

# 3. Apply database migrations (runs automatically on next `up`, or explicitly)
docker compose run --rm migrate

# 4. Restart services (zero-downtime if you have replicas behind a load balancer)
docker compose up -d --no-deps api worker web
```

---

## Kubernetes / Helm upgrades

```bash
# 1. Always back up first
kubectl exec -n <namespace> deploy/<release>-api -- \
  pg_dump "$DATABASE_URL" | gzip > lima-backup-$(date +%Y%m%dT%H%M%S).sql.gz

# 2. Upgrade the release (migration Helm hook runs automatically as a pre-upgrade job)
helm upgrade lima ./deploy/helm/lima \
  --namespace <namespace> \
  --reuse-values \
  --set images.api.tag=<new-tag> \
  --set images.worker.tag=<new-tag> \
  --set images.web.tag=<new-tag>

# 3. Monitor the rollout
kubectl rollout status deploy/<release>-api -n <namespace>
kubectl rollout status deploy/<release>-worker -n <namespace>
kubectl rollout status deploy/<release>-web -n <namespace>
```

### Rolling back a Helm release

```bash
# List revision history
helm history lima -n <namespace>

# Roll back to a specific revision
helm rollback lima <revision> -n <namespace>
```

---

## Secret rotation (credentials encryption key)

The `CREDENTIALS_ENCRYPTION_KEY` (/ `secrets.credentialsEncryptionKey` in
`values.yaml`) encrypts connector secrets at rest using AES-256-GCM.  Follow
these steps to rotate it without data loss:

1. **Generate a new key** (32 bytes, base64-encoded):
   ```bash
   openssl rand -base64 32
   ```

2. **Deploy both keys simultaneously** — set the *new* key as
   `CREDENTIALS_ENCRYPTION_KEY` and the *old* key as
   `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`.  The API's `DecryptWithRotation`
   helper will try the new key first and fall back to the old key transparently.
   ```bash
   helm upgrade lima ./deploy/helm/lima \
     --set secrets.credentialsEncryptionKey=<new-key> \
     --set secrets.credentialsEncryptionKeyPrevious=<old-key>
   ```

3. **Re-encrypt all connector secrets** — run the re-encryption admin endpoint
   (or a migration script) to update every ciphertext in `connectors.encrypted_credentials`
   to use the new key.

4. **Remove the previous key** — once all ciphertexts have been re-encrypted,
   clear `credentialsEncryptionKeyPrevious`:
   ```bash
   helm upgrade lima ./deploy/helm/lima \
     --set secrets.credentialsEncryptionKey=<new-key> \
     --set secrets.credentialsEncryptionKeyPrevious=""
   ```

---

## Audit retention

By default, audit events are retained indefinitely.  To apply a retention
policy for a workspace, call the database helper function introduced in
migration 008:

```sql
-- Retain audit events for 365 days for workspace <id>
SELECT apply_audit_retention('<workspace-uuid>', 365);
```

A scheduled job (Kubernetes CronJob, cron on the Compose host, or a pg_cron
extension job) should periodically run:

```sql
DELETE FROM audit_events WHERE expires_at IS NOT NULL AND expires_at < now();
```

Or call the `PruneExpiredAuditEvents` store method via the API worker.  The
append-only DB rules installed by migration 008 prevent ad-hoc tampering with
active audit records.

---

## Database connection pool tuning

| Environment variable | Default | Description |
|---|---|---|
| `DB_MAX_CONNS` | `25` | Maximum pool connections per API pod.  Multiply by API replica count and ensure the total is well below Postgres `max_connections` (default 100). |
| `DB_MIN_CONNS` | `2` | Minimum idle connections kept warm. |

For a typical 2-replica API deployment with Postgres `max_connections=100`,
set `DB_MAX_CONNS=20` to leave headroom for migrations and admin queries.

---

## High availability guidance

### Postgres

- Use a managed Postgres service (RDS, Cloud SQL, Azure Database) or a
  Patroni / pg_auto_failover cluster for production.
- Bitnami's postgresql sub-chart supports `replication.enabled=true` with a
  read replica, but failover is manual.  For automated failover use an external
  operator.

### Redis

- Use Redis Sentinel or Redis Cluster for HA, or a managed service (ElastiCache,
  Memorystore).  The worker service uses Redis for job queues; losing Redis
  causes job delivery to pause (jobs are retried when Redis recovers, no data
  is lost).

### Kubernetes

- PodDisruptionBudgets are enabled by default (`podDisruptionBudget.*.enabled: true`).
  This ensures at least one pod of each component stays running during
  voluntary disruptions (node drains, rolling upgrades).
- Enable HPA for automated scaling under load:
  ```yaml
  autoscaling:
    api:
      enabled: true
      minReplicas: 2
      maxReplicas: 10
  ```
- Run API and worker pods on separate nodes using `podAntiAffinity` if your
  cluster is large enough:
  ```yaml
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app.kubernetes.io/name: lima
            topologyKey: kubernetes.io/hostname
  ```

---

## Observability

### Docker Compose

Start the monitoring stack alongside the default services:

```bash
docker compose --profile monitoring up -d
```

This starts Prometheus (`:9090`) and Grafana (`:3001`, admin / admin).
The OTel Collector exposes scraped metrics on port `8889`; Prometheus is
pre-configured to scrape it.

### Kubernetes

Set `otel.endpoint` in `values.yaml` to your cluster's OTel Collector endpoint
and enable metrics annotations:

```yaml
otel:
  endpoint: http://otel-collector.monitoring.svc.cluster.local:4318
metrics:
  enabled: true   # adds prometheus.io/scrape annotations to the API pod
```

---

## Upgrade path summary

| From | To | Notes |
|---|---|---|
| Phase 0–6 | Phase 7 | Run migration 008 (adds `expires_at` to `audit_events`, append-only rules, export index). No breaking changes. |
| Any | Any | All migrations are idempotent; re-running is safe. |

---

## Getting help

- File issues at the project repository.
- Check `/healthz` on the API pod for DB connectivity status.
- Check the OTel Collector logs for trace and metric pipeline errors.
