import { del } from '@vercel/blob';
import { files } from './_lib/db.js';
import { CODE_RE, esc } from './_lib/util.js';

const size = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Parcel</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#fafaf9;color:#1c1917;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:28px;box-shadow:0 1px 2px rgba(28,25,23,.04);animation:up .45s cubic-bezier(.2,.7,.2,1) both}
@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
h1{margin:0 0 4px;font-size:18px;font-weight:600;word-break:break-word}
.m{color:#78716c;font-size:14px;margin:0}
.btn{display:block;margin-top:22px;text-align:center;background:#2f6f73;color:#fff;text-decoration:none;font-weight:500;padding:13px;border-radius:10px;transition:background .2s,transform .1s}
.btn:hover{background:#265b5f}.btn:active{transform:translateY(1px)}
.home{display:block;margin-top:18px;text-align:center;color:#78716c;font-size:13px;text-decoration:none}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><main class="card">${body}</main></body></html>`;

function html(res, status, title, body) {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8').setHeader('Cache-Control', 'no-store').send(page(title, body));
}
const gone = (res, status, h, p) =>
  html(res, status, h, `<h1>${esc(h)}</h1><p class="m">${esc(p)}</p><a class="home" href="/">Send a file</a>`);

export default async function handler(req, res) {
  const code = String(req.query.code ?? '').toLowerCase();
  if (!CODE_RE.test(code)) return gone(res, 404, 'Link not found', 'Check that the link was typed correctly.');

  const col = await files();
  const f = await col.findOne({ code });
  if (!f) return gone(res, 404, 'Link not found', 'Check that the link was typed correctly.');

  if (f.expiresAt.getTime() <= Date.now()) {
    // dead immediately; physically remove it now rather than waiting for the cron
    await del(f.url).then(() => col.deleteOne({ _id: f._id })).catch(() => {});
    return gone(res, 410, 'This file has expired', 'Files are only kept for a short time. Ask the sender to upload it again.');
  }

  const dl = `${f.url}?download=1`;
  if (req.query.d) return res.redirect(302, dl); // /abcd?d=1 starts the download directly

  const mins = Math.max(1, Math.round((f.expiresAt.getTime() - Date.now()) / 60000));
  const left = mins >= 1440 ? `${Math.floor(mins / 1440)} day(s)` : mins >= 60 ? `${Math.floor(mins / 60)} hour(s)` : `${mins} minute(s)`;
  return html(
    res,
    200,
    f.name,
    `<h1>${esc(f.name)}</h1><p class="m">${size(f.size)} · available for about ${left}</p>
<a class="btn" href="${esc(dl)}" rel="noopener">Download</a><a class="home" href="/">Send a file</a>`,
  );
}
