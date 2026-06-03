---
name: pg-health-check
description: "Zafin PostgreSQL database proactive health check automation. Use this skill whenever the user asks for a health check, mentions 'proactive check', 'DB checklist', 'dead tuples', 'wraparound', 'bloat analysis', 'checkpoint analysis', or any Zafin environment health assessment. Also trigger when the user wants to compare current PostgreSQL settings against recommended values, check rollback ratios, review autovacuum stats, or produce a health report from live database state. This skill depends on the postgresql-config skill for parameter formulas and constants."
---

# Zafin PostgreSQL Health Check — Deep Analysis

This skill drives a precise, SOP-driven analysis of a live PostgreSQL connection and produces findings + next steps. The goal is accuracy and actionable insight — not a formatted report.

## Overview

**Inputs**:

1. Live PostgreSQL connection (registered in the agent — data is gathered via the `runFullHealthCheck` / `runHealthCheckSection` tools described below).
2. **CPU Cores** — actual vCPU count of the DB node (from `kubectl describe node` or Azure SKU).
3. **Memory GiB** — actual RAM allocated to the PostgreSQL pod (from pod resource limits, NOT derived from settings).

**CRITICAL: NEVER derive Cores or Memory from PostgreSQL settings.**
Do NOT use `max_worker_processes / 2` for Cores or `shared_buffers / 0.4` for Memory. Misconfigured settings create circular validation — every formula check passes against the wrong baseline. If the user hasn't provided actual specs, ASK before running parameter validation. You can still complete all other checks without them. If specs are not provided, the Parameter Validation section must state: "AWAITING SKU INPUT — parameter formulas cannot be validated without actual CPU and Memory. Run: `kubectl describe node -l purpose=db | grep -E 'cpu:|memory:'` to obtain actual node specs."

**Output**: A markdown analysis named `healthcheck-<env>-<YYYYMMDD>.md`. No status icons or emoji — use plain text labels only: CRITICAL, WARNING, OK, MONITOR, PASS, FAIL, HOT-RELOADABLE, REQUIRES-RESTART.

---

## Step 1: Gather data via health-check tools

Call **`runFullHealthCheck`** to collect all sections in one shot, _or_ call **`runHealthCheckSection({ id })`** for a single section. Both run a read-only transaction against the registered Postgres connection. Each result has the shape `{ id, displayName, rows, error? }`.

### Section IDs used in this skill

Use these stable ids when calling `runHealthCheckSection`:

| Section id                    | What it tells you                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `active_long_running_queries` | pg_stat_activity snapshot — PID, state, durations, application, user, db, first 100 chars of SQL |
| `slow_queries_history`        | Top 10 by avg exec time from pg_stat_statements                                                  |
| `dead_tuples`                 | Per-table dead/live ratios, est. wasted space, dead-tuple percentage                             |
| `blocking_sessions`           | Blocked/blocking PIDs, query text, lock type                                                     |
| `maintenance_progress`        | Live pg*stat_progress*\* (vacuum/analyze/copy/create_index)                                      |
| `wraparound_risk`             | Per-database age(datfrozenxid)                                                                   |
| `autovacuum_config`           | Current values of autovacuum\_\* GUCs                                                            |
| `checkpoint_stats`            | pg_stat_bgwriter counters and timing                                                             |
| `wal_rate`                    | WAL bytes/time-window                                                                            |
| `rollback_ratio`              | xact_commit vs xact_rollback per db                                                              |

If a section returns `error`, retry it with `runHealthCheckSection({ id })`. If a specific section is unavailable (e.g., pg_stat_statements not installed), proceed with the remaining sections and note the gap in the report.

> The downstream analysis (Step 2 onwards) maps section ids to the existing checks:
> `dead_tuples` → bloat / dead-tuple analysis; `wraparound_risk` → freezing risk; `autovacuum_config` → settings comparison against `postgresql-config` formulas; `slow_queries_history` + `active_long_running_queries` → long-running queries; `blocking_sessions` → contention; `checkpoint_stats` + `wal_rate` → checkpoint / WAL tuning; `rollback_ratio` → application-error indicator; `maintenance_progress` → live autovacuum/analyze workers.

---

## Step 2: Extract and Analyze Every Data Point

For each area below, extract the raw numbers and apply the thresholds. Do not skip sections. Do not summarize prematurely. Every finding is written as a fact with the actual value, the threshold it was compared against, and whether it passes or fails.

### Connections

- **max_connections**: from `pg_settings`
- **current count**: from `connection_count`
- **Active / Idle / Idle-in-transaction**: count each `state` bucket in `active_sessions`
- Report: exact numbers, % of max used, flag if > 80% of max_connections used
- Flag any `idle in transaction` sessions — these hold open transactions that pin the XID horizon and block autovacuum reclaim cluster-wide
- If `idle in transaction` sessions exist, include their PID, age, xact_start timestamp, and query text

**Idle-in-transaction sessions that exceed the configured timeout:**
If a session's age exceeds `idle_in_transaction_session_timeout` (e.g., 23h) but is still alive, explain the mechanism: the timeout kills a session that is idle _continuously_ for the configured duration. If the application sends any query mid-transaction — even a trivial `SELECT 1` heartbeat — the idle timer resets while `xact_start` stays pinned at the original transaction start. The session remains alive indefinitely. The timeout is not broken; the application is keeping the session alive through periodic heartbeats. The fix is application-side: verify HikariCP/PgBouncer `idle-in-transaction-timeout` is set lower than the PostgreSQL `idle_in_transaction_session_timeout`.

### Long-running Queries & Transactions

- From `top_queries`: list all queries with `avg_exec_time_s > 10`. Include the query text (truncated), call count, total time, average time.
- From `long_transactions`: list any open transactions with `txn_age > 5 minutes`. Include pid, state, query, age.
- Flag `idle in transaction` transactions separately — these are the most dangerous (hold row-level locks, block autovacuum on affected tables)
- Threshold: > 30s avg → flag; > 5min open transaction → flag; > 1hr → CRITICAL
- For idle-in-transaction sessions exceeding the configured timeout, apply the heartbeat bypass explanation above — do not state "timeout not enforced" or leave the mechanism vague.

### Bloat

- From `bloat` section: compute **disk-level bloat** = `SUM(wastedbytes) / SUM(actual table + index sizes) × 100`
- List every table with `tbloat > 3.0` or `ibloat > 3.0` — include table name, tbloat ratio, ibloat ratio, estimated wasted bytes
- **Deduplication rule**: the bloat CSV may have multiple rows per table (one per index). Deduplicate and show each table once with BOTH its table bloat (tbloat) and a summary of all associated index bloat (list each index ibloat and wasted bytes). Do not double-count wasted space.
- Cross-reference each heavily bloated table with its `autovacuum_count` from dead_tuples/table_stats. If a table has high tbloat AND high autovacuum_count, autovacuum is running but the XID horizon is blocking reclaim — state this explicitly and point to the idle-in-transaction root cause. Do not recommend autovacuum tuning for this scenario.
- **pg_catalog.pg_statistic**: if present with dead_tuple_pct > 99%, flag as a standalone CRITICAL item. Every ANALYZE on any table creates new stats rows that become dead tuples. With tens of millions of dead rows, every subsequent vacuum/analyze cycle slows. pg_statistic cannot be pg_repack'd (system catalog). It resolves only when the XID horizon advances (i.e., idle-in-transaction sessions close and autovacuum completes).
- Thresholds:
  - < 5% disk-level → OK
  - 5–10% → WARNING, plan VACUUM FULL or pg_repack
  - > 10% → CRITICAL — REINDEX/pg_repack required; detail which tables are worst

### Dead Tuples / Autovacuum Health

- From `dead_tuples` and `db_table_stats`: for each table compute dead_tuple_pct = `n_dead_tup / (n_live_tup + n_dead_tup) × 100`
- List every table with dead_tuple_pct > 10%. Include: table name, n_live_tup, n_dead_tup, dead_tuple_pct, last_autovacuum, last_autoanalyze, autovacuum_count
- Thresholds:
  - < 10% all tables → OK
  - 10–30% some tables → WARNING, autovacuum lag
  - > 50% any table → CRITICAL, autovacuum not keeping up

**Stale autoanalyze detection**: Flag any table where `last_autoanalyze` is > 7 days old, especially if: (a) the table is large (> 500K rows), or (b) the table appears in top_queries with slow average execution times. Stale stats cause the query planner to choose bad query plans. For each flagged table, recommend:

```sql
ANALYZE VERBOSE <schema>.<table>;
```

Then run `EXPLAIN (ANALYZE, BUFFERS)` on slow queries against that table to verify plan quality after the ANALYZE.

**Active autovacuum worker analysis**: When reporting active autovacuum workers at snapshot time, check `index_vacuum_count` for each worker. If `index_vacuum_count = 0`, the worker has not completed even a single index pass — this indicates the XID horizon is blocking reclaim, not that autovacuum is misconfigured. State this distinction explicitly: "autovacuum is working correctly; it is the pinned XID horizon that prevents dead tuple reclaim." Do not recommend autovacuum configuration changes when a pinned XID horizon is the actual cause.

### Wraparound

- From `db_table_stats`: extract MAX(`wraparound_age`) and identify which table has the highest age
- Also check `pg_settings` for `autovacuum_freeze_max_age`, `vacuum_freeze_min_age`, `vacuum_freeze_table_age`, `vacuum_failsafe_age`
- The PostgreSQL hard limit is 2,147,483,648 (2.1B)

**Report distance from ALL of the following thresholds:**

| Threshold                   | Typical Value | Significance                                                                            |
| --------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `vacuum_freeze_min_age`     | 50M           | Tables past this are eligible for freeze                                                |
| `vacuum_freeze_table_age`   | 150M          | PostgreSQL must perform whole-table freeze scans when crossed — noticeable I/O increase |
| `autovacuum_freeze_max_age` | 200M          | Autovacuum runs forced freeze passes regardless of normal triggers                      |
| `vacuum_failsafe_age`       | 1,600M        | PostgreSQL skips cost delay to prevent wraparound at all costs                          |
| PostgreSQL hard limit       | 2,100M        | Data corruption risk                                                                    |

Status bands:

- < 100M → OK
- 100M–150M → MONITOR. Note the distance to vacuum_freeze_table_age (150M) — crossing it triggers whole-table freeze scans causing noticeable I/O load.
- 150M–200M → WARNING. Whole-table freeze scans now running. Verify autovacuum is not blocked.
- 200M–500M → WARNING/URGENT. Autovacuum forced freeze passes triggered. Verify freeze progress.
- > 500M → CRITICAL.

Weekly monitoring query:

```sql
SELECT schemaname, relname, age(relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='r' ORDER BY xid_age DESC LIMIT 20;
```

Alert if any table crosses 150M.

### Checkpoint Analysis

- From `checkpoint_stats`:
  - `checkpoints_timed`: scheduled checkpoints (fired by checkpoint_timeout)
  - `checkpoints_req`: forced checkpoints (fired because WAL filled max_wal_size before timeout)
  - Compute: `forced_pct = checkpoints_req / (checkpoints_req + checkpoints_timed) × 100`
  - Check `checkpoint_write_time` and `checkpoint_sync_time` for I/O pressure
  - Compute WAL generation rate: if stats period is known, `WAL rate = max_wal_size / (stats_period_minutes / (checkpoints_req / total_minutes))`
- Also report: `wal_level`, `max_wal_senders`, `archive_mode` — these determine whether pg_wal directory size reflects WAL generation rate. If wal_level=minimal, max_wal_senders=0, archive_mode=off: WAL segments are recycled immediately after each checkpoint. A small pg_wal directory alongside high forced checkpoints is normal in this configuration — the directory size is not an indicator of WAL generation rate.
- Report `buffers_clean` (bgwriter dirty page writes). If `buffers_clean = 0`, the bgwriter is contributing zero writes — all dirty pages are being written by the checkpoint process itself in bursts.

Thresholds:

- forced_pct < 10% → OK
- 10–50% → WARNING, WAL generation elevated
- > 50% → CRITICAL, WAL generation rate exceeds max_wal_size capacity

**Remediation order — do NOT jump to increasing max_wal_size:**

When forced checkpoints dominate, apply fixes in this order:

1. **First: terminate idle-in-transaction sessions** if present. Pinned XID horizons cause autovacuum to run repeatedly without reclaiming dead tuples, generating visibility-map WAL on every futile attempt. This is often the dominant source of elevated WAL generation in Zafin environments.

2. **Second: fix wal_buffers if critically undersized** (see Parameter Validation — wal_buffers). At 16 MB on a large-memory system, WAL flushes to disk on nearly every write. Fix requires restart — plan for maintenance window.

3. **Third: fix min_wal_size if at default 80 MB** (see Parameter Validation — min_wal_size). Quiet-to-busy transitions cause WAL to spike from 80 MB to max_wal_size, amplifying I/O. Fix is hot-reloadable — zero downtime.

4. **Only then consider increasing max_wal_size**, and only if forced checkpoints remain high after steps 1–3. State the trade-off explicitly: larger max_wal_size = longer crash recovery time. Do not recommend increasing max_wal_size without noting the RTO impact.

### WAL Size

- From `wal_size`: report exact size
- Always report alongside: `wal_level`, `max_wal_senders`, `archive_mode`. If all three are at minimal/0/off, WAL segments are recycled immediately after each checkpoint — a small pg_wal directory is expected regardless of WAL generation rate.
- < 5 GB → OK (when no replication/archiving)
- 5–50 GB → WARNING if no replication slots, verify no stuck slots (`pg_replication_slots`)
- > 50 GB → flag — check for stuck replication slots

### Deadlocks and Blocking

- From `blocking`: if rows present, list every blocked/blocking pair. Include: blocked_pid, blocking_pid, locktype, query text, duration
- Note: deadlocks are transient and may not appear in a snapshot. Check `pg_stat_database.deadlocks` if available in the CSV.
- If no blocking → state this explicitly

**FOR UPDATE NOWAIT pattern**: If idle-in-transaction session query text contains `FOR UPDATE NOWAIT`, note: NOWAIT acquires the lock immediately or fails immediately — it does not queue. Lock contention from NOWAIT does not appear as blocked sessions; it appears as rollbacks. If the application retries `FOR UPDATE NOWAIT` periodically (e.g., APPLICATION_LOCK polling), each failed attempt is a rollback. This pattern is a known contributor to high rollback ratios in Zafin environments. Report this cross-reference explicitly in both this section and the Rollback Ratio section.

### Rollback Ratio

- From `rollback_ratio` section, use the `zafin` database row
- Thresholds:
  - < 1% → OK
  - 1–5% → slightly elevated, investigate application retry patterns
  - 5–25% → WARNING, investigate — application bugs, lock contention, constraint violations
  - > 25% → CRITICAL — serious application-side issue
- Include xact_commit and xact_rollback counts and derive the absolute rate (rollbacks/sec over the stats period). Ratios alone are misleading — 0.5% of 10M transactions/hour is a different problem from 0.5% of 200 transactions/day.

**FOR UPDATE NOWAIT correlation**: If idle-in-transaction sessions with `FOR UPDATE NOWAIT` queries are present, correlate the rollback rate to this pattern. Each failed NOWAIT lock attempt is a rollback. Estimate contribution: sessions × retry_interval → rollbacks/sec. Even if not dominant, state the connection explicitly. The fix for this source of rollbacks is terminating the 9-day sessions AND fixing the application — both are needed.

### PostgreSQL Parameter Validation

- From `pg_settings`: extract all key parameters
- Cross-reference with `postgresql-config` skill formulas using actual CPU and Memory provided by the user
- If CPU/Memory not provided: skip spec-dependent formulas and mark as "AWAITING SKU INPUT" — but still run the three absolute checks below
- For each parameter: show actual value, expected value (formula or threshold), and PASS/FAIL/WARN

The parameter validation table must include an "Apply Method" column for every row that is not PASS. Values: HOT-RELOADABLE (change takes effect via `pg_reload_conf()`, no restart) or REQUIRES-RESTART (PostgreSQL must be restarted). Bundle all REQUIRES-RESTART items into the Medium-Term maintenance window section.

**Spec-dependent parameters** (skip if CPU/Memory not provided):

- `shared_buffers` → expected: `ROUND(0.4 × MemoryGiB)` GB
- `effective_cache_size` → expected: `ROUND(0.75 × MemoryGiB)` GB
- `work_mem` → expected formula from postgresql-config skill
- `maintenance_work_mem` → expected formula
- `max_wal_size` → expected formula
- `max_worker_processes` → expected: `2 × Cores`
- `max_parallel_workers` → expected: `Cores`
- `max_parallel_workers_per_gather` → expected: `MIN(FLOOR(0.5 × Cores), 4)`
- `max_parallel_maintenance_workers` → expected: `MIN(FLOOR(0.5 × Cores), 8)`
- `autovacuum_max_workers` → expected: `MAX(ROUND(Cores/8), 3)`

**Absolute checks — always run regardless of whether node specs are provided:**

**wal_buffers**
If `wal_buffers = 16MB` (the auto-tuned default) AND `shared_buffers > 100 GB`: flag as CRITICAL. Expected ~3% of shared_buffers (e.g., ~6 GB for a 205 GB shared_buffers system). At 16 MB, WAL must flush to disk on nearly every write, adding per-transaction latency and amplifying checkpoint I/O pressure. Requires restart.

```sql
ALTER SYSTEM SET wal_buffers = '6GB';
-- REQUIRES RESTART — plan for next maintenance window
```

**min_wal_size**
If `min_wal_size = 80MB` (default) AND `max_wal_size > 10 GB`: flag as WARNING. When WAL shrinks to 80 MB after a quiet period, the next write burst grows WAL from 80 MB to max_wal_size in a spike, causing a write amplification event. Hot-reloadable.

```sql
ALTER SYSTEM SET min_wal_size = '4GB';
SELECT pg_reload_conf();
```

**data_checksums**
If `data_checksums = off`: flag as WARNING on any production financial system. Silent disk corruption is undetectable without checksums. This is a cluster-level setting — cannot be changed with `ALTER SYSTEM`. Enabling requires offline operation: `pg_checksums --enable` on a stopped cluster. Raise with architecture team for next major maintenance window.

**pg_qualstats**
If `pg_qualstats` appears in `shared_preload_libraries`: flag as WARNING. pg_qualstats hooks into query execution and at the default sample_rate=0.25 adds overhead on 25% of all queries. When not actively used for query analysis, it should be removed. Action (REQUIRES-RESTART — bundle with other restart changes): remove `pg_qualstats` from `shared_preload_libraries`, remove all `pg_qualstats.*` settings from postgresql.conf, restart PostgreSQL, then run `DROP EXTENSION IF EXISTS pg_qualstats`.

**Zafin standard constants — do NOT flag as problems:**

- `idle_in_transaction_session_timeout = 23h`
- `autovacuum_vacuum_cost_delay = 100ms`
- `autovacuum_vacuum_cost_limit = 2000`
- `checkpoint_timeout = 30min`
- `checkpoint_completion_target = 0.9`
- `autovacuum_naptime = 30s`
- `idle_session_timeout = 2h`
- `autovacuum_vacuum_scale_factor = 0.05`
- `autovacuum_analyze_scale_factor = 0.05`
- `random_page_cost = 1.1`
- `effective_io_concurrency = 200`
- `JIT = off`
- `logging_collector = on`

### Huge Pages

- From `pg_settings`: check `huge_pages`
- Always flag `huge_pages = off` on any production system. Severity depends on shared_buffers:
  - **CRITICAL** if `shared_buffers > 100 GB`
  - **WARNING** if `shared_buffers >= 1 GB`
  - **INFO** if `shared_buffers < 1 GB`
- If `huge_pages = off` is paired with a planned shared_buffers increase, base severity and calculation on the **target** shared_buffers value.
- `huge_pages = off` must always appear as a row in the parameter table and in the Jira ticket issues table. Do not omit it.

**Pod/node-level configuration — always include in both the .md report and Jira ticket next steps when huge_pages = off:**

Calculate from the target shared_buffers value (in GiB):

- `hugepages_GiB = CEIL(shared_buffers_GiB × 1.1)` — round up to nearest whole GiB
- `HUGEPAGES_2M = hugepages_GiB × 1024 / 2`

Add to pod YAML resources section:

```yaml
resources:
  limits:
    hugepages-2Mi: <hugepages_GiB>Gi
  requests:
    hugepages-2Mi: <hugepages_GiB>Gi
```

Add to Linux deployment env vars:

```yaml
- name: HUGEPAGES_2M
  value: '<HUGEPAGES_2M>'
```

Set `huge_pages = try` in postgresql.conf (REQUIRES-RESTART — bundle with shared_buffers and other restart-required changes). After restart verify with `SHOW huge_pages;` — must return `on`.

- If `huge_pages = on`: confirm the pod YAML hugepages-2Mi allocation is >= the configured shared_buffers.

### Database Size

- From `db_table_stats`: sum `table_size` values for approximate DB size
- Or check for any `pg_database_size` output in the CSV
- Report the total and flag if unexpectedly large compared to prior checks (if prior data is available)

### Missing Metrics Gaps

After completing all sections, explicitly flag any expected metrics not present in the CSV. For each gap, state the SQL to add to future health check runs.

At minimum flag if missing:

1. **Cumulative deadlock count** — if not in CSV:

```sql
SELECT datname, deadlocks, conflicts FROM pg_stat_database WHERE datname='zafin';
```

2. **Exact database size** — if not in CSV:

```sql
SELECT pg_size_pretty(pg_database_size('zafin')) AS db_size;
```

3. **Replication slot status** — if `max_wal_senders > 0` but slot data not in CSV:

```sql
SELECT slot_name, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
```

---

## Step 3: Write the Output .md File

Write a file named `healthcheck-<env>-<YYYYMMDD>.md`.

**No icons or emoji anywhere in the output.** Use plain text labels throughout: CRITICAL, WARNING, OK, MONITOR, PASS, FAIL. Do not use colored circles, checkmarks, or any Unicode status symbols — not in section headers, severity summaries, bullet points, or inline text.

**No ALTER SYSTEM commands in the output.** Do not include SQL command blocks for parameter changes. Instead, state the change as a plain-text action line with the apply method. Example: "Set wal_buffers = 6GB (REQUIRES-RESTART)". The exact SQL is obvious to the DBA; the report's job is to state what to change, why, and whether it requires downtime.

**Causal chains must be stated explicitly.** When findings in different sections share a root cause, write the chain out. Example: "The 9-day idle-in-transaction session pins the XID horizon → autovacuum cannot reclaim dead tuples on any table modified since [date] → autovacuum runs repeatedly without effect → each futile run writes visibility-map WAL → WAL generation rate elevated → contributes to forced checkpoint rate → also: every ANALYZE creates new pg_statistic dead tuples that cannot be reclaimed → 19 GB catalog bloat." Do not leave the reader to connect dots across sections.

**Header**: environment name, date of CSV, date of analysis, node specs if known (or "AWAITING SKU INPUT").

**For each finding area**: raw numbers first, then interpretation, then next step. No filler sentences.

Example style (match the precision, not the words):

```
WRAPAROUND
  Max wraparound_age: 108,404,855 (pg_catalog.pg_depend, pg_proc, pg_class, pg_attribute)
  vacuum_freeze_min_age: 50,000,000 — already past, tables eligible for freeze
  vacuum_freeze_table_age: 150,000,000 — 42M remaining (crossing triggers whole-table freeze scans)
  autovacuum_freeze_max_age: 200,000,000 — 92M remaining
  vacuum_failsafe_age: 1,600,000,000 — 1,492M remaining
  Hard limit (2.1B): 1,992M remaining
  Status: MONITOR — no immediate danger; approaching vacuum_freeze_table_age. When crossed, I/O load from whole-table freeze scans will be noticeable.
  Note: 9-day idle-in-transaction sessions are slowing XID age advancement by pinning the oldest XID globally.
  Next step: Weekly check — alert if any table > 150M:
    SELECT schemaname, relname, age(relfrozenxid) AS xid_age FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'
    ORDER BY xid_age DESC LIMIT 20;

CHECKPOINTS
  checkpoints_timed: 822   checkpoints_req: 2,130   forced_pct: 72.2%
  Stats period: 23.5 days
  Avg checkpoint write time: 172,608 ms (172.6 seconds)
  buffers_clean (bgwriter): 0 — bgwriter contributed zero dirty page writes; all 671 GB checkpoint writes are burst-written by the checkpoint process
  WAL generation rate: ~195 GB/hour
  wal_level: minimal   max_wal_senders: 0   archive_mode: off — WAL recycled immediately after each checkpoint; pg_wal directory size does not reflect generation rate
  Status: CRITICAL — WAL generation rate exceeds max_wal_size capacity. Majority of checkpoints are forced.
  Root cause: idle-in-transaction sessions causing futile autovacuum WAL pressure; wal_buffers=16MB causing per-write flush overhead; min_wal_size=80MB causing write amplification spikes.
  Remediation order (see next steps section):
    1. Terminate 9-day sessions (reduces autovacuum WAL pressure — immediate)
    2. Fix min_wal_size=4GB (hot-reloadable, zero downtime)
    3. Fix wal_buffers=6GB (requires restart — bundle with huge_pages)
    4. Do NOT increase max_wal_size until steps 1-3 are done; increasing max_wal_size extends crash recovery time proportionally
```

**Severity summary at the top**: list all CRITICAL items first, then WARNING, then OK. One line each with area name and key number. No icons.

**Tiered next steps section** (mandatory, replaces flat priority list):

**IMMEDIATE (within 24 hours)** — anything actively blocking autovacuum or causing ongoing degradation. Include exact SQL.

**SHORT-TERM (within 1 week)** — hot-reloadable parameter fixes, pg_repack, stale stats refresh. Mark each action as "(HOT-RELOADABLE — zero downtime)".

**MEDIUM-TERM (next maintenance window)** — bundle ALL restart-required changes together. Mark each as "(REQUIRES-RESTART — bundle into one maintenance window)". Never split restart items across separate maintenance windows without a reason.

**ONGOING MONITORING** — recurring check queries with specific alert thresholds, items to add to the health check script.

**Items requiring external data**: state what's missing and exactly how to retrieve it (kubectl command, Grafana panel name, Azure Monitor path).

---

## Step 4: Create Jira Ticket in PRJTSKY

After writing the .md file, automatically create a Jira ticket in the **PRJTSKY (ProjectSky)** project. Do not ask the user — this is part of the standard health check workflow.

**Atlassian connection details:**

- Cloud ID: `c74d9cfe-6745-4f48-8ea1-55a13f1d0ae8`
- Project key: `PRJTSKY`
- Issue type: `Problem`
- Site URL for browse links: `https://zafinworks.atlassian.net/browse/<KEY>` (NOT zafin.atlassian.net — that bounces to an access-request page)

**Required custom fields (always set these):**

| Field                                  | Value                                                            |
| -------------------------------------- | ---------------------------------------------------------------- |
| `customfield_14201` (Nature of Ticket) | `{"id": "12402"}` — "Database"                                   |
| `customfield_10011` (Environment)      | `{"id": "14100"}` — "PROD DB"                                    |
| `customfield_11454` (Severity)         | `{"id": "11005"}` — "1"                                          |
| `customfield_10853` (Project Name)     | environment label string (e.g. "PNC_Tus")                        |
| `components`                           | `[{"id": "28250"}]` — "PostgreSQL (Flexi and AKS) Support - BAU" |
| `priority`                             | `{"name": "Critical"}`                                           |

**Ticket summary format:**
`<ENV_LABEL> PostgreSQL Health Check — Recommended DB Config & Hugepages (<YYYYMMDD>)`

Example: `HSBC PostgreSQL Health Check — Recommended DB Config & Hugepages (20260430)`

**Ticket description — strict rules:**

- No icons or emoji
- No ALTER SYSTEM commands
- Audience: client teams who are NOT DB-knowledgeable. Keep language plain, the param list compact, and the next-step actions concrete.
- Not a copy of the .md report. The .md lives locally as the deep analysis; the ticket is the action document.
- Do NOT paste the full report as a comment.
- Use exactly the four sections below, in order. Omit Hugepages if `huge_pages = on`. Omit "Other Actions Required" only if there is genuinely nothing beyond the param table (rare).

**Section 1 — Critical Findings**
Short bullet list (3–6 bullets). One sentence per bullet. Each bullet states a fact + impact, not a recommendation. The dominant root cause (if any) goes first. Use plain text labels only (CRITICAL/WARNING) inside bullets if you must — usually the bullet itself is enough.

**Section 2 — Recommendations — postgresql.conf parameters**
A single table covering ALL parameter changes (CRITICAL and WARNING combined). Columns:

| Parameter | Current | Recommended | Apply |

Apply column values are exactly `RELOAD` or `RESTART`. Order rows: RELOAD rows first, then RESTART rows. Immediately after the table, include this exact note:

> For RELOAD parameters, after editing core-database-conf, apply with:
>
> ```sql
> SELECT pg_reload_conf();
> ```
>
> RESTART parameters require a pod restart — bundle all together in the next maintenance window.

**Section 3 — Hugepages Configuration** (only if `huge_pages = off` or being changed)

No table. Plain text + two code blocks:

- One line of context stating node specs and shared_buffers target.
- Pod YAML block with `resources.requests` and `resources.limits` showing `hugepages-2Mi: <hugepages_GiB>Gi` (calculated as `CEIL(shared_buffers_GiB × 1.1)`).
- Linux deployment env var block showing `HUGEPAGES_2M = "<hugepages_GiB × 512>"`.
- One-line follow-up: set `huge_pages = try` in postgresql.conf, verify `SHOW huge_pages;` returns `on` after restart.
- Reference link, exactly as: `Reference ticket for team to enable hugepages: [CSO-55514: Enable Hugepages in ING PROD2 | ingvnextv3rg1we **Closed**](https://zafinworks.atlassian.net/browse/CSO-55514?focusedCommentId=1794067)`

**Section 4 — Other Actions Required**
Plain-language actions that are NOT postgresql.conf changes. Group under bold sub-headings as needed (e.g., **Immediate (within 24h):**, **Short-term (within 1 week):**). Include things like:

- Terminating specific idle-in-transaction sessions — provide exact `SELECT pg_terminate_backend(<pid>);` lines.
- Application-side fixes (e.g., HikariCP/PgBouncer idle-in-transaction kill timeout).
- Manual `VACUUM (FREEZE, VERBOSE) <table>;` on at-age tables.
- `ANALYZE` on tables with stale autoanalyze.
- `EXPLAIN (ANALYZE, BUFFERS)` to capture for slow queries.
- Disabling unused extensions (e.g., pg_qualstats) — note this requires bundling with the RESTART batch and a final `DROP EXTENSION`.
- A single closing line on what NOT to do as first response (e.g., "Do NOT increase max_wal_size as a first response — only consider after the above; larger max_wal_size proportionally extends crash recovery time.") if applicable.

SQL blocks for `pg_terminate_backend`, `VACUUM (FREEZE, VERBOSE)`, etc. are allowed and encouraged in this section. ALTER SYSTEM commands are still banned everywhere.

**contentFormat:** `markdown`

---

## Environment Name Extraction

Parse from CSV filename: `health-check-pgprimary-core-0-<ENV_NAME>-<TIMESTAMP>.csv`

Example: `health-check-pgprimary-core-0-pnctusprodv2rg1eu2-20260430-051610_1.csv`
→ Environment: `pnctusprodv2rg1eu2`

| CSV filename pattern       | Environment label |
| -------------------------- | ----------------- |
| `pnctusprod`               | PNC_Tus           |
| `pnchelprod`               | PNC_Hel           |
| `wfcprod` / `wfcusprod`    | WFC               |
| `wfchsprod`                | WFC_HS            |
| `wfchs2prod`               | WFC_HS2           |
| `bnsprod`                  | BNS               |
| `ingprod`                  | ING               |
| `sbprod`                   | SB                |
| `tfcprod`                  | TFC               |
| `dsjprod`                  | DSJ               |
| `usbprod`                  | USB               |
| `cibcprod` / `cibccpeprod` | CIBC_CPE          |
| `cibcieprod`               | CIBC_IE           |
| `cibcdboprod`              | CIBC_DBO          |
| `cibczrpeprod`             | CIBC_ZRPE         |
| `cibcpdmprod`              | CIBC_PDM          |
| `anbenprod` / `benprod`    | BEN               |
| `ccsprod`                  | CCS               |
| `uniprod`                  | UNI               |
| `anzprod`                  | ANZ               |
| `eiprod`                   | EI                |
| `mtbprod`                  | MTB               |
| `enbdretprod` / `enbdprod` | ENBD_RET          |
| `famfprod`                 | FamF              |
| `adcbprod`                 | ADCB              |
| `hsbcprod`                 | HSBC              |
| `citizensprod`             | Citizens          |
| `everprod`                 | EVER              |
| `cbaprod`                  | CBA               |
| `raboprod`                 | RABO              |
| `kiwiprod`                 | KIWI              |
| `nzanzprod`                | NZ_ANZ            |

---

## What to Cover — Checklist of Sections

Every output .md must cover all of these. Do NOT skip a section even if it looks clean — state that it's clean and give the key number.

1. Severity Summary (CRITICAL / WARNING / MONITOR / OK)
2. Connection counts (current, max, active/idle/idle-in-tx breakdown)
3. Long-running queries (top offenders by avg time, any > 30s)
4. Open transactions (anything > 5 min, especially idle-in-transaction with heartbeat bypass explanation if applicable)
5. Bloat analysis (disk-level %, worst tables, deduplicated, pg_statistic if severe)
6. Dead tuples / autovacuum health (worst tables, stale autoanalyze flags, active worker index_vacuum_count analysis)
7. Wraparound (max value, which table, distance from ALL five thresholds)
8. Checkpoint analysis (forced vs timed ratio, I/O times, wal_level/max_wal_senders/archive_mode context, bgwriter contribution)
9. WAL size (with infrastructure context)
10. Deadlocks / Blocking sessions (NOWAIT pattern cross-reference if applicable)
11. Rollback ratio (with absolute rates; NOWAIT correlation if applicable)
12. PostgreSQL parameter validation (spec-dependent if SKU known; wal_buffers/min_wal_size/data_checksums always)
13. Huge pages status (WARNING if huge_pages=off and shared_buffers >= 1 GB; CRITICAL if shared_buffers > 100 GB; always include pod YAML hugepages-2Mi value and HUGEPAGES_2M env var in next steps)
14. Database size
15. Missing metrics gaps (flag what's absent from the CSV; provide SQL)
16. Items requiring external data (CPU/Memory/IOPS/Disk — list what's needed and how to get it)
17. Tiered next steps (IMMEDIATE / SHORT-TERM / MEDIUM-TERM / ONGOING MONITORING)

---

## Common Mistakes to Avoid

1. **Do not skip sections because the data looks clean.** Write the value and mark it OK. The reader needs to know you checked it.

2. **Do not produce vague findings.** "Bloat is elevated" is useless. "Disk-level bloat is 14.3%; worst table: zrpe.mi_work_chunk, tbloat=209.8, ~917 MB wasted of ~921 MB total" is what's needed.

3. **Do not write next steps without the actual SQL or kubectl command.** Vague advice like "consider running VACUUM" is not actionable. Provide the exact command.

4. **Do not derive Cores or Memory from settings.** If specs are missing, mark Parameter Validation as "AWAITING SKU INPUT" and validate only the three absolute checks (wal_buffers, min_wal_size, data_checksums).

5. **Do cross-reference sections and state causal chains.** Bloated tables + high autovacuum_count + index_vacuum_count=0 + idle-in-transaction sessions = XID horizon pinned by open transaction, not an autovacuum configuration problem. Write out the chain.

6. **Do include absolute numbers alongside ratios.** A 25% rollback ratio on 40 transactions is noise. 25% of 255M transactions over 23 days (31.2 rollbacks/sec) is a serious issue. Always include both.

7. **Do apply actual Zafin SOP thresholds.** Use the thresholds in this skill and the `postgresql-config` skill. Do not flag Zafin standard constants as problems.

8. **Do not recommend autovacuum configuration changes when the root cause is a pinned XID horizon.** When index_vacuum_count=0 on active workers, autovacuum is working correctly — the XID horizon is blocking reclaim. Fix the sessions, not the autovacuum config.

9. **Do not recommend increasing max_wal_size as the first response to high forced checkpoints.** Follow the remediation order: sessions → wal_buffers → min_wal_size → max_wal_size (last resort). Always state the RTO trade-off when recommending max_wal_size increase.

10. **Do not use icons, emoji, or colored symbols in the output.** Use CRITICAL, WARNING, OK, MONITOR, PASS, FAIL as plain text labels.

11. **Do not leave missing metrics unacknowledged.** If deadlock counts, database size, or replication slot status are absent from the CSV, flag the gap explicitly and provide the SQL to add to future runs.

12. **Do not omit huge_pages=off from the parameter table or the Jira ticket.** If huge_pages is off on a production system with shared_buffers >= 1 GB, it must appear as an explicit WARNING row in both the .md parameter table and the Jira ticket's warning issues table. Always include the pod YAML hugepages-2Mi value (CEIL(shared_buffers_GiB × 1.1)Gi) and the HUGEPAGES_2M env var value (hugepages_GiB × 1024 / 2) in next steps. Do not talk about THP.
