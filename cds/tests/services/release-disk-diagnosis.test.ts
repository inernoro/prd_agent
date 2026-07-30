/**
 * release-disk-diagnosis.test.ts —— 发布目标只读磁盘诊断的判定源。
 *
 * 背景（2026-07-30）：生产发布三连死在发布脚本的磁盘护栏
 * （`requires at least 4096MB free on /; available=3870MB`），CDS 没有自由 shell，
 * 用户和 Agent 只能对着差额猜「空间被什么吃掉了」。磁盘诊断把猜变成看。
 *
 * 三条红线：
 * 1. 命令**只许读**——出现任何删除/修剪/写入动词即 fail（清理永远是人的决定）；
 * 2. appPath 必须 shell 转义——目标路径来自配置，不许拼进命令注入；
 * 3. 输出必须过脱敏——docker/env 输出里可能带凭据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  ReleaseService,
  buildDiskDiagnosisCommand,
} from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseTarget } from '../../src/types.js';
import { parseDiskGuardShortfall } from '../../web/src/lib/releaseDiagnosis';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('buildDiskDiagnosisCommand 只许读', () => {
  const command = buildDiskDiagnosisCommand('/root/inernoro/prd_agent');

  it('覆盖 df / docker df / 镜像排行 / 热点目录 du', () => {
    expect(command).toContain('df -Pm');
    expect(command).toContain('docker system df');
    expect(command).toContain('docker images');
    expect(command).toContain('du -sm');
    expect(command).toContain('.llmgw-release-evidence');
  });

  it('不含任何删除/修剪/写入动作（清理是人的决定）', () => {
    // 事故预防红线：这条命令会在生产机上以 root 跑，任何写动作都不可接受。
    expect(command).not.toMatch(/\b(rm|rmdir|prune|rmi|truncate|mkfs|dd|mv|chown|chmod|kill)\b/);
    // 唯一允许的重定向是丢弃 stderr 的 `2>/dev/null`；重定向到任何真实文件都算写。
    expect(command).not.toMatch(/>(?!\/dev\/null)/);
  });

  it('appPath 走 shell 单引号转义，注入串只会变成字面路径', () => {
    const hostile = buildDiskDiagnosisCommand("/tmp/x'; rm -rf /; echo '");
    expect(hostile).toContain("'/tmp/x'\\''; rm -rf /; echo '\\'''");
    // 转义后 rm 只出现在引号内的字面量里，不再是可执行 token：
    // 上一条只读断言对默认路径成立即可，这里验证引号闭合正确。
  });

  it('空 appPath 退回当前目录而不是拼出空串', () => {
    expect(buildDiskDiagnosisCommand('')).toContain("df -Pm '.'");
  });
});

describe('ReleaseService.diskDiagnosis', () => {
  let stateDir: string;
  let stateService: StateService;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-disk-diag-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addRemoteHost({
      id: 'host-prod',
      name: '生产主机',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'root',
      sshPrivateKeyEncrypted: 'PLAINTEXT-TEST-KEY',
      sshPrivateKeyFingerprint: 'deadbeefdeadbeef',
      tags: [],
      isEnabled: true,
      createdAt: '2026-07-30T00:00:00.000Z',
    } as never);
  });

  afterEach(async () => {
    await stateService.flush();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const target: ReleaseTarget = {
    id: 'target-prod',
    projectId: 'p1',
    name: '生产站点',
    type: 'ssh',
    isEnabled: true,
    createdAt: '2026-07-30T00:00:00.000Z',
    ssh: {
      host: 'map.example.net',
      port: 22,
      user: 'root',
      privateKeyRef: 'host-prod',
      appPath: '/root/app',
      deployCommand: './fast.sh',
      healthcheckUrl: 'https://map.example.net/api/version',
    },
  } as never;

  it('跑的是诊断命令，且输出过脱敏', async () => {
    let executed = '';
    const service = new ReleaseService(stateService, {
      sshExecutor: async (req) => {
        executed = req.command;
        return '== df ==\nAuthorization: Bearer sk-live-abcdef1234567890abcdef\n/dev/vda1 40000 36000 3870 91% /';
      },
    });
    const output = await service.diskDiagnosis(target);
    expect(executed).toContain('df -Pm');
    expect(executed).toContain("'/root/app'");
    expect(output).toContain('3870');
    // 脱敏与发布日志同一判据：凭据不许原样透出。
    expect(output).not.toContain('sk-live-abcdef1234567890abcdef');
  });

  it('非站点目标直接拒绝', async () => {
    const service = new ReleaseService(stateService, { sshExecutor: async () => 'ok' });
    await expect(service.diskDiagnosis({ ...target, ssh: undefined } as never))
      .rejects.toThrow('站点发布目标');
  });
});

describe('parseDiskGuardShortfall：从失败日志认出磁盘护栏', () => {
  it('解析出需求/可用/差额/挂载点（对齐 llmgw-disk-space-guard.sh 输出）', () => {
    const logs = [
      { level: 'warn', message: 'WARN: something else' },
      { level: 'warn', message: 'ERROR: LLM Gateway production stage http-full requires at least 4096MB free on /; available=3870MB target=.llmgw-release-evidence' },
    ];
    expect(parseDiskGuardShortfall(logs as never)).toEqual({
      requiredMb: 4096,
      availableMb: 3870,
      shortfallMb: 226,
      mountPoint: '/',
    });
  });

  it('非磁盘失败返回 null，不给无关失败塞磁盘按钮', () => {
    expect(parseDiskGuardShortfall([{ level: 'error', message: 'ssh exec exit=1' }] as never)).toBeNull();
    expect(parseDiskGuardShortfall([] as never)).toBeNull();
  });
});

describe('接线守卫：判定真的被路由与页面消费', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../', rel), 'utf8');

  it('路由注册了只读诊断端点并调用 service.diskDiagnosis', () => {
    const routes = read('src/routes/releases.ts');
    expect(routes).toContain("'/releases/targets/:id/disk-diagnosis'");
    expect(routes).toContain('service.diskDiagnosis(');
  });

  it('失败诊断页在磁盘护栏失败时给出诊断入口', () => {
    const page = read('web/src/pages/release-center/FailureDiagnosis.tsx');
    expect(page).toContain('parseDiskGuardShortfall');
    expect(page).toContain('/disk-diagnosis');
    expect(page).toContain('磁盘诊断');
  });
});
