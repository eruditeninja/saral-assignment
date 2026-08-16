import Redis from 'ioredis';
import { IQueueProvider } from '../types';
import { logger } from '../../logger';

/**
 * Redis-backed queue provider using LPUSH/BRPOP.
 * This is the local implementation wrapping the existing Redis queue logic.
 */
export class RedisQueueProvider implements IQueueProvider {
  private client: Redis | null = null;
  private readonly redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private getClient(): Redis {
    if (!this.client) {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null, // Required for BRPOP blocking
      });
    }
    return this.client;
  }

  async push(queueName: string, data: unknown): Promise<void> {
    const redis = this.getClient();
    const serialized = JSON.stringify(data);
    await redis.lpush(queueName, serialized);
    logger.debug({ queueName, dataLength: serialized.length }, 'Pushed to Redis queue');
  }

  async pop<T = unknown>(queueName: string, timeoutSeconds: number): Promise<T | null> {
    const redis = this.getClient();
    const result = await redis.brpop(queueName, timeoutSeconds);
    if (!result) {
      return null;
    }
    const [, value] = result;
    return JSON.parse(value) as T;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      logger.debug('Redis queue provider closed');
    }
  }
}
