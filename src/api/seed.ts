import { logger } from '../shared/logger';
import prisma from '../shared/prisma';

/**
 * Seed the default matcha hashtag sync jobs on API server boot.
 * Uses ON CONFLICT DO NOTHING to handle duplicate seeding on restart.
 */
export async function seedJobs(): Promise<void> {
  const jobs = [
    {
      jobType: 'recurring' as const,
      jobValue: '0 */3 * * *',
      fileName: 'metaSyncHashtag.js',
      payload: { hashtag: 'matcha', mediaType: 'top_media' },
    },
    {
      jobType: 'recurring' as const,
      jobValue: '0 */2 * * *',
      fileName: 'metaSyncHashtag.js',
      payload: { hashtag: 'matcha', mediaType: 'recent_media' },
    },
  ];

  for (const job of jobs) {
    try {
      const existing = await prisma.job.findFirst({
        where: {
          fileName: job.fileName,
          jobType: job.jobType,
          jobValue: job.jobValue,
        },
      });

      if (existing) {
        logger.info(
          { fileName: job.fileName, mediaType: (job.payload as any).mediaType },
          'Seed job already exists, skipping'
        );
        continue;
      }

      // Compute initial nextRunAt using cron-parser in UTC
      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(job.jobValue, { tz: 'UTC' });
      const nextRunAt = interval.next().toDate();

      await prisma.job.create({
        data: {
          ...job,
          nextRunAt,
        },
      });

      logger.info(
        { fileName: job.fileName, mediaType: (job.payload as any).mediaType, nextRunAt },
        'Seeded job'
      );
    } catch (error: any) {
      // Handle race condition: unique constraint violation means another process seeded it
      if (error?.code === 'P2002') {
        logger.info(
          { fileName: job.fileName, mediaType: (job.payload as any).mediaType },
          'Seed job already exists (concurrent creation), skipping'
        );
        continue;
      }
      throw error;
    }
  }
}
