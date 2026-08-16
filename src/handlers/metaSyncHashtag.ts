import prisma from '../shared/prisma';
import { config } from '../shared/config';
import { getQueueProvider, QUEUE_DOWNLOADS } from '../shared/providers';

// ---------------------------------------------------------------------------
// Handler constants — extract here so they're easy to find and tune
// ---------------------------------------------------------------------------

/** Maximum media items to ingest per sync run */
const MAX_ITEMS_PER_SYNC = 500;

/** Initial page size for Meta API requests (adaptively reduced on code-1 errors) */
const INITIAL_PAGE_LIMIT = 25;

/** Maximum retry attempts for Meta API requests */
const MAX_FETCH_RETRIES = 5;

/** Meta Graph API fields to request for each media item */
const MEDIA_FIELDS = 'id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetaMediaItem {
  id: string;
  media_type: string;
  timestamp: string;
  permalink: string;
  media_url?: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
}

interface MetaPaginationResponse {
  data: MetaMediaItem[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
  };
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
  };
}

interface DownloadQueueItem {
  mediaId: string;
  mediaURL: string;
  hashtagName: string;
}

interface FetchResult {
  data: any;
  effectiveUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep helper for rate-limit backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff on 429/rate-limits and dynamic limit downscaling on code 1
 * ("Please reduce the amount of data you're asking for").
 */
async function fetchWithRetry(initialUrl: string, maxRetries: number = MAX_FETCH_RETRIES): Promise<FetchResult> {
  let currentUrl = initialUrl;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    let response: Response;

    try {
      response = await fetch(currentUrl);
    } catch (networkErr: any) {
      console.warn(`[metaSyncHashtag] Network error: ${networkErr.message}. Retrying in 2s (attempt ${attempt}/${maxRetries})...`);
      await sleep(2000);
      continue;
    }

    // Handle 429 Too Many Requests
    if (response.status === 429) {
      const waitTime = Math.pow(2, attempt) * 1000;
      console.warn(`[metaSyncHashtag] Rate limited (429). Retrying in ${waitTime}ms (attempt ${attempt}/${maxRetries})...`);
      await sleep(waitTime);
      continue;
    }

    let rawBody = '';
    let parsedBody: any = null;
    try {
      rawBody = await response.text();
      parsedBody = JSON.parse(rawBody);
    } catch {
      // Body is not JSON
    }

    const err = parsedBody?.error;

    // Check for Meta code 1 ("Please reduce the amount of data you're asking for")
    const isDataReductionError =
      err?.code === 1 ||
      (typeof err?.message === 'string' && err.message.toLowerCase().includes('reduce the amount of data')) ||
      (typeof rawBody === 'string' && rawBody.toLowerCase().includes('reduce the amount of data'));

    if (isDataReductionError) {
      try {
        const urlObj = new URL(currentUrl);
        const currentLimit = parseInt(urlObj.searchParams.get('limit') || String(INITIAL_PAGE_LIMIT), 10);

        if (currentLimit > 1) {
          const nextLimit = Math.max(1, Math.floor(currentLimit / 2));
          urlObj.searchParams.set('limit', String(nextLimit));
          currentUrl = urlObj.toString();
          console.warn(
            `[metaSyncHashtag] Meta requested data reduction (code 1). Decreasing limit from ${currentLimit} -> ${nextLimit} and retrying...`
          );
          await sleep(1000);
          continue;
        }
      } catch (urlParseErr) {
        console.warn(`[metaSyncHashtag] Could not adjust limit on URL: ${currentUrl}`);
      }
    }

    // Check if Meta returned an API rate limit error object (codes 4, 17, 32, 613)
    if (err && (err.code === 4 || err.code === 17 || err.code === 32 || err.code === 613)) {
      const waitTime = Math.pow(2, attempt) * 1000;
      console.warn(`[metaSyncHashtag] Meta API rate limit (${err.message}). Retrying in ${waitTime}ms...`);
      await sleep(waitTime);
      continue;
    }

    if (!response.ok || err) {
      const errMsg = err ? JSON.stringify(err) : rawBody;
      throw new Error(`Meta API error HTTP ${response.status}: ${errMsg}`);
    }

    return { data: parsedBody, effectiveUrl: currentUrl };
  }

  throw new Error(`Exceeded max retries (${maxRetries}) for URL: ${currentUrl}`);
}

/**
 * Resolves hashtag name to Meta hashtag ID.
 */
async function getHashtagId(
  apiVersion: string,
  userId: string,
  hashtag: string,
  accessToken: string
): Promise<string> {
  const url = `https://graph.facebook.com/${apiVersion}/ig_hashtag_search?user_id=${encodeURIComponent(
    userId
  )}&q=${encodeURIComponent(hashtag)}&access_token=${encodeURIComponent(accessToken)}`;

  console.log(`[metaSyncHashtag] Resolving hashtag ID for #${hashtag}...`);
  const result = await fetchWithRetry(url);

  if (!result.data || !result.data.data || result.data.data.length === 0 || !result.data.data[0].id) {
    throw new Error(`Could not find hashtag ID for #${hashtag}`);
  }

  return result.data.data[0].id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Main sync execution handler.
 */
async function run(): Promise<void> {
  const rawPayload = process.env.PAYLOAD;
  if (!rawPayload) {
    throw new Error('PAYLOAD environment variable is required');
  }

  const payload = JSON.parse(rawPayload);
  const hashtag = payload.hashtag;
  const mediaType = payload.mediaType || 'top_media';

  if (!hashtag) {
    throw new Error('Missing "hashtag" in payload');
  }
  if (mediaType !== 'top_media' && mediaType !== 'recent_media') {
    throw new Error(`Invalid mediaType: "${mediaType}". Must be "top_media" or "recent_media".`);
  }

  const { metaAccessToken: accessToken, metaUserId: userId, metaApiVersion: apiVersion } = config;

  if (!accessToken || !userId) {
    throw new Error('META_ACCESS_TOKEN and META_USER_ID environment variables are required');
  }

  console.log(`[metaSyncHashtag] Starting sync for #${hashtag} (${mediaType})...`);

  // 1. Resolve hashtag ID
  const hashtagId = await getHashtagId(apiVersion, userId, hashtag, accessToken);
  console.log(`[metaSyncHashtag] Resolved hashtag #${hashtag} -> ID: ${hashtagId}`);

  // 2. Fetch pages (adaptively reduces page limit if Meta requests data reduction)
  let nextUrl: string | null = `https://graph.facebook.com/${apiVersion}/${hashtagId}/${mediaType}?user_id=${encodeURIComponent(
    userId
  )}&fields=${MEDIA_FIELDS}&limit=${INITIAL_PAGE_LIMIT}&access_token=${encodeURIComponent(accessToken)}`;

  let pageCount = 0;
  let totalItemsCount = 0;
  const downloadBatch: DownloadQueueItem[] = [];

  while (nextUrl && totalItemsCount < MAX_ITEMS_PER_SYNC) {
    pageCount++;
    console.log(`[metaSyncHashtag] Fetching page ${pageCount} of ${mediaType}...`);

    const { data: pageData } = await fetchWithRetry(nextUrl);
    const items = (pageData as MetaPaginationResponse).data || [];

    if (items.length === 0) {
      console.log(`[metaSyncHashtag] Page ${pageCount} returned 0 items. Ingestion completed.`);
      break;
    }

    // 3. Upsert media metadata in a single transaction (page-level atomicity)
    await prisma.$transaction(async (tx: any) => {
      for (const item of items) {
        const itemTimestamp = new Date(item.timestamp);
        const itemCommentsCount = typeof item.comments_count === 'number' ? item.comments_count : 0;
        const itemLikeCount = typeof item.like_count === 'number' ? item.like_count : null;
        const itemCaption = item.caption || null;
        const itemSourceUrl = item.media_url || null;

        await tx.$executeRaw`
          INSERT INTO media (
            hashtag_name,
            media_id,
            media_type,
            timestamp,
            permalink,
            caption,
            like_count,
            comments_count,
            sync_type,
            synced_at,
            source_url,
            created_at
          ) VALUES (
            ${hashtag},
            ${item.id},
            ${item.media_type},
            ${itemTimestamp},
            ${item.permalink},
            ${itemCaption},
            ${itemLikeCount},
            ${itemCommentsCount},
            ${mediaType},
            NOW(),
            ${itemSourceUrl},
            NOW()
          )
          ON CONFLICT (hashtag_name, media_id)
          DO UPDATE SET
            media_type = EXCLUDED.media_type,
            timestamp = EXCLUDED.timestamp,
            permalink = EXCLUDED.permalink,
            caption = EXCLUDED.caption,
            like_count = EXCLUDED.like_count,
            comments_count = EXCLUDED.comments_count,
            sync_type = EXCLUDED.sync_type,
            synced_at = NOW(),
            source_url = EXCLUDED.source_url;
        `;

        // Accumulate item for download queue if it has a media_url
        if (item.media_url) {
          downloadBatch.push({
            mediaId: item.id,
            mediaURL: item.media_url,
            hashtagName: hashtag,
          });
        }
      }
    });

    totalItemsCount += items.length;
    console.log(
      `[metaSyncHashtag] Page ${pageCount} upserted ${items.length} items (total: ${totalItemsCount})`
    );

    // Get next page URL
    nextUrl = pageData.paging?.next || null;
  }

  // 4. Push all accumulated items to download queue via provider
  if (downloadBatch.length > 0) {
    const queue = getQueueProvider();
    console.log(
      `[metaSyncHashtag] Pushing ${downloadBatch.length} media items to download queue...`
    );
    await queue.push(QUEUE_DOWNLOADS, downloadBatch);
    console.log(`[metaSyncHashtag] Download batch pushed to ${QUEUE_DOWNLOADS}`);
  } else {
    console.log('[metaSyncHashtag] No media items with URLs to download.');
  }

  console.log(
    `[metaSyncHashtag] Sync completed successfully. Pages: ${pageCount}, Items: ${totalItemsCount}`
  );
}

run()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[metaSyncHashtag] Fatal execution error:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
