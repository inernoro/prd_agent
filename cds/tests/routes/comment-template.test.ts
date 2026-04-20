/**
 * Tests for the /api/comment-template admin router.
 *
 * Focuses on the validation + persistence contract, not on the
 * renderer (tests/services/comment-template.test.ts covers that).
 *
 * Uses the same StateService + in-memory JSON pattern as the
 * storage-mode tests so no real mongo connection is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { createCommentTemplateRouter } from '../../src/routes/comment-template.js';
import {
  DEFAULT_TEMPLATE_BODY,
  VARIABLE_DEFS,
} from '../../src/services/comment-template.js';
import type { CdsConfig } from '../../src/types.js';

function buildApp(stateService: StateService, config: CdsConfig) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCommentTemplateRouter({ stateService, config }));
  return app;
}

async function request(
  app: express.Express,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no server address'));
        return;
      }
      const port = addr.port;
      const http = require('node:http');
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: url,
          headers: { 'Content-Type': 'application/json' },
        },
        (res: any) => {
          let chunks = '';
          res.on('data', (c: Buffer) => (chunks += c.toString()));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
            } catch (e) {
              resolve({ status: res.statusCode, body: chunks });
            }
          });
        },
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('comment-template router', () => {
  let tmpDir: string;
  let stateFile: string;
  let stateService: StateService;
  let app: express.Express;

  const config: CdsConfig = {
    // Minimum CdsConfig shape the router uses. The renderer only reads
    // previewDomain / rootDomains / publicBaseUrl, so the rest is
    // structurally typed around these three.
    previewDomain: 'preview.example.com',
    rootDomains: ['preview.example.com'],
    publicBaseUrl: 'https://cds.example.com',
    masterPort: 9900,
    workerPort: 5500,
    repoRoot: '/tmp',
    worktreeBase: '/tmp/worktrees',
    dockerNetwork: 'cds-test',
    portStart: 10000,
    sharedEnv: {},
    jwt: { secret: 'test', issuer: 'test' },
    mode: 'standalone',
    scheduler: { enabled: false, maxHotBranches: 3, idleTTLSeconds: 900, tickIntervalSeconds: 60, pinnedBranches: [] },
    janitor: { enabled: false, worktreeTTLDays: 30, diskWarnPercent: 80, sweepIntervalSeconds: 3600 },
  } as unknown as CdsConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-comment-tpl-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    app = buildApp(stateService, config);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('GET /api/comment-template', () => {
    it('returns the default template and variable catalog when nothing saved', async () => {
      const res = await request(app, 'GET', '/api/comment-template');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.body).toBe(DEFAULT_TEMPLATE_BODY);
      expect(res.body.isDefault).toBe(true);
      expect(res.body.variables).toHaveLength(VARIABLE_DEFS.length);
      expect(res.body.defaultBody).toBe(DEFAULT_TEMPLATE_BODY);
    });

    it('returns the saved template when one exists', async () => {
      stateService.setCommentTemplate({
        body: '# custom {{branch}}',
        prReviewBaseUrl: 'https://app.example.com',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const res = await request(app, 'GET', '/api/comment-template');
      expect(res.body.body).toBe('# custom {{branch}}');
      expect(res.body.prReviewBaseUrl).toBe('https://app.example.com');
      expect(res.body.isDefault).toBe(false);
    });
  });

  describe('PUT /api/comment-template', () => {
    it('saves body + baseUrl and timestamps it', async () => {
      const res = await request(app, 'PUT', '/api/comment-template', {
        body: '# body',
        prReviewBaseUrl: 'https://app.example.com',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.body).toBe('# body');
      expect(res.body.prReviewBaseUrl).toBe('https://app.example.com');
      expect(typeof res.body.updatedAt).toBe('string');
      // persists
      const saved = stateService.getCommentTemplate();
      expect(saved?.body).toBe('# body');
    });

    it('rejects non-http(s) prReviewBaseUrl', async () => {
      const res = await request(app, 'PUT', '/api/comment-template', {
        body: 'x',
        prReviewBaseUrl: 'ftp://nope.example.com',
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('accepts empty body (= reset to default at render time)', async () => {
      const res = await request(app, 'PUT', '/api/comment-template', { body: '', prReviewBaseUrl: '' });
      expect(res.status).toBe(200);
      expect(res.body.body).toBe('');
      expect(res.body.prReviewBaseUrl).toBe('');
    });

    it('rejects non-string body', async () => {
      const res = await request(app, 'PUT', '/api/comment-template', { body: 42 });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/comment-template/preview', () => {
    it('renders sample variables against an arbitrary body', async () => {
      const res = await request(app, 'POST', '/api/comment-template/preview', {
        body: 'branch={{branch}}, pr={{prNumber}}, sha={{shortSha}}',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Sample branch is "feature/preview" and sha sample starts a1b2c3d
      expect(res.body.rendered).toContain('feature/preview');
      expect(res.body.rendered).toContain('pr=123');
      expect(res.body.rendered).toContain('a1b2c3d');
    });

    it('falls back to saved body when preview payload omits body', async () => {
      stateService.setCommentTemplate({
        body: 'saved:{{branch}}',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const res = await request(app, 'POST', '/api/comment-template/preview', {});
      expect(res.body.rendered).toContain('saved:feature/preview');
    });
  });
});
