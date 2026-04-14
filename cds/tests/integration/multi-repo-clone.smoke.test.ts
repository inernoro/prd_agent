/**
 * P4 Part 18 (G1) middle-tier smoke test.
 *
 * This is the "clone + worktree + file landing" smoke the handoff
 * asked for. Unlike the unit tests (which use MockShellExecutor and
 * assert on command strings), this one runs against the real
 * ShellExecutor, creates a real local bare git repo in a temp dir,
 * and verifies end-to-end that:
 *
 *   1. POST /api/projects + POST /api/projects/:id/clone actually
 *      clones the real repo to the configured reposBase
 *   2. POST /api/branches then successfully `git worktree add`s a
 *      branch off the cloned repo (not the legacy config.repoRoot)
 *   3. The worktree directory contains the expected files from the
 *      branch's HEAD commit
 *
 * The whole test runs against file:// URLs so no network is needed.
 *
 * This test is intentionally separate from the fast unit tests so
 * it can stay slow-ish without regressing the main suite's speed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

interface SseEvent {
  event: string;
  data: any;
}

function requestJson(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestSse(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; events: SseEvent[] }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          Accept: 'text/event-stream',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          const events: SseEvent[] = [];
          for (const block of raw.split(/\n\n+/)) {
            const eventMatch = block.match(/^event: (.+)$/m);
            const dataMatch = block.match(/^data: (.+)$/m);
            if (eventMatch && dataMatch) {
              try {
                events.push({
                  event: eventMatch[1].trim(),
                  data: JSON.parse(dataMatch[1].trim()),
                });
              } catch {
                events.push({ event: eventMatch[1].trim(), data: dataMatch[1].trim() });
              }
            }
          }
          resolve({ status: res.statusCode!, events });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('P4 Part 18 (G1) multi-repo clone + worktree smoke test', () => {
  let tmpRoot: string;
  let sourceRepoUrl: string;
  let reposBase: string;
  let worktreeBase: string;
  let legacyRepoRoot: string;
  let stateFile: string;
  let server: http.Server;
  let stateService: StateService;

  beforeAll(async () => {
    // ── Scratch area ──
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-g1-smoke-'));
    reposBase = path.join(tmpRoot, 'repos');
    worktreeBase = path.join(tmpRoot, 'worktrees');
    legacyRepoRoot = path.join(tmpRoot, 'legacy-repo');
    stateFile = path.join(tmpRoot, 'state.json');

    fs.mkdirSync(reposBase, { recursive: true });
    fs.mkdirSync(worktreeBase, { recursive: true });
    fs.mkdirSync(legacyRepoRoot, { recursive: true });

    // ── Source bare repo (the "upstream" that CDS will clone) ──
    //
    // Every `git commit` uses --no-gpg-sign + -c commit.gpgsign=false
    // to bypass environments that have a signing hook on commits. The
    // test doesn't care about signatures; it only needs real objects
    // that `git clone` + `git worktree add` can reach.
    const sourceWork = path.join(tmpRoot, 'source-work');
    const sourceBare = path.join(tmpRoot, 'source.git');
    const shell = new ShellExecutor();
    const GIT_COMMIT = 'git -c commit.gpgsign=false -c tag.gpgsign=false commit --no-gpg-sign';

    // Helper: run a shell command and throw on non-zero exit so setup
    // failures are loud instead of producing an empty bare repo.
    async function run(cmd: string, cwd?: string): Promise<void> {
      const r = await shell.exec(cmd, cwd ? { cwd } : undefined);
      if (r.exitCode !== 0) {
        throw new Error(
          `setup command failed (exit ${r.exitCode}): ${cmd}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
        );
      }
    }

    fs.mkdirSync(sourceWork, { recursive: true });
    await run('git init -b main', sourceWork);
    await run('git config user.email "smoke@test.local"', sourceWork);
    await run('git config user.name "Smoke"', sourceWork);
    await run('git config commit.gpgsign false', sourceWork);
    fs.writeFileSync(path.join(sourceWork, 'README.md'), '# Smoke Repo\n', 'utf-8');
    await run('git add .', sourceWork);
    await run(`${GIT_COMMIT} -m "initial"`, sourceWork);
    await run('git checkout -b feature/hello', sourceWork);
    fs.mkdirSync(path.join(sourceWork, 'src'));
    fs.writeFileSync(path.join(sourceWork, 'src', 'hello.txt'), 'hi from feature/hello\n', 'utf-8');
    await run('git add .', sourceWork);
    await run(`${GIT_COMMIT} -m "feature hello"`, sourceWork);
    await run('git checkout main', sourceWork);
    await run(`git clone --bare "${sourceWork}" "${sourceBare}"`);
    sourceRepoUrl = `file://${sourceBare}`;

    // ── Real services with the real ShellExecutor ──
    stateService = new StateService(stateFile, tmpRoot);
    stateService.load();

    const worktreeService = new WorktreeService(shell);
    const config: CdsConfig = {
      repoRoot: legacyRepoRoot,
      reposBase,
      worktreeBase,
      masterPort: 9900,
      workerPort: 5500,
      dockerNetwork: 'cds-test',
      portStart: 20000,
      sharedEnv: {},
      jwt: { secret: 'x'.repeat(32), issuer: 't' },
      mode: 'standalone',
      executorPort: 9901,
    } as CdsConfig;

    // ContainerService is needed by createBranchRouter but this smoke
    // never deploys anything (it stops at worktree create), so a
    // stubbed one is fine. We only reach the /api/branches POST path.
    const stubContainer = {} as unknown as ContainerService;

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createProjectsRouter({ stateService, shell, config }),
    );
    app.use(
      '/api',
      createBranchRouter({
        stateService,
        worktreeService,
        containerService: stubContainer,
        shell,
        config,
        // schedulerService and registry are optional in the branch
        // router; we don't exercise cluster dispatch here.
      } as any),
    );

    server = app.listen(0);
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('completes the full clone → worktree → file landing round trip', async () => {
    // 1. Create project directly via stateService.
    //
    // We skip POST /api/projects because that path runs `docker
    // network create` via the real shell, which requires a live
    // docker daemon on the test host. CI environments that don't
    // have docker would block this smoke test for reasons unrelated
    // to the G1 multi-repo functionality we actually care about.
    // Seeding the project directly is equivalent to what the router
    // would do on a successful POST, minus the network side effect.
    const projectId = 'smoke-proj';
    const repoPath = `${reposBase}/${projectId}`;
    stateService.addProject({
      id: projectId,
      slug: projectId,
      name: 'Smoke Project',
      kind: 'git',
      gitRepoUrl: sourceRepoUrl,
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repoPath,
      cloneStatus: 'pending',
    });

    // 2. Branch create BEFORE clone should be refused by G1.5 guard
    const earlyCreate = await requestJson(server, 'POST', '/api/branches', {
      branch: 'main',
      projectId,
    });
    expect(earlyCreate.status).toBe(409);
    expect(earlyCreate.body.error).toBe('project_not_ready');

    // 3. Run the clone via SSE → should see start + progress + complete
    const clone = await requestSse(server, 'POST', `/api/projects/${projectId}/clone`);
    expect(clone.status).toBe(200);
    const eventNames = clone.events.map((e) => e.event);
    expect(eventNames[0]).toBe('start');
    expect(eventNames).toContain('complete');
    expect(eventNames).not.toContain('error');

    // Real filesystem check: the cloned dir exists with the expected file
    const cloneTarget = `${reposBase}/${projectId}`;
    expect(fs.existsSync(cloneTarget)).toBe(true);
    expect(fs.existsSync(path.join(cloneTarget, 'README.md'))).toBe(true);

    // State says ready now
    const afterClone = stateService.getProject(projectId)!;
    expect(afterClone.cloneStatus).toBe('ready');
    expect(afterClone.repoPath).toBe(cloneTarget);

    // 4. Create a branch on this project — should use the cloned repoPath,
    //    not the legacy repoRoot, and should succeed because the branch
    //    exists in the source bare repo.
    const branchCreate = await requestJson(server, 'POST', '/api/branches', {
      branch: 'feature/hello',
      projectId,
    });
    expect(branchCreate.status).toBe(201);
    expect(branchCreate.body.branch.projectId).toBe(projectId);

    // Worktree path lands inside worktreeBase, and contains the
    // feature/hello-only file we committed earlier. This is the
    // *real* proof that WorktreeService used the cloned repo (which
    // has that branch) and not the empty legacy repoRoot (which
    // doesn't know about `feature/hello` at all).
    const worktreePath = branchCreate.body.branch.worktreePath;
    expect(fs.existsSync(worktreePath)).toBe(true);
    const helloFile = path.join(worktreePath, 'src', 'hello.txt');
    expect(fs.existsSync(helloFile)).toBe(true);
    expect(fs.readFileSync(helloFile, 'utf-8').trim()).toBe('hi from feature/hello');
  }, 60000);
});
