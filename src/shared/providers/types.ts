/**
 * Provider interfaces for abstracting infrastructure concerns.
 *
 * These interfaces allow swapping between local (Redis, filesystem, child_process)
 * and AWS (SQS, S3, Lambda) implementations via PROVIDER_MODE config.
 */

/**
 * Standard logical queue names used across the system.
 */
export const QUEUE_SYNC_JOBS = 'queue:sync-jobs';
export const QUEUE_DOWNLOADS = 'queue:downloads';

/**
 * Queue provider — push/pop messages to a named queue.
 */
export interface IQueueProvider {
  /**
   * Push data to a named queue. Data is JSON-serialized internally.
   */
  push(queueName: string, data: unknown): Promise<void>;

  /**
   * Blocking pop from a named queue.
   * Returns parsed JSON data, or null if timeout reached.
   * @param queueName - The queue to pop from
   * @param timeoutSeconds - How long to wait (0 = block indefinitely where supported)
   */
  pop<T = unknown>(queueName: string, timeoutSeconds: number): Promise<T | null>;

  /**
   * Gracefully close connections/resources.
   */
  close(): Promise<void>;
}

/**
 * Storage provider — upload/retrieve media assets.
 */
export interface IStorageProvider {
  /**
   * Upload a media file and return its publicly accessible URL.
   * @param key - Storage key / filename (e.g. "matcha/17895695123.jpg")
   * @param data - File content as a Buffer
   * @param contentType - Optional MIME type (e.g. "image/jpeg")
   * @returns The public URL where the file can be accessed
   */
  upload(key: string, data: Buffer, contentType?: string): Promise<string>;

  /**
   * Get the public URL for a given storage key.
   */
  getUrl(key: string): string;

  /**
   * Gracefully close connections/resources.
   */
  close(): Promise<void>;
}

/**
 * Job executor provider — run handler code in an isolated environment.
 */
export interface IJobExecutor {
  /**
   * Execute a handler by name, passing environment variables.
   * @param handlerName - The handler file name (e.g. "metaSyncHashtag.js")
   * @param env - Environment variables to pass to the handler
   * @returns Exit code and optional error message
   */
  execute(
    handlerName: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; error?: string }>;

  /**
   * Gracefully close connections/resources.
   */
  close(): Promise<void>;
}
