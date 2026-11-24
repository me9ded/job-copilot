import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const HERE = import.meta.dirname;
const EXTENSION = resolve(HERE, '../../dist-e2e/chrome-mv3');
const FIXTURES = resolve(HERE, '../fixtures');

export interface AiRequestLog {
  bodies: Array<{ messages: Array<{ role: string; content: string }> }>;
}

/** Local server: job fixtures plus a fake OpenAI-compatible endpoint. */
function startServer(log: AiRequestLog): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        log.bodies.push(parsed);
        const content = JSON.stringify({ body: 'Dear Northwind Labs team,\n\nI build React and TypeScript interfaces and would like to bring that to your product team. I improved checkout conversion by 45% at a previous role.\n\nBest regards,\nSam Rivera' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ model: 'fake-local', choices: [{ message: { content } }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
      });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST' });
      return res.end();
    }
    const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '').replace(/[^a-z0-9.-]/gi, '');
    try {
      const html = readFileSync(resolve(FIXTURES, name), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

export const test = base.extend<
  object,
  { ctx: BrowserContext; extensionId: string; sw: Worker; baseUrl: string; aiLog: AiRequestLog; backend: { url: string; token: string } | null }
>({
  aiLog: [async ({}, use) => use({ bodies: [] }), { scope: 'worker' }],
  // The real FastAPI backend (mock model provider), if its virtualenv exists.
  backend: [
    async ({}, use) => {
      const dir = resolve(HERE, '../../../backend');
      const uvicorn = resolve(dir, '.venv/bin/uvicorn');
      // A virtualenv whose Python is gone (e.g. removed by a Homebrew upgrade) can't start: treat it as not installed.
      if (!existsSync(uvicorn) || !existsSync(resolve(dir, '.venv/bin/python'))) return use(null);
      const token = 'e2e-token-0123456789abcdefghijk';
      const port = 18_000 + Math.floor(Math.random() * 1000);
      const db = resolve(mkdtempSync(resolve(tmpdir(), 'jc-')), 'e2e.db');
      const proc = spawn(uvicorn, ['--factory', 'app.main:create_app', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: dir,
        env: { ...process.env, APP_TOKEN: token, AI_PROVIDER: 'mock', DATABASE_URL: `sqlite:///${db}` },
        stdio: 'ignore',
      });
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${url}/health`)).ok) break;
        } catch {
          /* starting */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      await use({ url, token });
      proc.kill();
    },
    { scope: 'worker' },
  ],
  baseUrl: [
    async ({ aiLog }, use) => {
      const server = await startServer(aiLog);
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      server.close();
    },
    { scope: 'worker' },
  ],
  ctx: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        headless: process.env.HEADED !== '1',
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
        acceptDownloads: true,
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],
  sw: [
    async ({ ctx }, use) => {
      const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
      await use(sw);
    },
    { scope: 'worker' },
  ],
  extensionId: [async ({ sw }, use) => use(new URL(sw.url()).host), { scope: 'worker' }],
});

export const expect = test.expect;
