# Backend Standards & Coding Conventions

This rule enforces coding, logging, error handling, and API design standards for `saral-project`.

---

## 1. TypeScript & Code Style

- **Strict Typing**: Never use `any` unless absolutely necessary for dynamic payload deserialization. Use explicit interfaces or generics.
- **Config Single Source of Truth**: All environment variables must be accessed through [`src/shared/config.ts`](file:///Users/air/Downloads/saral-project/src/shared/config.ts). Do not read `process.env` directly in domain logic or handlers.
- **Prisma Singleton**: Always import `prisma` from [`src/shared/prisma.ts`](file:///Users/air/Downloads/saral-project/src/shared/prisma.ts) to prevent connection pool exhaustion.
- **Redis Singleton**: Always import `getRedisClient()` or `redis` from [`src/shared/redis.ts`](file:///Users/air/Downloads/saral-project/src/shared/redis.ts).

---

## 2. Structured Logging with Pino

- **No `console.log`**: Always import `logger` from [`src/shared/logger.ts`](file:///Users/air/Downloads/saral-project/src/shared/logger.ts).
- **Log Levels**:
  - `logger.info()`: Key milestones (service boot, job picked, sync finished with counts).
  - `logger.warn()`: Non-fatal retries, transient network errors, rate limit warnings.
  - `logger.error()`: Uncaught exceptions, failed job runs, child process errors.
  - `logger.debug()`: Verbose step-by-step cursor traversal (only enabled in debug mode).
- **Structured Fields**: Pass an object as the first argument, e.g.:
  ```typescript
  logger.info({ jobId, hashtag: "matcha", count: 25 }, "Media batch successfully synced");
  ```

---

## 3. Express 5 API Conventions

- **Cursor Pagination Pattern (`GET /hashtags`)**:
  - Accepts query parameters: `hashtag` (string, required), `limit` (integer, default 25, max 100), `cursor` (base64 string, optional).
  - Cursors encode `{"timestamp": "ISO_STRING", "mediaId": "STRING"}`.
  - Query sorts by `timestamp DESC, mediaId DESC`.
  - Response structure:
    ```json
    {
      "data": [ ... ],
      "pagination": {
        "nextCursor": "eyJ0aW1lc3RhbXAiOi4uLiJ9",
        "hasMore": true
      }
    }
    ```
- **Error Response Standard**:
  ```json
  {
    "error": {
      "message": "Human-readable error description",
      "code": "INVALID_INPUT"
    }
  }
  ```

---

## 4. Child Process & Worker Safety

- **Exit Codes**: Handler processes must explicitly exit with code `0` on success and non-zero code on failure.
- **IPC Messages**: Use standard `process.send({ type: 'STATUS', ... })` if communicating intermediate progress to the parent consumer.
- **Graceful Shutdown**: All consumer loops must catch `SIGTERM` / `SIGINT` signals, close open Redis connections, and finish in-flight operations before terminating.
