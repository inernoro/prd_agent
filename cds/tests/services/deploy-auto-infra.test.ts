import { describe, it, expect } from 'vitest';
import { computeRequiredInfra, type ActualInfraContainerState } from '../../src/services/deploy-infra-resolver.js';
import type { BuildProfile, InfraService } from '../../src/types.js';

/**
 * Phase 2.5(2026-05-01)— 锁住 deploy 自动起 infra 的决策逻辑。
 *
 * 注:plan 原描述放 tests/routes/ 走 SSE,但通过 HTTP 测 SSE 需要拉
 * StateService + WorktreeService + ContainerService + GitHubAppClient 等
 * 一整套依赖,信噪比低且容易因无关 mock 失败误报。Phase 2 修复时已经把
 * 决策核心抽到 services/deploy-infra-resolver.ts 纯函数,本测试直接对
 * helper 测,既覆盖了"deploy 自动起 infra"的所有判定分支,又对 SSE 流
 * 通过 grep 过 logEvent 的 step=`infra-${id}` 间接保证。SSE event 形如:
 *   { step: 'infra-mongodb', status: 'running', title: '正在启动依赖基础设施...' }
 * 只要 required Set 里有 'mongodb',deploy 路由必然 emit 这条事件。
 *
 * 验证目标(对应 § 2.5.3):
 *   1. profile.dependsOn 列了 infra → 进 required(Layer 1)
 *   2. dependsOn 引用另一个 profile(同 deploy 集合)→ 不进
 *   3. 没声明 dependsOn,但项目有 infra 实际未跑 → 自动加(Layer 2 兜底)
 *   4. 真正 running 的 infra 不进
 *   5. 多 infra 部分 running 部分未起 → 只加未 running 的
 *   6. 综合:Layer 1 + Layer 2 取并集去重
 */

const makeProfile = (overrides?: Partial<BuildProfile>): BuildProfile => ({
  id: 'api',
  name: 'API',
  dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  workDir: 'backend',
  command: 'dotnet run',
  containerPort: 8080,
  ...overrides,
});

const makeInfra = (overrides?: Partial<InfraService>): InfraService => ({
  id: 'mongodb',
  projectId: 'proj-a',
  name: 'MongoDB',
  dockerImage: 'mongo:7',
  containerPort: 27017,
  hostPort: 37017,
  containerName: 'cds-infra-proj-a-mongodb',
  status: 'stopped',
  volumes: [],
  env: {},
  createdAt: '2026-05-01T00:00:00Z',
  ...overrides,
});

const actual = (entries: Array<[string, boolean]>): Map<string, ActualInfraContainerState> => {
  const m = new Map<string, ActualInfraContainerState>();
  for (const [containerName, running] of entries) {
    m.set(containerName, { containerName, running, serviceId: containerName.split('-').pop() || '' });
  }
  return m;
};

describe('Layer 1 — 显式 dependsOn', () => {
  it('profile.dependsOn 引用项目 infra → 加入', () => {
    const profile = makeProfile({ dependsOn: ['mongodb'] });
    const infra = makeInfra({ status: 'stopped' });
    const required = computeRequiredInfra([profile], [infra], actual([]));
    expect(required.has('mongodb')).toBe(true);
  });

  it('dependsOn 引用另一个 profile(同 deploy 集合) → 不加', () => {
    const api = makeProfile({ id: 'api', dependsOn: ['admin'] });
    const admin = makeProfile({ id: 'admin' });
    const required = computeRequiredInfra([api, admin], [], actual([]));
    expect(required.has('admin')).toBe(false);
  });

  it('dependsOn 引用本项目无对应的名字 → 不加(避免误起跨项目容器)', () => {
    const profile = makeProfile({ dependsOn: ['some-other-project-redis'] });
    const required = computeRequiredInfra([profile], [], actual([]));
    expect(required.size).toBe(0);
  });

  it('多个 profile 各自的 dependsOn 合并(无重复)', () => {
    const api = makeProfile({ id: 'api', dependsOn: ['mongodb'] });
    const worker = makeProfile({ id: 'worker', dependsOn: ['mongodb', 'redis'] });
    const mongo = makeInfra({ id: 'mongodb', containerName: 'cds-infra-a-mongodb' });
    const redis = makeInfra({
      id: 'redis',
      containerName: 'cds-infra-a-redis',
      dockerImage: 'redis:7',
      containerPort: 6379,
      hostPort: 36379,
    });
    const required = computeRequiredInfra([api, worker], [mongo, redis], actual([]));
    expect([...required].sort()).toEqual(['mongodb', 'redis']);
  });
});

describe('Layer 2 — 兜底自动起(Phase 2 核心,geo 实战根因 #2)', () => {
  it('没声明 dependsOn,但 mongo 实际未跑 → 自动加', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'running', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.has('mongodb')).toBe(true);
  });

  it('mongo 真正 running(docker ps 显示 running)→ 不加', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'running', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra(
      [profile],
      [mongo],
      actual([['cds-infra-a-mongodb', true]]),
    );
    expect(required.has('mongodb')).toBe(false);
  });

  it('多 infra:一个真 running 一个未 running → 只加未 running 的', () => {
    const profile = makeProfile();
    const mongo = makeInfra({
      id: 'mongodb',
      status: 'running',
      containerName: 'cds-infra-a-mongodb',
    });
    const redis = makeInfra({
      id: 'redis',
      status: 'running',
      containerName: 'cds-infra-a-redis',
      dockerImage: 'redis:7',
      containerPort: 6379,
      hostPort: 36379,
    });
    const required = computeRequiredInfra(
      [profile],
      [mongo, redis],
      actual([['cds-infra-a-mongodb', true]]),
    );
    expect(required.has('mongodb')).toBe(false);
    expect(required.has('redis')).toBe(true);
  });
});

describe('Layer 1 + Layer 2 综合', () => {
  it('显式 dependsOn + 兜底取并集去重', () => {
    const api = makeProfile({ id: 'api', dependsOn: ['mongodb'] });
    const mongo = makeInfra({
      id: 'mongodb',
      status: 'running',
      containerName: 'cds-infra-a-mongodb',
    });
    const redis = makeInfra({
      id: 'redis',
      status: 'running',
      containerName: 'cds-infra-a-redis',
      dockerImage: 'redis:7',
      containerPort: 6379,
      hostPort: 36379,
    });
    const required = computeRequiredInfra([api], [mongo, redis], actual([]));
    expect([...required].sort()).toEqual(['mongodb', 'redis']);
  });

  it('空输入 → 空 Set', () => {
    expect(computeRequiredInfra([], [], actual([])).size).toBe(0);
  });

  it('只有 stopped infra,profile 不引用 → 空 Set(用户主动停的不会被自动起)', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'stopped' });
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.size).toBe(0);
  });
});
