import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseService,
  isReleaseRunInFlight,
  type ReleaseSshExecRequest,
  type ReleaseSshExecutor,
} from '../../src/services/release-service.js';
import {
  canReuseReleasePreflight,
  RELEASE_PREFLIGHT_REUSE_TTL_MS,
} from '../../src/services/release-retention.js';
import { StateService } from '../../src/services/state.js';
import type { ReleasePreflightRecord, ReleaseTarget } from '../../src/types.js';

/**
 * 预检落库 + 复用回归（阶段三记账）。
 *
 * 事故值：「向导点预检 → 立刻点发布」会打 **2 轮**完全独立的探测 ——
 * `POST /preflight` 跑一次 SSH（echo 连通 + 远端仓库身份 + 脚本可执行）加一次 HTTP
 * 健康探测，`startRelease` 第一句 `await this.preflight(input)` 又原样再跑一遍。
 * 于是**用户看到并据以决策的结论，不是真正放行发布的那一份**（debt #4）。
 * 修复后同一轮只探测 1 次，run 显式引用那份落库结论。
 *
 * 反向断言同样重要：复用绝不能变成盲信。commit 变了 / 结论过期 / ok=false 一律重跑。
 */

const DEPLOY_COMMAND = "CDS_LOCAL_PROD_DIR='/opt/app-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'";

function isDeployCommand(command: string): boolean {
  return command.includes('CDS_RELEASE_ID=');
}

const CONNECT_PROBE = 'echo cds-release-connect-ok';

/** 一直挂着直到被中止：让发布停在真正的部署命令上，后续健康检查不会污染探测计数。 */
function hangUntilAborted(req: ReleaseSshExecRequest): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const fail = () => reject(req.signal.reason instanceof Error
      ? req.signal.reason
      : new Error(String(req.signal.reason)));
    if (req.signal.aborted) return fail();
    req.signal.addEventListener('abort', fail, { once: true });
  });
}

describe('发布前检查落库与复用', () => {
  let stateDir: string;
  let stateService: StateService;
  let healthServer: http.Server;
  let healthUrl: string;
  let healthProbeCount = 0;
  const services: ReleaseService[] = [];

  beforeEach(async () => {
    healthProbeCount = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-preflight-'));
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
      sshPrivateKeyEncrypted: 'PLAINTEXT-TEST-KEY',
      sshPrivateKeyFingerprint: 'deadbeefdeadbeef',
      tags: [],
      isEnabled: true,
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);

    healthServer = http.createServer((_req, res) => {
      healthProbeCount += 1;
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;
    stateService.upsertReleaseTarget(releaseTarget(healthUrl));
    // 先垫一条历史成功发布：否则预检认定这是「首次托管发布」，会跳过上线地址探测，
    // 健康探测计数恒为 0，测不出「预检整套翻倍」里的 HTTP 那一半。
    stateService.addReleaseRun({
      releaseId: 'rel_history',
      projectId: 'p1',
      branchId: 'b1',
      commitSha: '9'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: '9'.repeat(40), branchId: 'b1', branchName: 'main' },
      targetId: 'target-prod',
      planId: 'p1:ssh-script',
      status: 'success',
      startedAt: '2026-07-27T00:00:00.000Z',
      finishedAt: '2026-07-27T00:05:00.000Z',
      logs: [],
      seq: 0,
    });
  });

  afterEach(async () => {
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

  function createService(): {
    service: ReleaseService;
    probes: string[];
    countConnectProbes: () => number;
    countScriptProbes: () => number;
  } {
    const probes: string[] = [];
    const sshExecutor: ReleaseSshExecutor = async (req: ReleaseSshExecRequest) => {
      probes.push(req.command);
      // 发布命令挂住不返回：发布停在 deploy 这一步，健康检查等后续探测不会掺进计数。
      if (isDeployCommand(req.command)) return hangUntilAborted(req);
      return 'cds-release-connect-ok';
    };
    const service = new ReleaseService(stateService, { sshExecutor });
    services.push(service);
    return {
      service,
      probes,
      // 连通探测在预检与执行的 connect 步骤里都会发一条，所以要按条数而不是「有没有」断言。
      countConnectProbes: () => probes.filter((cmd) => cmd === CONNECT_PROBE).length,
      // 脚本可执行检查只有预检才发，是「预检跑了几轮」最干净的计数器。
      countScriptProbes: () => probes.filter((cmd) => cmd !== CONNECT_PROBE && !isDeployCommand(cmd)).length,
    };
  }

  const startInput = {
    branchId: 'b1',
    targetId: 'target-prod',
    operator: 'tester',
    previewUrl: 'https://preview.example.test',
  };

  it('向导预检 + 立刻发布：只探测一轮，run 引用的就是向导那份结论', async () => {
    const { service, countConnectProbes, countScriptProbes } = createService();

    const preflight = await service.preflight(startInput);
    expect(preflight.ok).toBe(true);
    expect(preflight.preflightId).toBeTruthy();
    expect(countConnectProbes()).toBe(1);
    expect(countScriptProbes()).toBe(1);
    expect(healthProbeCount).toBe(1);

    const run = await service.startRelease({ ...startInput, preflightId: preflight.preflightId });

    // 事故值：修复前这三项分别是 2 / 2 / 2 —— startRelease 内部无条件再跑一遍 preflight，
    // 于是预检的 SSH 与 HTTP 探测整套翻倍，且真正放行发布的是第二份结论。
    // 修复后连通探测只剩「预检 1 次 + 执行 connect 步骤 1 次」，脚本与健康探测各 1 次。
    expect(countConnectProbes()).toBe(2);
    expect(countScriptProbes()).toBe(1);
    expect(healthProbeCount).toBe(1);
    expect(run.preflightId).toBe(preflight.preflightId);

    const record = stateService.getReleasePreflight(preflight.preflightId!);
    expect(record?.ok).toBe(true);
    expect(record?.artifactCommitSha).toBe('a'.repeat(40));
    expect(record?.checks.length).toBe(preflight.checks.length);
  });

  it('前端没回传 preflightId 时，服务端按 (分支,目标,预览地址,操作人) 找回同一份', async () => {
    const { service, countScriptProbes } = createService();
    const preflight = await service.preflight(startInput);

    const run = await service.startRelease(startInput);

    expect(countScriptProbes()).toBe(1);
    expect(healthProbeCount).toBe(1);
    expect(run.preflightId).toBe(preflight.preflightId);
  });

  it('没有任何可复用结论时照常自己跑一次预检并落库', async () => {
    const { service, countScriptProbes } = createService();
    const run = await service.startRelease(startInput);
    expect(countScriptProbes()).toBe(1);
    expect(run.preflightId).toBeTruthy();
    expect(stateService.getReleasePreflight(run.preflightId!)?.ok).toBe(true);
  });

  it('分支 commit 变了：落库结论作废，发布前重新探测一轮', async () => {
    const { service, countScriptProbes } = createService();
    const preflight = await service.preflight(startInput);
    expect(preflight.ok).toBe(true);

    // 结论依据的产物已经不是现在要发的产物 —— 复用就是拿旧证据放行新东西。
    stateService.getBranch('b1')!.pinnedCommit = 'b'.repeat(40);
    const run = await service.startRelease({ ...startInput, preflightId: preflight.preflightId });

    expect(countScriptProbes()).toBe(2);
    expect(run.preflightId).not.toBe(preflight.preflightId);
    expect(run.commitSha).toBe('b'.repeat(40));
  });

  it('发布目标在复用窗口内被禁用：不许拿旧结论放行', async () => {
    const { service } = createService();
    const preflight = await service.preflight(startInput);
    expect(preflight.ok).toBe(true);

    stateService.upsertReleaseTarget({ ...releaseTarget(healthUrl), isEnabled: false });
    await expect(service.startRelease({ ...startInput, preflightId: preflight.preflightId }))
      .rejects.toThrow(/发布前检查未通过/);
  });

  it('预检结论落库后受保留策略约束，不会无界堆积', async () => {
    const { service } = createService();
    for (let i = 0; i < 25; i += 1) await service.preflight(startInput);
    expect(stateService.getReleasePreflights({ targetId: 'target-prod' }).length).toBeLessThanOrEqual(20);
  });
});

describe('canReuseReleasePreflight 判据', () => {
  const base: ReleasePreflightRecord = {
    id: 'pfl_1',
    projectId: 'p1',
    branchId: 'b1',
    targetId: 'target-prod',
    previewUrl: 'https://preview.example.test',
    operator: 'tester',
    ok: true,
    checks: [],
    artifactCommitSha: 'a'.repeat(40),
    // 目标配置指纹是复用的必要条件之一（Codex P1）：只比 targetId 的话，运维在两分钟
    // 复用窗口里换掉 host / 凭据 / 目录 / 脚本，旧结论会被套到没验证过的目标上。
    targetConfigFingerprint: 'fp_target_v1',
    createdAt: '2026-07-28T10:00:00.000Z',
  };
  const nowMs = Date.parse('2026-07-28T10:00:30.000Z');
  const key = {
    branchId: 'b1',
    targetId: 'target-prod',
    previewUrl: 'https://preview.example.test',
    operator: 'tester',
    commitSha: 'a'.repeat(40),
    targetConfigFingerprint: 'fp_target_v1',
  };

  it('同一件事、同一 commit、未过期 → 可复用', () => {
    expect(canReuseReleasePreflight(base, key, nowMs)).toBe(true);
  });

  it('目标配置变了 → 旧结论证明不了新目标，必须重跑', () => {
    expect(canReuseReleasePreflight(base, { ...key, targetConfigFingerprint: 'fp_target_v2' }, nowMs)).toBe(false);
  });

  it('存量记录没有指纹 → 一律重跑，不盲信', () => {
    const legacy = { ...base, targetConfigFingerprint: undefined };
    expect(canReuseReleasePreflight(legacy, key, nowMs)).toBe(false);
  });

  it('分支 commit 已经变了 → 旧结论证明不了新产物，必须重跑', () => {
    expect(canReuseReleasePreflight(base, { ...key, commitSha: 'b'.repeat(40) }, nowMs)).toBe(false);
  });

  it('拿不到当前 commit → 无从比对，宁可重跑', () => {
    expect(canReuseReleasePreflight(base, { ...key, commitSha: '' }, nowMs)).toBe(false);
  });

  it('结论已过期 → 重跑', () => {
    const expiredNow = Date.parse(base.createdAt) + RELEASE_PREFLIGHT_REUSE_TTL_MS + 1;
    expect(canReuseReleasePreflight(base, key, expiredNow)).toBe(false);
  });

  it('ok=false 一律不复用', () => {
    expect(canReuseReleasePreflight({ ...base, ok: false }, key, nowMs)).toBe(false);
  });

  it('换了目标 / 预览地址 / 操作人都不复用', () => {
    expect(canReuseReleasePreflight(base, { ...key, targetId: 'other' }, nowMs)).toBe(false);
    expect(canReuseReleasePreflight(base, { ...key, previewUrl: 'https://other.test' }, nowMs)).toBe(false);
    expect(canReuseReleasePreflight(base, { ...key, operator: 'someone-else' }, nowMs)).toBe(false);
  });

  it('记录来自未来（时钟回拨）→ 不可信，不复用', () => {
    expect(canReuseReleasePreflight(base, key, Date.parse(base.createdAt) - 1)).toBe(false);
  });
});
