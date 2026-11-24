import { browser } from 'wxt/browser';
import { exportAll, getSettings, importBackup, type ImportReport } from './storage/repo';
import { originPattern } from './util';

/**
 * Optional backup sync with the user's own backend. Every call is an explicit
 * user action; nothing syncs in the background. The backend token is never
 * included in the payload (exportAll strips it).
 */
async function endpoint(): Promise<{ url: string; token: string; origin: string }> {
  const { ai } = await getSettings();
  const base = ai.backend.baseUrl.replace(/\/+$/, '');
  const origin = originPattern(base);
  if (!origin) throw new Error('The backend URL is not valid.');
  if (!ai.backend.token) throw new Error('Add your backend access token first.');
  if (!(await browser.permissions.contains({ origins: [origin] }))) throw new Error(`Allow Job Copilot to reach ${origin.replace('/*', '')} first.`);
  return { url: `${base}/v1/sync`, token: ai.backend.token, origin };
}

async function check(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) throw new Error('The backend rejected the access token.');
  if (res.status === 404) throw new Error('No backup is stored on the backend yet.');
  if (res.status === 413) throw new Error('The backup is larger than the backend accepts.');
  throw new Error(`Backend error (HTTP ${res.status}).`);
}

export async function pushBackup(): Promise<{ bytes: number }> {
  const { url, token } = await endpoint();
  const body = JSON.stringify(await exportAll());
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, credentials: 'omit' });
  await check(res);
  return { bytes: body.length };
}

export async function pullBackup(): Promise<ImportReport> {
  const { url, token } = await endpoint();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' });
  await check(res);
  return importBackup(await res.json(), 'merge');
}
