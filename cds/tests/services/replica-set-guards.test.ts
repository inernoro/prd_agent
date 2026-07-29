/**
 * 复制集两道护栏（Codex 第三十六轮）。
 *
 * P1 —— 成员容器移除必须**复核**：ContainerService.remove 从不因 docker rm 失败
 * 抛错（只记事件），原实现拿它当成功，紧接着删掉成员记录 → 容器还在跑、还占端口，
 * 而 CDS 里已经没有任何记录指向它（成员对账管不着、孤儿收割器没墓碑）。
 *
 * P2 —— 项目级计划必须是整组动作：只覆盖部分服务的 add-replica 计划跑完会得到
 * 残缺组，画布显示「整组 x1」，实际另一半服务流量仍全打主实例，实验结论失真。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ReplicaSetService } from '../../src/services/replica-set.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

let tmpDir: string;
let state: StateService;
/** docker ps -a 的模拟返回：容器名集合（= 移除后仍存在的容器） */
let survivingContainers: string[];
/** shell.exec 是否直接失败（模拟 docker 查询不可用） */
let shellBroken: boolean;

const mkMember = (id: string, containerName: string) => ({
  id, versionId: 'dv1', weight: 40, image: 'img', status: 'running' as const,
  containerName, dbMode: 'shared' as const, createdAt: new Date().toISOString(),
});

const mkSvc = (): ReplicaSetService => new ReplicaSetService({
  state,
  container: { remove: async () => undefined } as never,
  versions: { get: () => undefined, assertReusable: () => undefined } as never,
  shell: {
    exec: async (cmd: string) => {
      if (shellBroken) return { stdout: '', stderr: 'docker daemon 不可用', exitCode: 1 };
      if (cmd.startsWith('docker ps -a')) {
        const m = cmd.match(/name=\^\/([^$]+)\$/);
        const name = m?.[1] ?? '';
        return { stdout: survivingContainers.includes(name) ? `${name}\n` : '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  } as never,
  portStart: 10000,
});

beforeEach(() => {
  survivingContainers = [];
  shellBroken = false;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rsguard-'));
  state = new StateService(path.join(tmpDir, 'state.json'));
  state.addProject({ id: 'proj', slug: 'demo', name: 'demo', createdAt: new Date().toISOString() } as Parameters<typeof state.addProject>[0]);
  for (const id of ['api', 'web']) {
    state.addBuildProfile({
      id, projectId: 'proj', name: id, runtime: 'docker', containerPort: 8080,
    } as unknown as BuildProfile);
  }
  const branch: BranchEntry = {
    id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: '/tmp/x',
    services: { api: { status: 'running' }, web: { status: 'running' } },
    status: 'running', createdAt: new Date().toISOString(),
    replicaSets: {
      api: {
        profileId: 'api', enabled: true, primaryWeight: 100,
        members: [mkMember('rs-1', 'cds-proj-main-api--rs-1')],
        updatedAt: new Date().toISOString(),
      },
    },
  } as unknown as BranchEntry;
  state.addBranch(branch);
});

afterEach(async () => {
  await flushAllJsonStateStores();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('成员容器移除必须复核（P1）', () => {
  it('容器真的没了才删记录', async () => {
    await mkSvc().removeMember('proj-main', 'api', 'rs-1');
    expect(state.getBranch('proj-main')!.replicaSets!.api.members).toHaveLength(0);
    expect(state.getContainerTeardownTombstones()).toHaveLength(0);
  });

  it('docker rm 没生效（容器仍在）→ 保留成员记录 + 写墓碑交孤儿收割器兜底', async () => {
    survivingContainers = ['cds-proj-main-api--rs-1'];
    await expect(mkSvc().removeMember('proj-main', 'api', 'rs-1')).rejects.toThrow('仍存在');
    // 记录保留：下次重试仍看得见这个副本，不会变成没人认领的容器
    const members = state.getBranch('proj-main')!.replicaSets!.api.members;
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe('error');
    // 墓碑是第二道保险：即便调用方吞掉异常（分支删除路径就是这么做的），收割器仍会兜底
    const tombs = state.getContainerTeardownTombstones();
    expect(tombs.map((t) => t.containerName)).toEqual(['cds-proj-main-api--rs-1']);
    expect(tombs[0].projectId).toBe('proj');
  });

  it('docker 查询本身失败时按「仍存在」保守处理——误判成已删会静默漏掉容器', async () => {
    shellBroken = true;
    await expect(mkSvc().removeMember('proj-main', 'api', 'rs-1')).rejects.toThrow('仍存在');
    expect(state.getContainerTeardownTombstones()).toHaveLength(1);
  });

  it('分支收割路径吞掉异常，但墓碑仍然留下（两道保险相互独立）', async () => {
    survivingContainers = ['cds-proj-main-api--rs-1'];
    await mkSvc().teardownForBranch('proj-main');
    expect(state.getBranch('proj-main')!.replicaSets).toBeUndefined();
    expect(state.getContainerTeardownTombstones()).toHaveLength(1);
  });
});

describe('项目级计划必须是整组动作（P2）', () => {
  const addStep = (profileId: string, projectGroupId?: string) =>
    ({ kind: 'add-replica' as const, profileId, ...(projectGroupId ? { params: { projectGroupId } } : {}) });

  // 模式二选一先钉住，免得存量成员把分支兜底成容器级、请求在整组校验之前就 409
  beforeEach(() => { state.getBranch('proj-main')!.replicaMode = 'project'; });

  it('只覆盖部分服务的整组副本被拒（残缺组会让实验结论失真）', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [addStep('api', 'pg-1')],
    })).toThrow('必须覆盖全部服务');
    // 被拒的请求不得留下任何副作用（与第三十四轮 P2 同一纪律）
    expect(state.getBranch('proj-main')!.replicaPlans ?? []).toHaveLength(0);
  });

  it('项目级 add-replica 必须带 projectGroupId', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [addStep('api'), addStep('web')],
    })).toThrow('projectGroupId');
  });

  it('覆盖全部服务的整组副本放行', () => {
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [addStep('api', 'pg-1'), addStep('web', 'pg-1')],
    });
    expect(plan.steps).toHaveLength(2);
    expect(state.getBranch('proj-main')!.replicaMode).toBe('project');
  });

  it('容器级模式不受整组约束（单服务加副本本来就是它的语义）', () => {
    state.getBranch('proj-main')!.replicaMode = 'container';
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'container', steps: [addStep('api')],
    });
    expect(plan.steps).toHaveLength(1);
  });

  it('项目级的非 add-replica 计划不受此约束（权重/回切按现有语义走）', () => {
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop',
      mode: 'project',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'rs-1', weight: 50 } }],
    });
    expect(plan.steps).toHaveLength(1);
  });
});

describe('项目级改权重/下线必须整组（P2 的另一半）', () => {
  beforeEach(() => {
    const b = state.getBranch('proj-main')!;
    b.replicaMode = 'project';
    // 一个跨两服务的项目级组
    b.replicaSets!.api.members = [{ ...mkMember('rs-a', 'c-a'), projectGroupId: 'pg-1' }];
    b.replicaSets!.web = {
      profileId: 'web', enabled: true, primaryWeight: 100,
      members: [{ ...mkMember('rs-w', 'c-w'), projectGroupId: 'pg-1' }],
      updatedAt: new Date().toISOString(),
    } as never;
  });

  const w = (memberId: string, profileId: string, weight: number) =>
    ({ kind: 'set-weight' as const, profileId, params: { memberId, weight } });

  it('只改组里一半的权重被拒（组内分流不一致 = 整组语义名存实亡）', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [w('rs-a', 'api', 50)],
    })).toThrow('必须整组进行');
  });

  it('整组覆盖但给了两个不同权重也被拒', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [w('rs-a', 'api', 50), w('rs-w', 'web', 30)],
    })).toThrow('同一个值');
  });

  it('整组同值放行', () => {
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project', steps: [w('rs-a', 'api', 50), w('rs-w', 'web', 50)],
    });
    expect(plan.steps).toHaveLength(2);
  });

  it('只下线组里一个成员被拒', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project',
      steps: [{ kind: 'remove-member', profileId: 'api', params: { memberId: 'rs-a' } }],
    })).toThrow('必须整组进行');
  });

  it('无 projectGroupId 的存量成员不受整组约束（按位配对兜底本就是容器级语义）', () => {
    const b = state.getBranch('proj-main')!;
    b.replicaSets!.api.members = [mkMember('rs-legacy', 'c-l')];
    delete (b.replicaSets!.web as { members: unknown[] }).members[0];
    b.replicaSets!.web.members = [];
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop', mode: 'project',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'rs-legacy', weight: 40 } }],
    });
    expect(plan.steps).toHaveLength(1);
  });
});

describe('成员身份必须是 profile + memberId 复合键（第三十八轮 P2）', () => {
  // 成员 id 在每个 profile 内独立分配，一个项目级组里几个服务各有一个 res-1 是
  // 常态（route-resolver 的粘性条目为此专门支持 profileId:memberId 作用域）。
  // 只按 memberId 建索引会把它们坍缩，单服务计划就能骗过整组校验。
  beforeEach(() => {
    const b = state.getBranch('proj-main')!;
    b.replicaMode = 'project';
    b.replicaSets!.api.members = [{ ...mkMember('res-1', 'c-api'), projectGroupId: 'pg-1' }];
    b.replicaSets!.web = {
      profileId: 'web', enabled: true, primaryWeight: 100,
      members: [{ ...mkMember('res-1', 'c-web'), projectGroupId: 'pg-1' }],
      updatedAt: new Date().toISOString(),
    } as never;
  });

  it('同名 res-1 分属两个服务时，只改其一仍被拒（不会互相顶替覆盖）', () => {
    expect(() => mkSvc().startPlan('proj-main', {
      onFailure: 'stop',
      mode: 'project',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 50 } }],
    })).toThrow('必须整组进行');
  });

  it('两个服务的同名 res-1 都覆盖到才放行', () => {
    const plan = mkSvc().startPlan('proj-main', {
      onFailure: 'stop',
      mode: 'project',
      steps: [
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 50 } },
        { kind: 'set-weight', profileId: 'web', params: { memberId: 'res-1', weight: 50 } },
      ],
    });
    expect(plan.steps).toHaveLength(2);
  });
});

describe('直接改单成员的项目级守卫（第三十八轮 P2）', () => {
  beforeEach(() => {
    const b = state.getBranch('proj-main')!;
    b.replicaMode = 'project';
    b.replicaSets!.api.members = [{ ...mkMember('rs-a', 'c-a'), projectGroupId: 'pg-1' }];
  });

  it('项目级组成员不许绕开计划单独改权重 / 单独下线', () => {
    const svc = mkSvc();
    expect(() => svc.assertDirectMemberMutationAllowed('proj-main', 'api', 'rs-a', 'weight')).toThrow('整组');
    expect(() => svc.assertDirectMemberMutationAllowed('proj-main', 'api', 'rs-a', 'remove')).toThrow('整组');
  });

  it('容器级分支照旧放行（直接改单成员本来就是它的语义）', () => {
    state.getBranch('proj-main')!.replicaMode = 'container';
    expect(() => mkSvc().assertDirectMemberMutationAllowed('proj-main', 'api', 'rs-a', 'weight')).not.toThrow();
  });

  it('项目级分支里无组身份的存量成员也放行', () => {
    const b = state.getBranch('proj-main')!;
    b.replicaSets!.api.members = [mkMember('rs-legacy', 'c-l')];
    expect(() => mkSvc().assertDirectMemberMutationAllowed('proj-main', 'api', 'rs-legacy', 'remove')).not.toThrow();
  });
});
