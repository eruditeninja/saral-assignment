---
name: database-ops
description: >-
  Use this skill when modifying the Prisma schema, generating the Prisma client,
  running database migrations, seeding jobs, or inspecting PostgreSQL data.
---

# Database Operations & Migrations Guide

This skill guides the agent through managing the PostgreSQL database and Prisma ORM in `saral-project`.

---

## 1. Schema Modifications (`prisma/schema.prisma`)

When modifying models in [`prisma/schema.prisma`](file:///Users/air/Downloads/saral-project/prisma/schema.prisma):

1. **Keep Mapping Consistent**: Always map camelCase TypeScript fields to snake_case column names using `@map("column_name")` and model names using `@@map("table_name")`.
2. **Preserve Unique Constraints**:
   - `job_runs`: `@@unique([jobId, nextRunAt])`
   - `media`: `@@id([hashtagName, mediaId])`

---

## 2. Generating Client & Applying Migrations

Execute the following commands in sequence:

```bash
# 1. Regenerate TypeScript client types
npx prisma generate

# 2. In development: create and apply migration
npx prisma migrate dev --name <descriptive_migration_name>

# 3. In production: deploy migrations non-interactively
npx prisma migrate deploy
```

---

## 3. Seeding Default Matcha Jobs

The default sync jobs are seeded in [`src/api/seed.ts`](file:///Users/air/Downloads/saral-project/src/api/seed.ts).

To manually trigger or verify seeding:
```bash
# Start API or run ts-node script
npx ts-node src/api/seed.ts
```

Seeded records:
1. `metaSyncHashtag.js` — `0 */3 * * *` — `{ hashtag: "matcha", mediaType: "top_media" }`
2. `metaSyncHashtag.js` — `0 */3 * * *` — `{ hashtag: "matcha", mediaType: "recent_media" }`

---

## 4. Troubleshooting Database Connection

- Ensure PostgreSQL service is active and listening on port 5432.
- If connection fails, verify `DATABASE_URL` in `.env`:
  `postgresql://saral:saral@localhost:5432/saral_hashtag`
