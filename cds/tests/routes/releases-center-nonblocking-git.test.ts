import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

function get(server: http.Server, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: (server.address() as any).port, path: url }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
}

describe('P2 release center HTTP history isolation', () => {
  it('serves another HTTP request while two cold center reads share delayed Git work', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-history-http-'));
    const state = new StateService(path.join(tmp, 'state.json')); state.load();
    const timestamp = new Date().toISOString(); const sha = 'a'.repeat(40);
    state.addProject({ id: 'p', name: 'P', slug: 'p', kind: 'git', repoPath: tmp,
      gitDefaultBranch: 'main', createdAt: timestamp, updatedAt: timestamp });
    const shell = new MockShellExecutor(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    shell.addResponsePattern(/^git .*$/, async ([command]) => {
      await held;
      return { stdout: command.includes('rev-parse') ? sha + '\n'
        : sha + '\x1f2026-10-11T00:00:00Z\x1f本地提交\n', stderr: '', exitCode: 0 };
    });
    const app = express(); app.get('/probe', (_req, res) => res.json({ ok: true }));
    app.use('/api', createReleasesRouter({ stateService: state, shell,
      config: { repoRoot: tmp, worktreeBase: path.join(tmp, 'wt') } }));
    const server = await new Promise<http.Server>(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    try {
      const first = get(server, '/api/releases/center?project=p');
      const second = get(server, '/api/releases/center?project=p');
      for (let attempt = 0; attempt < 50 && !shell.commands.length; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(shell.commands).toHaveLength(1);
      expect(await get(server, '/probe')).toEqual({ status: 200, body: { ok: true } });
      release();
      const responses = await Promise.all([first, second]);
      for (const response of responses) {
        expect(response.status).toBe(200); expect(response.body.commitRail.nodes[0].sha).toBe(sha);
        expect(response.body.rows).toBeDefined(); expect(response.body.dora).toBeDefined();
      }
      expect(shell.commands).toHaveLength(2);
      const historyCommand = shell.commands.find(command => command.includes("'log'"))!;
      expect(historyCommand).toContain(sha); expect(historyCommand).not.toContain('origin/main');
    } finally {
      release(); await new Promise<void>(resolve => server.close(() => resolve()));
      await flushAllJsonStateStores(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
