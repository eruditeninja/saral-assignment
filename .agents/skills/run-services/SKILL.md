---
name: run-services
description: >-
  Use this skill when starting, stopping, building, or orchestrating local
  services (API server, Scheduler, Relay, Sync Consumer, Download Consumer).
---

# Service Orchestration & Execution Guide

This skill provides operational workflows for running the 4 independent processes of `saral-project`.

---

## 1. Multi-Process Architecture Overview

The system consists of 4 independent Node.js processes running concurrently:

| Process | Script / Command | Purpose |
|---|---|---|
| **API Server + Scheduler** | `npm run start:api` (or `npm run dev:api`) | Express REST API (`GET /hashtags`, `POST /schedule`) + Cron Poll Loop |
| **Relay Service** | `npm run start:relay` | Polls PostgreSQL `job_runs` (`PENDING`) and pushes IDs to Redis |
| **Sync Consumer** | `npm run start:sync-consumer` | Pops from Redis `jobQueue`, forks handler, and fetches Meta media |
| **Download Consumer** | `npm run start:download-consumer` | Pops from Redis `downloadQueue`, downloads assets to `./media/`, updates DB |

---

## 2. Local Startup Workflow

### Step 1: Ensure Prerequisites are Running
Ensure local PostgreSQL and Redis servers are running on their default ports:
- PostgreSQL on port `5432`
- Redis on port `6379`

### Step 2: Run All Services (Recommended)
Run all 4 services concurrently in a single terminal with colored log output and unified graceful shutdown:

```bash
npm start
# or
npm run start:all
# or
./start-all.sh
```

### Step 3: Run Services Individually (Optional)
If debugging or isolating a single service, run each in a separate terminal:

```bash
# Terminal 1: API Server & Cron Scheduler
npm run start:api

# Terminal 2: Relay Service
npm run start:relay

# Terminal 3: Sync Job Consumer
npm run start:sync-consumer

# Terminal 4: Media Download Consumer
npm run start:download-consumer
```

---

## 3. Verifying System Health & Operations

- **API Health Check**:
  ```bash
  curl http://localhost:3000/health
  ```
- **Fetch Hashtag Media API**:
  ```bash
  curl "http://localhost:3000/hashtags?hashtag=matcha&limit=10"
  ```
- **Inspect Redis Queue Lengths**:
  ```bash
  # Check depth of jobQueue
  redis-cli LLEN jobQueue

  # Check depth of downloadQueue
  redis-cli LLEN downloadQueue
  ```
