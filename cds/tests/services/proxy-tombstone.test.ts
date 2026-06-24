import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ServiceState } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Stopped-but-not-deleted PR branch must serve the merged/abandoned gone page.
 *
 * When a repo keeps PR branches after close, the BranchEntry lingers as
 * `stopped`; routeToBranch would otherwise serve the generic stopped-status page
 * and never reach serveBranchGonePage. The proxy diverts to onBranchGone when a
 * tombstone matches the branch — but only for real HTML navigations, and only
 * when a tombstone actually exists (fail-safe).
 */
describe('ProxyService stopped-branch tombstone divert', () => {
  let stateService: StateService;
  let proxy: ProxyService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-tombstone-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    proxy = new ProxyService(stateService, {
      masterPort: 9900, workerPort: 5500, repoRoot: '/tmp', worktreeBase: '/tmp',
      portStart: 9000, previewDomain: 'preview.example.com', rootDomains: ['preview.example.com'],
    } as never);
    proxy.setResolveUpstream(() => 'http://127.0.0.1:39999');
  });

  function svc(profileId: string, status: ServiceState['status']): ServiceState {
    return { profileId, containerName: `c-${profileId}`, hostPort: 30000, status } as ServiceState;
  }

  function addStoppedBranch(createdAt = '2026-06-23T00:00:00.000Z'): BranchEntry {
    const id = StateService.slugify('feat/cooled');
    const entry = {
      id,
      branch: 'feat/cooled',
      projectId: 'default',
      status: 'stopped',
      createdAt,
      services: { web: svc('web', 'stopped') },
      lastStopSource: 'user',
    } as BranchEntry;
    stateService.addBranch(entry);
    return entry;
  }

  function tombstone(branchId: string) {
    stateService.recordRemovedBranch({
      previewSlug: 'feat-cooled-merged-slug',
      branch: 'feat/cooled',
      projectId: 'default',
      reason: 'merged',
      branchId,
      removedAt: '2026-06-24T00:00:00.000Z',
    });
  }

  function makeReq(url = '/', headers: Record<string, string> = {}): http.IncomingMessage {
    return { method: 'GET', url, headers: { host: 'feat-cooled.preview.example.com', accept: 'text/html', ...headers } } as unknown as http.IncomingMessage;
  }

  function makeRes(): http.ServerResponse {
    return { writeHead: vi.fn(), setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), headersSent: false } as unknown as http.ServerResponse;
  }

  it('diverts a stopped branch with a tombstone to the gone page on HTML navigation', async () => {
    const b = addStoppedBranch();
    tombstone(b.id);
    const gone = vi.fn();
    proxy.setOnBranchGone(gone);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(gone).toHaveBeenCalledTimes(1);
    // 转发墓碑自身的 previewSlug（map 主键），保证 gone 页再查必命中（Bugbot）。
    expect(gone).toHaveBeenCalledWith('feat-cooled-merged-slug', expect.anything(), expect.anything());
  });

  it('does NOT divert when the tombstone predates a reused branch incarnation', async () => {
    // 分支名复用：旧墓碑(2026-06-24)残留，但同名分支在之后(2026-06-25)被重建。
    const b = addStoppedBranch('2026-06-25T00:00:00.000Z');
    tombstone(b.id); // removedAt = 2026-06-24，早于 createdAt → 陈旧，不应分流
    const gone = vi.fn();
    proxy.setOnBranchGone(gone);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(gone).not.toHaveBeenCalled();
  });

  it('does NOT divert a stopped branch with NO tombstone (fail-safe)', async () => {
    addStoppedBranch();
    const gone = vi.fn();
    proxy.setOnBranchGone(gone);

    await proxy.handleRequest(makeReq(), makeRes());

    expect(gone).not.toHaveBeenCalled();
  });

  it('does NOT divert non-HTML asset requests even with a tombstone', async () => {
    const b = addStoppedBranch();
    tombstone(b.id);
    const gone = vi.fn();
    proxy.setOnBranchGone(gone);

    await proxy.handleRequest(makeReq('/assets/app.js', { accept: 'text/css,*/*' }), makeRes());

    expect(gone).not.toHaveBeenCalled();
  });
});
