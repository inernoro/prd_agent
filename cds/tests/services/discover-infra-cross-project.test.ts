import { describe, it, expect } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

/**
 * 跨项目同名 infra 隔离测试(Phase 2.5,2026-05-01)。
 *
 * 历史 bug:`discoverInfraContainers` 旧版用 `cds.service.id` 当 Map key,
 * 跨项目同名时 Map.set 互相覆盖 — A 项目查 mongodb 拿到 B 项目容器状态。
 * Phase 2 修复:Map key 改用 containerName(全局唯一,格式 cds-infra-<projectSlug>-<id>)。
 *
 * 本测试锁住该修复,防止后续 refactor 不小心改回 svc.id。
 */

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {},
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

describe('discoverInfraContainers — 跨项目隔离', () => {
  it('两个项目都有 svc.id="mongodb" 时,Map key 用 containerName 不撞', async () => {
    const mock = new MockShellExecutor();
    const service = new ContainerService(mock, makeConfig());
    // 模拟 docker ps 返回两个项目的同名 mongodb 容器
    mock.addResponsePattern(/docker ps/, () => ({
      stdout: [
        'cds-infra-proj-a-mongodb|running|cds.managed=true,cds.type=infra,cds.service.id=mongodb,cds.network=cds-proj-a',
        'cds-infra-proj-b-mongodb|exited|cds.managed=true,cds.type=infra,cds.service.id=mongodb,cds.network=cds-proj-b',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));

    const found = await service.discoverInfraContainers();

    // 关键:两条记录都在 — 旧 bug 下只剩后写入的(撞 key)
    expect(found.size).toBe(2);
    expect(found.has('cds-infra-proj-a-mongodb')).toBe(true);
    expect(found.has('cds-infra-proj-b-mongodb')).toBe(true);

    // value 里的 serviceId 都是 'mongodb',但 key 不同
    expect(found.get('cds-infra-proj-a-mongodb')?.serviceId).toBe('mongodb');
    expect(found.get('cds-infra-proj-b-mongodb')?.serviceId).toBe('mongodb');

    // running 状态分项目独立
    expect(found.get('cds-infra-proj-a-mongodb')?.running).toBe(true);
    expect(found.get('cds-infra-proj-b-mongodb')?.running).toBe(false);
  });

  it('value.containerName 与 key 一致,方便调用方反查', async () => {
    const mock = new MockShellExecutor();
    const service = new ContainerService(mock, makeConfig());
    mock.addResponsePattern(/docker ps/, () => ({
      stdout: 'cds-infra-geo-mongodb|running|cds.managed=true,cds.type=infra,cds.service.id=mongodb,cds.network=cds-proj-geo',
      stderr: '',
      exitCode: 0,
    }));

    const found = await service.discoverInfraContainers();
    const entry = found.get('cds-infra-geo-mongodb');
    expect(entry).toBeDefined();
    expect(entry!.containerName).toBe('cds-infra-geo-mongodb');
  });

  it('docker ps 无输出时返回空 Map(不抛错)', async () => {
    const mock = new MockShellExecutor();
    const service = new ContainerService(mock, makeConfig());
    mock.addResponsePattern(/docker ps/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const found = await service.discoverInfraContainers();
    expect(found.size).toBe(0);
  });

  it('docker ps 失败时返回空 Map(降级,不阻断 deploy)', async () => {
    const mock = new MockShellExecutor();
    const service = new ContainerService(mock, makeConfig());
    mock.addResponsePattern(/docker ps/, () => ({
      stdout: '', stderr: 'cannot connect to docker daemon', exitCode: 1,
    }));

    const found = await service.discoverInfraContainers();
    expect(found.size).toBe(0);
  });

  it('混合多种 service.id 不串(redis / mongodb / postgres 三项目 9 容器)', async () => {
    const mock = new MockShellExecutor();
    const service = new ContainerService(mock, makeConfig());
    const lines: string[] = [];
    for (const proj of ['a', 'b', 'c']) {
      for (const svc of ['mongodb', 'redis', 'postgres']) {
        lines.push(
          `cds-infra-${proj}-${svc}|running|cds.managed=true,cds.type=infra,cds.service.id=${svc},cds.network=cds-proj-${proj}`,
        );
      }
    }
    mock.addResponsePattern(/docker ps/, () => ({
      stdout: lines.join('\n'),
      stderr: '',
      exitCode: 0,
    }));

    const found = await service.discoverInfraContainers();
    expect(found.size).toBe(9);
    // 任取一组确认 svc.id 没串
    expect(found.get('cds-infra-a-mongodb')?.serviceId).toBe('mongodb');
    expect(found.get('cds-infra-b-redis')?.serviceId).toBe('redis');
    expect(found.get('cds-infra-c-postgres')?.serviceId).toBe('postgres');
  });
});
