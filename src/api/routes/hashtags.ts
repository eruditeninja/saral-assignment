import { Router, Request, Response } from 'express';
import prisma from '../../shared/prisma';
import { logger } from '../../shared/logger';

const router = Router();

const PAGE_SIZE = 25;

interface CursorPayload {
  createdAt: string;
  id: string;
}

/**
 * Encode cursor from createdAt + composite id fields.
 */
function encodeCursor(createdAt: Date, hashtagName: string, mediaId: string): string {
  const payload: CursorPayload = {
    createdAt: createdAt.toISOString(),
    id: `${hashtagName}:${mediaId}`,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decode cursor to get createdAt and composite id fields.
 */
function decodeCursor(cursor: string): { createdAt: Date; hashtagName: string; mediaId: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const payload: CursorPayload = JSON.parse(decoded);
    const [hashtagName, mediaId] = payload.id.split(':');
    if (!hashtagName || !mediaId) return null;
    const createdAt = new Date(payload.createdAt);
    if (isNaN(createdAt.getTime())) return null;
    return { createdAt, hashtagName, mediaId };
  } catch {
    return null;
  }
}

/**
 * GET /hashtags
 *
 * Query params:
 *   cursor - optional opaque pagination cursor
 *
 * Returns paginated media in descending order of creation time.
 * media_url falls back to source_url if not yet downloaded.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const cursorParam = req.query.cursor as string | undefined;

    let cursorFilter = {};
    if (cursorParam) {
      const cursor = decodeCursor(cursorParam);
      if (!cursor) {
        res.status(400).json({ error: 'Invalid cursor' });
        return;
      }
      // Cursor-based pagination: fetch rows BEFORE the cursor (descending order)
      // Use (createdAt < cursorCreatedAt) OR (createdAt = cursorCreatedAt AND composite id < cursor id)
      cursorFilter = {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            hashtagName: { lt: cursor.hashtagName },
          },
          {
            createdAt: cursor.createdAt,
            hashtagName: cursor.hashtagName,
            mediaId: { lt: cursor.mediaId },
          },
        ],
      };
    }

    const media = await prisma.media.findMany({
      where: cursorFilter,
      orderBy: [
        { createdAt: 'desc' },
        { hashtagName: 'desc' },
        { mediaId: 'desc' },
      ],
      take: PAGE_SIZE + 1, // Fetch one extra to determine if there's a next page
    });

    const hasNextPage = media.length > PAGE_SIZE;
    const results = hasNextPage ? media.slice(0, PAGE_SIZE) : media;

    // Build next cursor from the last item
    let nextCursor: string | null = null;
    if (hasNextPage && results.length > 0) {
      const lastItem = results[results.length - 1];
      nextCursor = encodeCursor(lastItem.createdAt, lastItem.hashtagName, lastItem.mediaId);
    }

    // Map results: media_url falls back to source_url
    const mappedResults = results.map((m: any) => ({
      hashtag_name: m.hashtagName,
      media_id: m.mediaId,
      media_type: m.mediaType,
      timestamp: m.timestamp,
      permalink: m.permalink,
      caption: m.caption,
      like_count: m.likeCount,
      comments_count: m.commentsCount,
      sync_type: m.syncType,
      synced_at: m.syncedAt,
      media_url: m.mediaUrl || m.sourceUrl,
      created_at: m.createdAt,
    }));

    res.json({
      data: mappedResults,
      pagination: {
        next_cursor: nextCursor,
        has_next_page: hasNextPage,
        page_size: PAGE_SIZE,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch hashtag media');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
