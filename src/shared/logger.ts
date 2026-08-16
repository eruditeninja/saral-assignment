import pino from 'pino';

const serviceName = process.env.SERVICE_NAME || 'unknown';

export const logger = pino({
  name: serviceName,
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
