/**
 * Ledger - durable, append-only operations log (JSONL).
 * Fields: id, ts, type, actor, action, detail, status
 * The file lives outside the repo (see LEDGER_PATH) so runtime data is never committed.
 */
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const LEDGER_PATH = resolve(process.env.LEDGER_PATH || './data/ledger.jsonl');
const MAX_READ = 200;

export const LEDGER_FIELDS = ['id', 'ts', 'type', 'actor', 'action', 'detail', 'status'];

export async function appendEntry({ type, actor = 'system', action, detail = '', status = 'ok' }) {
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: String(type || 'event'),
    actor: String(actor),
    action: String(action || ''),
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    status: String(status),
  };
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await appendFile(LEDGER_PATH, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export async function readEntries(limit = 50) {
  try {
    const raw = await readFile(LEDGER_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-Math.min(Math.max(limit, 1), MAX_READ));
    return slice.map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line, parseError: true }; }
    }).reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function ledgerStats() {
  const all = await readEntries(MAX_READ);
  const byStatus = {};
  for (const e of all) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  return { entriesRead: all.length, byStatus, path: LEDGER_PATH };
}
