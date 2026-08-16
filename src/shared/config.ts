import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface Config {
  databaseUrl: string;
  redisUrl: string;
  metaAccessToken: string;
  metaUserId: string;
  metaApiVersion: string;
  port: number;
  mediaDir: string;
  serviceName: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: Config = {
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaUserId: process.env.META_USER_ID || '',
  metaApiVersion: process.env.META_API_VERSION || 'v24.0',
  port: parseInt(process.env.PORT || '3000', 10),
  mediaDir: process.env.MEDIA_DIR || './media',
  serviceName: process.env.SERVICE_NAME || 'unknown',
};
