import 'server-only';
import { getAdminAccess } from '~/lib/db/db';
import { targetDbAudit } from '~/lib/db/schema';

export type AuditOrigin = 'chat' | 'schedule' | 'healthcheck' | 'manual';

export interface AuditContext {
  userId: string;
  projectId: string;
  connectionId: string;
  origin: AuditOrigin;
}

interface AuditRow {
  sqlText: string;
  sqlParams?: unknown;
  rows?: number;
  durationMs: number;
  error?: string;
}

/**
 * Fire-and-forget insert into target_db_audit. Errors are logged but never
 * propagate — we never let an audit failure abort a target-DB query.
 */
export function writeAudit(ctx: AuditContext, row: AuditRow): void {
  // Avoid awaiting: the caller has already returned to its caller by now.
  void (async () => {
    try {
      const dbAccess = getAdminAccess();
      await dbAccess.query(async ({ db }) => {
        await db.insert(targetDbAudit).values({
          userId: ctx.userId,
          projectId: ctx.projectId,
          connectionId: ctx.connectionId,
          origin: ctx.origin,
          sqlText: row.sqlText,
          sqlParams: row.sqlParams !== undefined ? (row.sqlParams as any) : null,
          rows: row.rows ?? null,
          durationMs: row.durationMs,
          error: row.error ?? null
        });
      });
    } catch (err) {
      console.error('[target-db-audit] failed to write audit row:', err);
    }
  })();
}
