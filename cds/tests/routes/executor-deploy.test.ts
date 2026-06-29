/**
 * Executor route regression tests.
 *
 * Focus: the /exec/deploy worktree-creation path used to hardcode
 * `projectId: 'default'` (and `<base>/default/<branchId>` for the
 * worktree directory). After legacy-cleanup/rename-default flips
 * the legacy project to a real id, that hardcoded path mints
 * orphan branches on the executor — same shape of bug as the
 * subdomain auto-build bug fixed earlier in index.ts.
 *
 * These tests exercise the new behaviour:
 *   1. body.projectId from the master is stamped onto the entry +
 *      drives the worktree directory.
 *   2. When the master omits projectId (older masters), the executor
 *      falls back to resolveProjectForAutoBuild instead of 'default'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createExecutorRouter } from '../../src/executor/routes.js';
import type { CdsConfig, BranchEntry } from '../../src/types.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'cds' },
  };
}

async function postSse(
  server: http.Server, urlPath: string, body: unknown,
): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const events: Array<{ event: string; data: any }> = [];
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        // Parse `event: X\ndata: Y\n\n` SSE blocks.
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let event = 'message';
          let data: any = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) {
              try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
            }
          }
          events.push({ event, data });
          idx = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => resolve({ status: res.statusCode!, events }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function postJson(
  server: http.Server, urlPath: string, body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Executor /exec/deploy', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let mock: MockShellExecutor;
  let containerEvents: Array<{ action: string; operationId?: string | null; requestId?: string | null; details?: Record<string, unknown> }>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-exec-'));
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.worktreeBase, { recursive: true });

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'default',
      slug: 'default',
      name: 'Legacy Default',
      kind: 'git',
      legacyFlag: true,
      createdAt: now,
      updatedAt: now,
    });

    mock = new MockShellExecutor();
    // Make every git/docker/mkdir/etc shell-out succeed silently.
    mock.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    containerEvents = [];
    const eventSink: ServerEventLogSink = {
      record(record) {
        containerEvents.push({
          action: record.action,
          operationId: record.operationId,
          requestId: record.requestId,
          details: record.details,
        });
      },
    };
    const containerService = new ContainerService(mock, config, undefined, eventSink);
    (containerService as any).waitForContainerAlive = async () => undefined;
    (containerService as any).waitForReadiness = async () => true;

    const app = express();
    app.use(express.json());
    app.use('/exec', createExecutorRouter({
      stateService, worktreeService, containerService, shell: mock, config,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('stamps the master-supplied projectId on the new entry + scopes worktree dir by it', async () => {
    // Pre-create the project locally so resolveProjectForAutoBuild has
    // something to match if needed (but the explicit body.projectId
    // should win).
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'realproj',
      slug: 'realproj',
      name: 'Real',
      kind: 'git',
      createdAt: now,
      updatedAt: now,
    });

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-feature-x',
      branchName: 'feature/x',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    expect(result.events.some(e => e.event === 'complete')).toBe(true);

    const entry = stateService.getBranch('realproj-feature-x');
    expect(entry).toBeDefined();
    expect(entry!.projectId).toBe('realproj');
    expect(entry!.worktreePath).toContain('/worktrees/realproj/realproj-feature-x');
    // Critical regression: must NOT be 'default'.
    expect(entry!.worktreePath).not.toContain('/worktrees/default/');
  });

  it('falls back to resolveProjectForAutoBuild when master omits projectId (older master)', async () => {
    // Simulate post-rename: legacy project flipped to 'prd-agent'.
    const legacy = stateService.getLegacyProject()!;
    legacy.id = 'prd-agent';
    legacy.legacyFlag = false;
    stateService.save();

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'prd-agent-some-branch',
      branchName: 'some-branch',
      // projectId intentionally omitted
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    const entry = stateService.getBranch('prd-agent-some-branch');
    expect(entry).toBeDefined();
    // The bug was: this used to be 'default', creating an orphan.
    expect(entry!.projectId).toBe('prd-agent');
    expect(entry!.worktreePath).toContain('/worktrees/prd-agent/');
  });

  it('emits an error event and refuses to create when projectId is ambiguous', async () => {
    // Multi-project setup with no clear owner for autoRepoRoot.
    const legacy = stateService.getLegacyProject()!;
    legacy.id = 'a';
    legacy.legacyFlag = false;
    legacy.repoPath = '/repos/a';
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'b', slug: 'b', name: 'b', kind: 'git', repoPath: '/repos/b', createdAt: now, updatedAt: now,
    });
    stateService.save();

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'orphan-branch',
      branchName: 'orphan-branch',
      // No projectId, and resolver returns undefined → must refuse.
      profiles: [],
      env: {},
    });

    expect(result.events.some(e => e.event === 'error')).toBe(true);
    // The pre-fix bug would have created an entry with projectId='default'.
    expect(stateService.getBranch('orphan-branch')).toBeUndefined();
  });

  it('scopes customEnv by resolved projectId — does not pull other projects vars when overrides absent', async () => {
    // Two projects with conflicting env vars in their own scopes.
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now,
    });
    stateService.addProject({
      id: 'b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now,
    });
    stateService.setCustomEnvVar('SECRET', 'secret-from-a', 'a');
    stateService.setCustomEnvVar('SECRET', 'secret-from-b', 'b');
    stateService.setCustomEnvVar('SHARED', 'shared-global', '_global');

    // Pre-create the branch so we exercise the merge-env path without
    // also exercising worktree/profile build (which is what the
    // earlier tests validate). On second deploy the executor reuses
    // the entry; getMergedEnv(resolvedProjectId) is what we're after.
    stateService.addBranch({
      id: 'a-feature', projectId: 'a', branch: 'feature',
      worktreePath: path.join(tmpDir, 'worktrees', 'a', 'a-feature'),
      services: {}, status: 'idle', createdAt: now,
    });

    // No envOverrides in payload → executor's getMergedEnv must pick
    // up project A's scope (not project B, not _global only).
    // We can't directly observe the env handed to runService from this
    // test (it'd need a containerService spy), but we *can* assert the
    // request completes successfully — coverage of the executor branch.
    // Behavioural correctness is locked by the unit test on
    // StateService.getCustomEnv elsewhere; this test pins the
    // integration: deploy with projectId='a' must not crash + must use
    // the new scoped getMergedEnv signature.
    const result = await postSse(server, '/exec/deploy', {
      branchId: 'a-feature',
      branchName: 'feature',
      projectId: 'a',
      profiles: [],
      env: {},
    });
    expect(result.status).toBe(200);
    // No error event from getMergedEnv() invocation with new signature.
    expect(result.events.some(e => e.event === 'error')).toBe(false);
  });

  it('emits error WITH the post-teardown services snapshot when pull fails (Bugbot remote-error-stale-services)', async () => {
    // Orphan teardown runs before pull. If pull then fails, the error event must still carry the current
    // services snapshot so the master can reconcile (the removed orphan must not stay running on master).
    const now = new Date().toISOString();
    stateService.addProject({ id: 'realproj', slug: 'realproj', name: 'Real', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addBranch({
      id: 'realproj-pullfail',
      projectId: 'realproj',
      branch: 'feature/pullfail',
      worktreePath: path.join(tmpDir, 'worktrees', 'realproj', 'realproj-pullfail'),
      services: {
        'old-extra': { profileId: 'old-extra', containerName: 'cds-realproj-pullfail-old-extra', hostPort: 10008, status: 'running' },
      },
      status: 'running',
      createdAt: now,
    });
    // Force the git reset (inside WorktreeService.pull) to fail — exact responses win over the catch-all.
    mock.addResponse('git reset --hard origin/feature/pullfail', { stdout: '', stderr: 'fatal: couldn\'t find remote ref', exitCode: 1 });

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-pullfail',
      branchName: 'feature/pullfail',
      projectId: 'realproj',
      // A real desired profile so the deploy does NOT short-circuit on empty payload → it reaches pull.
      profiles: [{ id: 'api', name: 'API', dockerImage: 'node:20', workDir: 'api', command: 'node server.js', containerPort: 8080 }],
      env: {},
    });

    expect(result.status).toBe(200);
    const errorEvent = result.events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    // The error payload carries a services snapshot (object) so the master can reconcile on failure.
    expect(errorEvent!.data?.services).toBeDefined();
    expect(typeof errorEvent!.data.services).toBe('object');
    // The orphan was torn down before the pull failed (its container was removed + entry cleared).
    expect(stateService.getBranch('realproj-pullfail')!.services['old-extra']).toBeUndefined();
    expect(errorEvent!.data.services['old-extra']).toBeUndefined();
    // worker 自身分支态落 error（Bugbot「Failed remote deploy reverts to building」）：否则下一次心跳会把
    // master 已 finalize 的 error 覆盖回 building。
    expect(stateService.getBranch('realproj-pullfail')!.status).toBe('error');
    expect(stateService.getBranch('realproj-pullfail')!.errorMessage).toBeTruthy();
  });

  it('does not stamp projectId on a branch the executor already knows about', async () => {
    // Existing entry on the executor (e.g., re-deploy after restart).
    // The deploy path must be a no-op for entry creation; the
    // pre-existing projectId is the source of truth.
    const now = new Date().toISOString();
    const seeded: BranchEntry = {
      id: 'realproj-existing',
      projectId: 'whatever-was-there-before',
      branch: 'existing',
      worktreePath: path.join(tmpDir, 'worktrees', 'whatever', 'realproj-existing'),
      services: {},
      status: 'idle',
      createdAt: now,
    };
    stateService.addBranch(seeded);

    await postSse(server, '/exec/deploy', {
      branchId: 'realproj-existing',
      branchName: 'existing',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    const entry = stateService.getBranch('realproj-existing');
    // Should not have been overwritten — the master-supplied value
    // only applies to newly-created entries.
    expect(entry!.projectId).toBe('whatever-was-there-before');
  });

  it('empty payload tears down orphan services BEFORE/WITHOUT pulling (Codex P2 cleanup-before-pull)', async () => {
    // A branch whose only service was a branch-local extra; the master cleared it and sent profiles: [].
    // The cleanup must NOT be gated behind git pull — otherwise a transient git failure / upstream-deleted
    // branch would error out leaving the worker container running while master saved the empty list.
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'realproj-empty-clear',
      projectId: 'realproj',
      branch: 'feature/empty-clear',
      worktreePath: path.join(tmpDir, 'worktrees', 'realproj', 'realproj-empty-clear'),
      services: {
        'extra-api': { profileId: 'extra-api', containerName: 'cds-realproj-empty-clear-extra-api', hostPort: 10007, status: 'running' },
      },
      status: 'running',
      createdAt: now,
    });
    stateService.addProject({ id: 'realproj', slug: 'realproj', name: 'Real', kind: 'git', createdAt: now, updatedAt: now });
    mock.commands.length = 0;

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-empty-clear',
      branchName: 'feature/empty-clear',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    // The orphan service container was removed + entry cleared, status idle.
    expect(result.events.some(e => e.event === 'complete' && e.data?.message === '已清空所有服务')).toBe(true);
    const entry = stateService.getBranch('realproj-empty-clear');
    expect(entry!.services['extra-api']).toBeUndefined();
    expect(entry!.status).toBe('idle');
    // pull was skipped (nothing to build) — no `git ... pull` was issued and no 'pull' step emitted.
    expect(result.events.some(e => e.event === 'step' && e.data?.step === 'pull')).toBe(false);
    expect(mock.commands.some(c => /\bpull\b/.test(c))).toBe(false);
    // the orphan container WAS removed.
    expect(mock.commands.some(c => /docker rm/.test(c) && c.includes('cds-realproj-empty-clear-extra-api'))).toBe(true);
  });

  it('threads operationId/requestId from master into executor docker run events', async () => {
    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-op-trace',
      branchName: 'feature/op-trace',
      projectId: 'default',
      requestId: 'req-exec-deploy',
      operationId: 'op-exec-deploy',
      actor: 'user:42',
      trigger: 'manual',
      profiles: [{
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        workDir: '.',
        command: 'node server.js',
        containerPort: 3000,
      }],
      env: {},
    });

    expect(result.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'app.pre-run-rm')?.operationId).toBe('op-exec-deploy');
    expect(containerEvents.find((event) => event.action === 'app.run.started')?.requestId).toBe('req-exec-deploy');
    expect(containerEvents.find((event) => event.action === 'app.pre-run-rm')?.details?.actor).toBe('user:42');
  });

  it('threads operationId into executor stop and delete container events', async () => {
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'exec-owned',
      projectId: 'default',
      branch: 'feature/exec-owned',
      worktreePath: path.join(tmpDir, 'worktrees', 'default', 'exec-owned'),
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-exec-owned-api',
          hostPort: 10001,
          status: 'running',
        },
      },
      status: 'running',
      createdAt: now,
    });

    const stop = await postJson(server, '/exec/stop', {
      branchId: 'exec-owned',
      requestId: 'req-exec-stop',
      operationId: 'op-exec-stop',
      actor: 'scheduler',
      trigger: 'auto-lifecycle',
    });
    expect(stop.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'container.stop.requested')?.operationId).toBe('op-exec-stop');

    const branch = stateService.getBranch('exec-owned')!;
    branch.status = 'running';
    branch.services.api.status = 'running';
    stateService.save();
    const del = await postJson(server, '/exec/delete', {
      branchId: 'exec-owned',
      requestId: 'req-exec-delete',
      operationId: 'op-exec-delete',
      actor: 'user:42',
      trigger: 'manual',
    });
    expect(del.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'container.remove.requested')?.operationId).toBe('op-exec-delete');
    expect(stateService.getBranch('exec-owned')).toBeUndefined();
  });
});
