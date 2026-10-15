import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { ReleaseService } from '../../src/services/release-service.js';
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

function backgroundShell() {
  const shell = new MockShellExecutor();
  (shell as any).execBackgroundObservation = async (command: string, options: any) => {
    const result = await shell.exec(command, options);
    if (result.stdout) options?.onData?.(result.stdout, 'stdout');
    if (result.stderr) options?.onData?.(result.stderr, 'stderr');
    return { ...result, stdout: '', stderr: '' };
  };
  return shell;
}
const isGitCommand = (command: string) => /^(?:git|'git') /.test(command);

describe('P2 release center HTTP history isolation', () => {
  it('records release metadata through the shared executor without holding the run-start hook or other HTTP requests', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-meta-http-'));
    const state = new StateService(path.join(tmp, 'state.json')); state.load();
    const timestamp = new Date().toISOString(); const sha = 'b'.repeat(40);
    state.addProject({ id: 'p', name: 'P', slug: 'p', kind: 'git', repoPath: tmp,
      gitDefaultBranch: 'main', createdAt: timestamp, updatedAt: timestamp });
    const service = new ReleaseService(state);
    let hook!: Parameters<ReleaseService['onRunStarted']>[0];
    const subscribe = service.onRunStarted.bind(service);
    service.onRunStarted = listener => { hook = listener; subscribe(listener); };
    const shell = backgroundShell(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let written!: () => void;
    const writeCompleted = new Promise<void>(resolve => { written = resolve; });
    let observedOptions: any;
    shell.addResponsePattern(/^(?:git|'git') .*$/, async (_match, options) => {
      observedOptions = options; await held;
      return { stdout: '2026-01-02T03:04:05Z\x1f真实元信息\x1f实际提交者\n', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/release-commit-file-read/, async () => ({ stdout: 'null', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/release-commit-file-write/, async (_match, options) => {
      const file = path.join(tmp, '.cds', 'release-commit-times.json');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, options!.stdin!);
      written();
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const app = express(); app.get('/probe', (_req, res) => res.json({ ok: true }));
    app.use('/api', createReleasesRouter({ stateService: state, shell, releaseService: service,
      config: { repoRoot: tmp, worktreeBase: path.join(tmp, 'wt') } }));
    const server = await new Promise<http.Server>(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const storePath = path.join(tmp, '.cds', 'release-commit-times.json');
    try {
      const run = { projectId: 'p', commitSha: sha, branchId: 'missing' } as any;
      expect(hook(run)).toBeUndefined(); hook(run);
      for (let i = 0; i < 50 && !shell.commands.some(command => isGitCommand(command)); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(shell.commands.filter(command => isGitCommand(command))).toHaveLength(1);
      expect(shell.commands.find(command => isGitCommand(command))!).toContain("'show'"); expect(shell.commands.find(command => isGitCommand(command))!).toContain(sha);
      expect(observedOptions).toMatchObject({ captureOutput: false, onData: expect.any(Function), beforeStart: expect.any(Function) });
      expect(observedOptions.timeout).toBeGreaterThan(0); expect(observedOptions.timeout).toBeLessThanOrEqual(3000);
      expect(observedOptions.signal.aborted).toBe(false);
      expect(await get(server, '/probe')).toEqual({ status: 200, body: { ok: true } });
      expect(fs.existsSync(storePath)).toBe(false);
      release();
      await writeCompleted;
      expect(JSON.parse(fs.readFileSync(storePath, 'utf8')).entries).toEqual([['p::' + sha,
        { at: '2026-01-02T03:04:05.000Z', subject: '真实元信息', author: '实际提交者' }]]);
    } finally {
      release(); await new Promise<void>(resolve => server.close(() => resolve()));
      await flushAllJsonStateStores(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves another HTTP request while two cold center reads share delayed Git work', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-history-http-'));
    const state = new StateService(path.join(tmp, 'state.json')); state.load();
    const timestamp = new Date().toISOString(); const sha = 'a'.repeat(40);
    state.addProject({ id: 'p', name: 'P', slug: 'p', kind: 'git', repoPath: tmp,
      gitDefaultBranch: 'main', createdAt: timestamp, updatedAt: timestamp });
    const shell = backgroundShell(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    shell.addResponsePattern(/^(?:git|'git') .*$/, async ([command]) => {
      await held;
      return { stdout: command.includes('rev-parse') ? sha + '\n'
        : sha + '\x1f2026-10-11T00:00:00Z\x1f本地提交\n', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/release-commit-file-read/, async () => ({ stdout: 'null', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/release-commit-file-write/, async (_match, options) => {
      const file = path.join(tmp, '.cds', 'release-commit-times.json');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, options!.stdin!);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const app = express(); app.get('/probe', (_req, res) => res.json({ ok: true }));
    app.use('/api', createReleasesRouter({ stateService: state, shell,
      config: { repoRoot: tmp, worktreeBase: path.join(tmp, 'wt') } }));
    const server = await new Promise<http.Server>(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    try {
      const first = get(server, '/api/releases/center?project=p');
      const second = get(server, '/api/releases/center?project=p');
      for (let attempt = 0; attempt < 50 && !shell.commands.some(command => isGitCommand(command)); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(shell.commands.filter(command => isGitCommand(command))).toHaveLength(1);
      expect(await get(server, '/probe')).toEqual({ status: 200, body: { ok: true } });
      release();
      const responses = await Promise.all([first, second]);
      for (const response of responses) {
        expect(response.status).toBe(200); expect(response.body.commitRail.nodes[0].sha).toBe(sha);
        expect(response.body.rows).toBeDefined(); expect(response.body.dora).toBeDefined();
      }
      expect(shell.commands.filter(command => isGitCommand(command))).toHaveLength(2);
      const historyCommand = shell.commands.find(command => command.includes("'log'"))!;
      expect(historyCommand).toContain(sha); expect(historyCommand).not.toContain('origin/main');
    } finally {
      release(); await new Promise<void>(resolve => server.close(() => resolve()));
      await flushAllJsonStateStores(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

it('awaits one shared cold clock load before returning persisted metadata while probes stay responsive', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-clock-cold-http-'));
  const state = new StateService(path.join(tmp, 'state.json')); state.load();
  const sha = 'c'.repeat(40), at = '2026-01-02T03:04:05.000Z';
  const now = new Date().toISOString(); state.addProject({ id: 'p', name: 'P', slug: 'p', kind: 'git', repoPath: tmp, gitDefaultBranch: 'main', createdAt: now, updatedAt: now });
  state.getReleaseRuns = (() => [{ id: 'r', releaseId: 'r', projectId: 'p', targetId: 't', planId: 'plan', branchId: 'b', commitSha: sha, status: 'succeeded', startedAt: now, finishedAt: now, seq: 1, logs: [] }]) as any;
  const shell = backgroundShell(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  shell.addResponsePattern(/^(?:git|'git') .*$/, async ([command]) => ({ stdout: command.includes('rev-parse') ? sha + '\n' : sha + '\x1f' + at + '\x1f实际提交\n', stderr: '', exitCode: 0 }));
  let loadOptions: any;
  shell.addResponsePattern(/release-commit-file-read/, async (_match, options) => {
    loadOptions = options; await held; return { stdout: JSON.stringify({ version: 1, entries: [['p::' + sha, at]] }), stderr: '', exitCode: 0 };
  });
  const app = express(); app.get('/probe', (_req, res) => res.json({ ok: true }));
  app.use('/api', createReleasesRouter({ stateService: state, shell, config: { repoRoot: tmp } }));
  const server = await new Promise<http.Server>(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
  let responses: Promise<any>[] = [];
  try {
    let completed = 0;
    responses = Array.from({ length: 2 }, () => get(server, '/api/releases/center?project=p').then(value => { completed++; return value; }));
    for (let i = 0; i < 50 && !shell.commands.some(command => command.includes('release-commit-file-read')); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(shell.commands.filter(command => command.includes('release-commit-file-read'))).toHaveLength(1);
    expect(loadOptions).toMatchObject({ timeout: 3000, priority: 'diagnostic', schedulingGroup: 'release-meta-file' });
    expect(await get(server, '/probe')).toEqual({ status: 200, body: { ok: true } }); expect(completed).toBe(0);
    release();
    for (const result of await Promise.all(responses)) {
      expect(result.status).toBe(200); expect(result.body.commitMeta[sha]).toEqual({ sha, committedAt: at });
    }
  } finally {
    release(); await Promise.allSettled(responses); await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
