import { readFileSync } from 'fs';
import path from 'path';

export interface HealthCheckSection {
  id: string;
  displayName: string;
  description: string;
  sql: string;
}

/**
 * Header text in `apps/dbagent/healthcheck/queries.sql` → stable id, friendly name, LLM-facing description.
 * Adding a section is a one-row edit + a new section in queries.sql with the matching header.
 */
const CATALOG: Array<{ header: string; id: string; displayName: string; description: string }> = [
  {
    header: 'Active long running queries',
    id: 'active_long_running_queries',
    displayName: 'Active Long-Running Queries',
    description:
      'Currently executing queries: PID, state, duration since start, application, user, database, and first 100 chars of SQL — surfaces ongoing performance issues.'
  },
  {
    header: 'Past long running queries',
    id: 'slow_queries_history',
    displayName: 'Top 10 Slowest Historical Queries',
    description:
      'Average and total exec time per statement from pg_stat_statements — identifies persistent expensive workloads, not just current snapshots.'
  },
  {
    header: 'Dead tuples',
    id: 'dead_tuples',
    displayName: 'Dead-Tuple Bloat per Table',
    description:
      'Per-table dead vs live row counts plus dead/live ratio — flags tables needing vacuum or accumulating bloat.'
  },
  {
    header: 'Blocking sessions',
    id: 'blocking_sessions',
    displayName: 'Blocking Lock Tree',
    description: 'Who is blocking whom, with PIDs, query text, and lock types — diagnoses deadlocks and contention.'
  },
  {
    header: 'Progress',
    id: 'maintenance_progress',
    displayName: 'Background Maintenance Progress',
    description:
      'Live snapshot of pg_stat_progress_* views (vacuum, analyze, copy, create_index) — shows what is running right now.'
  },
  {
    header: 'Wraparound',
    id: 'wraparound_risk',
    displayName: 'Transaction ID Wraparound Risk',
    description: 'Per-database age(datfrozenxid) — alerts when approaching the 2-billion transaction wraparound limit.'
  },
  {
    header: 'Autovaccum parameters',
    id: 'autovacuum_config',
    displayName: 'Autovacuum Configuration',
    description: 'Current autovacuum_* setting values — verifies tuning matches workload and Zafin SOP.'
  },
  {
    header: 'Checkpoint',
    id: 'checkpoint_stats',
    displayName: 'Checkpoint Activity & Tuning',
    description: 'pg_stat_bgwriter counters and timing — indicates whether checkpoints are well-spaced or stressed.'
  },
  {
    header: 'WAL',
    id: 'wal_rate',
    displayName: 'WAL Generation Rate',
    description: 'Bytes-per-time-window of WAL written — informs max_wal_size and checkpoint_timeout tuning.'
  },
  {
    header: 'Rollback ratio',
    id: 'rollback_ratio',
    displayName: 'Transaction Rollback Ratio',
    description: 'Rollbacks vs commits per database — high ratios signal application errors or contention.'
  }
];

const HEADER_RE = /^[A-Z][a-zA-Z ]+:$/;

let cached: HealthCheckSection[] | null = null;

function getQueriesPath(): string {
  // In dev (next dev), cwd is apps/dbagent. In Docker the file ships alongside.
  return path.join(process.cwd(), 'healthcheck', 'queries.sql');
}

function stripPsqlMeta(sql: string): string {
  // Drop psql meta-commands like \o /tmp/foo.csv and bare \o — they are interpreter-level, not pg_query.
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .trim();
}

function parseSections(raw: string): Map<string, string> {
  const lines = raw.split(/\r?\n/);
  const sections = new Map<string, string>();

  let currentHeader: string | null = null;
  let currentBuffer: string[] = [];

  const flush = () => {
    if (currentHeader === null) return;
    sections.set(currentHeader, stripPsqlMeta(currentBuffer.join('\n')));
  };

  for (const line of lines) {
    if (HEADER_RE.test(line.trim())) {
      flush();
      currentHeader = line.trim().replace(/:$/, '');
      currentBuffer = [];
    } else if (currentHeader !== null) {
      currentBuffer.push(line);
    }
  }
  flush();

  return sections;
}

export function loadHealthCheckSections(): HealthCheckSection[] {
  if (cached) return cached;
  const raw = readFileSync(getQueriesPath(), 'utf8');
  const sections = parseSections(raw);

  cached = CATALOG.map(({ header, id, displayName, description }) => {
    const sql = sections.get(header);
    if (!sql) {
      throw new Error(
        `[healthcheck] queries.sql is missing the section "${header}:" expected for id="${id}". Verify the file ships with the agent.`
      );
    }
    return { id, displayName, description, sql };
  });

  return cached;
}

export function getHealthCheckSection(id: string): HealthCheckSection | undefined {
  return loadHealthCheckSections().find((s) => s.id === id);
}

export function listHealthCheckSectionMeta(): Array<Pick<HealthCheckSection, 'id' | 'displayName' | 'description'>> {
  return loadHealthCheckSections().map(({ id, displayName, description }) => ({ id, displayName, description }));
}
