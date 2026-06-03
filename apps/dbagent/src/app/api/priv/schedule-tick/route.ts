import { env } from '~/lib/env/server';
import { checkAndRunJobsAsAdmin } from '~/lib/monitoring/scheduler';

export async function POST(req: Request) {
  const expected = env.SCHEDULER_SECRET;
  if (!expected) {
    return new Response('Scheduler is not configured (set SCHEDULER_SECRET)', { status: 503 });
  }
  const supplied = req.headers.get('x-scheduler-secret');
  if (!supplied || supplied !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  await checkAndRunJobsAsAdmin();
  return new Response('OK', { status: 200 });
}
