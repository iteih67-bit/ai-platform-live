/**
 * ai-live-platform - zero-dependency Node server.
 * Routes:
 *   GET  /              -> status dashboard (HTML)
 *   GET  /healthz       -> liveness/readiness JSON (for the hosting platform)
 *   GET  /api/status    -> full platform status JSON
 *   GET  /api/ledger    -> recent operations ledger entries
 *   POST /api/ledger    -> append a ledger entry (requires Authorization: Bearer <APP_TOKEN>)
 *   GET  /api/echo      -> simple echo used by smoke tests
 * Docs: see README.md
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendEntry, readEntries, ledgerStats, LEDGER_FIELDS } from './lib/ledger.js';
import { buildStatus } from './lib/status.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const APP_TOKEN = process.env.APP_TOKEN || '';
const MAX_BODY = 32 * 1024; // 32 KB
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 120);

const hits = new Map(); // ip -> {count, resetAt}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null;
  const payload = isObj ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let dashboardCache = null;
async function dashboard() {
  if (!dashboardCache) {
    dashboardCache = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  }
  return dashboardCache;
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (rateLimited(ip)) return send(res, 429, { error: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return send(res, 200, await dashboard());
    }

    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, { status: 'ok', uptime: process.uptime(), version: (await buildStatus()).version });
    }

    if (req.method === 'GET' && path === '/api/status') {
      return send(res, 200, await buildStatus());
    }

    if (req.method === 'GET' && path === '/api/ledger') {
      const limit = Number(url.searchParams.get('limit') || 50);
      return send(res, 200, { fields: LEDGER_FIELDS, stats: await ledgerStats(), entries: await readEntries(limit) });
    }

    if (req.method === 'POST' && path === '/api/ledger') {
      const auth = req.headers.authorization || '';
      if (!APP_TOKEN || auth !== `Bearer ${APP_TOKEN}`) {
        return send(res, 401, { error: 'unauthorized', hint: 'set APP_TOKEN and send Authorization: Bearer <token>' });
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
      if (!body.action) return send(res, 400, { error: 'missing_action' });
      const entry = await appendEntry({
        type: body.type || 'operation',
        actor: body.actor || 'api',
        action: body.action,
        detail: body.detail || '',
        status: body.status || 'ok',
      });
      return send(res, 201, { ok: true, entry });
    }

    if (req.method === 'GET' && path === '/api/echo') {
      return send(res, 200, { ok: true, echo: url.searchParams.get('msg') || 'hello', ts: new Date().toISOString() });
    }

    const KNOWN_PATHS = ['/', '/index.html', '/healthz', '/api/status', '/api/ledger', '/api/echo'];
    if (KNOWN_PATHS.includes(path)) {
      return send(res, 405, { error: 'method_not_allowed', method: req.method, path });
    }

    return send(res, 404, { error: 'not_found', path });
  } catch (err) {
    const code = err && err.message === 'payload_too_large' ? 413 : 500;
    try { await appendEntry({ type: 'error', actor: 'server', action: `${req.method} ${path}`, detail: String(err && err.message || err), status: 'error' }); } catch { /* best effort */ }
    return send(res, code, { error: code === 413 ? 'payload_too_large' : 'internal_error' });
  }
});

server.listen(PORT, HOST, async () => {
  const msg = `listening on ${HOST}:${PORT}`;
  console.log(`[ai-live-platform] ${msg} (node ${process.version})`);
  try {
    await appendEntry({ type: 'boot', actor: 'server', action: 'start', detail: msg, status: 'ok' });
  } catch (e) { console.error('[ledger] boot entry failed:', e.message); }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[ai-live-platform] ${sig} received, shutting down`);
    try { await appendEntry({ type: 'shutdown', actor: 'server', action: sig, detail: 'graceful stop', status: 'ok' }); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
