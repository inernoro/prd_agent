import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, installSpaFallback, type ServerDeps } from '../../src/server.js';
import { SelfMaintenanceRuntime } from '../../src/services/self-maintenance-runtime.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor, ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor, OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import { shellQuote } from '../../src/services/sidecar/sidecar-deployer.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { setRestartWait } from '../../src/services/self-restart-wait.js';
import { getHttpFixtureTrace, listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';
import type { CdsConfig, ExecResult, IShellExecutor } from '../../src/types.js';

type Reply = { status: number; raw: string; headers: http.IncomingHttpHeaders };
const actor = 'maintenance-fixture-owner';
const password = 'maintenance-fixture-private-password';
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('真实服务器的维护占用观察入口', () => {
  let root: string, server: http.Server, state: StateService, operation: IsolatedShellExecutor;
  let cookie: string, armFirstGit: boolean, held: boolean;
  let entered: ReturnType<typeof deferred>;
  let requests: Promise<Reply>[], resourceClosers: Array<() => Promise<void>>;
  let maintenance: SelfMaintenanceRuntime;
  function releaseFirstGit(): void {
    fs.writeFileSync(path.join(root, 'release-first-git'), 'release');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-maintenance-status-'));
    for (const name of ['CDS_AI_ACCESS_KEY', 'AI_ACCESS_KEY', 'CDS_GITHUB_CLIENT_ID',
      'CDS_GITHUB_CLIENT_SECRET', 'CDS_PUBLIC_HEALTH_DETAILS']) vi.stubEnv(name, '');
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', actor); vi.stubEnv('CDS_PASSWORD', password);
    vi.stubEnv('CDS_SSO_ENABLED', 'false'); vi.stubEnv('CDS_PREVIEW_INSTANCE', '0');
    vi.stubEnv('CDS_REPO_ROOT', root); vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    requests = []; resourceClosers = []; cookie = ''; armFirstGit = false; held = false;
    entered = deferred();

    // Git读值是本侧有限控制数据；维护通道仍用真实owned Node进程，不伪造assignment或停止。
    const reads = new MockShellExecutor();
    reads.addResponsePattern(/.*/, ([command]) => {
      if (command === 'git rev-parse --abbrev-ref HEAD') return ok('main');
      // finally放开首Git后，真实restart路由必须在此无效SHA处失败，不能调度daemon。
      if (command === 'git rev-parse HEAD') return ok('fixture-invalid-full-sha');
      if (command === 'git rev-parse --short HEAD') return ok('a'.repeat(8));
      if (command.includes('refs/remotes/origin/HEAD')) return ok('refs/remotes/origin/main');
      if (command === 'git log -1 --format=%cI HEAD') return ok('2026-10-21T00:00:00.000Z');
      if (command === 'docker version --format "{{.Server.Version}}"') return ok('fixture-docker');
      return { ...ok(), exitCode: 1, stderr: 'fixture Git read unavailable' };
    });
    operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation' });
    const shell: IShellExecutor = {
      exec: reads.exec.bind(reads),
      async execOwnedOperation(command, options) {
        const result = await reads.exec(command);
        const hold = armFirstGit && !held && command === 'git rev-parse --abbrev-ref HEAD';
        if (hold) held = true;
        const finish = `process.stdout.write(${JSON.stringify(result.stdout)});process.stderr.write(${JSON.stringify(result.stderr)});process.exit(${result.exitCode});`;
        const source = hold
          ? `const fs=require('node:fs');process.stderr.write('fixture-first-git-held');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root, 'release-first-git'))})){clearInterval(timer);${finish}}},10);`
          : finish;
        let gateOutput = '';
        return operation.execOwnedOperation(`${shellQuote(process.execPath)} --eval ${shellQuote(source)}`, {
          ...options,
          onData: (chunk, channel) => {
            if (hold && channel === 'stderr') {
              gateOutput += chunk;
              if (gateOutput.includes('fixture-first-git-held')) entered.resolve();
            }
            options.onData?.(chunk, channel);
          },
        });
      },
      execBackgroundObservation: operation.execBackgroundObservation.bind(operation),
    };
    const config: CdsConfig = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'),
      masterPort: 9900, workerPort: 5500, dockerNetwork: 'fixture', portStart: 10001,
      sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' }, mode: 'standalone',
      rootDomains: ['example.test'] };
    maintenance = new SelfMaintenanceRuntime(shell, root, () => {});
    const app = createServer({ stateService: state, shell, config,
      selfMaintenanceRuntime: maintenance,
      worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config),
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as unknown as ServerDeps['proxyService'],
      bridgeService: {} as ServerDeps['bridgeService'],
      registerResourceShutdown: closer => { resourceClosers.push(closer); },
    });
    const react = path.join(root, 'react');
    fs.mkdirSync(react); fs.writeFileSync(path.join(react, 'index.html'), '<html>fixture</html>');
    installSpaFallback(app, path.join(root, 'legacy'), react);
    server = listenLoopbackFixture(app);
    if (!server.listening) await once(server, 'listening');
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(getHttpFixtureTrace(server)).toBeDefined();
    const login = await request('POST', '/api/login', { username: actor, password });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers['set-cookie']?.[0]?.split(';')[0];
    expect(sessionCookie).toBeDefined();
    cookie = sessionCookie!;
  });

  afterEach(async () => {
    if (root) releaseFirstGit();
    await Promise.allSettled(requests ?? []);
    await Promise.allSettled((resourceClosers ?? []).map(close => close()));
    await operation?.close();
    await state?.flush();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function request(method: 'GET' | 'POST', url: string, body?: unknown, authenticated = false): Promise<Reply> {
    const trace = getHttpFixtureTrace(server);
    if (!trace) throw new Error('缺少自有HTTP夹具身份');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('自有HTTP夹具尚未监听');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = new Promise<Reply>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, agent: false,
        headers: { ...(authenticated ? { cookie } : {}), ...(payload === undefined ? {} : {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        }) } }, res => {
        let raw = '';
        res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
        res.on('aborted', () => reject(new Error('自有HTTP夹具响应中断'))); res.on('error', reject);
        res.on('end', () => {
          if (!res.complete || res.headers['x-cds-fixture-id'] !== trace.id
            || res.headers['x-cds-fixture-pid'] !== String(trace.pid)) {
            reject(new Error('自有HTTP夹具响应不完整或身份不匹配')); return;
          }
          resolve({ status: res.statusCode || 0, raw, headers: res.headers });
        });
      });
      req.on('error', reject); req.end(payload);
    });
    requests.push(response); void response.catch(() => {});
    return response;
  }

  it('首Git仍等待时默认和probe状态都显示同票维护来源、认证actor与prepare阶段', async () => {
    expect((await request('GET', '/api/self-status')).status).toBe(401);
    armFirstGit = true;
    const restarting = request('POST', '/api/self-restart', { drainTimeoutMs: 0 }, true);
    try {
      await entered.promise;
      expect(held).toBe(true);
      expect(state.getActiveSelfUpdate()).toBeNull();
      const plain = await request('GET', '/api/self-status', undefined, true);
      const probe = await request('GET', '/api/self-status?probe=remote', undefined, true);
      expect(plain.status).toBe(200); expect(probe.status).toBe(200);
      const first = JSON.parse(plain.raw).selfMaintenance;
      const second = JSON.parse(probe.raw).selfMaintenance;
      const expected = { source: 'self-restart', actor, phase: 'prepare' };
      expect.soft(first, '默认真实self-status必须展示仍在首await的owner').toMatchObject(expected);
      expect.soft(second, 'probe真实self-status必须展示同一owner').toMatchObject(expected);
      if (first && second) {
        expect(first.id).toBeTypeOf('string'); expect(first.id.trim()).not.toBe('');
        expect(second.id).toBe(first.id);
      }
    } finally {
      releaseFirstGit();
      const stopped = await restarting;
      expect(stopped.status).toBe(200);
      expect(stopped.raw).toContain('event: error');
      expect(stopped.raw).toContain('无法读取当前 CDS 完整提交 SHA');
      expect(stopped.raw).not.toContain('event: done');
    }
  });

  it('真实health消费者对维护退化503且只公开bool，合法busy与lightweight保持200', async () => {
    // 仅补齐本用例的SPA依赖，不创建/覆盖仓库真实构建产物。
    const reactIndex = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
    const exists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file) === reactIndex || exists(file));
    expect((await request('GET', '/healthz')).status).toBe(200);
    const ticket = maintenance.acquire({ source: 'self-update-dry-run', actor })!;
    expect((await request('GET', '/healthz')).status).toBe(200); // 正常持票不是退化。
    // 真实operation资格回调注入cleanup终态，仅证明保守分类/HTTP合同，不签真实清理失败。
    await expect(maintenance.exec(ticket, 'private-maintenance-command', {
      beforeStart: () => { throw new OperationExecutionError('cleanup'); },
    })).rejects.toMatchObject({ code: 'cleanup' });
    expect(maintenance.finish(ticket)).toBe(false);
    const publicHealth = await request('GET', '/healthz');
    expect(publicHealth.status).toBe(503);
    expect(JSON.parse(publicHealth.raw)).toEqual({ ok: false, port: 9900 });
    expect(publicHealth.raw).not.toMatch(/maintenance-fixture-owner|private-maintenance-command|assignment|actorPid/);
    vi.stubEnv('CDS_PUBLIC_HEALTH_DETAILS', '1');
    const detail = await request('GET', '/healthz');
    expect(detail.status).toBe(503);
    expect(JSON.parse(detail.raw).checks.selfMaintenance).toEqual({ ok: false });
    expect(detail.raw).not.toMatch(/maintenance-fixture-owner|private-maintenance-command|assignment|actorPid/);
    const plain = await request('GET', '/api/self-status', undefined, true);
    const probe = await request('GET', '/api/self-status?probe=remote', undefined, true);
    expect(plain.status).toBe(200); expect(probe.status).toBe(200);
    for (const reply of [plain, probe]) expect(JSON.parse(reply.raw).selfMaintenance)
      .toMatchObject({ id: ticket.id, actor, source: 'self-update-dry-run', state: 'cleanup-unconfirmed' });
    const healthRead = vi.spyOn(maintenance, 'isHealthy');
    const light = await request('GET', '/healthz?lightweight=1');
    expect(light.status).toBe(200); expect(JSON.parse(light.raw)).toEqual({ ok: true, port: 9900 });
    expect(healthRead).not.toHaveBeenCalled();
  });
});
