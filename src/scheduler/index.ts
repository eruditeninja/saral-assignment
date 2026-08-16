import { CronExpressionParser } from 'cron-parser';
import prisma from '../shared/prisma';
import { logger } from '../shared/logger';

const SCHEDULER_POLL_INTERVAL_MS = 30_000; // 30 seconds
const BATCH_SIZE = 50;

interface RawJobRow {
  id: string;
  job_type: string;
  job_value: string;
  file_name: string;
  payload: any;
  active: boolean;
  next_run_at: Date;
  created_at: Date;
}

export async function pollAndScheduleJobs(): Promise<number> {
  let scheduledCount = 0;

  try {
    await prisma.$transaction(async (tx: any) => {
      const jobs = await tx.$queryRaw<RawJobRow[]>`
        SELECT id, job_type, job_value, file_name, payload, active, next_run_at, created_at
        FROM jobs
        WHERE active = true AND next_run_at <= (NOW() AT TIME ZONE 'UTC')
        ORDER BY next_run_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED;
      `;

      if (!jobs || jobs.length === 0) {
        return;
      }

      for (const job of jobs) {
        try {
          // 2. Create JobRun entry snapshotting job state
          await tx.jobRun.create({
            data: {
              jobId: job.id,
              nextRunAt: job.next_run_at,
              payload: job.payload,
              relayStatus: 'PENDING',
              relayRetryCount: 0,
              status: 'QUEUED',
            },
          });

          // 3. Update the job's next_run_at or deactivate if once
          if (job.job_type === 'once') {
            await tx.job.update({
              where: { id: job.id },
              data: { active: false },
            });
            logger.info({ jobId: job.id }, 'Once-job fired and deactivated');
          } else {
            // Recurring job: compute next nextRunAt from current time (floating schedule / missed tick recovery)
            const interval = CronExpressionParser.parse(job.job_value, {
              currentDate: new Date(),
              tz: 'UTC',
            });
            let nextDate = interval.next().toDate();
            while (nextDate <= new Date()) {
              nextDate = interval.next().toDate();
            }

            await tx.job.update({
              where: { id: job.id },
              data: { nextRunAt: nextDate },
            });
            logger.info(
              { jobId: job.id, prevRunAt: job.next_run_at, nextRunAt: nextDate },
              'Recurring job scheduled next tick'
            );
          }

          scheduledCount++;
        } catch (jobError: any) {
          // If unique constraint (jobId, nextRunAt) fails on jobRun creation, it was already scheduled
          if (jobError?.code === 'P2002') {
            logger.warn(
              { jobId: job.id, nextRunAt: job.next_run_at },
              'JobRun already exists for this tick, skipping'
            );
          } else {
            logger.error({ error: jobError, jobId: job.id }, 'Error processing scheduled job');
          }
        }
      }
    });
  } catch (error) {
    logger.error({ error }, 'Error in scheduler poll tick');
  }

  return scheduledCount;
}

let isSchedulerRunning = false;
let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Starts the scheduler loop running at 30-second intervals.
 */
export function startScheduler(pollIntervalMs: number = SCHEDULER_POLL_INTERVAL_MS): void {
  if (isSchedulerRunning) {
    logger.warn('Scheduler is already running');
    return;
  }

  isSchedulerRunning = true;
  logger.info({ pollIntervalMs }, 'Starting scheduler poll loop');

  const runLoop = async () => {
    if (!isSchedulerRunning) return;
    try {
      await pollAndScheduleJobs();
    } catch (err) {
      logger.error({ error: err }, 'Unexpected error in scheduler loop execution');
    } finally {
      if (isSchedulerRunning) {
        schedulerTimer = setTimeout(runLoop, pollIntervalMs);
      }
    }
  };

  // Run immediately on start, then schedule next
  runLoop();
}

/**
 * Stops the scheduler loop.
 */
export function stopScheduler(): void {
  isSchedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  logger.info('Scheduler stopped');
}
