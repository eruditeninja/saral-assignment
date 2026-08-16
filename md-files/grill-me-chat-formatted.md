# Grill-Me Chat Export 

**initial-solution.md#L1-97** 

**requirment.md#L1-122**  grill me based on the requirement and the initial solution i provided. Make no assumption. Ask and clarify each and every questions. Few decisions were already made in the initial solution. Keeping those in my you can ask more question around it. Consider each and every edge case for system. 

> 3:32 PM
I've reviewed both your requirement and initial solution carefully. Great foundation — let me start grilling you on the details. I'll go one question at a time.


## Question 1


**When a recurring job's **`nextRunAt`** is in the past (e.g., server was down for 12 hours and a job runs every 3 hours), how should the scheduler handle the gap? This is critical for the hashtag sync use case — if the server was down, should it fire 4 catch-up syncs or just skip to the next future tick?**

create one immediate job and update the next tick for after 3 hours. (write-in)

Got it — so on recovery you fire **one catch-up sync** and then reset `nextRunAt` to `now() + interval` rather than computing from the original cron expression. That's a pragmatic choice for the hashtag sync use case since fetching the same recent media 4 times would be redundant.


## Question 2


**Follow-up on missed tick recovery: When you say "update the next tick for after 3 hours," how exactly do you compute the new **`nextRunAt`**?**

**For example, if the cron is **`0 */3 * * *`** (every 3 hours at :00) and you recover at 14:37:**

- **Option A: nextRunAt = 14:37 + 3h = 17:37 (schedule drifts from original alignment)**
- **Option B: nextRunAt = next cron match = 15:00 (stays aligned to original cron)**
- **Option C: nextRunAt = 17:37 but snapped to 18:00**

**This matters because Option A causes permanent schedule drift.**

Compute nextRunAt as `now() + interval` from the moment of processing (floating schedule)

Alright — floating schedule with `now() + interval`. Simple and avoids a burst of catch-up runs. Trade-off is permanent drift from the original cron alignment, which is acceptable for this use case.


## Question 3


**For **`POST /schedule`** with **`jobType: "once"`** — what should happen if the caller provides a **`jobValue`** (ISO timestamp) that is already in the past? For example, someone sends **`jobValue: "2026-08-15T00:00:00Z"`** but it's already August 16th.**

Reject with a 400 error — past timestamps for 'once' jobs are invalid

Clean — 400 for past timestamps on `once` jobs.


## Question 4


**For **`POST /schedule`** with **`jobType: "recurring"`** — do you validate the cron expression (**`jobValue`**) before inserting? Specifically:**

1. **Should malformed cron expressions be rejected upfront (e.g., **`"not a cron"`**)?**
2. **Should there be a minimum interval guard (e.g., rejecting **`* * * * *`** which runs every minute)?**

Yes — validate the cron expression syntax and reject with 400 if malformed

Validate syntax, reject malformed — but no minimum interval guard. Got it.


## Question 5


**Can the same **`fileName`** be scheduled multiple times via **`POST /schedule`**? For example:**

- **Two recurring jobs both running **`metaRecentPost.js`** but on different cron schedules**
- **A **`once`** job and a **`recurring`** job both targeting **`metaRecentPost.js`**
- **The exact same request sent twice (same fileName, same jobType, same jobValue)**

**How do you handle deduplication at the job scheduling level (distinct from the jobRuns UNIQUE constraint)?**

Unique constraint on (fileName, jobType, jobValue) — prevent exact duplicates but allow same file on different schedules

Good — `UNIQUE (fileName, jobType, jobValue)` on the `jobs` table prevents exact duplicates while allowing the same script on different schedules. This means the same file can have a `once` and a `recurring` job, or two recurring jobs with different cron expressions.


## Question 6


**Does the system need any API to manage existing jobs after creation? Specifically:**

- **Cancel/delete a recurring job (set **`active = false`**)**
- **Pause/resume a job**
- **Update a job's schedule (change cron expression)**
- **List all active jobs**

**The requirement says the system periodically syncs recent media every 3 hours. If you want to change that interval, how would that happen?**

No — once created, a job runs until it's a 'once' that fires. No management API.

Understood — no management API. Jobs are fire-and-forget at the scheduling level. If you need to change behavior, it's a code/DB change, not a runtime API operation.


## Question 7


**What should the poll interval (N seconds) be for the scheduler's poll loop?**

**This controls the maximum latency between a job becoming due and being picked up. For the hashtag sync use case (every 3 hours), even 60 seconds would be fine. But if you later want near-real-time **`once`** jobs, a shorter interval matters.**

**Consider: shorter = more DB queries, longer = more latency.**

30 seconds

30 seconds poll interval — good balance for a 3-hour job. Max 30s latency is negligible.


## Question 8


**What should the batch size be for the scheduler's **`SELECT ... FOR UPDATE SKIP LOCKED LIMIT <batchSize>`**?**

**This controls how many due jobs a single scheduler instance claims per poll cycle. Considerations:**

- **Too small: multiple poll cycles needed to drain a backlog**
- **Too large: one instance hogs all work, defeating multi-instance scaling**
- **The transaction holds row locks for the duration of processing (inserting jobRuns + updating nextRunAt)**

50 jobs per batch

50 per batch. Since the operations inside the transaction are lightweight (INSERT jobRun + UPDATE nextRunAt), the lock duration is short even for 50 rows.


## Question 9


**What should the Relay's poll interval and batch size be?**

**The relay polls **`jobRuns WHERE relayStatus = 'PENDING'`** and pushes to the queue. Since the relay sits between the scheduler and the queue, its latency directly impacts end-to-end job pickup time.**

**With a 30s scheduler poll + 30s relay poll, worst case you have \~60s from job becoming due to it hitting the queue.**

More aggressive — shorter interval (5-10s) since relay should drain fast

Makes sense — relay is lightweight (just push to queue), so aggressive polling (5-10s) keeps the pipeline moving without significant DB load.


## Question 10


**What happens when the relay fails to push to the queue? For example, RabbitMQ is temporarily down.**

**The row's **`relayStatus`** stays **`PENDING`** since the update to **`SENT`** only happens on confirmed push. But:**

1. **Should there be explicit retry logic with backoff, or rely on the natural poll cycle to retry?**
2. **Is there a max retry count before giving up?**
3. **If it permanently fails, what state should the row be in?**

Retry up to N times with backoff, then mark FAILED. Expose a separate mechanism to manually retry FAILED relays.

Good — bounded retries with backoff, then `relayStatus = 'FAILED'`, with a manual retry escape hatch.


## Question 11


**What should the max retry count (N) be for the relay before marking **`relayStatus = 'FAILED'`**?**

3 retries

3 retries, then FAILED. Need to track `retryCount` on `jobRuns` then.


## Question 12


**To support the 3-retry limit, how should the relay track retry attempts? This affects whether retries survive relay restarts.**

**If tracked in-memory, a relay restart resets the count (effectively unlimited retries across restarts). If tracked in DB, the count is durable.**

Add `relayRetryCount` column to jobRuns — increment on each failed push attempt, mark FAILED when it hits 3

Durable retry tracking via `relayRetryCount` column on `jobRuns`. Clear and survives restarts.


## Question 13


**Relay crash scenario: The relay pushes a message to the queue successfully, but crashes ***before*** updating **`relayStatus`** from **`PENDING`** to **`SENT`**. On restart:**

1. **The row is still **`PENDING`** → relay picks it up again → pushes a duplicate to the queue.**
2. **The consumer gets two messages for the same jobRun.**

**Your design says the consumer does **`UPDATE ... WHERE status = 'QUEUED'`** for idempotency. This handles it — but I want to confirm you've thought through this specific failure mode and are comfortable with the at-least-once behavior here.**

Relay crash after push but before UPDATE is safe — the row stays PENDING, relay re-polls it, pushes a duplicate to the queue, but the consumer is idempotent (conditional UPDATE WHERE status = 'QUEUED'), so the duplicate is harmlessly discarded

Exactly right — the at-least-once delivery + idempotent consumer design handles this gracefully. The duplicate push is a no-op at the consumer.


## Question 14


**How does the consumer execute the handler file referenced by **`fileName`** (e.g., **`metaRecentPost.js`**)?**

**This is important for:**

- **Security (dynamic file execution is risky)**
- **Error isolation (if the handler crashes, does it take down the consumer process?)**
- **Dependency injection (how does the handler get access to DB, config, etc.?)**

Spawn a child process that runs the file (e.g., `child_process.fork(fileName)`)

Child process execution — good for error isolation. A crashed handler won't take down the consumer.


## Question 15


**With **`child_process.fork()`**, how does the handler file receive its inputs?**

1. **Payload data (from **`jobRuns.payload`** jsonb) — the handler needs to know ***what*** to do (e.g., which hashtag to sync)**
2. **Infrastructure (DB connection string, API tokens, S3 config) — the handler needs to connect to services**

**How are these passed to the child process?**

Via environment variables set on the child process

Environment variables for everything — payload serialized into env vars alongside DB/config. Simple, though large payloads could hit env var size limits. Fine for this use case where payload is small (hashtag name + ID).


## Question 16


**Should there be a timeout for handler execution in the child process?**

**Consider: the handler is fetching up to 500 media items from Meta's API with pagination, then downloading/uploading media assets. This could take a while. But a handler that hangs indefinitely would leave the jobRun stuck in **`PICKED`** status forever.**

Fixed timeout (e.g., 5 minutes) — kill the child process if it exceeds this, mark status = FAILED

5-minute fixed timeout, kill the process, mark FAILED. Clean.


## Question 17


**What happens to FAILED jobRuns? Specifically:**

1. **Recurring jobs: The ***job*** will fire again on its next tick (3 hours later), creating a ***new*** jobRun. But the ***current*** FAILED jobRun — is it ever retried, or is it terminal?**
2. **Once jobs: The job is already **`active = false`**. If the jobRun fails, the work is lost unless there's a retry mechanism.**

**Should the consumer retry failed jobRuns, or is FAILED always terminal?**

No — FAILED is terminal. The recurring job will naturally create a new jobRun on the next tick (3 hours later). One-time jobs stay FAILED permanently.

FAILED is terminal — no consumer-level retries. Recurring jobs self-heal on the next tick. Once jobs that fail are lost (acceptable for this scope).


## Question 18


**Consumer crash scenario: The consumer picks up a jobRun (status = **`PICKED`**), forks a child process, but the consumer process itself crashes (e.g., OOM, host dies) before the child completes and before it can update the status to **`SUCCESS`** or **`FAILED`**.**

**The jobRun is now stuck in **`PICKED`** status permanently. No other consumer will pick it up because the **`WHERE status = 'QUEUED'`** guard excludes it.**

**How do you handle this?**

i will go with 2nd implementation but will not implement now and tell in to do list (write-in)

Smart — a stuck job detector is the right answer, but it's a known TODO, not a blocker for the assignment. Document it as a trade-off.


## Question 19


**The **`jobRuns`** table has a **`payload`** (jsonb) column. What goes in it and when/how is it populated?**

**For the hashtag sync use case, the handler needs to know:**

- **Which hashtag to sync (e.g., **`matcha`**)**
- **The hashtag ID from Meta's API**
- **Whether it's a top_media or recent_media sync**
- **Possibly the API token**

**Is this payload provided by the caller at **`POST /schedule`** time, or does the scheduler build it when creating the jobRun?**

i will take as an input hashtag name and top media and recent media only in api. it will be like common hashtag media fetcher for meta api. rest things like hastagID can be fetch via name to id api fo meta (write-in)

So the `POST /schedule` caller provides:

- `hashtag` name (e.g., `"matcha"`)
- `mediaType` (e.g., `"top_media"` or `"recent_media"`)

And this becomes the payload stored in `jobRuns.payload`. The handler resolves the hashtag ID at runtime by calling Meta's name-to-ID API. Good — keeps the scheduler decoupled from Meta-specific details.


## Question 20


**Follow-up on payload: Since the **`payload`** comes from the caller at **`POST /schedule`** time, it needs to be stored on the **`jobs`** table too (not just **`jobRuns`**), because for recurring jobs, the scheduler creates new jobRuns on each tick and needs to copy the payload each time.**

**Does the **`jobs`** table get a **`payload`** (jsonb) column?**

Add `payload` (jsonb) to the `POST /schedule` request body and store it on the `jobs` table. The scheduler copies it to `jobRuns.payload` when creating each run.

Clean — `payload` jsonb on `jobs`, copied to `jobRuns` on each tick. The `POST /schedule` body becomes:

```
json
```

{

"jobType": "once" | "recurring",

"jobValue": "\<timestamp|cron>",

"fileName": "metaRecentPost.js",

"payload": { "hashtag": "matcha", "mediaType": "recent_media" }

}


## Question 21


**Which queue implementation will you use for this assignment?**

**The requirement says: use local replacements if not using AWS, and structure code so local can later be replaced with AWS SQS.**

**This implies you need a queue interface/abstraction with a concrete implementation behind it.**

In-memory queue (simple array/event emitter) — easiest for the assignment, swappable later

In-memory queue with an interface so it can be swapped for SQS later. Perfect for the assignment scope.


## Question 22


**Which storage implementation will you use for downloading/uploading media assets (images, videos from Instagram)?**

**The requirement says to download media assets and store them. Same pattern as the queue — local replacement that can later be swapped for S3.**

Local file storage (save to a `./media/` directory) — simplest, swappable later via interface

Local file storage in `./media/` behind an interface. Clean.


## Question 23


**Your design has 4 logical components: Scheduler, Relay, Consumer, and API server (for **`POST /schedule`** and **`GET /hashtags`**). How are these deployed?**

**For the assignment, do they all run in a single Node.js process, or are they separate processes? This affects:**

- **How the in-memory queue works (same process = direct function call, separate process = need IPC)**
- **How you start the system (one **`npm start`** vs multiple)**

Three processes: (1) Express API + scheduler, (2) Relay, (3) Consumer

Three processes. But wait — this impacts the in-memory queue choice significantly.


## Question 24


**Critical conflict: You chose an in-memory queue and three separate processes. The relay (process 2) needs to push messages to the queue, and the consumer (process 3) needs to read from it. But an in-memory queue only exists within a single process — process 2 can't write to process 3's memory.**

**How do you resolve this? The relay needs to deliver messages to the consumer across process boundaries.**

Switch to Redis (BullMQ or raw Redis list) as the queue since it bridges processes naturally

Good catch-and-correct. Redis (BullMQ or raw list) as the queue to bridge the three processes. This is the right call for separate processes.


## Question 25


**Which Redis queue approach?**

- **BullMQ: Full-featured job queue library. But your design already handles retries, status tracking, and scheduling in the DB — BullMQ's features would overlap/conflict with your architecture.**
- **Raw Redis list: Simple LPUSH/BRPOP. Your relay LPUSHes, your consumer BRPOPs. Clean, no feature overlap.**
- **Raw Redis Streams: XADD/XREADGROUP with consumer groups. More powerful than lists for multi-consumer, but more complex.**

**Given that your DB already owns all the job state and the queue is just a delivery pipe, which fits best?**

Raw Redis list (LPUSH/BRPOP) — minimal, lightweight, full control, matches the 'swappable interface' goal

Raw Redis list (LPUSH/BRPOP) — the queue is just a dumb pipe. All intelligence lives in the DB. This is consistent with your design philosophy.


## Question 26


**What data does the relay push into the Redis list for each jobRun?**

**Trade-offs:**

- **Full row data: Consumer doesn't need a DB read to start work, but message is larger and data could go stale**
- **Just the ID: Consumer fetches fresh data from DB, but adds a read before every job execution**
- **ID + essential fields: Compromise — consumer has what it needs for execution, falls back to DB only for edge cases**

Only the jobRun ID — consumer fetches the full row from DB on pickup

Just the jobRun ID in the queue message. Consumer fetches the full row from DB — ensures fresh data and keeps the queue messages tiny. The extra DB read is negligible for a 3-hour-interval job.


## Question 27


**The requirement says **`GET /hashtags`** returns stored media in descending order of creation time with pagination.**

**What pagination strategy?**

- **Cursor-based: More robust for real-time data (no skipped/duplicated rows when new data arrives), but more complex to implement**
- **Offset-based: Simpler, but inserting new rows can cause duplicates/gaps across pages**

**For a system where new media is constantly being ingested, cursor-based is generally recommended. But offset is simpler for the assignment.**

Cursor-based pagination using `createdAt` + `id` as the cursor (encode as opaque token)

Cursor-based with `createdAt` + `id` as a composite cursor, encoded as an opaque token. Solid choice — handles concurrent ingestion without duplicates across pages.


## Question 28


**What should the default page size be for the **`GET /hashtags`** paginated API?**

25 items per page (matches Meta's API default limit)

25 per page, matching Meta's default.


## Question 29


**The requirement says avoid duplicate media records. How do you enforce this?**

**Consider: the same media can appear in both **`top_media`** and **`recent_media`** responses. Also, subsequent syncs of **`recent_media`** every 3 hours may return overlapping media (Meta's recent_media window is \~24 hours).**

**Do you:**

1. **Silently skip duplicates (ON CONFLICT DO NOTHING)**
2. **Upsert to refresh metadata (ON CONFLICT DO UPDATE) — e.g., like_count and comments_count change over time**

UNIQUE on `media_id` with INSERT ON CONFLICT DO UPDATE to refresh metadata (caption, like_count, etc.) on re-fetch

Upsert on `media_id` — duplicates refresh metadata like `like_count` and `comments_count`. Smart, since these counters change over time and each sync gives you updated values for free.


## Question 30


**When the handler processes a batch of media from Meta's API, it needs to:**

1. **Store metadata in the **`media`** table**
2. **Download the media asset (image/video) and save to **`./media/`**

**What's the ordering and atomicity between these two operations?**

**Consider:**

- **Media URLs from Meta are temporary (they expire)**
- **Downloading a video could fail or be slow**
- **You're processing up to 500 items per sync**

Store metadata first, then download async — media row exists immediately, asset download is best-effort (nullable `localPath` column)

Metadata first, then best-effort async download. Media row has a nullable `localPath` that gets populated when the asset is downloaded. This means the `GET /hashtags` API can return media immediately even if the asset hasn't been downloaded yet.


## Question 31


**How does the async download actually happen? When the handler is processing a page of 25 media items:**

1. **It stores all 25 metadata rows**
2. **Then what? Does it download the 25 assets in the same handler execution, or decouple the download?**

**This matters because:**

- **You have a 5-minute handler timeout**
- **500 media items across pages could mean 500 downloads**
- **Video downloads could be large and slow**

Enqueue a separate 'download asset' job for each media item via the job scheduler — fully decoupled

Fully decoupled — each media item gets its own download job enqueued through the scheduler. This means:

- The sync handler only fetches metadata + enqueues downloads
- Downloads happen as separate jobRuns through the full pipeline (scheduler → relay → queue → consumer)
- Each download has its own 5-min timeout and failure tracking


## Question 32


**For these download jobs, do they go through the full **`POST /schedule`** → **`jobs`** table → scheduler poll → **`jobRuns`** → relay → queue pipeline?**

**That's a lot of machinery for a simple "download this URL now" task. With 500 media items per sync, you'd be creating 500 **`jobs`** rows (each as **`jobType: 'once'`**) and 500 **`jobRuns`** rows.**

**Is the full scheduler pipeline the right path for downloads, or should they take a shortcut?**

No — the sync handler directly inserts into jobRuns (bypassing the jobs table) since these are fire-once tasks with no schedule

Direct insert into `jobRuns` for downloads — bypasses the jobs table since these are one-shot tasks that need no scheduling. The relay picks them up as usual (since they have `relayStatus = PENDING`).


## Question 33


**If download tasks are inserted directly into **`jobRuns`** (bypassing **`jobs`** table), what **`jobId`** do they reference?**

**Your **`jobRuns`** table has a **`jobId`** column. Also, you have a **`UNIQUE (jobId, nextRunAt)`** constraint.**

- **If **`jobId`** is NULL, the UNIQUE constraint won't work as expected (NULL ≠ NULL in SQL)**
- **If you use a shared parent job, 500 downloads in the same sync would need distinct **`nextRunAt`** values to satisfy the UNIQUE constraint**

**This is a schema tension.**

we can use the same parent job Id nextRunAt value as now and payload data as {media's primary key id and value as the temp url from meta api which will be helpful for downloading the media}. Once the media is downloaded we will set the permanent link in media db. in the meantime we will serve with the temporary media link. (write-in)

So for downloads: all share the parent sync job's `jobId`, each has `nextRunAt = now()`, and the payload contains the media row's primary key + Meta's temporary URL. But we have a problem — if 500 download jobRuns all have the same `jobId` and `nextRunAt = now()`, the `UNIQUE (jobId, nextRunAt)` constraint would reject all but the first one.


## Question 34


**Schema conflict: With 500 download jobRuns sharing the same **`jobId`** and **`nextRunAt = now()`**, the **`UNIQUE (jobId, nextRunAt)`** constraint would reject 499 of them.**

**How do you resolve this? The UNIQUE constraint was designed to prevent duplicate ticks for the same scheduled job, but download jobRuns are a different beast.**

for downloading the media, we will create a single jobRun for each job . so if fetch 500 media then we will create only single runJob for this. (write-in)

Ah, so **one single jobRun** handles all 500 media downloads in batch — not one jobRun per media item. The download handler receives the parent sync jobRun's ID, queries the DB for all media rows with `localPath IS NULL`, and downloads them all in a batch.


## Question 35


**Let me make sure I understand the flow correctly. When a sync handler runs (e.g., **`metaRecentPost.js`**):**

1. **Fetch page 1 from Meta → store 25 media rows (metadata only, **`localPath = NULL`**)**
2. **Fetch page 2 → store next 25 media rows**
3. **... continue through all pages (up to 500 items)**
4. **After all pages are processed → create ONE download jobRun**
5. **The download handler picks up that jobRun → queries for all media with **`localPath IS NULL`** → downloads them all**

**Is this correct? And if so, how does step 4 work — does the sync handler directly insert a jobRun, or does it create a job via **`POST /schedule`**?**

The sync handler creates ONE 'download' jobRun that downloads all pending media (localPath IS NULL) in batch

Clear — the sync handler directly inserts one jobRun for downloads. That jobRun's handler queries `WHERE localPath IS NULL` and batch-downloads everything pending.


## Question 36


**Inside the download handler, when downloading potentially 500 media assets:**

**How do you manage concurrency? Downloading 500 files sequentially could easily exceed the 5-minute timeout. But firing 500 concurrent HTTP requests could overwhelm the network/disk.**

**Also, what happens if some downloads fail but others succeed? Is the whole jobRun marked FAILED, or do you track per-item success?**

Concurrent with a fixed pool size (e.g., 10 parallel downloads at a time via p-limit or similar)

Concurrent with a pool of \~10 parallel downloads. Good balance.


## Question 37


**Follow-up: If 480 out of 500 downloads succeed and 20 fail, what's the jobRun status?**

**The 480 successful downloads have already written files to **`./media/`** and updated **`localPath`** in the DB. The 20 failures still have **`localPath IS NULL`**.**

what i can think of is , we can have another loop process that loops over the media table and finds all the media row which localPath is null and and try to download via tempLink. (write-in)

So a separate sweep process that periodically scans for `localPath IS NULL` and attempts downloads. This is a self-healing mechanism for failed downloads.


## Question 38


**This sweep process for retrying failed downloads — should this be:**

1. **Another scheduled job through your existing job system?**
2. **A standalone loop?**
3. **A TODO for later?**

**Also consider: Meta's temporary media URLs expire after some time. If the URL has expired, the sweep can't download the asset even if it retries. The media row would need a fresh URL from a new Meta API call.**

even to download for the first time, we will use this process. it is for download the media only (write-in)

Got it — so the download isn't a separate "retry" process. It's **the primary download mechanism**:

1. Sync handler fetches metadata from Meta → stores rows with `localPath IS NULL` and `media_url` (temp URL)
2. A dedicated download process/loop scans for `localPath IS NULL` → downloads using `media_url` → sets `localPath`

There's no separate "download jobRun" at all. The download is a continuous sweep, not triggered by the job system.


## Question 39


**How does this download process run? Is it:**

1. **A scheduled job through your existing scheduler (recurring, e.g., every 5 minutes)?**
2. **A poll loop inside one of your existing three processes?**
3. **A fourth separate process?**

**This is important to nail down because it determines whether the job system is involved at all in media downloads.**

process: 1. while downloading the media from api, we will be accumulate the of [{mediaId:"",mediaURL:""}] and later on push into the redis queue and then a consumer will pick these messages in batch and download and update the media db with our local url. (write-in)

Ah, I see — so the flow is:

1. **Sync handler** (child process) fetches pages from Meta → stores metadata → accumulates `[{mediaId, mediaURL}]`
2. **Sync handler** pushes these directly to the Redis queue (LPUSH) as a batch message
3. **Consumer** BRPOPs the download message → downloads all assets in batch (with concurrency pool) → updates `localPath` in DB

The sync handler writes directly to Redis, bypassing the relay entirely for downloads. The scheduler/relay pipeline is only for the scheduled sync jobs, not for downloads.


## Question 40


**Let me confirm: with this approach, the sync handler (a child process forked by the consumer) directly writes to Redis.**

**This means:**

- **The child process needs a Redis connection (in addition to DB access via env vars)**
- **The download messages bypass the relay's at-least-once delivery guarantee and retry tracking**
- **If the Redis push fails after metadata is stored, the download is lost (no **`relayRetryCount`** fallback)**

**Are you comfortable with the sync handler directly pushing to Redis, or should downloads still go through the relay for consistency?**

For now, we sync handler pushes directly into the redis but later on, we will also implement a cron job that will pull directly from db which are not downloaded where localPath is null with retry count as well. (write-in)

Understood. The design is:

1. **Happy path**: Sync handler → Redis push → Consumer downloads → updates `localPath`
2. **Fallback (TODO)**: A periodic sweep job that catches any media with `localPath IS NULL` (failed Redis push, failed download, etc.) with retry tracking

For the assignment, you'll implement the happy path and document the sweep as a trade-off.


## Question 41


**With two types of messages flowing through Redis (scheduled job runs from the relay, and download tasks from the sync handler), do you use one queue or two?**

**Considerations:**

- **Different message shapes (jobRun ID vs. batch of **`{mediaId, mediaURL}`**)**
- **Different consumer logic (fork child process vs. download files)**
- **Single queue = simpler, but consumer needs to dispatch by message type**
- **Two queues = cleaner separation, but consumer needs to listen to both**

Two separate Redis lists (queues) — one for scheduled job runs (from relay), one for download tasks (from sync handler)

Two Redis lists — clean separation. Consumer listens on both (can alternate BRPOP across the two keys, or use `BRPOP key1 key2 timeout` which Redis supports natively).


## Question 42


**With two Redis queues, does a single consumer process handle both, or do you have separate consumer processes?**

**Considerations:**

- **One process: simpler to manage, but a heavy download batch could block sync job processing**
- **Two processes: better isolation, but more processes to manage (now 4 total: API+scheduler, relay, sync consumer, download consumer)**

Two consumer processes — one per queue (sync job consumer and download consumer)

So we now have **4 processes**:

1. Express API + Scheduler
2. Relay
3. Sync Job Consumer (BRPOP on job queue, forks child processes)
4. Download Consumer (BRPOP on download queue, downloads media assets)


## Question 43


**With 4 Node.js processes + Postgres + Redis, how should the reviewer start the system for the assignment?**

**This is a deliverable concern — the reviewer needs a smooth setup experience.**

Docker Compose with 4 services + Postgres + Redis

Docker Compose — one `docker-compose up` starts everything. Clean for reviewers.


## Question 44


**The requirement says to track the **`matcha`** hashtag with:**

- **Top media (one-time fetch or also recurring?)**
- **Recent media every 3 hours**

**Should these jobs be pre-seeded (automatically created on first startup), or does the reviewer need to manually **`POST /schedule`** to set them up?**

**Also, clarify: is top media fetched once and never again, or also on a schedule?**

Yes — seed at application startup (e.g., on API server boot, check if jobs exist and create them if not)

Auto-seed on startup — the API server checks if the matcha sync jobs exist and creates them if not.


## Question 45


**Clarify: top media — is this a one-time fetch or recurring?**

**Meta's **`top_media`** endpoint returns the most popular posts for a hashtag. These change over time as new posts gain traction. The requirement says "Fetch and store top media" but doesn't specify frequency.**

**`recent_media`** is explicitly every 3 hours. What about **`top_media`**?**

Top media = recurring every 3 hours alongside recent media (both on the same schedule)

Both top_media and recent_media on 3-hour recurring schedules. So on startup, two recurring jobs are seeded:

1. `metaTopMedia.js` — cron `0 */3 * * *` — payload: `{hashtag: "matcha", mediaType: "top_media"}`
2. `metaRecentMedia.js` — cron `0 */3 * * *` — payload: `{hashtag: "matcha", mediaType: "recent_media"}`


## Question 46


**Since both top_media and recent_media sync logic is nearly identical (same fields, same pagination, same storage), do you use:**

1. **Two separate handler files?**
2. **One handler file parameterized by **`mediaType`** from the payload?**
3. **One handler that does both in a single run?**

One handler file (e.g., `metaSyncHashtag.js`) that reads `mediaType` from the payload and calls the appropriate Meta endpoint

One handler, parameterized by `mediaType`. Clean — no code duplication. So the seeded jobs both reference `metaSyncHashtag.js` with different payloads.


## Question 47


**Meta's **`top_media`** and **`recent_media`** endpoints are paginated (25 items per page). The requirement mentions up to 500 media items per sync.**

**How does the handler manage pagination?**

- **Does it follow all **`next`** cursors until exhausted?**
- **Does it cap at a maximum number of pages/items?**
- **What if the API returns 50 pages (1250 items)?**

i am getting this as response: { "data": [ { "id": "17900476179560032", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-15T13:25:47+0000", "permalink": "https\://www\.instagram.com/p/DcD_b_kgvBR/", "media_url": "https\://scontent-del3-2.cdninstagram.com/v/t51.82787-15/776040547_18600634981027796_4589019503199379766_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=110&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=7mrzenYrLIMQ7kNvwE_qh2S&_nc_oc=AdrMVHwHGvfHJTkItsJz63sEAoER4zYWxAADtpg5ED5T4jFUMf7h86VwLGD0EF-cG88&_nc_zt=23&_nc_ht=scontent-del3-2.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHpvV9ie0k3U8cWPyq5NdguOVIVrZ993apaOiwv7gSR8w&oe=6A877157", "caption": "Got my matcha cups bedazzled at mumbaiblondie ✨✨🤍🤍 It perfectly matched with skincare received from arencia_global 🤍🤍 #matcha #matchalover #arencia #arenciaskincare #beautyblogger", "like_count": 554, "comments_count": 0 }, { "id": "18434664625133757", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-11T12:25:13+0000", "permalink": "https\://www\.instagram.com/p/Db5lU_oE7EI/", "media_url": "https\://scontent-del2-2.cdninstagram.com/v/t51.82787-15/773403154_18615929524015408_6933147387074585738_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=105&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=xduGSAE0tg8Q7kNvwEFxQzg&_nc_oc=AdqEcyNtJb2UUZT4zf0BC--FGrlVxGs-QB9mvD7FQhFPgU7d0BKF4qZHf5C2h1y4fIk&_nc_zt=23&_nc_ht=scontent-del2-2.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQGvAeERZiEfaAHRyAN-lrAW-W9XJn69cSDdmXTk8hvCYg&oe=6A876570", "caption": "โปรเจกต์ใหม่ล่าสุดของทาง cpscoffee ที่ไปคอลแลปกับไร่ชา Shibakirien จากเมือง Shizuoka ประเทศญี่ปุ่น ที่ทางร้านเลือกเอามัทฉะ 3 สายพันธุ์ที่มีคาแรกเตอร์ต่างกัน จะมี Saemidori, Tsuyuhikari, Okumidori มาให้เราได้ลองเลือกได้ตามชอบ\n\nนอกจากนี้ยังมีเมนูเครื่องดื่มพิเศษที่ทางร้านได้ทำมา3 ตัว Matcha Sky, Matcha Cookie Cloud, Matcha Earl Grey ให้สั่งด้วย แต่อีกไฮไลท์ที่เราชอบเลยคือ Usucha & Wagashi Set จะจัดมาเป็นเซ็ตให้เราได้ลองตีมัทฉะกินเองไปเลย มาพร้อมขนมไว้กินคู่กัน มีให้เลือกระหว่าง Warabimochi หรือ Daifuku & Signature Matcha Cream\n\nเมนูทั้งหมดเป็นมีจะมีขายเฉพาะที่สาขา Sukhumvit 53 และจะขายถึงแค่วันที่ 30 กันยา 2026 เท่านั้นนะ\n\n📍 : Thonglor\n↗️ : ร้านอยู่ในซอยสุขุมวิท 53\n🚙 : มีที่จอดรถหน้าร้าน\n🕑 : 6:30-18:00 เปิดทุกวัน\n___________________\n#CAFETELLER \n#CAFETELLERxTHONGLO\n#CPSCoffee #matcha", "like_count": 622, "comments_count": 2 }, { "id": "18122215891876104", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-12T17:08:55+0000", "permalink": "https\://www\.instagram.com/p/Db8qlpuE_oS/", "media_url": "https\://scontent-del2-1.cdninstagram.com/v/t51.82787-15/773218305_18614338648021098_1059953704204611411_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=111&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=o0f7EOK6gGoQ7kNvwGYTsyn&_nc_oc=AdodyqzGgzs4nsJPRVWloejTCFWN3HHkNpL0fr6CEN-QdHEvPBk4APs3QLalebQOx1o&_nc_zt=23&_nc_ht=scontent-del2-1.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHGU6QdLaBU2-vNuV6OEOqMFvR9eZCOLSLkN01J0vzdkw&oe=6A8757BD", "caption": "Matcha day in Bangkok 🍵🌿", "like_count": 571, "comments_count": 8 }, { "id": "18456691516141636", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-06T14:30:01+0000", "permalink": "https\://www\.instagram.com/p/Dbs7txtli1B/", "media_url": "https\://scontent-del2-3.cdninstagram.com/v/t51.82787-15/767101514_18608474317054569_6303917830381210072_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=101&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=UTQP6iuHmj0Q7kNvwGiTQwZ&_nc_oc=Adr90jOpQ0g0lrJ8bMXyFWPSll12cpRu1dZJDYtG3F1OI0cQ65Q4CF6tr0FO5a7E3ZQ&_nc_zt=23&_nc_ht=scontent-del2-3.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQGa2oUh2I6PeY-AF8aDJkyNiGsKEZWJpeERgQrL0RPFag&oe=6A8768DA", "caption": "Mis cafeterías favoritas para tomar café o matcha en la CDMX 🤍 #cafe #matcha #cdmx", "comments_count": 30 }, { "id": "18010608941928505", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-15T09:19:15+0000", "permalink": "https\://www\.instagram.com/p/DcDjOalE4Ul/", "media_url": "https\://scontent-del2-3.cdninstagram.com/v/t51.82787-15/775956030_18613029478005345_7910639845377824956_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=pqTPHx8sUrAQ7kNvwGNeh3L&_nc_oc=Ado8BUTUE3ASDUdaPIp16Igt5OkphaBAj9mf8k4mzhPXqj3SUDa8NU1aYZhvW51qhcM&_nc_zt=23&_nc_ht=scontent-del2-3.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHav5wU5LeA3xeH1uhh8VUnrlv8Kf-IBbITIa0-w7Wwfg&oe=6A877219", "caption": "just me, lately. 🤍\n\n#cafevibes \n#vibes \n#matcha \n#tiikpchaya", "comments_count": 12 } ], "paging": { "cursors": { "after": "ZAmIyYmM4M2NmMWI4NGZAhNWEwMGI1NmMyYjIyMjUwNGYZD" }, "next": "https\://graph.facebook.com/v25.0/17843758702042126/top_media?user_id=17841480695597364&fields=id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count&limit=5&access_token=EAAMQTKttZCYkBSELKv4G4xFswfgVyZCaCbXbeA4bajoc5mzq1lHqdxnYPVawQdYSXyjpD83eqsfAVnK6RjPzj7QHG11uZBZAOZAw0n6J2XQuYYO3uHkK6z1lrR27TqGIHFi9rl6D93LjnJapU9wviXGUznKezcB9q32Pl6rI3mm6XJ7epuvd5UGG3CctKXyUmJwHt&after=ZAmIyYmM4M2NmMWI4NGZAhNWEwMGI1NmMyYjIyMjUwNGYZD" } } (write-in)

Great — you've actually hit the API. I can see the response structure. The pagination uses cursor-based (`after` cursor + `next` URL). Let me continue with the questions.


## Question 48


**Based on the actual Meta API response, pagination uses cursor-based **`after`** + **`next`** URL. I can see some items don't have **`like_count`** (item 4 has **`comments_count: 30`** but no **`like_count`**).**

**Back to the pagination question: How many pages do you follow? The requirement says "up to 500 media items per sync."**

Follow `next` links up to a max of 20 pages (500 items at 25/page) and stop

Max 20 pages (500 items). Stop even if more pages exist.


## Question 49


**Looking at the actual API response, the fields are: **`id`**, **`media_type`**, **`timestamp`**, **`permalink`**, **`media_url`**, **`caption`**, **`like_count`**, **`comments_count`**.**

**I noticed:**

- **`like_count`** is sometimes missing (item 4 doesn't have it)**
- **`caption`** can be very long (item 2 is \~1000+ chars)**
- **`media_url`** is a temporary CDN link that expires**

**The requirement says: ***"Note: the above are suggestions; we want to see what you keep and leave out of the database and why."***

**Which fields do you store in your **`media`** table?**

Store all fields from Meta PLUS additional derived fields (e.g., hashtag name, sync type, sync timestamp)

All Meta fields + derived fields. Let me nail down the exact schema.


## Question 50


**Which derived/additional fields should the **`media`** table have beyond the Meta API fields (**`id`**, **`media_type`**, **`timestamp`**, **`permalink`**, **`media_url`**, **`caption`**, **`like_count`**, **`comments_count`**)?**

hashtag_name (e.g., 'matcha') — to support multiple hashtags in the future, sync_type ('top_media' or 'recent_media') — to know how this media was discovered, synced_at (timestamp of the sync that ingested/updated this record), source_url (the original media_url from Meta, even though it expires) — for debugging/audit, media_url (the permanent/local URL to serve to API consumers), in media_url set the local path value, later on we can store s3 base path as well. (write-in)

Clear schema. So:

- `source_url` = Meta's temp CDN URL (for audit)
- `media_url` = local path (e.g., `./media/<mediaId>.jpg`), later swapped for S3 URL
- No separate `local_path` column — `media_url` serves that purpose


## Question 51


**For the **`media_url`** column: when metadata is first stored (before the asset is downloaded), what value does **`media_url`** have?**

**The asset hasn't been downloaded yet, so there's no local path. But the API consumer (**`GET /hashtags`**) might need a URL to display the image.**

**Options:**

- **Start as NULL → API consumer gets no image until downloaded**
- **Start as the Meta temp URL → works immediately but will expire**
- **Start as NULL → API falls back to **`source_url`** if **`media_url`** is NULL**

media_url starts as NULL — set to local path once downloaded. API returns source_url as fallback when media_url is NULL.

`media_url` starts NULL, API returns `source_url` as fallback. Progressive enhancement — consumers get *something* immediately (Meta's temp URL) and the permanent local URL once downloaded.


## Question 52


**What's the primary key of the **`media`** table?**

**Meta's **`id`** field (e.g., **`17900476179560032`**) is globally unique across Instagram. But:**

- **The same media could appear under both **`top_media`** and **`recent_media`** for the same hashtag**
- **If you support multiple hashtags in the future, the same media could appear under different hashtags**

**Do you use Meta's **`id`** as the PK, or a composite key, or a surrogate key?**

Composite key: (hashtag_name, media_id) — unique per hashtag, in case the same media appears under different hashtags

Composite `(hashtag_name, media_id)` — future-proofs for multiple hashtags. The same media can exist as separate rows under different hashtags.


## Question 53


**With the composite key **`(hashtag_name, media_id)`** and **`ON CONFLICT DO UPDATE`** for dedup: if the same media appears in both **`top_media`** AND **`recent_media`** responses, the second sync will upsert the existing row.**

**The **`sync_type`** column would be overwritten. If it was first ingested via **`top_media`** and later appears in **`recent_media`**, **`sync_type`** would flip to **`recent_media`**.**

**Is this the desired behavior, or should you track both sources?**

The upsert (ON CONFLICT DO UPDATE) always updates to the latest sync_type, even if the media was originally discovered via a different source

Last-write-wins for `sync_type`. Simple and sufficient — the important thing is the metadata refresh (like_count, comments_count), not preserving discovery history.


## Question 54


**The requirement says: ***"Create all database tables through migrations"*** and the stack is Express + TypeScript + Postgres.**

**Which database library and migration tool will you use?**

Prisma — type-safe ORM with schema-first design and auto-generated client

Prisma — type-safe, schema-first, great for TypeScript. Migrations via `prisma migrate`.


## Question 55


**What ID strategy do you use for the **`jobs`** and **`jobRuns`** tables?**

**With multi-instance services, auto-increment can cause contention. UUIDs are distributed-safe but larger and not naturally ordered. For cursor-based pagination on the media table, ordered IDs (BIGSERIAL or UUIDv7) would help.**

UUIDs (uuid_generate_v4()) for all tables

UUIDs everywhere. For cursor-based pagination on the media table, you'll rely on `createdAt` + `id` (UUID) as the composite cursor, which works fine since UUIDs are unique even if not ordered.


## Question 56


**Meta's API has rate limits. If your handler hits a 429 (Too Many Requests) or 4xx error mid-pagination (e.g., after fetching page 3 of 20):**

1. **Do you retry the failed page?**
2. **Do you save what you've fetched so far (pages 1-3) and abandon the rest?**
3. **Do you implement any rate-limiting/backoff?**

Yes — implement basic retry with exponential backoff on 429 responses within the handler

Basic retry with exponential backoff on 429s within the handler. The handler retries the failed page, not the entire sync.


## Question 57


**When the handler is fetching pages from Meta and storing media metadata, what's the transaction boundary?**

**If the handler crashes after fetching page 10 of 20 (250 items stored), what happens?**

- **If you stored pages 1-10 already, you have partial data but no data loss**
- **If you buffered everything in memory, you lose all 250 items**

**With upsert (ON CONFLICT DO UPDATE), re-processing already-stored items is safe.**

Page-level atomicity — process and store each page immediately as it's fetched (25 items at a time)

Page-level atomicity — each page of 25 items is upserted in a single transaction as soon as it's fetched. Crash after page 10 preserves 250 items already stored. Re-running the sync from scratch is safe due to upsert.


## Question 58


**Does the **`POST /schedule`** endpoint require any authentication or authorization?**

**If this service is exposed on a network, anyone could schedule arbitrary jobs.**

No auth for now, but document it as a trade-off

No auth, documented as a trade-off. Fair for the assignment.


## Question 59


**The **`jobRuns`** table will grow indefinitely. Every 3 hours, you get 2 new jobRuns (top_media + recent_media), plus download jobRuns. Over a year that's \~6,000+ rows.**

**Do you implement any data retention/cleanup for old jobRuns?**

I will setup a cron for db clean but not now. mention in tradeoff. (write-in)

Cleanup cron as a TODO, documented in trade-offs. 6,000 rows/year is manageable without it.


## Question 60


**With 4 separate processes, observability is important for debugging. What logging strategy?**

**Docker Compose aggregates logs from all services, but without structure it's hard to trace a request through scheduler → relay → consumer.**

Structured logging with levels (info, warn, error) using a library like winston or pino

Structured logging with pino/winston. Each process tagged with its service name.


## Question 61


**Do you need health check endpoints for the Docker Compose services? Docker can use these to detect and restart unhealthy containers.**

No — not in scope for the assignment, rely on Docker Compose restart policies

No health checks — Docker restart policies handle it. Fair for assignment scope.


## Question 62


**For the Docker setup, all 4 services share the same TypeScript codebase. Do you use one Dockerfile or separate ones?**

**Since they share **`node_modules`**, Prisma client, and TypeScript compilation, a single image with different entrypoints is most efficient.**

One Dockerfile shared by all 4 services (different CMD/entrypoint per service in docker-compose.yml)

One Dockerfile, different entrypoints in `docker-compose.yml`. Efficient — one build, four services.


## Question 63


**Will you write automated tests for this assignment? The requirement says ***"we are looking for clear engineering judgment and a clean implementation"*** but doesn't explicitly require tests.**

Yes — write unit tests for critical paths: scheduler poll logic, relay logic, consumer idempotency, API pagination

Unit tests for critical paths. Good signal to reviewers.


## Question 64


**Which test framework for TypeScript?**

Jest — most popular, built-in mocking, good TypeScript support via ts-jest

Jest with ts-jest.


## Question 65


**What project structure do you envision? With 4 services sharing one codebase, organization matters.**

**Consider:**

- **Shared code: Prisma client, Redis connection, queue interface, logger**
- **Service-specific code: scheduler loop, relay loop, consumer handler, API routes**
- **Handler files: metaSyncHashtag.js and download logic**

Feature-based — src/scheduler/, src/relay/, src/consumer/, src/api/, src/shared/

Feature-based structure. Clean separation.


## Question 66


**Looking at the API response, all items in the sample are **`media_type: 'CAROUSEL_ALBUM'`**. Instagram carousels can have multiple images/videos.**

**The **`media_url`** returned is the cover image of the carousel. To get individual carousel items, you'd need to call Meta's **`/{media_id}/children`** endpoint.**

**Do you fetch carousel children, or just store the cover image?**

CAROUSEL_ALBUM is stored as a single row with media_type = 'CAROUSEL_ALBUM'. Only the cover image (media_url) is downloaded — individual carousel items are ignored.

Single row per carousel, cover image only. Simple and sufficient — document as a trade-off/future enhancement.


## Question 67


**For the **`GET /hashtags`** API response shape: what fields does each media item include?**

**Specifically, how do you handle the **`media_url`** vs **`source_url`** decision for the consumer? The API should abstract away the internal download state.**

Return `media_url` with fallback to `source_url` (as discussed earlier) — client always gets a URL

API always returns a URL — local path if downloaded, Meta's temp URL as fallback. Client never sees null.


## Question 68


**When **`media_url`** contains the local path (asset downloaded), how does the API consumer access the file?**

**If **`media_url`** is **`./media/17900476179560032.jpg`**, that's a filesystem path — not a URL the API consumer can fetch. The API server needs to serve the media files.**

The API server mounts `./media/` as static directory via Express static middleware, so `media_url` is a full HTTP URL like `http\://localhost:3000/media/17900476179560032.jpg`

Express static middleware serves `./media/`. The `media_url` stored in DB is a full URL like `http://localhost:3000/media/<mediaId>.jpg`. In production, this would be an S3 URL.


## Question 69


**What naming convention for downloaded media files in **`./media/`**?**

**The file extension matters too — do you infer it from **`media_type`** (IMAGE → .jpg, VIDEO → .mp4) or from the **`media_url`**'s Content-Type header?**

Use the `media_id` as the filename (e.g., `17900476179560032.jpg`) — deterministic, dedup-safe, easy to look up

`media_id` as filename — deterministic and dedup-safe. If the same media is downloaded twice, it just overwrites the same file.


## Question 70


**How do you determine the file extension (**`.jpg`**, **`.mp4`**, etc.) for the downloaded media?**

**Meta's **`media_type`** can be **`IMAGE`**, **`VIDEO`**, or **`CAROUSEL_ALBUM`**. But the actual content could vary (e.g., a CAROUSEL_ALBUM cover could be .webp, .png, etc.).**

my looking media_url : { "data": [ { "id": "17900476179560032", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-15T13:25:47+0000", "permalink": "https\://www\.instagram.com/p/DcD_b_kgvBR/", "media_url": "https\://scontent-del3-2.cdninstagram.com/v/t51.82787-15/776040547_18600634981027796_4589019503199379766_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=110&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=7mrzenYrLIMQ7kNvwE_qh2S&_nc_oc=AdrMVHwHGvfHJTkItsJz63sEAoER4zYWxAADtpg5ED5T4jFUMf7h86VwLGD0EF-cG88&_nc_zt=23&_nc_ht=scontent-del3-2.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHpvV9ie0k3U8cWPyq5NdguOVIVrZ993apaOiwv7gSR8w&oe=6A877157", "caption": "Got my matcha cups bedazzled at mumbaiblondie ✨✨🤍🤍 It perfectly matched with skincare received from arencia_global 🤍🤍 #matcha #matchalover #arencia #arenciaskincare #beautyblogger", "like_count": 554, "comments_count": 0 }, { "id": "18434664625133757", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-11T12:25:13+0000", "permalink": "https\://www\.instagram.com/p/Db5lU_oE7EI/", "media_url": "https\://scontent-del2-2.cdninstagram.com/v/t51.82787-15/773403154_18615929524015408_6933147387074585738_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=105&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=xduGSAE0tg8Q7kNvwEFxQzg&_nc_oc=AdqEcyNtJb2UUZT4zf0BC--FGrlVxGs-QB9mvD7FQhFPgU7d0BKF4qZHf5C2h1y4fIk&_nc_zt=23&_nc_ht=scontent-del2-2.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQGvAeERZiEfaAHRyAN-lrAW-W9XJn69cSDdmXTk8hvCYg&oe=6A876570", "caption": "โปรเจกต์ใหม่ล่าสุดของทาง cpscoffee ที่ไปคอลแลปกับไร่ชา Shibakirien จากเมือง Shizuoka ประเทศญี่ปุ่น ที่ทางร้านเลือกเอามัทฉะ 3 สายพันธุ์ที่มีคาแรกเตอร์ต่างกัน จะมี Saemidori, Tsuyuhikari, Okumidori มาให้เราได้ลองเลือกได้ตามชอบ\n\nนอกจากนี้ยังมีเมนูเครื่องดื่มพิเศษที่ทางร้านได้ทำมา3 ตัว Matcha Sky, Matcha Cookie Cloud, Matcha Earl Grey ให้สั่งด้วย แต่อีกไฮไลท์ที่เราชอบเลยคือ Usucha & Wagashi Set จะจัดมาเป็นเซ็ตให้เราได้ลองตีมัทฉะกินเองไปเลย มาพร้อมขนมไว้กินคู่กัน มีให้เลือกระหว่าง Warabimochi หรือ Daifuku & Signature Matcha Cream\n\nเมนูทั้งหมดเป็นมีจะมีขายเฉพาะที่สาขา Sukhumvit 53 และจะขายถึงแค่วันที่ 30 กันยา 2026 เท่านั้นนะ\n\n📍 : Thonglor\n↗️ : ร้านอยู่ในซอยสุขุมวิท 53\n🚙 : มีที่จอดรถหน้าร้าน\n🕑 : 6:30-18:00 เปิดทุกวัน\n___________________\n#CAFETELLER \n#CAFETELLERxTHONGLO\n#CPSCoffee #matcha", "like_count": 622, "comments_count": 2 }, { "id": "18122215891876104", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-12T17:08:55+0000", "permalink": "https\://www\.instagram.com/p/Db8qlpuE_oS/", "media_url": "https\://scontent-del2-1.cdninstagram.com/v/t51.82787-15/773218305_18614338648021098_1059953704204611411_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=111&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=o0f7EOK6gGoQ7kNvwGYTsyn&_nc_oc=AdodyqzGgzs4nsJPRVWloejTCFWN3HHkNpL0fr6CEN-QdHEvPBk4APs3QLalebQOx1o&_nc_zt=23&_nc_ht=scontent-del2-1.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHGU6QdLaBU2-vNuV6OEOqMFvR9eZCOLSLkN01J0vzdkw&oe=6A8757BD", "caption": "Matcha day in Bangkok 🍵🌿", "like_count": 571, "comments_count": 8 }, { "id": "18456691516141636", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-06T14:30:01+0000", "permalink": "https\://www\.instagram.com/p/Dbs7txtli1B/", "media_url": "https\://scontent-del2-3.cdninstagram.com/v/t51.82787-15/767101514_18608474317054569_6303917830381210072_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=101&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=UTQP6iuHmj0Q7kNvwGiTQwZ&_nc_oc=Adr90jOpQ0g0lrJ8bMXyFWPSll12cpRu1dZJDYtG3F1OI0cQ65Q4CF6tr0FO5a7E3ZQ&_nc_zt=23&_nc_ht=scontent-del2-3.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQGa2oUh2I6PeY-AF8aDJkyNiGsKEZWJpeERgQrL0RPFag&oe=6A8768DA", "caption": "Mis cafeterías favoritas para tomar café o matcha en la CDMX 🤍 #cafe #matcha #cdmx", "comments_count": 30 }, { "id": "18010608941928505", "media_type": "CAROUSEL_ALBUM", "timestamp": "2026-08-15T09:19:15+0000", "permalink": "https\://www\.instagram.com/p/DcDjOalE4Ul/", "media_url": "https\://scontent-del2-3.cdninstagram.com/v/t51.82787-15/775956030_18613029478005345_7910639845377824956_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=pqTPHx8sUrAQ7kNvwGNeh3L&_nc_oc=Ado8BUTUE3ASDUdaPIp16Igt5OkphaBAj9mf8k4mzhPXqj3SUDa8NU1aYZhvW51qhcM&_nc_zt=23&_nc_ht=scontent-del2-3.cdninstagram.com&edm=APCawUEEAAAA&_nc_gid=7nkhrSLCjY5z4Si9OtQGjQ&oh=00_AQHav5wU5LeA3xeH1uhh8VUnrlv8Kf-IBbITIa0-w7Wwfg&oe=6A877219", "caption": "just me, lately. 🤍\n\n#cafevibes \n#vibes \n#matcha \n#tiikpchaya", "comments_count": 12 } ], "paging": { "cursors": { "after": "ZAmIyYmM4M2NmMWI4NGZAhNWEwMGI1NmMyYjIyMjUwNGYZD" }, "next": "https\://graph.facebook.com/v25.0/17843758702042126/top_media?user_id=17841480695597364&fields=id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count&limit=5&access_token=EAAMQTKttZCYkBSELKv4G4xFswfgVyZCaCbXbeA4bajoc5mzq1lHqdxnYPVawQdYSXyjpD83eqsfAVnK6RjPzj7QHG11uZBZAOZAw0n6J2XQuYYO3uHkK6z1lrR27TqGIHFi9rl6D93LjnJapU9wviXGUznKezcB9q32Pl6rI3mm6XJ7epuvd5UGG3CctKXyUmJwHt&after=ZAmIyYmM4M2NmMWI4NGZAhNWEwMGI1NmMyYjIyMjUwNGYZD" } } (write-in)

I see — the `media_url` always ends with `.jpg` (even for CAROUSEL_ALBUM). So parsing the extension from the URL path is reliable.


## Question 71


**For the file extension: looking at the actual URLs, the path segment always contains the extension (e.g., **`...766_n.jpg?stp=...`**). So you can extract **`.jpg`** from the URL.**

**Which approach for determining the extension?**

Parse the extension from the media_url path (e.g., extract `.jpg` from the URL before the query params)

Parse from URL path. Practical and reliable for Meta's CDN URLs.


## Question 72


**Docker volume question: The download consumer (process 4) writes files to **`./media/`**, and the API server (process 1) serves them via Express static middleware. These are different containers.**

**How do they share the **`./media/`** directory?**

Volume mount — `./media/` is a Docker volume shared between the API server (serves files) and the download consumer (writes files)

Shared Docker volume between API server and download consumer. Both mount the same volume at `/app/media`.


## Question 73


**The Meta API requires an access token and user_id. These are provided in the assignment requirements.**

**Where do you store these credentials? The handler needs them to make API calls.**

Store the Meta API token in an environment variable (via Docker Compose .env file)

Environment variable via `.env` file. Proper practice.


## Question 74


**Last question on the seeding flow: When the API server boots and seeds the matcha jobs, what if the seed fails? For example:**

1. **DB isn't ready yet (common in Docker Compose — app starts before Postgres)**
2. **The **`UNIQUE (fileName, jobType, jobValue)`** constraint fires because jobs already exist from a previous run**

**Case 2 is expected on restart — you should handle it gracefully (ON CONFLICT DO NOTHING). But case 1 needs a strategy.**

No error handling beyond logging — if seeding fails, the process exits and Docker restarts it

Exit + Docker restart. Simple and effective for the DB-not-ready race condition. Docker's `restart: unless-stopped` handles it.

I believe I've covered all the major design branches. Let me compile everything into a comprehensive design document.

**Design Decisions**

That's a thorough grilling! I've compiled all **35+ decisions** into a comprehensive design document. Here's a quick recap of the key decisions we landed on:

**Architecture**: 4 processes — API+Scheduler, Relay, Sync Consumer, Download Consumer — all Docker Compose, one Dockerfile.

**Key design choices**:

- Floating schedule recovery (one catch-up sync, drift accepted)
- Redis raw lists (LPUSH/BRPOP) as dumb pipes, DB owns all state
- Relay with 3 durable retries → FAILED state
- Child process execution with 5-min timeout, FAILED is terminal
- Sync handler pushes download batch directly to Redis (separate queue)
- Download consumer with 10-concurrent pool
- Prisma + Jest + structured logging

**Potential risks I'd flag**:

1. **The sync handler pushing directly to Redis** bypasses the relay's delivery guarantee. If Redis push fails after metadata is stored, downloads are lost until the TODO sweep job is implemented.
2. **5-min timeout for the download handler** might be tight for 500 assets at 10 concurrency — that's \~50 batches of downloads, each needing at least a few seconds.
3. **UUIDs with cursor-based pagination** works but is slightly less efficient than ordered IDs (UUIDv7 or BIGSERIAL) since the cursor needs `createdAt + id` instead of just `id`.

The full design document is ready for reference when you start implementation
