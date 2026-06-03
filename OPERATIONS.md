# Xata Agent — DBA Operations Guide

For the Zafin DBA team. Replaces the manual `kubectl exec` + `psql` healthcheck routine with a single web UI that holds connection strings to every Postgres in the fleet and runs scheduled, audited, read-only diagnostics on demand.

---

## 1. First-time setup (per environment)

Required env vars on the host running the agent (Azure AKS Helm values, `.env.local` for dev):

```
DATABASE_URL       # state DB — agent's own postgres (NOT a managed target)
AUTH_SECRET        # long random string — JWT signing
ANTHROPIC_API_KEY  # the LLM brain (or OPENAI_API_KEY / etc.)
SCHEDULER_SECRET   # long random string — gates /api/priv/schedule-tick
```

Apply migrations once: `pnpm run db:migrate`. Run the app: `pnpm run dev` (dev) or `docker compose up` (prod-shaped). Open the Web UI on `:4001`.

The scheduler is a second process: `pnpm run dev-scheduler`. It POSTs `/api/priv/schedule-tick` with the secret every 10 s (dev) / 60 s (prod) — that's what makes scheduled healthchecks fire. Put both in your Helm chart as separate pods.

---

## 2. Register a target database

> Sidebar → **Starter guide → Connect to Database** (or **Settings → Connections** to manage the full fleet)

| Field                         | What to enter                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| **Connection Name**           | Human label, e.g. `cibc-dbo-prod`, `hsbc-uks-prod`                                      |
| **Connection String**         | `postgres://xata_agent_ro:<pw>@host:5432/dbname` — see below                            |
| **CPU Cores** _(optional)_    | Actual vCPU count of the DB node (e.g. 64). Drives `postgresql-config` tuning formulas. |
| **Memory (GiB)** _(optional)_ | RAM allocated to the pod / VM (e.g. 512). Same.                                         |

Click **Validate Connection** before **Save**. Validate runs `SELECT version()` against the target.

**Recommended target-side role** (run once per managed Postgres):

```sql
CREATE ROLE xata_agent_ro WITH LOGIN PASSWORD '...';
GRANT pg_read_all_stats, pg_read_all_settings TO xata_agent_ro;
GRANT CONNECT ON DATABASE <dbname> TO xata_agent_ro;
GRANT USAGE ON SCHEMA pg_catalog, information_schema, public TO xata_agent_ro;
```

The agent ALSO wraps every query in `BEGIN; SET TRANSACTION READ ONLY; …` — belt-and-suspenders. But a read-only role makes the contract obvious.

---

## 3. Daily flows

### A. Ad-hoc diagnosis (chat)

> Sidebar → **Chat**. Pick a connection. Ask a question.

The model has these tools available against the target DB (all read-only, all audited):

- **`getSlowQueries`**, **`safeExplainQuery`**, **`unsafeExplainQuery`** — `pg_stat_statements` + EXPLAIN
- **`describeTable`**, **`findTableSchema`**, **`getPerformanceAndVacuumSettings`**
- **`getCurrentActiveQueries`**, **`getQueriesWaitingOnLocks`**, **`getVacuumStats`**, **`getConnectionsStats`**, **`getConnectionsGroups`**
- **`runHealthCheckSection(id)`** / **`runFullHealthCheck`** — the 10-section bundle
- **`getPlaybook(name)`** / **`listPlaybooks`** — pull canonical Zafin SOPs

**Tip:** ask "use the postgresql-config playbook to recommend params for this DB" — the model is system-prompted to call `getPlaybook("postgresql-config")` first and apply Zafin's exact formulas instead of inventing values.

### B. Run a healthcheck on demand

> Chat → "Run a full health check on this DB."

The model calls `runFullHealthCheck` → 10 sections execute in parallel, 60 s timeout each. It then either applies the `pg-health-check` playbook to produce the Zafin-style markdown report, or you can paste the JSON into your own analysis.

### C. Schedule recurring healthchecks

> Sidebar → **Monitoring → New Schedule**

| Field                   | Recommendation                                                      |
| ----------------------- | ------------------------------------------------------------------- |
| Playbook                | `pg-health-check`                                                   |
| Connection              | the target DB                                                       |
| Schedule type           | `cron`                                                              |
| Cron expression         | `0 9 * * 1` (Mon 09:00) — start weekly                              |
| Additional instructions | Free-form. Cores/Memory come from the connection row automatically. |
| Notify level            | `warning` (Slack ping when something needs attention)               |
| Max steps               | 8–10 (caps agentic iterations)                                      |
| Enabled                 | ✓                                                                   |

Save. The scheduler will fire at the cron time. Findings + the full message trace land in **Monitoring → Runs**.

### D. Browse the audit log

Every statement the agent has run against any target DB lives in the state DB's `target_db_audit` table (no UI yet — query directly):

```sql
SELECT started_at, user_id, origin, sql_text, rows, duration_ms, error
FROM target_db_audit
WHERE connection_id = '<uuid>'
  AND started_at > NOW() - INTERVAL '7 days'
ORDER BY started_at DESC
LIMIT 200;
```

`origin` is `chat | schedule | healthcheck | manual`. Useful columns:

- `error` — non-null only for failed/aborted queries
- `duration_ms` — sort to find slow probes
- `sql_params` — bound parameters for parametrised statements

### E. Custom playbooks

> Sidebar → **Playbooks → Create Custom Playbook**

Built-in playbooks live in code (`apps/dbagent/built-in-playbooks/*.md`). Custom ones live in the `playbooks` DB table per project and override built-ins of the same name. Edit any time via the UI; changes take effect on the next chat (no restart).

---

## 4. Built-in playbooks (cheat sheet)

| Name                             | When to use                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pg-health-check`                | The headline workflow — full SOP-driven analysis of the target DB. Pairs with `runFullHealthCheck`. |
| `postgresql-config`              | Recommend `postgresql.conf` + huge pages for given Cores / Memory. Uses Zafin formulas.             |
| `investigateSlowQueries`         | Drill into `pg_stat_statements`.                                                                    |
| `investigateHighCpuUsage`        | Live triage of an active CPU spike.                                                                 |
| `investigateLowMemory`           | Live triage of memory pressure.                                                                     |
| `investigateHighConnectionCount` | Live triage of connection-pool saturation.                                                          |
| `generalMonitoring`              | Periodic glance — slow queries, locks, basic metrics.                                               |
| `tuneSettings`                   | Generic tuning suggestions based on schema + instance.                                              |

---

## 5. When things break

| Symptom                                                                 | Where to look            | Likely cause                                                                                             |
| ----------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Chat returns _"No providers enabled. Please configure API keys"_        | env vars on the pod      | `ANTHROPIC_API_KEY` (or OpenAI / Deepseek / Google) is unset                                             |
| Chat returns Anthropic 429 (`rate-limit`)                               | response headers in log  | switch to a Sonnet model, or wait 60 s for the per-minute budget to reset                                |
| Scheduled run never fires                                               | `dev-scheduler` pod logs | scheduler not running, or `SCHEDULER_SECRET` mismatch between scheduler and agent pods (you'll see 401s) |
| `target_db_audit` rows missing for a chat                               | state DB                 | audit is fire-and-forget; check agent pod logs for `[target-db-audit]` errors                            |
| Tool result `error: "permission denied for relation X"`                 | target DB                | `xata_agent_ro` role missing GRANT on a schema                                                           |
| Tool result `error: "cannot execute UPDATE in a read-only transaction"` | agent log                | LLM hallucinated a write; the read-only wrap caught it. Reinforce read-only intent in the next message.  |
| Two scheduled runs fire for the same row                                | shouldn't happen         | scheduler uses `FOR UPDATE SKIP LOCKED` — file a bug if you see it                                       |

**Log locations**

- Agent app: stdout of the agent pod (`kubectl logs -f deploy/xata-agent`)
- Scheduler: stdout of the scheduler pod
- State DB queries (if needed): `target_db_audit` table covers tool calls; for app-internal queries, enable Postgres logging on the state DB

---

## 6. Restart cheatsheet

```bash
# Apply a new migration
pnpm run db:migrate

# Restart the agent (env changes need this; code changes hot-reload)
kubectl rollout restart deploy/xata-agent

# Restart the scheduler
kubectl rollout restart deploy/xata-scheduler

# Dev:
#   kill node on :4001, then  cd apps/dbagent && pnpm exec next dev --turbo --port 4001
```

---

## 7. Things to know but not memorise

- Connection strings are stored plaintext in `connections.connection_string`. Pre-prod is fine; for prod, plan a Key-Vault migration (item in REVIEW.md §2.8).
- Every target-DB statement is read-only AND audited — there is **no path** by which the LLM can write to a managed Postgres through this agent. Even `EXPLAIN ANALYZE INSERT …` fails inside the read-only tx.
- The skill auto-sync from disk is gone — built-in playbooks are now part of the image. To update a built-in, edit `apps/dbagent/built-in-playbooks/*.md` and redeploy.
- The Anthropic prompt-cache is on by default — multi-step chats cost ~1/3 what they did before.
- OTel exporter only registers when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No more `ECONNREFUSED ::1:4318` noise in logs.
