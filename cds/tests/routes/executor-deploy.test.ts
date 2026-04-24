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

describe('Executor /exec/deploy', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let mock: MockShellExecutor;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-exec-'));
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.worktreeBase, { recursive: true });

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    mock = new MockShellExecutor();
    // Make every git/docker/mkdir/etc shell-out succeed silently.
    mock.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);

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
});
