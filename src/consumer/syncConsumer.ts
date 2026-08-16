import prisma from '../shared/prisma';
import { getQueueProvider, getJobExecutor, QUEUE_SYNC_JOBS } from '../shared/providers';
import { logger } from '../shared/logger';
import { config } from '../shared/config';

/**
 * Executes a single jobRun by picking it idempotently and running the handler
 * via the configured job executor (fork or Lambda).
 */
export async function processJobRun(jobRunId: string): Promise<void> {
  logger.info({ jobRunId }, 'Attempting to pick jobRun');

  // Idempotency: only pick if currently QUEUED
  const updateResult = await prisma.$executeRaw`
    UPDATE job_runs
    SET status = 'PICKED'
    WHERE id = ${jobRunId}::uuid AND status = 'QUEUED';
  `;

  if (updateResult === 0) {
    logger.warn({ jobRunId }, 'JobRun is not in QUEUED state (duplicate or already picked). Skipping.');
    return;
  }

  // Fetch full jobRun details including payload and job info
  const jobRun = await prisma.jobRun.findUnique({
    where: { id: jobRunId },
    include: { job: true },
  });

  if (!jobRun) {
    logger.error({ jobRunId }, 'JobRun not found in DB after picking');
    return;
  }

  const handlerFileName = jobRun.job?.fileName || 'metaSyncHashtag.js';
  const executor = getJobExecutor();

  logger.info({ jobRunId, handlerFileName }, 'Executing handler via job executor');

  try {
    const result = await executor.execute(handlerFileName, {
      JOB_RUN_ID: jobRun.id,
      PAYLOAD: JSON.stringify(jobRun.payload),
      DATABASE_URL: config.databaseUrl,
      REDIS_URL: config.redisUrl,
      META_ACCESS_TOKEN: config.metaAccessToken,
      META_USER_ID: config.metaUserId,
      META_API_VERSION: config.metaApiVersion,

    });

    if (result.exitCode === 0) {
      logger.info({ jobRunId }, 'Sync handler completed successfully');
      await prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'SUCCESS',
          errorMessage: null,
        },
      });
    } else {
      const errorMsg = (result.error || `Handler exited with code ${result.exitCode}`).slice(0, 1000);
      logger.error({ jobRunId, exitCode: result.exitCode, errorMsg }, 'Sync handler failed');
      await prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'FAILED',
          errorMessage: errorMsg,
        },
      });
    }
  } catch (error: any) {
    logger.error({ jobRunId, error }, 'Unexpected error executing handler');
    await prisma.jobRun.update({
      where: { id: jobRunId },
      data: {
        status: 'FAILED',
        errorMessage: (error?.message || 'Unexpected executor error').slice(0, 1000),
      },
    });
  }
}

let isConsumerRunning = false;

/**
 * Starts the consumer loop for sync jobs.
 * Uses the configured queue provider (Redis BRPOP or SQS long poll).
 */
export async function startSyncConsumer(): Promise<void> {
  if (isConsumerRunning) {
    logger.warn('Sync Consumer is already running');
    return;
  }

  const queue = getQueueProvider();

  isConsumerRunning = true;
  logger.info({ queueName: QUEUE_SYNC_JOBS }, 'Starting Sync Job Consumer loop');

  while (isConsumerRunning) {
    try {
      // Pop from queue with 5s timeout to allow checking isConsumerRunning flag for graceful shutdown
      const jobRunId = await queue.pop<string>(QUEUE_SYNC_JOBS, 5);
      if (jobRunId) {
        await processJobRun(jobRunId);
      }
    } catch (error) {
      logger.error({ error }, 'Error in sync consumer loop');
      // Small pause to prevent aggressive busy-looping on connection failure
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  logger.info('Sync Consumer loop ended');
}

/**
 * Stops the consumer loop.
 */
export function stopSyncConsumer(): void {
  isConsumerRunning = false;
}
