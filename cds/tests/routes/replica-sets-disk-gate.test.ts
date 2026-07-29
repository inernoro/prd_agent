import { describe, it, expect, beforeEach } from 'vitest';
import { isDiskGrowingReplicaAction, requestGrowsDisk } from '../../src/routes/replica-sets.js';
import { diskGuard } from '../../src/services/disk-guard.js';

/**
 * 磁盘冻结档下，复制集里**会让磁盘增长**的动作必须被拦（Codex 第三十一轮 P1）。
 *
 * 复制集是独立挂载的路由器，branches.ts 的那道守卫罩不到；而这边恰恰最能吃盘：
 * db-guard / isolate 是 mongodump + restore（一次几个 GB），加成员要拉镜像起容器，
 * promote 会派发一次真实部署。磁盘满的恢复期里，一个带认证的请求就能把最后的
 * 空间吃光——尽管部署那侧已经在返回 507。
 *
 * 同样重要的是**别拦错**：回切主库 / 删成员 / 解散 / 调权重 / 探测 / 审计要么在
 * 释放空间，要么是恢复期必须还能用的自救手段，磁盘满时把它们堵死等于断了退路。
 */
describe('复制集磁盘刹车：拦哪些、放哪些', () => {
  it('拦下整库克隆类动作（一次 dump+restore 是几个 GB）', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/db-guard')).toBe(true);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/isolate')).toBe(true);
  });

  it('拦下会拉镜像 / 派发部署的动作', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/members')).toBe(true);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/members/res-1/promote')).toBe(true);
  });

  it('拦下计划保存（计划里可能含隔离与加副本步骤）', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-plans')).toBe(true);
  });

  it('放行自救与释放类动作——磁盘满时堵死它们等于断退路', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/revert-db')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-plans/plan1/cancel')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-plans/plan1/steps/s1/skip')).toBe(false);
  });

  it('放行只读 / 诊断类动作', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/probe')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/isolation-audit')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets')).toBe(false);
  });

  it('复制集配置写入本身不吃盘，不拦', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api')).toBe(false);
  });

  it('容忍尾斜杠——Express 非严格路由会把带尾斜杠的请求派发到同一个 handler', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/db-guard/')).toBe(true);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-sets/api/isolate/')).toBe(true);
  });

  it('不误伤其他路由器的同名路径段', () => {
    expect(isDiskGrowingReplicaAction('/projects/p1/db-guard')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/deploy')).toBe(false);
  });
});

describe('复制集磁盘刹车：档位联动', () => {
  beforeEach(() => diskGuard.reset());

  it('冻结档给出带使用率的可读拒绝理由', () => {
    diskGuard.update(97);
    const reason = diskGuard.blockReasonForDeploy();
    expect(reason).toContain('97%');
    expect(reason).toContain('停止/删除类操作不受影响');
  });

  it('未到冻结档不拦（85% 属主动回收档，回收更狠但不停业务）', () => {
    diskGuard.update(85);
    expect(diskGuard.blockReasonForDeploy()).toBeNull();
  });
});

describe('计划端点按步骤种类判定（Codex 第三十二轮 P1）', () => {
  it('纯清理计划在冻结档必须放行——面板的删成员/解散/回切都走这个端点', () => {
    // 按路径一刀切等于在磁盘压力最大、最需要回收的时候，把 UI 上唯一的清理入口
    // 也堵死了：拦错比漏拦更伤。
    expect(requestGrowsDisk('/branches/b1/replica-plans', {
      steps: [{ kind: 'remove-member' }, { kind: 'dissolve' }, { kind: 'revert-db' }],
    })).toBe(false);
  });

  it('含加副本或隔离步骤的计划照拦', () => {
    expect(requestGrowsDisk('/branches/b1/replica-plans', {
      steps: [{ kind: 'remove-member' }, { kind: 'add-replica' }],
    })).toBe(true);
    expect(requestGrowsDisk('/branches/b1/replica-plans', { steps: [{ kind: 'isolate-db' }] })).toBe(true);
  });

  it('步骤读不出来时保守当作会增长（畸形 body 不该成为绕过手段）', () => {
    expect(requestGrowsDisk('/branches/b1/replica-plans', {})).toBe(true);
    expect(requestGrowsDisk('/branches/b1/replica-plans', null)).toBe(true);
    expect(requestGrowsDisk('/branches/b1/replica-plans', { steps: 'not-an-array' })).toBe(true);
  });

  it('非计划端点不看 body，按路径判定不变', () => {
    expect(requestGrowsDisk('/branches/b1/db-guard', { steps: [{ kind: 'remove-member' }] })).toBe(true);
    expect(requestGrowsDisk('/branches/b1/replica-sets/api/revert-db', {})).toBe(false);
  });
});
