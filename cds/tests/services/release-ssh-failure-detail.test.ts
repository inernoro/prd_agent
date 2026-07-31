import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseService,
  classifyReleaseFailure,
  isReleaseRunInFlight,
  type ReleaseSshExecRequest,
  type ReleaseSshExecutor,
} from '../../src/services/release-service.js';
import {
  SSH_EXEC_FAILURE_MAX_CHARS,
  formatSshExecFailure,
  maskSshExecSecrets,
} from '../../src/services/ssh-exec-failure.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';

/**
 * 事故回归：2026-07-29 16:07 的 rel_3c72935be772e798。
 *
 * 门禁挂在 gateway_route_self_test（ok=false / status=401），但发布中心的失败摘要
 * 是空的——判据 JSON 由 scripts/llmgw-prod-preflight.py 打到 **stdout**，而当时的
 * 摘要写成 `stderr.slice(0, 500)`：stdout 整段丢弃，set -eu 下 stderr 又基本为空。
 *
 * 本套件钉住三件事：stdout 必须进摘要、取尾不取头、预算不许超过下游的二次截断阈值。
 * 把 defaultReleaseSshExecutor 改回 `stderr.slice(0, 500)`，用例 1/2/6 必红。
 */

describe('formatSshExecFailure', () => {
  it('stderr 为空时，stdout 里的门禁判据必须进摘要（事故值回归）', () => {
    const preflightJson = [
      '{',
      '  "verdict": "fail",',
      '  "checks": [',
      '    {"name": "gateway_route_self_test", "ok": false, "status": 401, "keyEnv": "LLMGW_GATE_KEY"}',
      '  ]',
      '}',
    ].join('\n');

    const message = formatSshExecFailure({ exitCode: 1, stdout: preflightJson, stderr: '' });

    expect(message).toContain('gateway_route_self_test');
    expect(message).toContain('401');
    expect(message).toContain('--- stdout(tail) ---');
  });

  it('输出超预算时取尾不取头，且显式标注截断', () => {
    const lines: string[] = ['FIRST-LINE-MARKER'];
    for (let i = 0; i < 3_000; i += 1) lines.push(`noise line ${i}`);
    lines.push('LAST-LINE-MARKER');

    const message = formatSshExecFailure({ exitCode: 1, stdout: lines.join('\n'), stderr: '' });

    // 失败原因永远在输出末尾；头截断（slice(0, N)）会把它整段切掉。
    expect(message).toContain('LAST-LINE-MARKER');
    expect(message).not.toContain('FIRST-LINE-MARKER');
    expect(message).toContain('truncated');
  });

  it('预算必须小于下游 sanitizeFailureSummary 的头截断阈值，且格式化结果不越预算', () => {
    // 超过 2048 的话，这里保下来的尾部会在 sanitizeFailureSummary 里被从头切掉，等于白改。
    expect(SSH_EXEC_FAILURE_MAX_CHARS).toBeLessThan(2 * 1024);

    const huge = 'x'.repeat(50_000);
    const message = formatSshExecFailure({ exitCode: 7, stdout: huge, stderr: huge });
    expect(message.length).toBeLessThanOrEqual(SSH_EXEC_FAILURE_MAX_CHARS);
  });

  it('几 MB 的 stdout 不能把脱敏正则拖死（发布脚本的输出就是这个量级）', () => {
    // 脱敏前不裁窗口的话，PEM 那条惰性正则在这个输入上要跑几十秒。
    const megabytes = 'deploy log line padding\n'.repeat(200_000);
    const started = Date.now();
    const message = formatSshExecFailure({ exitCode: 1, stdout: `${megabytes}FINAL-FAILURE`, stderr: '' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(message).toContain('FINAL-FAILURE');
  });

  it('裁窗口切断 PEM 时，剩下的密钥残段必须一并丢掉而不是裸奔', () => {
    const keyBody = 'MIIEowIBAAKCAQEA0123456789abcdef\n'.repeat(2_000);
    const stdout = [
      '-----BEGIN RSA PRIVATE KEY-----',
      keyBody,
      '-----END RSA PRIVATE KEY-----',
      'preflight failed: gate 401',
    ].join('\n');

    const message = formatSshExecFailure({ exitCode: 1, stdout, stderr: '' });
    expect(message).not.toContain('MIIEowIBAAKCAQEA');
    expect(message).toContain('preflight failed: gate 401');
  });

  it('凭据必须脱敏（这条消息会原样落进 state.json，且不过 maskLog）', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const message = formatSshExecFailure({
      exitCode: 1,
      stdout: `GW_KEY=sk-live-abc123\nLLMGW_GATE_KEY=sk-gate-zzz\n${pem}`,
      stderr: 'API_KEY=sk-err-999',
    });

    expect(message).not.toContain('sk-live-abc123');
    expect(message).not.toContain('sk-gate-zzz');
    expect(message).not.toContain('sk-err-999');
    expect(message).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(message).toContain('***');
  });

  it('两段都为空时给出明确的空输出标记，而不是一句没有信息的裸退出码', () => {
    expect(formatSshExecFailure({ exitCode: 3, stdout: '', stderr: '' }))
      .toBe('ssh exec exit=3\n(no output captured)');
  });

  it('maskSshExecSecrets 覆盖 *_KEY= 前缀族（旧 maskLog 白名单盖不到 GW_KEY）', () => {
    expect(maskSshExecSecrets('GW_KEY=abc')).toBe('GW_KEY=***');
    expect(maskSshExecSecrets('TOKEN=abc')).toBe('TOKEN=***');
    expect(maskSshExecSecrets('普通输出 ok=false')).toBe('普通输出 ok=false');
  });

  /**
   * 非必红的回归钉：新格式不得打破既有失败分类。
   * 首行 `exit=<code>` 之后必须是非单词字符，否则 release.script.missing 规则里的
   * `/ssh exec exit=4[12]\b/` 会失配，41/42 会从「配置问题、不可重试」掉回泛化分类。
   */
  it('新格式不得打破 release.script.missing 的分类正则', () => {
    for (const exitCode of [41, 42]) {
      const failure = classifyReleaseFailure({
        message: formatSshExecFailure({ exitCode, stdout: 'preflight aborted', stderr: '' }),
        phase: 'preflight',
      });
      expect(failure.code).toBe('release.script.missing');
      expect(failure.retryable).toBe(false);
    }
  });
});

describe('ReleaseService 失败摘要端到端', () => {
  let stateDir: string;
  let stateService: StateService;
  let healthServer: http.Server;
  let healthUrl: string;
  const services: ReleaseService[] = [];

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ssh-failure-'));
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

    healthServer = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;
    stateService.upsertReleaseTarget({
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
        deployCommand: "CDS_LOCAL_PROD_DIR='/opt/app-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'",
        healthcheckUrl: healthUrl,
      },
    } as ReleaseTarget);
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

  async function waitForTerminal(releaseId: string): Promise<ReleaseRun> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const run = stateService.getReleaseRun(releaseId);
      if (run && !isReleaseRunInFlight(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('等待 run 终态超时');
  }

  it('stdout 里的门禁判据要一路活到 failure.summary（同时验证没被二次头截断）', async () => {
    // 判据前面塞满噪音：只有「取尾 + 预算 < 2048」同时成立，判据才活得到摘要。
    const noise = Array.from({ length: 400 }, (_, i) => `warm-up noise line ${i}`).join('\n');
    const verdict = '{"name": "gateway_route_self_test", "ok": false, "status": 401}';
    const sshExecutor: ReleaseSshExecutor = async (req: ReleaseSshExecRequest) => {
      if (!req.command.includes('CDS_RELEASE_ID=')) return 'cds-release-connect-ok';
      throw new Error(formatSshExecFailure({ exitCode: 1, stdout: `${noise}\n${verdict}`, stderr: '' }));
    };
    const service = new ReleaseService(stateService, { sshExecutor });
    services.push(service);

    const started = await service.startRelease({
      branchId: 'b1',
      targetId: 'target-prod',
      operator: 'tester',
      previewUrl: 'https://preview.example.test',
    });
    const run = await waitForTerminal(started.releaseId);

    expect(run.status).toBe('failed');
    expect(run.failure?.summary).toContain('gateway_route_self_test');
    expect(run.failure?.summary).toContain('401');
    expect(run.errorMessage).toContain('gateway_route_self_test');
  });
});
