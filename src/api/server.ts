import express from 'express';
import path from 'path';
import fs from 'fs';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import scheduleRouter from './routes/schedule';
import hashtagsRouter from './routes/hashtags';
import { seedJobs } from './seed';
import { startScheduler, stopScheduler } from '../scheduler';
import prisma from '../shared/prisma';

export const app = express();

// Middleware
app.use(express.json());

// Ensure media directory exists and serve static media files
const mediaPath = path.resolve(process.cwd(), config.mediaDir);
if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}
app.use('/media', express.static(mediaPath));

// API Routes
app.use('/schedule', scheduleRouter);
app.use('/hashtags', hashtagsRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api' });
});

/**
 * Bootstrap the API server, seed jobs, and start the scheduler.
 */
export async function startServer(): Promise<void> {
  try {
    logger.info('Running startup job seeding...');
    await seedJobs();
    logger.info('Job seeding completed successfully.');

    // Start background scheduler
    startScheduler();

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port, mediaPath }, 'API Server + Scheduler running');
    });

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down gracefully...');
      stopScheduler();
      server.close(async () => {
        await prisma.$disconnect();
        logger.info('Server closed cleanly');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ error }, 'Fatal error during API server boot. Exiting for container restart.');
    process.exit(1);
  }
}

// Start if executed directly
if (require.main === module) {
  startServer();
}
