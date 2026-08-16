import { Router, Request, Response } from 'express';
import prisma from '../../shared/prisma';
import { logger } from '../../shared/logger';

const router = Router();

/**
 * POST /schedule
 *
 * Request body:
 * {
 *   "jobType": "once" | "recurring",
 *   "jobValue": "<ISO timestamp>" | "<cron expression>",
 *   "fileName": "metaSyncHashtag.js",
 *   "payload": { "hashtag": "matcha", "mediaType": "top_media" | "recent_media" }
 * }
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobType, jobValue, fileName, payload } = req.body;

    // Validate required fields
    if (!jobType || !jobValue || !fileName || !payload) {
      res.status(400).json({ error: 'Missing required fields: jobType, jobValue, fileName, payload' });
      return;
    }

    // Validate jobType
    if (jobType !== 'once' && jobType !== 'recurring') {
      res.status(400).json({ error: 'jobType must be "once" or "recurring"' });
      return;
    }

    let nextRunAt: Date;

    if (jobType === 'once') {
      // Validate ISO timestamp
      const timestamp = new Date(jobValue);
      if (isNaN(timestamp.getTime())) {
        res.status(400).json({ error: 'jobValue must be a valid ISO timestamp for once jobs' });
        return;
      }
      // Reject past timestamps
      if (timestamp <= new Date()) {
        res.status(400).json({ error: 'jobValue must be a future timestamp for once jobs' });
        return;
      }
      nextRunAt = timestamp;
    } else {
      // Validate cron expression
      try {
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(jobValue, { tz: 'UTC' });
        nextRunAt = interval.next().toDate();
      } catch {
        res.status(400).json({ error: 'jobValue must be a valid cron expression for recurring jobs' });
        return;
      }
    }

    // Create job — unique constraint handles duplicates
    const job = await prisma.job.create({
      data: {
        jobType,
        jobValue,
        fileName,
        payload,
        nextRunAt,
      },
    });

    logger.info({ jobId: job.id, jobType, fileName }, 'Job created');
    res.status(201).json(job);
  } catch (error: any) {
    // Handle unique constraint violation
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'Duplicate job: a job with the same fileName, jobType, and jobValue already exists' });
      return;
    }
    logger.error({ error }, 'Failed to create job');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
