Build the Job Scheduler service for the hashtag sync system, based on 
this design. Before implementing, ask me questions on anything still ambiguous 
or missing. Do not propose implementation yet.

## Components

### 1. Scheduler Service
- Can run as multiple instances — concurrency-safe via SELECT ... FOR UPDATE 
  SKIP LOCKED (no leader election / lease table needed).
- Source of truth for scheduling is the DB, not in-process cron timers.
- Exposes POST /schedule
  {
    jobType: "once" | "recurring",
    jobValue: <ISO timestamp> | <cron expr, e.g. "0 */3 * * *">,
    fileName: "metaRecentPost.js"
  }
- On request: insert a row into `jobs` table, computing and storing the 
  initial `nextRunAt` from `jobValue`.
- Poll loop (runs in every instance) every N seconds:
    BEGIN;
      SELECT * FROM jobs
      WHERE active = true AND nextRunAt <= now()
      FOR UPDATE SKIP LOCKED
      LIMIT <batchSize>;
    ...
  Every row returned — whether due because time naturally passed, or because 
  it was missed during downtime — is processed identically, including 
  immediately on boot.
- For each due job, within the same transaction as the SELECT above:
  1. If jobType = "once" → set jobs.active = false.
  2. If jobType = "recurring" → advance jobs.nextRunAt to the next scheduled 
     time based on jobValue.
  3. Insert one jobRuns row (see schema below) with relayStatus = PENDING, 
     status = QUEUED.
  COMMIT (releases the row lock). No external system (queue) is touched 
  inside this transaction.
  If the insert hits the UNIQUE (jobId, nextRunAt) constraint, treat as 
  already-processed and skip.

### 2. Relay (separate process, also multi-instance safe via SKIP LOCKED)
- Polls: SELECT ... FROM jobRuns WHERE relayStatus = 'PENDING' 
  FOR UPDATE SKIP LOCKED LIMIT <batchSize>
- Pushes payload to the real queue.
- On confirmed push → UPDATE relayStatus = 'SENT', sentAt = now().
- Delivery is at-least-once, not exactly-once — consumer must be idempotent.

### 3. Queue
- Candidates: RabbitMQ / Redis / AWS SQS / in-memory (local dev).

### 4. Consumer
- On pickup, atomically transitions state via:
    UPDATE jobRuns SET status = 'PICKED' WHERE id = :id AND status = 'QUEUED'
  0 rows affected → duplicate delivery, skip (ack without processing).
  1 row affected → proceed, execute the handler file (fileName).
- On completion: status = SUCCESS or FAILED (+ errorMessage).
- Writes only to status/errorMessage — never touches relayStatus.

## Data model (merged jobRuns; relayStatus and status are independent 
dimensions written by different processes)
- jobs — id, jobType, jobValue, fileName, activeFlag, nextRunAt
- jobRuns:
  - id
  - jobId
  - nextRunAt          -- snapshot of jobs.nextRunAt at creation time; NOT a 
                           live reference, jobs.nextRunAt is advanced past 
                           this in the same transaction
  - payload (jsonb)
  - relayStatus         -- PENDING | SENT       (owned by relay)
  - sentAt
  - status              -- QUEUED | PICKED | SUCCESS | FAILED  (owned by consumer)
  - errorMessage
  - createdAt
  UNIQUE (jobId, nextRunAt)

## decisions
1. Producer-side atomicity → merged into jobRuns, single transaction, no 
   separate outbox table.
2. "Exactly once" → at-least-once delivery + idempotent consumer.
3. jobType "once" auto-expiry → same transaction as jobRuns insert.
4. Terminal success status → SUCCESS.
5. Scheduler Service scaling → multi-instance safe via SELECT ... FOR UPDATE 
   SKIP LOCKED; no single-instance restriction needed.
6. Consumer idempotency → conditional UPDATE ... WHERE status = 'QUEUED'.
7. Producer idempotency → composite UNIQUE (jobId, nextRunAt) on jobRuns.
8. Missed-tick recovery → DB-backed poll loop against jobs.nextRunAt; a crash 
   before commit rolls back cleanly (lock released, nothing advanced) and is 
   naturally retried on the next poll cycle.
9. SKIP LOCKED and the UNIQUE constraint solve different, non-overlapping 
   problems and both are required: SKIP LOCKED prevents two concurrent 
   pollers from grabbing the same row at the same instant (no lock to skip 
   once a transaction has committed or rolled back); UNIQUE (jobId, 
   nextRunAt) prevents the same logical tick from being recorded twice ever, 
   including sequential, non-concurrent duplicate attempts (e.g. a retried 
   insert long after the original transaction committed).
10. Merging outbox into jobRuns removes the need for a separate delivery-
    plumbing cleanup policy — the row's lifetime is the job run's history 
    lifetime.
