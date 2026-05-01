import { describe, it, expect } from 'vitest';
import { computeRequiredInfra, type ActualInfraContainerState } from '../../src/services/deploy-infra-resolver.js';
import type { BuildProfile, InfraService } from '../../src/types.js';

/**
 * Phase 2.5(2026-05-01)— state vs docker 实际状态同步测试。
 *
 * 锁住 Phase 2 的关键修正:**docker 实际状态优先于 state.json**。
 *
 * 历史背景:
 *   旧版 deploy 路由直接信 `infra.status === 'running'` 跳过启动。问题是
 *   state.json 写入有滞后:
 *   - CDS 重启后 reconcile 还没跑完(前几秒 state 滞后)
 *   - 用户在 CDS 之外手动 `docker stop` 了容器(state 完全不知道)
 *   - 容器自己 OOMKill 退出(state 没人来更新)
 *   这些情况下 state 写 running 但 docker 实际 Exited。旧版 deploy 把它跳过
 *   → 应用一启动就 DNS 解析失败。
 *
 * Phase 2 修复:在 deploy 决策时调 discoverInfraContainers 取 docker 实际状态,
 * 凡是 state 不是 stopped 但 docker 实际未 running 的,一律加进 required。
 * 用户主动 stop 的(status='stopped')仍然跳过 — 那是用户意愿。
 *
 * 验证目标(对应 § 2.5.4):
 *   1. state="running" + docker 不存在 → 加入(stale state)
 *   2. state="running" + docker 存在但 Exited → 加入
 *   3. state="error" + docker 不存在 → 加入(error 不应阻止重启)
 *   4. state="stopped" + docker 实际不在 → 仍然跳过(用户主动停)
 *   5. state="stopped" + docker 实际 running → 仍然跳过(用户停了 state,但容器
 *      还在跑;deploy 不主动接管)— 这是有意行为
 *   6. 跨项目同名 infra 用 containerName 隔离查 docker 状态(锁住 Phase 2 修过的
 *      Map key 撞键 bug)
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
  status: 'running',
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

describe('state vs docker — docker 状态优先', () => {
  it('state="running" + docker 完全不存在(reconcile 滞后)→ 加入 required', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'running', containerName: 'cds-infra-a-mongodb' });
    // actualInfraState 里没有该 container — 模拟 docker ps 看不到
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.has('mongodb')).toBe(true);
  });

  it('state="running" + docker 容器存在但 Exited(被 OOMKill 或手动 stop)→ 加入', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'running', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra(
      [profile],
      [mongo],
      actual([['cds-infra-a-mongodb', false]]),  // 存在但未 running
    );
    expect(required.has('mongodb')).toBe(true);
  });

  it('state="error"(上次启动失败)+ docker 不存在 → 加入(允许重试)', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'error', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.has('mongodb')).toBe(true);
  });

  it('state="running" + docker 真的 running → 不加(正常 happy path)', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'running', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra(
      [profile],
      [mongo],
      actual([['cds-infra-a-mongodb', true]]),
    );
    expect(required.has('mongodb')).toBe(false);
  });
});

describe('state="stopped" 永远跳过(尊重用户意愿)', () => {
  it('state="stopped" + docker 实际不在 → 跳过(用户主动停了)', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'stopped', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.has('mongodb')).toBe(false);
  });

  it('state="stopped" + docker 还 running(陈旧)→ 仍然跳过(deploy 不主动接管)', () => {
    const profile = makeProfile();
    const mongo = makeInfra({ status: 'stopped', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra(
      [profile],
      [mongo],
      actual([['cds-infra-a-mongodb', true]]),
    );
    expect(required.has('mongodb')).toBe(false);
  });

  it('Layer 1 例外:state="stopped" 但 profile 显式 dependsOn → 重新启动', () => {
    // dependsOn 是显式声明,deploy 应该尊重它,自动 reset stopped → running
    const profile = makeProfile({ dependsOn: ['mongodb'] });
    const mongo = makeInfra({ status: 'stopped', containerName: 'cds-infra-a-mongodb' });
    const required = computeRequiredInfra([profile], [mongo], actual([]));
    expect(required.has('mongodb')).toBe(true);
  });
});

describe('跨项目 containerName 隔离(Phase 2 修过的 Map key 撞键 bug)', () => {
  it('A 项目 mongodb Exited + B 项目 mongodb running → A deploy 应该加入', () => {
    // projectInfra 只传 A 项目的 — 模拟 stateService.getInfraServicesForProject('proj-a')
    const profile = makeProfile();
    const mongoA = makeInfra({
      projectId: 'proj-a',
      status: 'running',
      containerName: 'cds-infra-a-mongodb',
    });
    // actualInfraState 同时含 A + B(docker ps 不区分项目,Phase 2 修复后用 containerName key)
    const required = computeRequiredInfra(
      [profile],
      [mongoA],
      actual([
        ['cds-infra-a-mongodb', false],    // A 容器 Exited → 应该加入
        ['cds-infra-b-mongodb', true],     // B 容器 running(无关,不应被误用)
      ]),
    );
    expect(required.has('mongodb')).toBe(true);
  });

  it('A 项目 mongodb running + B 项目 mongodb Exited → A deploy 不加(B 状态不串)', () => {
    const profile = makeProfile();
    const mongoA = makeInfra({
      projectId: 'proj-a',
      status: 'running',
      containerName: 'cds-infra-a-mongodb',
    });
    const required = computeRequiredInfra(
      [profile],
      [mongoA],
      actual([
        ['cds-infra-a-mongodb', true],     // A 真 running
        ['cds-infra-b-mongodb', false],    // B 死了(无关)
      ]),
    );
    expect(required.has('mongodb')).toBe(false);
  });
});
