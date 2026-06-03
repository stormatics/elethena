-- Consolidates F-A cleanup + target-DB audit log + scheduler perf index +
-- per-connection node specs. Single migration to keep deploys atomic.

-- 1. Drop skill-sourced playbook rows (built-in versions now live in code).
DELETE FROM "playbooks" WHERE "source" = 'skill';

--> statement-breakpoint
-- 2. Drop the source / display_name columns from playbooks (F-A: only built-in vs custom).
DROP INDEX IF EXISTS "idx_playbooks_source";

--> statement-breakpoint
ALTER TABLE "playbooks" DROP COLUMN IF EXISTS "source";

--> statement-breakpoint
ALTER TABLE "playbooks" DROP COLUMN IF EXISTS "display_name";

--> statement-breakpoint
-- 3. Composite index for scheduler tick: WHERE enabled AND next_run <= NOW().
CREATE INDEX IF NOT EXISTS "idx_schedules_enabled_next_run"
  ON "schedules" ("enabled", "next_run")
  WHERE "enabled" = true;

--> statement-breakpoint
-- 4. Per-connection node specs (used by the postgresql-config playbook so the
--    LLM doesn't have to re-ask Cores / Memory every run).
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "cores" integer;

--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "memory_gib" integer;

--> statement-breakpoint
-- 5. Append-only audit log of every statement run against a target DB.
CREATE TABLE IF NOT EXISTS "target_db_audit" (
  "id"            bigserial PRIMARY KEY,
  "user_id"       text NOT NULL,
  "project_id"    uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "origin"        text NOT NULL,  -- 'chat' | 'schedule' | 'healthcheck' | 'manual'
  "sql_text"      text NOT NULL,
  "sql_params"    jsonb,
  "rows"          integer,
  "started_at"    timestamp NOT NULL DEFAULT now(),
  "duration_ms"   integer,
  "error"         text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_target_db_audit_started"
  ON "target_db_audit" ("started_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_target_db_audit_conn"
  ON "target_db_audit" ("connection_id", "started_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_target_db_audit_project"
  ON "target_db_audit" ("project_id", "started_at" DESC);
