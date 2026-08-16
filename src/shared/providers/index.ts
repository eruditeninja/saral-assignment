import { IQueueProvider, IStorageProvider, IJobExecutor } from './types';
import { config } from '../config';
import { logger } from '../logger';
import { RedisQueueProvider } from './local/redisQueue';
import { LocalStorageProvider } from './local/localStorage';
import { ForkExecutor } from './local/forkExecutor';

// Re-export interfaces and constants for convenience
export type { IQueueProvider, IStorageProvider, IJobExecutor } from './types';
export { QUEUE_SYNC_JOBS, QUEUE_DOWNLOADS } from './types';

let queueProviderInstance: IQueueProvider | null = null;
let storageProviderInstance: IStorageProvider | null = null;
let jobExecutorInstance: IJobExecutor | null = null;

/**
 * Get the singleton queue provider.
 * Currently uses Redis. To add AWS SQS, add a provider under ./aws/ implementing IQueueProvider.
 */
export function getQueueProvider(): IQueueProvider {
  if (!queueProviderInstance) {
    queueProviderInstance = new RedisQueueProvider(config.redisUrl);
    logger.info('Initialized Redis queue provider');
  }
  return queueProviderInstance;
}

/**
 * Get the singleton storage provider.
 * Currently uses local filesystem. To add AWS S3, add a provider under ./aws/ implementing IStorageProvider.
 */
export function getStorageProvider(): IStorageProvider {
  if (!storageProviderInstance) {
    storageProviderInstance = new LocalStorageProvider(config.mediaDir, config.port);
    logger.info({ mediaDir: config.mediaDir }, 'Initialized local storage provider');
  }
  return storageProviderInstance;
}

/**
 * Get the singleton job executor.
 * Currently uses child_process.fork. To add AWS Lambda, add a provider under ./aws/ implementing IJobExecutor.
 */
export function getJobExecutor(): IJobExecutor {
  if (!jobExecutorInstance) {
    jobExecutorInstance = new ForkExecutor();
    logger.info('Initialized fork job executor');
  }
  return jobExecutorInstance;
}

/**
 * Close all provider instances. Call during graceful shutdown.
 */
export async function closeAllProviders(): Promise<void> {
  const closeTasks: Promise<void>[] = [];

  if (queueProviderInstance) {
    closeTasks.push(queueProviderInstance.close());
    queueProviderInstance = null;
  }
  if (storageProviderInstance) {
    closeTasks.push(storageProviderInstance.close());
    storageProviderInstance = null;
  }
  if (jobExecutorInstance) {
    closeTasks.push(jobExecutorInstance.close());
    jobExecutorInstance = null;
  }

  await Promise.all(closeTasks);
  logger.info('All providers closed');
}
