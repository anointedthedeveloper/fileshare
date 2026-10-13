# Parcel — temporary file sharing

Upload files up to **3 GB**, share a link, and have them **deleted automatically** after 1 hour to 30 days.
Anonymous or account-based, resumable chunked uploads, optional password / download limits, S3-compatible
object storage in production.

| | |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Backend | Node 22 + Express + Mongoose (MongoDB) + Zod |
| Storage | Adapter: local disk (dev / single node) or any S3-compatible service (production) |
| Auth | JWT in an HTTP-only cookie + double-submit CSRF token |

## Contents
1. [Design decisions](#design-decisions)
2. [Project structure](#project-structure)
3. [Quick start](#quick-start)
4. [Configuration](#configuration)
5. [Upload protocol](#upload-protocol)
6. [REST API](#rest-api)
7. [File-type policy & security](#file-type-policy--security)
8. [Expiration & deletion](#expiration--deletion)
9. [MongoDB setup](#mongodb-setup)
10. [Storage setup](#storage-setup)
11. [Production deployment](#production-deployment)
12. [Backup & restore](#backup--restore)
13. [Testing](#testing)
14. [Known limitations](#known-limitations)

---

## Design decisions

**Why chunked, proxied multipart uploads.** A single 3 GB request is fragile (proxies time out, one dropped
packet restarts everything) and a "normal Express upload" or serverless function cannot hold it. Instead:

* `initiate` returns a **part size** (8 MiB default) chosen by the server. The browser slices the `File`
  with `Blob.slice` and sends parts in parallel (3 at a time) as `POST …/parts?partNumber=N`, with the raw
  bytes as the request body.
* The API **streams each part straight into storage**. Memory is bounded by `PART_SIZE × concurrent parts`;
  a 3 GB file is never in RAM, and never in MongoDB.
* The **storage adapter** exposes one contract (`createMultipart / uploadPart / listParts / completeMultipart /
  abortMultipart`) with two real implementations:
  * **Local disk** – each upload owns one sparse file; part *N* is written at offset `(N-1)·partSize`, so
    completion is an atomic `rename`, not a 3 GB copy.
  * **S3-compatible** – native `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload`.
* **Resumability**: the server asks storage (`listParts`) which parts really landed, so a browser refresh, a
  dropped connection or an API restart continue from where they stopped. The client persists a random
  `clientKey` per file, which makes `initiate` idempotent (no duplicate records).
* Parts are proxied through the API (not presigned direct-to-bucket) deliberately: size limits, file
  signature checks, quota, rate limits and auth are then enforced **server-side on every byte**.
  Trade-off: upload bandwidth passes through the API tier (see [limitations](#known-limitations)).
* **MongoDB holds metadata only** (files, sessions, users, settings, audit/error logs). Bytes live in storage.

**Expiration is enforced three ways**, never by TTL alone: (1) every download/info request checks
`expiresAt` itself, so an expired file is unreachable even if cleanup is behind; (2) a background worker
physically deletes the object, then marks the record; (3) object-storage lifecycle rules as a safety net.
The MongoDB TTL index is on `purgeAt`, which is set **only after** the object was deleted — a TTL on
`expiresAt` would delete the record first and orphan the bytes forever.

## Project structure

```
.
├── backend/
│   ├── src/
│   │   ├── config.ts            env schema (Zod), hard limits (3 GB, 30 days), retention options
│   │   ├── app.ts / server.ts   Express app, graceful shutdown;  worker.ts = standalone cleanup worker
│   │   ├── models/              File, UploadSession, User, Settings, AuditLog, ErrorLog (+ indexes)
│   │   ├── storage/             types.ts (contract), local.ts, s3.ts, index.ts (factory)
│   │   ├── services/            uploads, files, cleanup (worker logic), filePolicy, retention,
│   │   │                        scanner (ClamAV + plug-in point), settings, auth, audit
│   │   ├── routes/              uploads, files, auth, user, admin, health
│   │   ├── middleware/          auth, csrf, rateLimit, errors (consistent envelope)
│   │   └── scripts/initDb.ts    create indexes + bootstrap admin
│   ├── tests/                   unit/API tests (mock storage) + integration/ (real storage)
│   └── Dockerfile
├── frontend/
│   ├── src/lib/upload.ts        resumable chunked uploader (XHR, retries, speed/ETA)
│   ├── src/pages/               Home, Download, Login, MyFiles, Admin
│   ├── src/components/          Dropzone, UploadProgress, UploadResult (QR), Navbar, ui
│   ├── nginx.conf               static hosting + streaming reverse proxy for /api
│   └── Dockerfile
├── docker-compose.yml           MongoDB + MinIO + API + worker + web
├── .env.example
└── .github/workflows/ci.yml
```

## Quick start

### A. Everything in Docker (MongoDB + MinIO + API + worker + web)
```bash
cp .env.example .env            # set JWT_SECRET and ADMIN_PASSWORD at least
docker compose up --build
# app:           http://localhost:8080
# MinIO console: http://localhost:9001   (minioadmin / minioadmin — change in .env)
```

### B. Local development (hot reload)
Prerequisites: Node ≥ 20, MongoDB (local or Docker).
```bash
docker compose up -d mongo minio minio-init    # or point MONGODB_URI at your own MongoDB

# backend  → http://localhost:4000
cd backend
cp ../.env.example .env                        # then edit: STORAGE_PROVIDER=local, MONGODB_URI=mongodb://127.0.0.1:27017/fileshare, NODE_ENV=development
npm install
npm run db:init                                # indexes + admin from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev

# frontend → http://localhost:5173  (Vite proxies /api to :4000 so cookies are same-origin)
cd ../frontend
npm install
npm run dev
```
`STORAGE_PROVIDER=local` writes to `LOCAL_STORAGE_PATH` (default `./data/storage`); no MinIO needed.

### Build / run without Docker
```bash
cd backend  && npm ci && npm run build && npm start          # API  (RUN_WORKER_IN_API=true runs the cleanup worker inside)
cd backend  && npm run worker                                # or a dedicated worker process
cd frontend && npm ci && npm run build                       # static files in frontend/dist
```

## Configuration

All backend settings are environment variables, validated at startup (`backend/src/config.ts`).
See [`.env.example`](.env.example) for the full annotated list. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/fileshare` | |
| `JWT_SECRET` | – | **Required in production.** `openssl rand -base64 48` |
| `PUBLIC_APP_URL`, `CORS_ORIGINS` | `http://localhost:5173` | CORS allows only these origins, with credentials |
| `STORAGE_PROVIDER` | `local` | `local` or `s3` |
| `LOCAL_STORAGE_PATH` | `./data/storage` | must be a persistent volume in production |
| `S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_FORCE_PATH_STYLE / S3_KEY_PREFIX` | | omit endpoint for AWS; `S3_FORCE_PATH_STYLE=true` for MinIO |
| `MAX_FILE_BYTES` | 3 GiB | cannot be configured above 3 GiB |
| `PART_SIZE_BYTES` | 8 MiB | S3 needs ≥ 5 MiB; auto-doubled if a file would need > 10 000 parts |
| `STORAGE_QUOTA_BYTES` | 500 GB | total of all non-deleted files incl. in-flight uploads |
| `ALLOW_ANONYMOUS_UPLOADS`, `ALLOW_REGISTRATION` | true | also togglable in the admin UI |
| `UPLOADS_PER_HOUR` | 60 | per client; counted in MongoDB so it holds across instances |
| `RATE_LIMIT_*` | | per-IP, per-instance burst limits (API / parts / download / auth / password) |
| `SCANNER` | `none` | `clamav` enables a clamd INSTREAM scan at finalisation |
| `RUN_WORKER_IN_API` | true | set false and run `npm run worker` separately when scaling the API |
| `CLEANUP_INTERVAL_SECONDS`, `DELETE_MAX_ATTEMPTS`, `DELETE_RETRY_BASE_SECONDS`, `TOMBSTONE_HOURS` | 60, 8, 30, 24 | cleanup tuning |
| `TRUST_PROXY` | 0 | number of proxies in front of the API (so rate limits see real IPs) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | bootstrap administrator (created or promoted on start) |

Administrators can lower upload size, quota, per-hour uploads, available retention periods, blocked
extensions, and toggle anonymous uploads / registration at runtime (Admin → Settings). The 3 GB and 30-day
ceilings are compiled in and cannot be raised from the UI, the API or the environment.

## Upload protocol

```
POST   /api/uploads/initiate            { filename, size, retention, mimeType?, password?, downloadLimit?, clientKey? }
  → 201 { sessionId, partSize, totalParts, expectedSize, uploadedParts:[], manageToken }   (200 + resumed:true on replay)
POST   /api/uploads/:sessionId/parts?partNumber=N      body = raw bytes, Content-Length must equal the part size
  → 200 { partNumber, size, etag }        parts may be sent in any order, in parallel, and may be retried
GET    /api/uploads/:sessionId           → { status, uploadedParts:[…], uploadedBytes, … }   (use to resume)
POST   /api/uploads/:sessionId/complete  → 200 { state:"completed", file:{ fileId, name, size, expiresAt, … } }
                                           202 { state:"processing" }  (large files still being assembled/hashed/scanned → poll again)
                                           409 incomplete_upload       (parts missing; upload them and call again)
DELETE /api/uploads/:sessionId           → 204   cancels and removes partial data
```
Every part is exactly `partSize` bytes except the last. The file becomes visible **only after** `complete`
has assembled the object, verified size and file signature, computed SHA-256 and run the scanner. The first
part's header is checked while streaming, so a mismatching 3 GB file is rejected after a few KB.

`manageToken` (returned once, stored hashed) lets an anonymous uploader delete their file via
`X-Manage-Token`. Idempotency: repeating `initiate` with the same `clientKey` returns the same session.

## REST API

All errors use one envelope: `{ "error": { "code": "file_too_large", "message": "…", "details"?: … } }`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/config` | – | limits, available retention options, flags (drives the UI) |
| `POST /api/uploads/initiate` · `GET/POST/DELETE /api/uploads/:id…` | anon or user | see above |
| `GET /api/files/:fileId` | – | public metadata (name, size, expiry, password flag, executable warning) |
| `GET /api/files/:fileId/status` | – | `200 ready` · `410 expired/deleted` · `404` |
| `POST /api/files/:fileId/unlock` `{password}` | – (rate limited) | returns a 15-min download token for protected files |
| `GET /api/files/:fileId/download[?token=]` | – | streams as attachment; supports `Range`, `HEAD` |
| `DELETE /api/files/:fileId` | owner, admin, or `X-Manage-Token` | delete now |
| `POST /api/auth/register · login · logout`, `GET /api/auth/me` | – | cookie sessions; responses include `csrfToken` |
| `GET /api/user/files?page&pageSize` | user | list own files (status, downloads, deletion state) |
| `GET /api/admin/stats` | admin | totals, bytes, active/expired, failures, quota, recent errors |
| `GET /api/admin/files?state=all\|active\|expired\|failed\|uploading` · `DELETE /api/admin/files/:id` | admin | |
| `GET/PUT /api/admin/settings` · `POST /api/admin/cleanup/run` · `GET /api/admin/audit` · `GET /api/admin/errors` | admin | all state changes are audit-logged |
| `GET /health/live`, `GET /health/ready` | – | liveness; readiness checks MongoDB **and** storage |

Status codes: `400` validation · `401` auth/password · `403` forbidden/CSRF · `404` unknown link ·
`409` conflict/incomplete · `410` expired/deleted/limit reached · `413` too large · `415` signature mismatch ·
`416` bad range · `429` rate limited · `507` storage full.
CSRF: state-changing requests that carry the auth cookie must send `X-CSRF-Token` (the value from login / `/me`).

## File-type policy & security

* **No fixed allow-list.** Any extension is accepted unless an admin blocks it. A built-in registry
  (`backend/src/services/filePolicy.ts`) maps ~60 common extensions (PDF, Office, ZIP/RAR/7Z, **EXE/MSI/APK**,
  images, video, audio, source files…) to a MIME type and, where reliable, a **magic-number signature** that
  is verified on the first bytes (while streaming, and again from storage at finalisation). Unknown
  extensions pass without a signature check.
* Extend it with a JSON file (`FILE_POLICY_PATH`):
  ```json
  { "types": { "xyz": { "mime": "application/x-xyz", "magic": "XYZ1", "warn": true } }, "remove": ["bat"] }
  ```
* The declared browser MIME is advisory; it is rejected only if it contradicts the extension's media
  category (e.g. `video/mp4` for `.png`). The stored MIME always comes from the server's registry.
* **Uploaded files are never executed or parsed** by the server. Downloads are always
  `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
  and **HTML/SVG/JS/CSS/XML are served as `application/octet-stream`**, so they can never render in the app's origin.
* The download page shows an **"only open if you trust the sender"** warning for executables and APKs.
* Filenames are sanitised (path components, control and bidi characters, Windows reserved names). Storage keys
  are random and unrelated to filenames; the local adapter additionally refuses any key that escapes its root.
* Helmet, strict CORS, per-route rate limits (password guessing is limited per IP **and** file), bcrypt for
  passwords (links and accounts), HMAC-pseudonymised client IPs, redacted structured logs (pino), audit log
  for admin actions, 128-bit unguessable file IDs.
* **Malware scanning**: set `SCANNER=clamav` (requires `clamd` with `StreamMaxLength 3G`). The scan runs in the
  same single pass as the checksum, fail-**closed** (a scanner outage rejects the upload). To integrate another
  engine, implement `Scanner` in `services/scanner.ts` and call `setScanner()`.

## Expiration & deletion

Retention options: 1 h, 6 h, 12 h, 1 d, 3 d, 7 d, 14 d, 30 d. `expiresAt` is computed **by the server**
(`completion time + retention`); requests with `retentionSeconds > 2 592 000`, unknown options, or any
client-supplied `expiresAt` are rejected with `400`. Downloads never extend it.

The worker (`services/cleanup.ts`, every `CLEANUP_INTERVAL_SECONDS`):
1. **Claims** expired / pending / retryable files atomically (`deletion.status → in_progress` with a lock), so
   multiple workers never double-delete and a crashed worker's stale lock is simply reclaimed (resume-safe).
2. Deletes the object from storage (idempotent — already-missing counts as success), then marks the record
   `deleted`, wipes secrets, and sets `purgeAt` (tombstone for `TOMBSTONE_HOURS` so links answer `410`, not `404`).
   `TOMBSTONE_HOURS=0` removes the record immediately.
3. On storage failure: records `lastError`, exponential back-off (30 s → … capped at 6 h), writes a system error
   (visible in Admin), and **keeps retrying indefinitely** — the file stays blocked from download meanwhile.
4. Aborts abandoned upload sessions (expired or idle), releases storage multipart state, removes the never-published
   file record; returns stuck `completing` sessions to `active`; queues orphaned `uploading` records.
5. Purges tombstones past `purgeAt` (the Mongo TTL index on `purgeAt` does the same, as a supplement).

Run it inside the API (`RUN_WORKER_IN_API=true`) or as a separate process (`npm run worker`).

## MongoDB setup

* Any MongoDB ≥ 6 (standalone is sufficient; Atlas or a replica set recommended in production).
* Create a dedicated database user with `readWrite` on the `fileshare` database and set `MONGODB_URI`.
* Indexes are created automatically on start; to do it explicitly (e.g. in a release step):
  ```bash
  cd backend && npm run db:init     # syncIndexes() for all models + bootstrap admin
  ```
  Notable indexes: unique `fileId`/`storageKey`; `{deletion.status, expiresAt}` and `{deletion.status,
  deletion.nextAttemptAt}` (cleanup); `{ownerId, createdAt}` (My Files); unique partial `{scopeKey, clientKey}`
  (idempotent initiate); TTL on `File.purgeAt`, `UploadSession.purgeAt`, `ErrorLog.createdAt` (30 days).

## Storage setup

**Local disk** (`STORAGE_PROVIDER=local`): set `LOCAL_STORAGE_PATH` to a directory on a **persistent, large volume**.
Fine for development or one node; it cannot be shared across multiple API replicas.

**S3-compatible** (`STORAGE_PROVIDER=s3`) — recommended for production:
1. Create a **private** bucket (no public access, no public ACLs).
2. Create credentials limited to that bucket with: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`,
   `s3:ListBucket`, `s3:ListBucketMultipartUploads`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`.
3. Set `S3_BUCKET`, `S3_REGION`, keys. For non-AWS: also `S3_ENDPOINT` (and `S3_FORCE_PATH_STYLE=true` for MinIO).
   Examples: Cloudflare R2 `https://<account>.r2.cloudflarestorage.com` (region `auto`), Backblaze B2
   `https://s3.<region>.backblazeb2.com`, MinIO `http://minio:9000`.
4. **Lifecycle rules as a safety net** (the app still enforces expiry itself). AWS example:
   ```json
   { "Rules": [
     { "ID": "abort-stale-multipart", "Status": "Enabled", "Filter": {"Prefix": "files/"},
       "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 } },
     { "ID": "expire-backstop", "Status": "Enabled", "Filter": {"Prefix": "files/"},
       "Expiration": { "Days": 31 } } ] }
   ```
   `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json`.
   The 31-day expiry sits one day above the 30-day maximum so it can only ever remove objects the worker missed.
   Keep the prefix equal to `S3_KEY_PREFIX`. (Lifecycle granularity is daily, which is why it is a backstop, not the mechanism.)
5. Capacity: production storage must be **persistent** and sized for `STORAGE_QUOTA_BYTES`. Do not use ephemeral
   container/PaaS disks.

## Production deployment

Reference topology: **frontend (nginx) → API (1..n) + worker → MongoDB (Atlas/replica set) + S3-compatible bucket.**

1. Provision MongoDB and a bucket (above). Generate `JWT_SECRET`.
2. Put the config in your secret manager / `.env` (never in the image). Set `NODE_ENV=production`,
   `COOKIE_SECURE=true`, `CORS_ORIGINS=https://files.example.com`, `TRUST_PROXY=1`, `STORAGE_PROVIDER=s3`,
   `RUN_WORKER_IN_API=false`.
3. Build and run: `docker compose up -d --build` (drop the `minio`/`mongo` services and point the env at your
   managed ones), or deploy `backend/` and `frontend/` images separately. Run **one** `worker` container
   (more are safe, just redundant).
4. **Serve the frontend and the API from the same site** (the provided nginx proxies `/api`). Cookies are then
   first-party and `SameSite=Lax` works with CSRF protection intact. Terminate TLS in front (Caddy, a cloud
   load balancer, …). Whatever sits in front **must not buffer request bodies** and needs read/send timeouts of
   several minutes (`proxy_request_buffering off; proxy_read_timeout 1800s;` — already set in `frontend/nginx.conf`).
   Cloudflare's free proxy limits request bodies to 100 MB: that is fine because each *part* is ≤ `PART_SIZE_BYTES`.
5. **Do not deploy the API on serverless functions** (request body/time limits, no streaming); use containers/VMs.
6. Health checks: `GET /health/live` (liveness), `GET /health/ready` (MongoDB + storage).
7. Scale-out: run several API replicas behind the load balancer (any replica can serve any part, because state
   is in MongoDB and storage). Use S3 storage (local disk is single-node). Add a shared rate limiter at the edge.
8. Create the first admin via `ADMIN_EMAIL`/`ADMIN_PASSWORD`, sign in, open **/admin**, review settings.

## Backup & restore

* **MongoDB** holds accounts, settings, audit logs and file metadata:
  `mongodump --uri "$MONGODB_URI" --gzip --archive=fileshare-$(date +%F).gz` · restore with
  `mongorestore --uri "$MONGODB_URI" --gzip --archive=fileshare-….gz --drop`. On Atlas enable continuous backups.
  Run `npm run db:init` after a restore to re-sync indexes.
* **File bytes are temporary by design** (max 30 days). Backing them up is usually unnecessary; if your policy
  requires it, enable bucket versioning/cross-region replication, but note the app deletes expired objects on purpose.
* Restoring metadata older than the storage state is safe: the worker deletes anything past `expiresAt`, and a
  `ready` record whose object is gone returns `404 object_missing` and is logged.
* Local-disk deployments: snapshot the volume together with the MongoDB dump.

## Testing

```bash
cd backend
npm test                     # 89 unit/API tests — real MongoDB (mongodb-memory-server), mock storage
npm run test:integration     # real HTTP server + real storage provider (local disk by default)

# against an S3-compatible service (MinIO, moto, R2, AWS…):
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=fileshare-test npm run test:integration

# a genuine 3 GB upload → verify → download → expire → physical delete (needs ~3 GB free disk, ~1 min):
RUN_LARGE_FILE_TEST=1 npx vitest run tests/integration/e2e.test.ts
```
Covered: small upload; 3 GB limit (logic tested via request size, **no 3 GB allocation**); chunked upload,
out-of-order/retried parts, resume after interruption, failure recovery; retention validation (>30 d rejected);
expired links blocked before cleanup; background deletion; retry/back-off/stale-lock recovery of failed
deletions; concurrent workers; unauthorized deletion; password links + brute-force limiting; download limits under
concurrency; invalid filenames/metadata/signatures; streaming + Range + HEAD; abandoned session cleanup;
CSRF; admin authorization + audit; client-disconnect handling; TTL index placement.

## Known limitations

These are real, not hypothetical:

* **Docker images were not built in the development sandbox** (no Docker daemon there). `docker-compose.yml`
  was validated with `docker compose config`; the backend was verified via the same `npm run build` +
  `node dist/server.js` / `dist/worker.js` steps the Dockerfile runs, and the frontend via `vite build`.
  Run `docker compose up --build` once on your machine to confirm.
* **The S3 adapter was exercised against the `moto` S3 emulator, not against AWS S3 or MinIO** (both were
  unavailable in the sandbox). It uses only standard multipart calls, but run
  `S3_TEST_ENDPOINT=… npm run test:integration` against your real provider before going live.
* The genuine 3 GB test was run against **local-disk storage** (upload 34 s, download 12 s on the dev VM); the same
  size over S3 is covered by the multipart contract tests at 5 MiB parts, not by a 3 GB run.
* Part bytes are **proxied through the API**, so API bandwidth ≈ upload bandwidth, and the S3 adapter buffers a single part
  (≤ `PART_SIZE_BYTES`) in memory to sign it. Presigned direct-to-bucket uploads would offload the API but would
  move signature/size enforcement to post-hoc checks; not implemented.
* `express-rate-limit` is **per process**. The hourly-upload cap is MongoDB-backed and shared; for the burst
  limits across replicas, add an edge/CDN limiter or a shared store.
* ClamAV scanning of a 3 GB file can take minutes; `complete` then answers `202` and the client polls. clamd's
  `StreamMaxLength` must be raised to ≥ 3 GB or large files are (safely) rejected.
* No e-mail verification or password reset; no per-user quotas; no multi-range (`Range: a-b,c-d`) responses
  (they fall back to the full file).
* Two simultaneous retries of the *same* part number can race on local disk (they carry identical bytes, so the
  result is still correct); the client never does this.
* Anonymous per-client limits key on a pseudonymised IP, so users behind one NAT share a counter.
* Download tokens for password-protected files travel in a query string (15-minute lifetime, redacted from logs);
  browsers need a plain URL to stream a large attachment natively.
