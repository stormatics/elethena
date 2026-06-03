/* eslint-disable no-process-env */
const SCHEDULER_TICK_INTERVAL_SECONDS = parseInt(
  process.env.SCHEDULER_TICK_INTERVAL_SECONDS || (process.env.NODE_ENV === 'production' ? '60' : '10'),
  10
);
const PORT = process.env.PORT || 4001;

const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;
if (!SCHEDULER_SECRET) {
  console.error('SCHEDULER_SECRET is required to call /api/priv/schedule-tick. Set it in .env.local.');
  process.exit(1);
}

async function tick() {
  try {
    const response = await fetch(`http://localhost:${PORT}/api/priv/schedule-tick`, {
      method: 'POST',
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET as string }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log('Scheduler tick completed successfully');
  } catch (error) {
    console.error('Error in scheduler tick:', error);
  }
}

// Read interval from environment (in seconds), default to 10 seconds
// Convert seconds to milliseconds for setInterval
const intervalMs = SCHEDULER_TICK_INTERVAL_SECONDS * 1000;
console.log(`Starting scheduler with ${SCHEDULER_TICK_INTERVAL_SECONDS}s interval (${intervalMs}ms)`);

setInterval(tick, intervalMs);
