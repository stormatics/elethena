import { tool, Tool } from 'ai';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  getHealthCheckSection,
  HealthCheckSection,
  listHealthCheckSectionMeta,
  loadHealthCheckSections
} from '~/lib/healthcheck/queries';
import { AuditContext } from '~/lib/targetdb/audit';
import { withAuditedReadOnlyConnection } from '~/lib/targetdb/db';

interface SectionResult {
  id: string;
  displayName: string;
  rows: unknown[];
  totalRowCount?: number; // set when rows were truncated
  error?: string;
}

const SECTION_TIMEOUT_MS = 60_000;
// Cap rows per section sent back to the LLM. The full row set on a real DB
// can be hundreds of rows × dozens of columns — that's thousands of tokens
// per section, 10 sections per runFullHealthCheck call. Top N is plenty for
// SOP-driven analysis.
const ROWS_PER_SECTION_CAP = 50;

// Build the catalog string once (per server boot). All three tool descriptions
// reference this same string instead of re-rendering the table 3x per request.
const SECTION_CATALOG_TEXT = listHealthCheckSectionMeta()
  .map((s) => `- ${s.id} (${s.displayName}): ${s.description}`)
  .join('\n');

async function runOneSection(pool: Pool, audit: AuditContext, section: HealthCheckSection): Promise<SectionResult> {
  try {
    const result = await withAuditedReadOnlyConnection(pool, audit, async (client) => await client.query(section.sql), {
      statementTimeoutMs: SECTION_TIMEOUT_MS
    });
    const fullCount = result.rows.length;
    const rows = fullCount > ROWS_PER_SECTION_CAP ? result.rows.slice(0, ROWS_PER_SECTION_CAP) : result.rows;
    return {
      id: section.id,
      displayName: section.displayName,
      rows,
      ...(fullCount > ROWS_PER_SECTION_CAP ? { totalRowCount: fullCount } : {})
    };
  } catch (err) {
    return {
      id: section.id,
      displayName: section.displayName,
      rows: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function getHealthCheckToolset({
  targetDb,
  audit
}: {
  targetDb: Pool;
  audit: AuditContext;
}): Record<string, Tool> {
  return {
    listHealthCheckSections: tool({
      description:
        `Return the catalog of PostgreSQL health-check sections available against the target DB. ` +
        `Each entry has a stable id (use with runHealthCheckSection), a display name, and a description. ` +
        `Sections:\n${SECTION_CATALOG_TEXT}`,
      parameters: z.object({}),
      execute: async () => listHealthCheckSectionMeta()
    }),

    runHealthCheckSection: tool({
      description:
        `Run one named section of the health check against the target Postgres (read-only transaction, 60s timeout). ` +
        `Returns { id, displayName, rows } or { ..., error } on failure. ` +
        `Available section ids are listed in listHealthCheckSections.`,
      parameters: z.object({
        id: z.string().describe('Stable section id, e.g. "dead_tuples" or "wraparound_risk".')
      }),
      execute: async ({ id }) => {
        const section = getHealthCheckSection(id);
        if (!section) {
          return {
            id,
            displayName: id,
            rows: [],
            error: `Unknown health-check section id: ${id}. Use listHealthCheckSections to see valid ids.`
          };
        }
        return runOneSection(targetDb, audit, section);
      }
    }),

    runFullHealthCheck: tool({
      description:
        `Run the full health check: every section in the catalog, in parallel, against the target Postgres (read-only, 60s per section). ` +
        `Returns an array of { id, displayName, rows, error? }. Best for scheduled / periodic runs.`,
      parameters: z.object({}),
      execute: async () => {
        const sections = loadHealthCheckSections();
        // Parallel execution — each section gets its own short-lived read-only connection.
        return Promise.all(sections.map((s) => runOneSection(targetDb, audit, s)));
      }
    })
  };
}
