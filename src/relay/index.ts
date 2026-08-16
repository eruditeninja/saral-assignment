import prisma from '../shared/prisma';
import { getQueueProvider, QUEUE_SYNC_JOBS } from '../shared/providers';
import { logger } from '../shared/logger';

const RELAY_POLL_INTERVAL_MS = 5_000; // 5 seconds
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;

interface RawJobRunRow {
  id: string;
  job_id: string;
  relay_status: string;
  relay_retry_count: number;
}

/**
 * Polls for PENDING job runs and pushes their IDs to the sync-jobs queue.
 * Handles durable retries up to 3 attempts.
 */
export async function pollAndRelayJobRuns(): Promise<number> {
  let processedCount = 0;
  const queue = getQueueProvider();

  try {
    // 1. Fetch PENDING job runs using SELECT ... FOR UPDATE SKIP LOCKED to prevent duplicate processing across instances
    const pendingJobRuns = await prisma.$transaction(async (tx: any) => {
      return await tx.$queryRaw<RawJobRunRow[]>`
        SELECT id, job_id, relay_status, relay_retry_count
        FROM job_runs
        WHERE relay_status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED;
      `;
    });

    if (!pendingJobRuns || pendingJobRuns.length === 0) {
      return 0;
    }

    for (const jobRun of pendingJobRuns) {
      try {
        // Push only the jobRun ID to the queue (Redis or SQS)
        await queue.push(QUEUE_SYNC_JOBS, jobRun.id);

        // Update status to SENT upon successful queue push
        await prisma.jobRun.update({
          where: { id: jobRun.id },
          data: {
            relayStatus: 'SENT',
            sentAt: new Date(),
          },
        });

        logger.info({ jobRunId: jobRun.id }, 'Relayed jobRun to sync-jobs queue');
        processedCount++;
      } catch (pushError: any) {
        const nextRetryCount = (jobRun.relay_retry_count || 0) + 1;
        const willFail = nextRetryCount >= MAX_RETRIES;

        logger.error(
          {
            error: pushError,
            jobRunId: jobRun.id,
            retryCount: nextRetryCount,
            maxRetries: MAX_RETRIES,
          },
          'Failed to push jobRun to queue'
        );

        await prisma.jobRun.update({
          where: { id: jobRun.id },
          data: {
            relayRetryCount: nextRetryCount,
            relayStatus: willFail ? 'FAILED' : 'PENDING',
            errorMessage: pushError?.message || 'Failed to relay to Redis queue',
          },
        });
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error during relay poll loop execution');
  }

  return processedCount;
}

let isRelayRunning = false;
let relayTimer: NodeJS.Timeout | null = null;

/**
 * Starts the relay loop running at 5-second intervals.
 */
export function startRelay(pollIntervalMs: number = RELAY_POLL_INTERVAL_MS): void {
  if (isRelayRunning) {
    logger.warn('Relay is already running');
    return;
  }

  isRelayRunning = true;
  logger.info({ pollIntervalMs }, 'Starting relay poll loop');

  const runLoop = async () => {
    if (!isRelayRunning) return;
    try {
      await pollAndRelayJobRuns();
    } catch (err) {
      logger.error({ error: err }, 'Unhandled error in relay loop');
    } finally {
      if (isRelayRunning) {
        relayTimer = setTimeout(runLoop, pollIntervalMs);
      }
    }
  };

  runLoop();
}

/**
 * Stops the relay loop.
 */
export function stopRelay(): void {
  isRelayRunning = false;
  if (relayTimer) {
    clearTimeout(relayTimer);
    relayTimer = null;
  }
  logger.info('Relay stopped');
}
