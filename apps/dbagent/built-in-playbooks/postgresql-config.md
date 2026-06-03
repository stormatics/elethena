---
name: postgresql-config
description: "Zafin PostgreSQL configuration parameter calculator and huge pages setup guide. Use this skill whenever the task involves PostgreSQL tuning, parameter calculation, postgresql.conf generation, shared_buffers sizing, huge pages configuration, THP (Transparent Huge Pages) disabling, Kubernetes StatefulSet memory limits for Postgres, or any mention of Zafin DB node setup. Also trigger when the user provides CPU cores and memory and wants Postgres config values, or asks about autovacuum tuning, work_mem sizing, WAL configuration, or effective_cache_size. Even if the user just says 'calculate postgres params' or 'configure the DB node', use this skill."
---

# Zafin PostgreSQL Configuration Skill

This skill contains the canonical formulas and constant values used at Zafin to configure PostgreSQL on Kubernetes. All values are derived from two inputs: **Cores** (vCPUs) and **Memory** (total RAM in GiB allocated to the DB pod).

> **Important**: This is not the complete parameter list. Additional parameters are documented in Confluence: https://zafinworks.atlassian.net/wiki/x/cYCZJwE

---

## OUTPUT STRUCTURE (MANDATORY)

When producing a configuration recommendation, the reply MUST be a single Markdown document with exactly these top-level sections in this order, written in the voice of a senior DBA. Do **not** dump raw calculation logs. Do **not** repeat the same numbers in three formats. Do **not** add status icons or emoji.

1. **Hardware Profile & Base Constants** — a 3-column table (Constant | Value | Notes) listing Cores, Memory, MAX_CONN choice, storage type, workload type, and any other inputs the user gave.
2. **Memory Settings** — explanatory prose for each parameter (1–2 sentences on _why_ the formula is what it is), then a fenced `ini` code block listing the final `postgresql.conf` lines for memory.
3. **Connections and Parallelism** — same structure: prose then a fenced code block. Include a sub-table for workload-specific `max_parallel_workers_per_gather` (OLTP / Mixed / OLAP).
4. **WAL and Checkpoints** — prose + fenced code block.
5. **Autovacuum** — prose + fenced code block. Call out Zafin's choice of `vacuum_scale_factor = 0.05`, `analyze_scale_factor = 0.02`, `cost_limit = 4000` explicitly.
6. **Planner & I/O** — prose + fenced code block (`random_page_cost`, `effective_io_concurrency`, etc.).
7. **Logging** — prose + fenced code block.
8. **Final Consolidated Parameter Table** — ONE Markdown table with columns `Parameter | Formula | Computed | Final Value | Hot-reloadable?`. EVERY parameter recommended above appears here exactly once. This is the table the user will copy into a JIRA ticket.
9. **Huge Pages & Pod-Level Setup** — a dedicated section, separate from the postgresql.conf parameters. Cover:
   - The OS-level **huge page count** formula (`(shared_buffers + 10% overhead) / 2 MiB`) and the resulting reservation in GiB
   - **Disabling THP** (Transparent Huge Pages): the exact `tuned`/`grub`/sysctl commands
   - **Kubernetes StatefulSet** memory limits + `hugepages-2Mi` resource request that mirrors the reservation
   - A fenced `bash` block with the verify-on-pod commands (`cat /proc/meminfo | grep -i huge`, etc.)
10. **Final `postgresql.conf` Snippet** — a single complete fenced `ini` code block containing every parameter from section 8, in the same order, with section-divider comments (`# === Memory ===`, etc.). This is what a DBA pastes into the StatefulSet ConfigMap. Use proper newlines — every parameter on its own line.

### Formatting rules

- Every code block uses a fenced triple-backtick with a language hint (`ini` for postgres conf, `bash` for shell, `yaml` for k8s).
- Every parameter inside prose/tables is wrapped in backticks: `` `shared_buffers` ``.
- Tables use proper Markdown pipes WITH a header separator row (`|---|---|`). Never inline pipes without a header separator.
- Final values use units consistently: GiB for shared_buffers/cache/wal sizes, MB for work_mem/temp_buffers, ms for timeouts.

---

## Inputs

| Input      | Description                              | Example |
| ---------- | ---------------------------------------- | ------- |
| **Cores**  | Total vCPU count on the DB node          | 416     |
| **Memory** | Total RAM in GiB allocated to PostgreSQL | 3800    |

---

## Calculated Parameters (Formulas)

These parameters are **derived** from the Cores and Memory inputs. Always use these formulas — never hardcode values.

### Memory-based parameters

| Parameter              | Formula                                                                                       | Unit   | Notes                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| `shared_buffers`       | `ROUND(0.4 × Memory, 0)`                                                                      | GiB    | Must be ≤ 40% of available memory on DB node |
| `effective_cache_size` | `ROUND(IF(Memory ≤ 16, 0.75 × Memory, (0.8 × Memory) − 1), 0)`                                | GiB    |                                              |
| `work_mem`             | `ROUND(IF(Memory < 64, Memory × 1024 × 0.0025, MAX(162, (Memory × 1024 × 0.00125) + 80)), 0)` | **MB** | Unit is MB, not GiB                          |
| `maintenance_work_mem` | `ROUND(0.05 × Memory, 0)`                                                                     | GiB    |                                              |
| `max_wal_size`         | `ROUND(0.1 × Memory, 0)`                                                                      | GiB    |                                              |
| `autovacuum_work_mem`  | `ROUND((0.2 × Memory) / autovacuum_max_workers, 0)`                                           | GiB    | Depends on autovacuum_max_workers result     |

### CPU-based parameters

| Parameter                          | Formula                       | Notes        |
| ---------------------------------- | ----------------------------- | ------------ |
| `max_worker_processes`             | `2 × Cores`                   |              |
| `max_parallel_workers`             | `Cores`                       |              |
| `max_parallel_workers_per_gather`  | `MIN(0.5 × Cores, 4)`         | Capped at 4  |
| `max_parallel_maintenance_workers` | `MIN(0.5 × Cores, 8)`         | Capped at 8  |
| `autovacuum_max_workers`           | `ROUND(MAX(Cores / 8, 3), 0)` | Minimum of 3 |

---

## Constant Parameters (Fixed Values)

These parameters use **fixed values** regardless of hardware. Do not change them unless explicitly instructed.

| Parameter                             | Value    | Notes                        |
| ------------------------------------- | -------- | ---------------------------- |
| `checkpoint_timeout`                  | `30min`  |                              |
| `wal_buffers`                         | `-1`     | Let PostgreSQL auto-tune     |
| `checkpoint_completion_target`        | `0.9`    |                              |
| `random_page_cost`                    | `1.1`    |                              |
| `effective_io_concurrency`            | `200`    |                              |
| `autovacuum`                          | `on`     |                              |
| `autovacuum_naptime`                  | `30s`    |                              |
| `autovacuum_vacuum_threshold`         | `50`     |                              |
| `autovacuum_analyze_threshold`        | `50`     |                              |
| `autovacuum_vacuum_scale_factor`      | `0.05`   |                              |
| `autovacuum_analyze_scale_factor`     | `0.05`   |                              |
| `autovacuum_vacuum_cost_delay`        | `100ms`  |                              |
| `autovacuum_vacuum_cost_limit`        | `2000`   |                              |
| `log_autovacuum_min_duration`         | `1000ms` |                              |
| `logging_collector`                   | `on`     |                              |
| `idle_session_timeout`                | `2h`     | PostgreSQL 14+ only (vNext)  |
| `idle_in_transaction_session_timeout` | `23h`    |                              |
| `huge_pages`                          | `on`     | See Huge Pages section below |

---

## Huge Pages Configuration

Zafin standardizes on **2 MiB Huge Pages only**. Transparent Huge Pages (THP) must be **disabled** — PostgreSQL discourages THP due to latency and memory fragmentation.

### Why Huge Pages

- Reduced CPU overhead managing memory pages
- Lower latency and OOM risk
- Improved memory efficiency vs THP

### Pre-checks

Before enabling, verify on DB nodes:

```bash
kubectl describe node -l purpose=db
```

Look for `hugepages-2Mi` in the output. If both `hugepages-1Gi` and `hugepages-2Mi` show `0 (0%)`, huge pages are not enabled at the node level.

### Calculating Required Huge Pages

Formula:

```
shared_memory = shared_buffers + (5% headroom of shared_buffers)
HUGEPAGES_2M = CEIL(shared_memory_in_GiB × 512)
```

Example (740 GiB node, 700 GiB to PostgreSQL):

```
shared_buffers     = 0.4 × 700 = 280 GiB
shared_memory      = 280 + (0.05 × 280) = 294 GiB  (round to ~296 GiB)
HUGEPAGES_2M       = 296 × 512 = 151,552 pages  (round up as needed)
```

Alternative — query running PostgreSQL for actual shared memory:

```sql
SELECT pg_size_pretty(SUM(size)) AS total_shared_memory
FROM pg_shmem_allocations;
```

On PostgreSQL 15+, calculate without a running instance (requires PG to be stopped):

```bash
/usr/pgsql-15/bin/postgres --shared-buffers=<VALUE> -D $PGDATA -C shared_memory_size_in_huge_pages
```

### StatefulSet Resource Configuration

The `memory` limit and `hugepages-2Mi` are **separate** — huge pages are not counted in the memory limit. Set `memory` to the RAM you want PostgreSQL to use; do not reserve memory for UI or other workloads unless the deployment explicitly co-locates them on the DB node. The "~40 GiB UI reserve" that appears in some examples is illustrative for a specific deployment and is not a general rule.

```yaml
resources:
  limits:
    cpu: '<CPU_LIMIT>'
    hugepages-2Mi: <HUGEPAGES_GiB>Gi # e.g. 296Gi
    memory: <REMAINING_MEMORY>Gi # = total_pod_alloc - hugepages - ui_pod_reserve
  requests:
    cpu: '<CPU_REQUEST>'
    hugepages-2Mi: <HUGEPAGES_GiB>Gi
    memory: <MEMORY_REQUEST>Gi
```

### DaemonSet to Disable THP and Enable Huge Pages

Deploy this DaemonSet on all DB nodes. It writes the page count to the kernel, disables THP, and restarts kubelet.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hugepages-2m
  namespace: kube-system
spec:
  selector:
    matchLabels: { app: hugepages-2m }
  template:
    metadata:
      labels: { app: hugepages-2m }
    spec:
      hostPID: true
      priorityClassName: system-node-critical
      nodeSelector:
        kubernetes.azure.com/agentpool: dbnodes
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
      tolerations:
        - operator: 'Exists'
      containers:
        - name: configure
          image: ubuntu:22.04
          securityContext: { privileged: true }
          resources:
            requests: { cpu: 5m, memory: 16Mi }
          env:
            - name: HUGEPAGES_2M
              value: '<CALCULATED_PAGE_COUNT>'
          command:
            - /bin/bash
            - -c
            - |
              set -eux
              echo "${HUGEPAGES_2M}" > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
              if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
                echo never > /sys/kernel/mm/transparent_hugepage/enabled || true
              fi
              if [ -f /sys/kernel/mm/transparent_hugepage/defrag ]; then
                echo never > /sys/kernel/mm/transparent_hugepage/defrag || true
              fi
              nsenter -t 1 -m -u -i -n -p systemctl restart kubelet
              sleep infinity
          volumeMounts:
            - { name: sys, mountPath: /sys }
            - { name: proc, mountPath: /proc }
      volumes:
        - { name: sys, hostPath: { path: /sys } }
        - { name: proc, hostPath: { path: /proc } }
```

### Verification Checklist

1. **THP disabled**:

   ```bash
   cat /sys/kernel/mm/transparent_hugepage/enabled
   # Expect: always madvise [never]
   cat /proc/meminfo | grep -i AnonHugePages
   # Expect: AnonHugePages: 0 kB
   ```

2. **Node huge pages allocated**:

   ```bash
   kubectl describe node -l purpose=db
   # Expect: hugepages-2Mi showing ~100% allocation
   ```

3. **Inside PostgreSQL container**:
   ```bash
   grep -i hugepage /proc/meminfo
   # Expect: HugePages_Total > 0, HugePages_Free is low
   ```

---

## Example: Full Calculation for Cores=416, Memory=3800 GiB

| Parameter                          | Value    |
| ---------------------------------- | -------- |
| `shared_buffers`                   | 1520 GiB |
| `effective_cache_size`             | 3039 GiB |
| `work_mem`                         | 4830 MB  |
| `maintenance_work_mem`             | 190 GiB  |
| `max_wal_size`                     | 380 GiB  |
| `max_worker_processes`             | 832      |
| `max_parallel_workers`             | 416      |
| `max_parallel_workers_per_gather`  | 4        |
| `max_parallel_maintenance_workers` | 8        |
| `autovacuum_max_workers`           | 52       |
| `autovacuum_work_mem`              | 15 GiB   |
