# Parcel

Upload a file (up to **1 GB**), get a short link like `s.anobyte.online/k3x9`. The file is deleted automatically
after the time you pick — **1 hour, 6 hours, 1 day or 3 days (never longer)**. No accounts, no admin.

One Vercel project: React page + 4 tiny serverless functions. Files go **browser → Vercel Blob** directly
(functions can't take big uploads); MongoDB stores only the short code + expiry.

## Deploy (about 5 minutes)
1. Push this repo to GitHub → Vercel → **Add New Project** → import it (Vite is detected).
2. In the project: **Storage → Create → Blob**, connect it to the project. This adds `BLOB_READ_WRITE_TOKEN` for you.
3. **Settings → Environment Variables → Import .env** and use `.env.example` with your real `MONGODB_URI`
   (or add the MongoDB Atlas integration from the Vercel Marketplace, which injects it automatically).
   In Atlas → **Network Access** allow `0.0.0.0/0` (Vercel's IPs change).
4. **Settings → Domains** → add `s.anobyte.online`, and add the DNS record Vercel shows (CNAME → `cname.vercel-dns.com`).
5. Redeploy. Done.

## How it works
- `POST /api/upload` – hands the browser a short-lived upload token (1 GB cap enforced by Blob itself).
- `POST /api/register` – verifies the uploaded file, saves it in MongoDB, returns a 4-character code.
- `GET /:code` – download page (`/:code?d=1` starts the download immediately). Expired links die instantly.
- `GET /api/cleanup` – daily cron: deletes expired files from Blob, then their MongoDB records. Expired files are
  also removed lazily when someone opens the link and on every new upload.

Codes are 4 lowercase letters/digits (no look-alikes like 0/o/1/l); on a collision it retries, then grows to 5 characters.

## Local run / tests
```bash
npm i
npm test            # API tests (real MongoDB, mocked Blob)
npm run dev:ui      # UI only
npx vercel dev      # full app (needs `vercel link` + env pulled)
```

## Honest limits
- Not tested against a real Vercel Blob store (none available while building); the Blob calls are standard but
  do one real upload after deploying.
- Files are **public-by-URL**: anyone with the link (or the Blob URL) can download until expiry. Fine for sharing; not for secrets.
- No resume after a closed tab (an interrupted upload restarts). Check your Vercel plan's Blob storage/transfer limits for 1 GB files.
- Vercel Hobby cron runs once a day, so the *bytes* may linger up to ~24 h after expiry; the *link* is dead immediately.
