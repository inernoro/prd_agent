import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseService,
  RELEASE_HEARTBEAT_STALE_MS,
  assertReleaseRunTransition,
  canTransitionReleaseRun,
  classifyReleaseFailure,
  isReleaseRunInFlight,
  isReleaseRunTerminal,
  type ReleaseServiceOptions,
  type ReleaseSshExecRequest,
  type ReleaseSshExecutor,
} from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseRun, ReleaseRunStatus, ReleaseTarget } from '../../src/types.js';

/**
 * CDS 发布系统阶段一（止血）回归。
 *
 * 病根：发布执行体是一个不受管的内存 Promise（`void this.runRelease(...)`）。
 * CDS 自更新或重启把它连同进程一起抹掉，ReleaseRun 永远停在 running；而在途守卫
 * 会因此拒绝该目标的一切新发布，且当时既没有取消、没有执行超时、也没有心跳收割
 * ——这个发布目标从此发不出去，只能改库。自更新是 CDS 的日常操作，不是理论风险。
 *
 * 本套件把「不再卡死」钉成回归：心跳 / 中断收敛 / 执行超时 / 取消 / 状态机 / 结构化失败。
 */

const DEPLOY_COMMAND = "CDS_LOCAL_PROD_DIR='/opt/app-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'";

/** 真正的发布命令（含注入的 CDS_RELEASE_ID 环境变量）；其余都是预检探测。 */
function isDeployCommand(command: string): boolean {
  return command.includes('CDS_RELEASE_ID=');
}

/** 一直挂着直到被中止 —— 模拟远端脚本卡死 / 长静默构建阶段。 */
function hangUntilAborted(req: ReleaseSshExecRequest): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const fail = () => reject(req.signal.reason instanceof Error
      ? req.signal.reason
      : new Error(String(req.signal.reason)));
    if (req.signal.aborted) return fail();
    req.signal.addEventListener('abort', fail, { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor 超时：期望的状态一直没有出现');
}

describe('ReleaseService 阶段一止血', () => {
  let stateDir: string;
  let stateService: StateService;
  let healthServer: http.Server;
  let healthUrl: string;
  const services: ReleaseService[] = [];

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-run-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
    stateService.addBranch({
      id: 'b1',
      projectId: 'p1',
      branch: 'main',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'running',
      pinnedCommit: 'a'.repeat(40),
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    stateService.addRemoteHost({
      id: 'host-prod',
      name: '生产主机',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'deploy',
      // 无 CDS_SECRET_KEY 时 sealToken 是 no-op，明文即可被 unsealToken 读回。
      sshPrivateKeyEncrypted: 'PLAINTEXT-TEST-KEY',
      sshPrivateKeyFingerprint: 'deadbeefdeadbeef',
      tags: [],
      isEnabled: true,
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);

    healthServer = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;
    stateService.upsertReleaseTarget(releaseTarget(healthUrl));
  });

  afterEach(async () => {
    // 把仍在途的执行体收掉，避免挂起的 Promise 与心跳定时器泄漏到下一个用例。
    for (const service of services.splice(0)) {
      for (const run of stateService.getReleaseRuns()) {
        if (isReleaseRunInFlight(run)) service.cancelRelease(run.releaseId, 'test-teardown');
      }
    }
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function releaseTarget(healthcheckUrl: string): ReleaseTarget {
    return {
      id: 'target-prod',
      projectId: 'p1',
      name: '生产站点',
      type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z',
      isEnabled: true,
      ssh: {
        host: '127.0.0.1',
        port: 22,
        user: 'deploy',
        privateKeyRef: 'host-prod',
        appPath: '/opt/app-prod/current',
        deployCommand: DEPLOY_COMMAND,
        healthcheckUrl,
      },
    };
  }

  function createService(
    deployHandler: (req: ReleaseSshExecRequest) => Promise<string>,
    options: ReleaseServiceOptions = {},
  ): { service: ReleaseService; calls: ReleaseSshExecRequest[] } {
    const calls: ReleaseSshExecRequest[] = [];
    const sshExecutor: ReleaseSshExecutor = async (req) => {
      calls.push(req);
      if (!isDeployCommand(req.command)) return 'cds-release-connect-ok';
      return deployHandler(req);
    };
    const service = new ReleaseService(stateService, { sshExecutor, ...options });
    services.push(service);
    return { service, calls };
  }

  function seedRun(overrides: Partial<ReleaseRun> & { releaseId: string; status: ReleaseRunStatus }): ReleaseRun {
    const startedAt = overrides.startedAt || new Date().toISOString();
    return stateService.addReleaseRun({
      projectId: 'p1',
      branchId: 'b1',
      commitSha: 'a'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
      targetId: 'target-prod',
      planId: 'p1:ssh-script',
      startedAt,
      logs: [],
      seq: 0,
      ...overrides,
    });
  }

  function start(service: ReleaseService): Promise<ReleaseRun> {
    return service.startRelease({
      branchId: 'b1',
      targetId: 'target-prod',
      operator: 'tester',
      previewUrl: 'https://preview.example.test',
    });
  }

  // ── 中断收敛（本阶段最重要的一件事） ────────────────────────────────────

  it('CDS 发布中途重启：心跳过期的 run 收敛为失败，该发布目标可以再次发布', async () => {
    const stale = new Date(Date.now() - RELEASE_HEARTBEAT_STALE_MS - 60_000).toISOString();
    seedRun({ releaseId: 'rel_zombie', status: 'running', startedAt: stale, heartbeatAt: stale });

    // 修复前：在途守卫看到这条永远停在 running 的 run，拒绝一切新发布 —— 目标被永久锁死。
    const { service } = createService(async () => 'deployed');
    const run = await start(service);
    expect(run.releaseId).not.toBe('rel_zombie');

    const zombie = stateService.getReleaseRun('rel_zombie')!;
    expect(zombie.status).toBe('failed');
    expect(zombie.finishedAt).toBeTruthy();
    expect(zombie.failure?.code).toBe('release.interrupted');
    expect(zombie.failure?.owner).toBe('cds');
    expect(zombie.failure?.retryable).toBe(true);
    expect(zombie.failure?.suggestedAction).toBeTruthy();
    expect(zombie.errorMessage).toContain('CDS 重启导致执行体丢失');
  });

  it('reconcileInterruptedReleases 只收心跳过期的非终态 run', () => {
    const stale = new Date(Date.now() - RELEASE_HEARTBEAT_STALE_MS - 1_000).toISOString();
    const fresh = new Date().toISOString();
    seedRun({ releaseId: 'rel_stale', status: 'running', startedAt: stale, heartbeatAt: stale });
    seedRun({ releaseId: 'rel_fresh', status: 'running', startedAt: fresh, heartbeatAt: fresh });
    seedRun({ releaseId: 'rel_done', status: 'success', startedAt: stale, heartbeatAt: stale });
    seedRun({ releaseId: 'rel_rollback', status: 'rollback_running', startedAt: stale, heartbeatAt: stale });
    // 存量 run 没有 heartbeatAt：按 startedAt 判定，同样要被收掉。
    seedRun({ releaseId: 'rel_legacy', status: 'healthchecking', startedAt: stale });

    const { service } = createService(async () => 'deployed');
    expect(service.reconcileInterruptedReleases()).toEqual({ reconciled: 3 });

    expect(stateService.getReleaseRun('rel_stale')?.status).toBe('failed');
    expect(stateService.getReleaseRun('rel_legacy')?.status).toBe('failed');
    // 回滚 run 收敛到回滚侧的终态，不会串到 failed。
    expect(stateService.getReleaseRun('rel_rollback')?.status).toBe('rollback_failed');
    expect(stateService.getReleaseRun('rel_fresh')?.status).toBe('running');
    expect(stateService.getReleaseRun('rel_done')?.status).toBe('success');

    // 幂等：再收一轮没有可收的了。
    expect(service.reconcileInterruptedReleases()).toEqual({ reconciled: 0 });
  });

  it('状态怪异的存量 run 也能被收割器终态化，不会把目标永久锁死', async () => {
    const stale = new Date(Date.now() - RELEASE_HEARTBEAT_STALE_MS - 60_000).toISOString();
    // 未登记状态（例如已删除的历史状态 prechecking）没有合法转移边；收割器是
    // 「目标发不出去」的最后一道闸，遇到这种记录必须强制终态化而不是放弃。
    seedRun({ releaseId: 'rel_legacy_status', status: 'prechecking' as ReleaseRunStatus, startedAt: stale, heartbeatAt: stale });

    const { service } = createService(async () => 'deployed');
    expect(service.reconcileInterruptedReleases()).toEqual({ reconciled: 1 });
    expect(stateService.getReleaseRun('rel_legacy_status')?.status).toBe('failed');

    // 目标已释放，可以再次发布。
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)!.status === 'success');
  });

  // ── 心跳（与收割是一对闭环，缺一边就误杀慢发布） ────────────────────────

  it('SSH 长静默阶段持续打心跳，慢发布不会被收割器误杀', async () => {
    const { service } = createService(hangUntilAborted, { heartbeatIntervalMs: 15 });
    const run = await start(service);

    await waitFor(() => {
      const current = stateService.getReleaseRun(run.releaseId)!;
      return Boolean(current.heartbeatAt && current.heartbeatAt > current.startedAt);
    });

    const beating = stateService.getReleaseRun(run.releaseId)!;
    expect(beating.status).toBe('running');
    // 心跳新鲜 → 收割器不动它（这正是「长静默阶段必须打点」的意义）。
    expect(service.reconcileInterruptedReleases()).toEqual({ reconciled: 0 });
  });

  // ── 执行超时 ────────────────────────────────────────────────────────────

  it('远端脚本挂住超过执行超时：run 判失败并释放目标', async () => {
    const { service, calls } = createService(hangUntilAborted, { execTimeoutMs: 60 });
    const run = await start(service);

    await waitFor(() => isReleaseRunTerminal(stateService.getReleaseRun(run.releaseId)!.status));

    const timedOut = stateService.getReleaseRun(run.releaseId)!;
    expect(timedOut.status).toBe('failed');
    expect(timedOut.errorMessage).toContain('发布命令执行超时');
    expect(timedOut.failure?.code).toBe('release.exec.timeout');
    expect(timedOut.failure?.retryable).toBe(true);
    // 超时必须真的中止在跑的 SSH，而不是只改一条记录。
    expect(calls.some((call) => isDeployCommand(call.command) && call.signal.aborted)).toBe(true);
    // 目标已释放：可以再次发布。
    expect(stateService.getReleaseRuns({ targetId: 'target-prod' }).some(isReleaseRunInFlight)).toBe(false);
  });

  // ── 取消 ────────────────────────────────────────────────────────────────

  it('cancelRelease 终止在途发布、释放目标，并且幂等', async () => {
    const { service, calls } = createService(hangUntilAborted);
    const run = await start(service);
    await waitFor(() => calls.some((call) => isDeployCommand(call.command)));

    expect(service.cancelRelease(run.releaseId, 'alice')).toEqual({ ok: true });

    const cancelled = stateService.getReleaseRun(run.releaseId)!;
    expect(cancelled.status).toBe('failed');
    expect(cancelled.finishedAt).toBeTruthy();
    expect(cancelled.errorMessage).toContain('发布已被 alice 取消');
    expect(cancelled.failure?.code).toBe('release.cancelled');
    expect(calls.find((call) => isDeployCommand(call.command))!.signal.aborted).toBe(true);
    expect(stateService.getReleaseRuns({ targetId: 'target-prod' }).some(isReleaseRunInFlight)).toBe(false);

    // 幂等：对已终态的 run 再取消不抛异常、不改状态。
    expect(service.cancelRelease(run.releaseId, 'alice')).toEqual({ ok: true });
    expect(stateService.getReleaseRun(run.releaseId)!.status).toBe('failed');

    // 被取消的执行体随后抛出的中止异常不得把 run 二次改写。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stateService.getReleaseRun(run.releaseId)!.failure?.code).toBe('release.cancelled');
  });

  it('取消归因不被残留日志带偏（确定事实不走文本推断）', async () => {
    // 发布过程中脚本先往 stderr 吐了一行含 ECONNREFUSED 的噪声，随后用户取消。
    // 归因若按日志文本推断，会把一次人为取消误标成「目标主机不可达」。
    const { service } = createService(async (req) => {
      req.onOutput('warn', 'curl: (7) Failed to connect: ECONNREFUSED 10.0.0.9:6379\n');
      return hangUntilAborted(req);
    });
    const run = await start(service);
    await waitFor(() => (stateService.getReleaseRun(run.releaseId)!.logs || [])
      .some((log) => log.message.includes('ECONNREFUSED')));

    service.cancelRelease(run.releaseId, 'alice');
    expect(stateService.getReleaseRun(run.releaseId)!.failure?.code).toBe('release.cancelled');
  });

  it('cancelRelease 对不存在的 run 返回失败原因而不是抛异常', () => {
    const { service } = createService(async () => 'deployed');
    expect(service.cancelRelease('rel_nope', 'alice')).toEqual({
      ok: false,
      reason: 'ReleaseRun not found: rel_nope',
    });
  });

  // ── 状态机 ──────────────────────────────────────────────────────────────

  it('非法状态转移被拒绝，合法链路放行', () => {
    expect(canTransitionReleaseRun('queued', 'running')).toBe(true);
    expect(canTransitionReleaseRun('running', 'healthchecking')).toBe(true);
    expect(canTransitionReleaseRun('healthchecking', 'success')).toBe(true);
    expect(canTransitionReleaseRun('rollback_running', 'rollback_success')).toBe(true);

    // 跳步、回头、终态复活一律拒绝。
    expect(() => assertReleaseRunTransition('queued', 'success')).toThrow(/Invalid ReleaseRun transition/);
    expect(() => assertReleaseRunTransition('healthchecking', 'running')).toThrow(/Invalid ReleaseRun transition/);
    expect(() => assertReleaseRunTransition('failed', 'running')).toThrow(/Invalid ReleaseRun transition/);
    expect(() => assertReleaseRunTransition('success', 'failed')).toThrow(/Invalid ReleaseRun transition/);
    // 回滚 run 不得跨到发布侧终态。
    expect(() => assertReleaseRunTransition('rollback_running', 'success')).toThrow(/Invalid ReleaseRun transition/);
  });

  it('终态判定与在途判定互为取反', () => {
    expect(isReleaseRunTerminal('success')).toBe(true);
    expect(isReleaseRunTerminal('failed')).toBe(true);
    expect(isReleaseRunTerminal('rollback_success')).toBe(true);
    expect(isReleaseRunTerminal('rollback_failed')).toBe(true);
    for (const status of ['queued', 'running', 'healthchecking', 'rollback_running'] as ReleaseRunStatus[]) {
      expect(isReleaseRunTerminal(status), status).toBe(false);
      expect(isReleaseRunInFlight({ status }), status).toBe(true);
    }
  });

  it('已终态的 run 不会被在跑的执行体复活（状态机断言接在真实写入路径上）', async () => {
    // 取消发生在 SSH 命令已经发出之后：命令随后正常返回，执行体接着想推进到
    // healthchecking → success。没有转移断言时，一条已经终态化的 run 会被
    // 悄悄改回在途再改成成功，在途守卫和审计记录同时失真。
    let cancel: () => void = () => {};
    const { service } = createService(async () => {
      cancel();
      return 'deployed';
    });
    const run = await start(service);
    cancel = () => { service.cancelRelease(run.releaseId, 'alice'); };

    await waitFor(() => isReleaseRunTerminal(stateService.getReleaseRun(run.releaseId)!.status));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const final = stateService.getReleaseRun(run.releaseId)!;
    expect(final.status).toBe('failed');
    expect(final.failure?.code).toBe('release.cancelled');
  });

  it('成功发布走完 queued → running → healthchecking → success', async () => {
    const { service } = createService(async () => 'deployed');
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)!.status === 'success');

    const done = stateService.getReleaseRun(run.releaseId)!;
    expect(done.finishedAt).toBeTruthy();
    expect(done.heartbeatAt).toBeTruthy();
    expect(done.failure).toBeUndefined();
  });

  // ── 结构化失败 ──────────────────────────────────────────────────────────

  it('SSH 不通时给出 owner / 是否可重试 / 建议动作', async () => {
    const { service } = createService(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:22');
    });
    const run = await start(service);
    await waitFor(() => isReleaseRunTerminal(stateService.getReleaseRun(run.releaseId)!.status));

    const failed = stateService.getReleaseRun(run.releaseId)!;
    expect(failed.failure?.code).toBe('release.ssh.unreachable');
    expect(failed.failure?.owner).toBe('external');
    expect(failed.failure?.retryable).toBe(true);
    expect(failed.failure?.suggestedAction).toContain('SSH 端口');
    expect(failed.failure?.evidenceRefs).toContain(`release-run:${run.releaseId}`);
  });

  it('脚本非零退出与健康探测失败各自归因，不再只有一个字符串', () => {
    const scriptExit = classifyReleaseFailure({
      message: 'ssh exec exit=1 stderr=dotnet build failed',
      phase: 'deploy',
    });
    expect(scriptExit.owner).not.toBe('unknown');
    expect(scriptExit.retryable).toBe(false);
    expect(scriptExit.suggestedAction).toBeTruthy();

    const healthcheck = classifyReleaseFailure({
      message: 'healthcheck HTTP 502',
      phase: 'healthcheck',
    });
    expect(healthcheck.code).toBe('release.healthcheck.failed');
    expect(healthcheck.owner).toBe('code');
    expect(healthcheck.retryable).toBe(true);
    expect(healthcheck.suggestedAction).toBeTruthy();

    // 委派给分支侧分类器：编译错误照样能被认出来，不用在发布侧复制那 12 条规则。
    const compile = classifyReleaseFailure({
      message: 'ssh exec exit=1',
      phase: 'deploy',
      logText: 'Program.cs(12,5): error CS1002: ; expected',
    });
    expect(compile.code).toBe('build.compile.csharp');
    expect(compile.owner).toBe('code');
  });
});
