import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ServiceState } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * #1 重启中断分支按需自愈（demand-driven，不复活重试风暴）。
 *
 * 访问到一个被 CDS self-update/崩溃重启打断的 error 分支（errorMessage 含「重启中断」）时，
 * 代理触发一次重部署回调（去重）。只认这个已知瞬态、重跑安全的原因——真正的构建失败/崩溃/
 * 用户停止/远端执行器分支一律不碰；非浏览器导航（HEAD/资源/探针）不触发。
 */
describe('ProxyService interrupted-branch recovery scoping', () => {
  let stateService: StateService;
  let proxy: ProxyService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-recover-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    proxy = new ProxyService(stateService, {
      masterPort: 9900, workerPort: 5500, repoRoot: '/tmp', worktreeBase: '/tmp',
      portStart: 9000, previewDomain: 'preview.example.com', rootDomains: ['preview.example.com'],
    } as never);
    proxy.setResolveUpstream(() => 'http://127.0.0.1:39999');
  });

  function svc(profileId: string, status: ServiceState['status'], errorMessage?: string): ServiceState {
    return { profileId, containerName: `c-${profileId}`, hostPort: 30000, status, errorMessage } as ServiceState;
  }

  function addBranch(over: Partial<BranchEntry>): BranchEntry {
    const id = StateService.slugify('feat/interrupted');
    const entry = {
      id,
      branch: 'feat/interrupted',
      projectId: 'default',
      status: 'error',
      errorMessage: '上一次部署被 CDS 重启中断',
      githubCommitSha: 'abc1234',
      services: { web: svc('web', 'error', '上一次部署被 CDS 重启中断') },
      ...over,
    } as BranchEntry;
    stateService.addBranch(entry);
    return entry;
  }

  function makeReq(method = 'GET', headers: Record<string, string> = {}): http.IncomingMessage {
    return { method, url: '/', headers: { host: 'feat-interrupted.preview.example.com', accept: 'text/html', ...headers } } as unknown as http.IncomingMessage;
  }
  function makeRes(): http.ServerResponse {
    return { writeHead: vi.fn(), setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), headersSent: false } as unknown as http.ServerResponse;
  }

  it('fires recovery for a restart-interrupted error branch on navigation', async () => {
    addBranch({});
    const recover = vi.fn(async () => {});
    proxy.setOnRecoverInterrupted(recover);
    await proxy.handleRequest(makeReq(), makeRes());
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(StateService.slugify('feat/interrupted'));
  });

  it('does NOT fire for a genuinely crashed/failed error branch (no interrupted marker)', async () => {
    addBranch({ errorMessage: '构建失败: dotnet build error CS1002', services: { web: svc('web', 'error', '构建失败') } });
    const recover = vi.fn(async () => {});
    proxy.setOnRecoverInterrupted(recover);
    await proxy.handleRequest(makeReq(), makeRes());
    expect(recover).not.toHaveBeenCalled();
  });

  it('does NOT fire for an executor-owned (remote) interrupted branch', async () => {
    addBranch({ executorId: 'executor-remote-1' });
    const recover = vi.fn(async () => {});
    proxy.setOnRecoverInterrupted(recover);
    await proxy.handleRequest(makeReq(), makeRes());
    expect(recover).not.toHaveBeenCalled();
  });

  it('does NOT fire for a HEAD request (uptime monitors)', async () => {
    addBranch({});
    const recover = vi.fn(async () => {});
    proxy.setOnRecoverInterrupted(recover);
    await proxy.handleRequest(makeReq('HEAD'), makeRes());
    expect(recover).not.toHaveBeenCalled();
  });

  it('does NOT fire when no recovery callback is wired', async () => {
    addBranch({});
    // no setOnRecoverInterrupted → must stay on the diagnostic path, never throw
    let threw = false;
    try { await proxy.handleRequest(makeReq(), makeRes()); } catch { threw = true; }
    expect(threw).toBe(false);
  });
});
