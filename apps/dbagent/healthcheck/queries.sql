Active long running queries:
select
    pid,
    state,
    xact_start,
    backend_start,
    query_start,
    now() - query_start as Query_duration,
    backend_type,
    application_name,
    usename,
    datname,
    substring(query, 1, 100)
from
    pg_stat_activity
order by
    Query_duration;

Past long running queries:

\o /tmp/long-running.csv

select
    substring(query, 1, 100) as query,
    round((total_exec_time / 1000) :: numeric, 2) as total_exec_time_s,
    calls,
    round(((total_exec_time / calls) / 1000) :: numeric, 2) as avg_exec_time_s
from
    pg_stat_statements
order by
    avg_exec_time_s desc
limit
    10;

\o  

Dead tuples:

SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(
        CASE
            WHEN n_live_tup = 0 THEN NULL
            ELSE (n_dead_tup :: numeric / n_live_tup)
        END,
        6
    ) AS dead_to_live_ratio,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(
        (
            pg_relation_size(relid) * (
                n_dead_tup :: numeric / NULLIF(n_live_tup + n_dead_tup, 0)
            )
        ) :: bigint
    ) AS est_dead_space,
    ROUND(
        100 * (
            n_dead_tup :: numeric / NULLIF(n_live_tup + n_dead_tup, 0)
        ),
        2
    ) AS dead_tuple_pct
FROM
    pg_stat_user_tables
ORDER BY
    n_dead_tup DESC
LIMIT
    100;


Index / table bloat:

SELECT
    current_database(),
    schemaname,
    tablename,
    ROUND(
        (
            CASE
                WHEN otta = 0 THEN 0.0
                ELSE sml.relpages :: float / otta
            END
        ) :: numeric,
        1
    ) AS tbloat,
    CASE
        WHEN relpages < otta THEN 0
        ELSE bs *(sml.relpages - otta) :: BIGINT
    END AS wastedbytes,
    iname,
    ROUND(
        (
            CASE
                WHEN iotta = 0
                OR ipages = 0 THEN 0.0
                ELSE ipages :: float / iotta
            END
        ) :: numeric,
        1
    ) AS ibloat,
    CASE
        WHEN ipages < iotta THEN 0
        ELSE bs *(ipages - iotta)
    END AS wastedibytes
FROM
    (
        SELECT
            schemaname,
            tablename,
            cc.reltuples,
            cc.relpages,
            bs,
            CEIL(
                (
                    cc.reltuples *(
                        (
                            datahdr + ma - (
                                CASE
                                    WHEN datahdr % ma = 0 THEN ma
                                    ELSE datahdr % ma
                                END
                            )
                        ) + nullhdr2 + 4
                    )
                ) /(bs -20 :: float)
            ) AS otta,
            COALESCE(c2.relname, '?') AS iname,
            COALESCE(c2.reltuples, 0) AS ituples,
            COALESCE(c2.relpages, 0) AS ipages,
            COALESCE(
                CEIL((c2.reltuples *(datahdr -12)) /(bs -20 :: float)),
                0
            ) AS iotta
        FROM
            (
                SELECT
                    ma,
                    bs,
                    schemaname,
                    tablename,
                    (
                        datawidth +(
                            hdr + ma -(
                                case
                                    when hdr % ma = 0 THEN ma
                                    ELSE hdr % ma
                                END
                            )
                        )
                    ) :: numeric AS datahdr,
                    (
                        maxfracsum *(
                            nullhdr + ma -(
                                case
                                    when nullhdr % ma = 0 THEN ma
                                    ELSE nullhdr % ma
                                END
                            )
                        )
                    ) AS nullhdr2
                FROM
                    (
                        SELECT
                            schemaname,
                            tablename,
                            hdr,
                            ma,
                            bs,
                            SUM((1 - null_frac) * avg_width) AS datawidth,
                            MAX(null_frac) AS maxfracsum,
                            hdr +(
                                SELECT
                                    1 + count(*) / 8
                                FROM
                                    pg_stats s2
                                WHERE
                                    null_frac <> 0
                                    AND s2.schemaname = s.schemaname
                                    AND s2.tablename = s.tablename
                            ) AS nullhdr
                        FROM
                            pg_stats s,
                            (
                                SELECT
                                    (
                                        SELECT
                                            current_setting('block_size') :: numeric
                                    ) AS bs,
                                    CASE
                                        WHEN substring(v, 12, 3) IN ('8.0', '8.1', '8.2') THEN 27
                                        ELSE 23
                                    END AS hdr,
                                    CASE
                                        WHEN v ~ 'mingw32' THEN 8
                                        ELSE 4
                                    END AS ma
                                FROM
                                    (
                                        SELECT
                                            version() AS v
                                    ) AS foo
                            ) AS constants
                        GROUP BY
                            1,
                            2,
                            3,
                            4,
                            5
                    ) AS foo
            ) AS rs
            JOIN pg_class cc ON cc.relname = rs.tablename
            JOIN pg_namespace nn ON cc.relnamespace = nn.oid
            AND nn.nspname = rs.schemaname
            AND nn.nspname <> 'information_schema'
            LEFT JOIN pg_index i ON indrelid = cc.oid
            LEFT JOIN pg_class c2 ON c2.oid = i.indexrelid
    ) AS sml
WHERE
    schemaname IN ('zmrm_analytics', ' zplatform')
ORDER BY
    tbloat DESC NULLS LAST,
    ibloat DESC NULLS LAST,
    wastedbytes DESC,
    wastedibytes DESC;

Blocking sessions:

SELECT
    blocked.pid AS blocked_pid,
    blocked.query AS blocked_query,
    blocked_locks.locktype,
    blocked_locks.relation :: regclass,
    blocked_locks.page,
    blocked_locks.tuple,
    blocked_locks.transactionid,
    blocking.pid AS blocking_pid,
    blocking.query AS blocking_query
FROM
    pg_locks blocked_locks
    JOIN pg_stat_activity blocked ON blocked_locks.pid = blocked.pid
    JOIN pg_locks blocking_locks ON (
        blocking_locks.locktype = blocked_locks.locktype
        AND blocking_locks.database IS NOT DISTINCT
        FROM
            blocked_locks.database
            AND blocking_locks.relation IS NOT DISTINCT
        FROM
            blocked_locks.relation
            AND blocking_locks.page IS NOT DISTINCT
        FROM
            blocked_locks.page
            AND blocking_locks.tuple IS NOT DISTINCT
        FROM
            blocked_locks.tuple
            AND blocking_locks.virtualxid IS NOT DISTINCT
        FROM
            blocked_locks.virtualxid
            AND blocking_locks.transactionid IS NOT DISTINCT
        FROM
            blocked_locks.transactionid
            AND blocking_locks.classid IS NOT DISTINCT
        FROM
            blocked_locks.classid
            AND blocking_locks.objid IS NOT DISTINCT
        FROM
            blocked_locks.objid
            AND blocking_locks.objsubid IS NOT DISTINCT
        FROM
            blocked_locks.objsubid
    )
    AND blocking_locks.granted = true
    JOIN pg_stat_activity blocking ON blocking_locks.pid = blocking.pid
WHERE
    NOT blocked_locks.granted;

Autovacuum processes: stats:

SELECT
    ns.nspname AS schema,
    c.relname AS table,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
    s.n_live_tup,
    s.n_dead_tup,
    round(
        100.0 * s.n_dead_tup / NULLIF(s.n_live_tup + s.n_dead_tup, 0),
        2
    ) AS dead_pct,
    s.last_vacuum,
    s.last_autovacuum,
    s.last_analyze,
    s.last_autoanalyze,
    s.vacuum_count,
    s.autovacuum_count,
    s.analyze_count,
    s.autoanalyze_count
FROM
    pg_stat_user_tables s
    JOIN pg_class c ON c.oid = s.relid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE
    c.relkind = 'r'
ORDER BY
    s.n_dead_tup DESC
LIMIT
    50;

Progress:

SELECT
    *
FROM
    pg_stat_progress_vacuum;

SELECT
    pid,
    now() - xact_start AS runtime,
    datname,
    query
FROM
    pg_stat_activity
WHERE
    query ILIKE 'autovacuum:%'
ORDER BY
    runtime DESC;

Wraparound:

SELECT
    ns.nspname AS schema,
    c.relname AS table,
    age(c.relfrozenxid) AS xid_age
FROM
    pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE
    c.relkind = 'r'
ORDER BY
    age(c.relfrozenxid) DESC
LIMIT
    50;

Autovaccum parameters:
 SHOW autovacuum;

SHOW autovacuum_max_workers;

SHOW autovacuum_naptime;

SHOW autovacuum_vacuum_threshold;

SHOW autovacuum_vacuum_scale_factor;

SHOW autovacuum_analyze_threshold;

SHOW autovacuum_analyze_scale_factor;

SHOW autovacuum_vacquum_cost_limit;

SHOW autovacuum_vacuum_cost_delay;

SHOW track_counts;

Checkpoint:

SELECT
    now() AS observed_at,
    stats_reset,
    checkpoints_timed,
    checkpoints_req,
    (checkpoints_timed + checkpoints_req) AS checkpoints_total,
    checkpoint_write_time,
    checkpoint_sync_time,
    buffers_checkpoint,
    buffers_clean,
    maxwritten_clean,
    buffers_backend,
    buffers_backend_fsync,
    buffers_alloc
FROM
    pg_stat_bgwriter;

WAL:

select
    count(*) as count
from
    pg_ls_waldir();

du - sh pg_wal/ 

Rollback ratio:

SELECT
    datname,
    xact_commit,
    xact_rollback,
    round(
        100.0 * xact_rollback / nullif(xact_commit + xact_rollback, 0),
        2
    ) AS rollback_ratio_percent
FROM
    pg_stat_database
WHERE
    datname NOT IN ('template0', 'template1')
ORDER BY
    rollback_ratio_percent DESC;

wraparound + autovaccum:

SELECT
    current_database() AS database_name,
    n.nspname AS schema_name,
    c.relname AS table_name,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS table_size,
    s.n_live_tup AS live_tuples,
    s.n_dead_tup AS dead_tuples,
    s.last_vacuum,
    s.last_autovacuum,
    s.last_analyze,
    s.last_autoanalyze,
    age(c.relfrozenxid) AS wraparound_age,
    s.vacuum_count,
    s.autovacuum_count
FROM
    pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_all_tables s ON c.oid = s.relid
WHERE
    c.relkind = 'r'
    AND n.nspname = 'zplatform'
ORDER BY
    age(c.relfrozenxid) DESC;