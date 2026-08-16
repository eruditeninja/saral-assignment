# Hashtag Tracking System — Instructions

## setup

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### Running the System Locally

1. Ensure `.env` exists in the project root with the necessary PostgreSQL, Redis, and Meta Graph API credentials:
   ```bash
   cp .env.example .env
   # Edit .env with your PostgreSQL, Redis, and Meta credentials
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Generate Prisma client & apply database migrations:
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```

4. Build and run all services with a single command:
   ```bash
   npm start
   ```

   *Alternatively, run services individually in separate terminals:*
   ```bash
   # Terminal 1: API Server + Scheduler
   npm run start:api

   # Terminal 2: Relay Service
   npm run start:relay

   # Terminal 3: Sync Job Consumer
   npm run start:sync-consumer

   # Terminal 4: Media Download Consumer
   npm run start:download-consumer
   ```

### API Endpoints & cURL Examples

#### 1. Fetch Ingested Hashtags (Paginated)

```bash
curl --location 'http://localhost:3000/hashtags' \
--header 'Accept: application/json'
```

**Fetch Subsequent Pages:**
Pass the `next_cursor` from the response:
```bash
curl --location 'http://localhost:3000/hashtags?cursor=<next_cursor>' \
--header 'Accept: application/json'
```

#### 2. Schedule a Hashtag Sync Job

**Recurring Cron Job (e.g. Every 6 Hours):**
```bash
curl --location 'http://localhost:3000/schedule' \
--header 'Content-Type: application/json' \
--data '{
  "jobType": "recurring",
  "jobValue": "0 */6 * * *",
  "fileName": "metaSyncHashtag.js",
  "payload": {
    "hashtag": "matcha",
    "mediaType": "top_media"
  }
}'
```

**One-Time Job (Future ISO Timestamp):**
```bash
curl --location 'http://localhost:3000/schedule' \
--header 'Content-Type: application/json' \
--data '{
  "jobType": "once",
  "jobValue": "2026-08-17T12:00:00.000Z",
  "fileName": "metaSyncHashtag.js",
  "payload": {
    "hashtag": "matcha",
    "mediaType": "recent_media"
  }
}'
```

#### 3. Health Check

```bash
curl --location 'http://localhost:3000/health'
```

---

## vars

The following environment variables configure the system:

| Variable | Description | Default / Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://saral:saral@localhost:5432/saral_hashtag` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `META_ACCESS_TOKEN` | Meta Graph API Page Access Token | `<Meta Graph API token>` |
| `META_USER_ID` | Instagram Business User ID | `17841480695597364` |
| `META_API_VERSION` | Meta Graph API Version | `v24.0` |
| `PORT` | API Server listening port | `3000` |
| `MEDIA_DIR` | Directory for downloaded media assets | `./media` |

---

## tradeoffs

The following design decisions and trade-offs were made per the confirmed architecture:

| Item | Status / Rationale |
|---|---|
| **Missed Tick Recovery (Floating Schedule)** | Trade-off — If the scheduler experiences downtime, it executes a single catch-up sync and calculates `nextRunAt = now() + interval`. Drift is accepted to prevent redundant heavy ingestion. |
| **Stuck Job Detector (`PICKED` -> `FAILED`)** | TODO — Future enhancement: periodic sweeper to detect and transition abandoned `PICKED` rows older than 10 minutes. |
| **Failed Download Sweeper** | TODO — Future enhancement: background sweeper to retry items where `media_url` is null and `source_url` is present. |
| **Data Retention / Cleanup Cron** | TODO — Future enhancement: periodic table partitioning or cleanup of historic `job_runs`. |

---

## ai-usage

### Tools Used
- **Antigravity AI Agent** with Claude Opus 4.6 (Thinking) & Gemini 3.7 Flash for design analysis, architecture formulation, and systematic code implementation.
- **Grill-Me Skill** for comprehensive, rigorous multi-round interactive architecture evaluation.

### How AI Was Used (Workflow & Process)
1. **Requirements Analysis & Initial Design Formulation**:
   - Analyzed [`md-files/requirment.md`](file:///Users/air/Downloads/saral-project/md-files/requirment.md) and mapped out the initial component-level architecture.
   - Collaborated with AI to standardize initial thoughts, component responsibilities, and concurrency models, producing the initial design document [`md-files/initial-solution.md`](file:///Users/air/Downloads/saral-project/md-files/initial-solution.md).

2. **In-Depth Architectural Review Session (`/grill-me`)**:
   - Fed [`md-files/initial-solution.md`](file:///Users/air/Downloads/saral-project/md-files/initial-solution.md) and [`md-files/requirment.md`](file:///Users/air/Downloads/saral-project/md-files/requirment.md) into the `/grill-me` interactive review skill.
   - Conducted an intensive ~2-hour technical grilling session spanning **over 70 question-and-answer interactions** to pressure-test edge cases, failure states, and schema invariants.
   - Complete transcript is preserved in [`md-files/grill-me-chat-formatted.md`](file:///Users/air/Downloads/saral-project/md-files/grill-me-chat-formatted.md).

3. **Design Decisions Specification**:
   - Consolidated all agreed-upon decisions from the interview into [`md-files/design_decisions.md`](file:///Users/air/Downloads/saral-project/md-files/design_decisions.md).
   - This document served as the blueprint covering database constraints, transactional outbox relay, queue schemas, consumer concurrency (`p-limit`), and rate-limit backoff.

4. **Iterative Implementation & Extensibility**:
   - Generated clean, modular TypeScript service components (Express API Server, PostgreSQL Cron Scheduler, Transactional Outbox Relay, Sync Consumer, and Download Consumer).
   - Built a provider abstraction layer (`IQueueProvider`, `IStorageProvider`, `IJobExecutor`) to keep the system extensible for future cloud migrations (e.g., SQS, S3, Lambda).

### What Was Handcrafted, Reviewed, and Tested Manually
- **Database Schema Design & Constraints**: Manually crafted and verified composite primary keys `(hashtag_name, media_id)`, multi-column unique constraints `(file_name, job_type, job_value)` and `(job_id, next_run_at)`, and index definitions.
- **End-to-End API Testing**: Manually executed `curl` queries across `/hashtags` and `/schedule` endpoints.
- **Bug Detection & Fixes**: Identified and fixed subtle pagination and cursor boundary edge cases discovered during manual API validation.
- **Pagination & Ingestion Rate Limiting**: Verified 20-page caps (500 items max), cursor traversal, adaptive limit downscaling on Meta code 1 errors, and exponential backoff retry on HTTP 429 status codes.
