import path from 'path';
import pLimit from 'p-limit';
import prisma from '../shared/prisma';
import { getQueueProvider, getStorageProvider, QUEUE_DOWNLOADS } from '../shared/providers';
import { logger } from '../shared/logger';

interface DownloadItem {
  mediaId: string;
  mediaURL: string;
  hashtagName: string;
}

const CONCURRENCY_LIMIT = 10;

/**
 * Extracts file extension from URL or content type, defaulting to .jpg.
 */
function getExtensionFromUrl(url: string, contentType?: string | null): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 5) {
      return ext.toLowerCase();
    }
  } catch {}

  if (contentType) {
    if (contentType.includes('video/mp4')) return '.mp4';
    if (contentType.includes('image/png')) return '.png';
    if (contentType.includes('image/webp')) return '.webp';
    if (contentType.includes('image/jpeg')) return '.jpg';
  }

  return '.jpg';
}

/**
 * Downloads a single media asset and uploads it to storage (local or S3).
 */
async function downloadAsset(item: DownloadItem): Promise<void> {
  const { mediaId, mediaURL, hashtagName } = item;
  const storage = getStorageProvider();

  try {
    const response = await fetch(mediaURL);
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status} fetching media URL: ${mediaURL}`);
    }

    const contentType = response.headers.get('content-type');
    const ext = getExtensionFromUrl(mediaURL, contentType);
    const fileName = `${mediaId}${ext}`;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to storage provider (local filesystem or S3)
    const storedUrl = await storage.upload(fileName, buffer, contentType || undefined);

    // Update the media record with the stored media_url
    await prisma.media.update({
      where: {
        hashtagName_mediaId: {
          hashtagName,
          mediaId,
        },
      },
      data: {
        mediaUrl: storedUrl,
      },
    });

    logger.debug({ mediaId, fileName, storedUrl }, 'Downloaded and updated media record');
  } catch (error) {
    logger.error({ error, mediaId, mediaURL }, 'Failed to download media asset');
  }
}

/**
 * Processes a batch of media items to download in parallel.
 */
export async function processDownloadBatch(batch: DownloadItem[]): Promise<void> {
  if (!Array.isArray(batch) || batch.length === 0) {
    return;
  }

  const limit = pLimit(CONCURRENCY_LIMIT);

  logger.info({ batchSize: batch.length, concurrency: CONCURRENCY_LIMIT }, 'Starting media download batch');

  const tasks = batch.map((item) => limit(() => downloadAsset(item)));
  await Promise.all(tasks);

  logger.info({ batchSize: batch.length }, 'Completed media download batch');
}

let isDownloadConsumerRunning = false;

/**
 * Starts the consumer loop for media asset downloads.
 * Uses the configured queue provider (Redis BRPOP or SQS long poll).
 */
export async function startDownloadConsumer(): Promise<void> {
  if (isDownloadConsumerRunning) {
    logger.warn('Download Consumer is already running');
    return;
  }

  const queue = getQueueProvider();

  isDownloadConsumerRunning = true;
  logger.info({ queueName: QUEUE_DOWNLOADS }, 'Starting Download Consumer loop');

  while (isDownloadConsumerRunning) {
    try {
      const batch = await queue.pop<DownloadItem[]>(QUEUE_DOWNLOADS, 5);
      if (batch) {
        await processDownloadBatch(batch);
      }
    } catch (error) {
      logger.error({ error }, 'Error in download consumer loop');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  logger.info('Download Consumer loop ended');
}

/**
 * Stops the download consumer loop.
 */
export function stopDownloadConsumer(): void {
  isDownloadConsumerRunning = false;
}
