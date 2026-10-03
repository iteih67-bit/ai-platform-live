/**
 * Status collection for the platform dashboard / API.
 * Local probes are best-effort and never throw.
 */
import { readFile } from 'node:fs/promises';

const startedAt = Date.now();

async function probe(name, url, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const began = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { name, up: res.ok, http: res.status, ms: Date.now() - began };
  } catch (err) {
    return { name, up: false, http: null, ms: Date.now() - began, error: err.name };
  } finally {
    clearTimeout(t);
  }
}

export async function buildStatus() {
  const probes = [];
  if (process.env.PROBE_OMNIROUTE_URL) probes.push(await probe('omniroute', process.env.PROBE_OMNIROUTE_URL));
  if (process.env.PROBE_LAB_URL) probes.push(await probe('lab-dvwa', process.env.PROBE_LAB_URL));

  let version = 'unknown';
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    version = pkg.version;
  } catch { /* ignore */ }

  return {
    service: 'ai-live-platform',
    version,
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    region: process.env.APP_REGION || process.env.RENDER_REGION || process.env.FLY_REGION || process.env.KOYEB_REGION || 'local',
    release: process.env.APP_RELEASE || 'dev',
    probes,
  };
}

export const platformStartedAt = startedAt;
