import { CronExpressionParser } from 'cron-parser';
import { sql } from 'drizzle-orm';
import { incrementScheduleFailures, updateScheduleRunData } from '~/lib/db/schedules';
import { DBAccess, DBUserAccess, getAdminAccess } from '../db/db';
import { Schedule, ScheduleInsert } from '../db/schema';
import { env } from '../env/server';
import { runSchedule } from './runner';

export function utcToLocalDate(utcString: string): Date {
  const date = new Date(utcString);
  const offset = date.getTimezoneOffset() * 60000; // Convert offset to milliseconds
  return new Date(date.getTime() - offset);
}

export function scheduleGetNextRun(schedule: ScheduleInsert, now: Date): Date {
  if (schedule.scheduleType === 'cron' && schedule.cronExpression) {
    const interval = CronExpressionParser.parse(schedule.cronExpression);
    return interval.next().toDate();
  }
  if (schedule.scheduleType === 'automatic' && schedule.minInterval) {
    // TODO ask the model to get the interval, for now use the minInterval
    const nextRun = new Date(now.getTime() + schedule.minInterval * 1000);
    return nextRun;
  }
  return now;
}

export function shouldRunSchedule(schedule: Schedule, now: Date): boolean {
  if (schedule.enabled === false || !schedule.nextRun) return false;
  const nextRun = utcToLocalDate(schedule.nextRun);

  if (schedule.status !== 'scheduled') {
    if (
      schedule.status === 'running' &&
      nextRun.getTime() + env.TIMEOUT_FOR_RUNNING_SCHEDULE_SECS * 1000 < now.getTime()
    ) {
      console.log(`Schedule ${schedule.id} is running but timeout has expired, restarting`);
      // The process might have crashed while the schedule was running.
      // We should restart it.
      return true;
    }
    return false;
  }

  return now >= nextRun;
}

export async function checkAndRunJobsAsAdmin() {
  console.log('Checking and running jobs as admin');
  try {
    const adminAccess = getAdminAccess();
    const now = new Date();
    const timeoutSecs = env.TIMEOUT_FOR_RUNNING_SCHEDULE_SECS;
    const maxRuns = env.MAX_PARALLEL_RUNS;

    // Atomically claim up to MAX_PARALLEL_RUNS due schedules using FOR UPDATE
    // SKIP LOCKED. Each scheduler-tick (potentially across replicas) pulls a
    // distinct slice — no double-execution, no leader-election sidecar needed.
    // We mark them as 'running' inside the same transaction so they're
    // invisible to the next tick.
    const schedulesToRunNow = await adminAccess.query(async ({ db }) => {
      const result = await db.execute(sql<Schedule>`
        WITH due AS (
          SELECT id FROM schedules
          WHERE enabled = true
            AND (
              (status = 'scheduled' AND next_run <= ${now.toUTCString()}::timestamptz)
              OR (status = 'running' AND next_run + (${timeoutSecs} * INTERVAL '1 second') < ${now.toUTCString()}::timestamptz)
            )
          ORDER BY next_run ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${maxRuns}
        )
        UPDATE schedules s
        SET status = 'running'
        FROM due
        WHERE s.id = due.id
        RETURNING s.*;
      `);
      return (result.rows ?? []) as unknown as Schedule[];
    });

    if (schedulesToRunNow.length === 0) return;

    console.log(`Claimed ${schedulesToRunNow.length} schedule(s) this tick`);

    // Run claimed jobs in parallel, each with its own DBUserAccess instance.
    await Promise.all(
      schedulesToRunNow.map((schedule) => {
        const userAccess = new DBUserAccess(schedule.userId);
        return runJob(userAccess, schedule, now);
      })
    );
  } catch (error) {
    console.error('Error in scheduler:', error);
  }
}

async function runJob(dbAccess: DBAccess, schedule: Schedule, now: Date) {
  console.log(`Running playbook ${schedule.playbook} for schedule ${schedule.id}`);

  // Status is already 'running' (set atomically by the claim in checkAndRunJobsAsAdmin).
  try {
    await runSchedule(dbAccess, schedule, now);
  } catch (error) {
    console.error(`Error running playbook ${schedule.playbook}:`, error);
    await incrementScheduleFailures(dbAccess, schedule);
  }

  // Reset to 'scheduled' and recompute next_run (also in case of errors).
  schedule.status = 'scheduled';
  schedule.lastRun = now.toUTCString();
  schedule.nextRun = scheduleGetNextRun(schedule, now).toUTCString();
  await updateScheduleRunData(dbAccess, schedule);
  console.log(`Schedule ${schedule.id} → next_run ${schedule.nextRun}`);
}
