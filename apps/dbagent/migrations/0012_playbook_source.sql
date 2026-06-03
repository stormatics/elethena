-- Track whether a playbook row was synced from a skill file on disk vs hand-authored in the UI.
-- 'custom' = user-authored, 'skill' = synced from apps/dbagent/skills/*.md, 'builtin' is implicit.
ALTER TABLE "playbooks" ADD COLUMN "source" text NOT NULL DEFAULT 'custom';

--> statement-breakpoint
-- Pretty label shown in UI; null falls back to name. Derived from skill H1 on sync.
ALTER TABLE "playbooks" ADD COLUMN "display_name" text;

--> statement-breakpoint
CREATE INDEX "idx_playbooks_source" ON "playbooks"("source");
