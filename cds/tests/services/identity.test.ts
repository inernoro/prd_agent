/**
 * 身份层判据测试。
 *
 * 钉住这一层存在的四个理由（每条对应一笔此前的债）：
 *   1. 授权在主体上，所以换机器 / 丢凭据不必重批；
 *   2. 判据是「在不在授权名单里」而不是「是不是我建的」，团队协作才不会一直卡；
 *   3. 撤用户级凭证必须级联撤下游，否则撤了等于没撤；
 *   4. 总览按主体聚合、退役凭证折叠、超期归档 —— 这是「保留一大片」与
 *      「删了分不清」之外的第三条路。
 *
 * 外加一条零回归：存量凭证没有 expiresAt = 永不过期，不许被新逻辑判成过期。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import {
  buildPrincipalOverview,
  cascadeRevokeTargets,
  credentialUsability,
  daysFromNow,
  decideProjectCredentialIssue,
  hasActiveGrant,
  PROJECT_CREDENTIAL_TTL_DAYS,
  REVOCATION_RETENTION_DAYS,
  slideExpiry,
  USER_CREDENTIAL_TTL_DAYS,
} from '../../src/services/identity.js';
import type { AgentKey, Principal, ProjectGrant, UserCredential } from '../../src/types.js';

const NOW = Date.parse('2026-09-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const principal: Principal = {
  id: 'pr_alpha',
  name: '我的笔记本',
  kind: 'machine',
  status: 'active',
  createdAt: '2026-08-01T00:00:00Z',
};

function userCred(overrides: Partial<UserCredential> = {}): UserCredential {
  return {
    id: 'uc_1',
    principalId: principal.id,
    hash: 'x'.repeat(64),
    createdAt: '2026-08-01T00:00:00Z',
    expiresAt: new Date(NOW + 60 * DAY).toISOString(),
    ...overrides,
  };
}

function projectKey(overrides: Partial<AgentKey> & { projectId: string }): AgentKey & { projectId: string } {
  return {
    id: 'k1',
    label: '项目钥匙',
    hash: 'y'.repeat(64),
    scope: 'rw',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  } as AgentKey & { projectId: string };
}

describe('credentialUsability —— 三种不可用要分开报', () => {
  it('有效', () => {
    expect(credentialUsability(userCred(), principal, NOW)).toEqual({ usable: true });
  });

  it('已吊销', () => {
    const r = credentialUsability(userCred({ revokedAt: '2026-08-20T00:00:00Z' }), principal, NOW);
    expect(r).toEqual({ usable: false, reason: 'revoked' });
  });

  it('已过期', () => {
    const r = credentialUsability(userCred({ expiresAt: new Date(NOW - DAY).toISOString() }), principal, NOW);
    expect(r).toEqual({ usable: false, reason: 'expired' });
  });

  it('主体被停用：凭证本身没问题也不可用', () => {
    const r = credentialUsability(userCred(), { status: 'disabled' }, NOW);
    expect(r).toEqual({ usable: false, reason: 'principal-disabled' });
  });

  it('零回归：存量凭证没有 expiresAt = 永不过期，不许被判成过期', () => {
    const legacy = projectKey({ projectId: 'p1' });
    expect(legacy.expiresAt).toBeUndefined();
    expect(credentialUsability(legacy, undefined, NOW + 3650 * DAY)).toEqual({ usable: true });
  });
});

describe('slideExpiry —— 用一次自动续', () => {
  it('把到期时间往后推满一个 TTL', () => {
    const next = slideExpiry(new Date(NOW + DAY).toISOString(), USER_CREDENTIAL_TTL_DAYS, NOW);
    expect(next).toBe(daysFromNow(USER_CREDENTIAL_TTL_DAYS, NOW));
  });

  it('一天内重复使用不重复落盘（返回 undefined 表示不必写）', () => {
    const already = daysFromNow(USER_CREDENTIAL_TTL_DAYS, NOW);
    expect(slideExpiry(already, USER_CREDENTIAL_TTL_DAYS, NOW)).toBeUndefined();
  });

  it('项目级凭证是短命的：TTL 明显短于用户级', () => {
    expect(PROJECT_CREDENTIAL_TTL_DAYS).toBeLessThan(USER_CREDENTIAL_TTL_DAYS);
  });
});

describe('项目授权 —— 判据是「在不在名单里」，不是「是不是我建的」', () => {
  const created: ProjectGrant = {
    id: 'pg_1', projectId: 'p-mine', principalId: principal.id,
    origin: 'created', grantedAt: '2026-08-01T00:00:00Z',
  };
  const approved: ProjectGrant = {
    id: 'pg_2', projectId: 'p-others', principalId: principal.id,
    origin: 'approved', grantedAt: '2026-08-02T00:00:00Z', grantedBy: '管理员',
  };

  it('created 与 approved 一视同仁 —— 别人建的项目批过一次之后不必年年批', () => {
    expect(hasActiveGrant([created, approved], principal.id, 'p-mine')).toBe(true);
    expect(hasActiveGrant([created, approved], principal.id, 'p-others')).toBe(true);
  });

  it('没授权的项目：不给签，并指路走一次页面批准', () => {
    const decision = decideProjectCredentialIssue(principal, [created], 'p-stranger');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('no-grant');
      expect(decision.message).toContain('页面批准');
      // 批准之后同一主体换机器不必再批 —— 这句是产品承诺，必须写在提示里
      expect(decision.message).toContain('换机器');
    }
  });

  it('有授权：允许自助签发（自愈链路的闸门）', () => {
    const decision = decideProjectCredentialIssue(principal, [created], 'p-mine');
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.grant.origin).toBe('created');
  });

  it('授权被撤销后立刻不能再签', () => {
    const revoked = { ...created, revokedAt: '2026-08-30T00:00:00Z' };
    expect(hasActiveGrant([revoked], principal.id, 'p-mine')).toBe(false);
    expect(decideProjectCredentialIssue(principal, [revoked], 'p-mine').allowed).toBe(false);
  });

  it('主体被停用：一律不给签', () => {
    const decision = decideProjectCredentialIssue({ id: principal.id, status: 'disabled' }, [created], 'p-mine');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('principal-disabled');
  });
});

describe('cascadeRevokeTargets —— 撤源头必须带走下游', () => {
  it('只带走这张用户级凭证签出的、且还没被撤的那些', () => {
    const keys = [
      projectKey({ projectId: 'p1', id: 'k-mine-1', issuedByCredentialId: 'uc_1' }),
      projectKey({ projectId: 'p2', id: 'k-mine-2', issuedByCredentialId: 'uc_1' }),
      projectKey({ projectId: 'p3', id: 'k-other', issuedByCredentialId: 'uc_2' }),
      projectKey({ projectId: 'p4', id: 'k-legacy' }),
      projectKey({ projectId: 'p5', id: 'k-already', issuedByCredentialId: 'uc_1', revokedAt: '2026-08-30T00:00:00Z' }),
    ];
    const targets = cascadeRevokeTargets(keys, 'uc_1');
    expect(targets.map((t) => t.keyId).sort()).toEqual(['k-mine-1', 'k-mine-2']);
    expect(targets[0].projectId).toBeTruthy();
  });

  it('存量凭证（没有签发来源）绝不会被误伤', () => {
    const keys = [projectKey({ projectId: 'p1', id: 'k-legacy' })];
    expect(cascadeRevokeTargets(keys, 'uc_1')).toEqual([]);
  });
});

describe('buildPrincipalOverview —— 按主体聚合，不按钥匙平铺', () => {
  it('活的进主列表，退役的折叠，超过保留期的归档掉不再展示', () => {
    const longAgo = new Date(NOW - (REVOCATION_RETENTION_DAYS + 10) * DAY).toISOString();
    const recently = new Date(NOW - 3 * DAY).toISOString();
    const result = buildPrincipalOverview({
      principals: [principal],
      userCredentials: [userCred({ id: 'uc_live' })],
      projectCredentials: [
        projectKey({ projectId: 'p1', id: 'k-live', principalId: principal.id }),
        projectKey({ projectId: 'p1', id: 'k-just-revoked', principalId: principal.id, revokedAt: recently }),
        projectKey({ projectId: 'p1', id: 'k-ancient', principalId: principal.id, revokedAt: longAgo }),
      ],
      grants: [{ id: 'pg_1', projectId: 'p1', principalId: principal.id, origin: 'created', grantedAt: recently }],
      projectNameById: { p1: '示例项目' },
      now: NOW,
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.activeCredentials.map((c) => c.id).sort()).toEqual(['k-live', 'uc_live']);
    expect(row.retiredCredentials.map((c) => c.id)).toEqual(['k-just-revoked']);
    expect(result.archivedCount).toBe(1);
    expect(row.grants[0].projectName).toBe('示例项目');
  });

  it('存量凭证没有主体时列进「未认领」，不假装它们不存在', () => {
    const result = buildPrincipalOverview({
      principals: [principal],
      userCredentials: [],
      projectCredentials: [projectKey({ projectId: 'p1', id: 'k-legacy' })],
      grants: [],
      now: NOW,
    });
    expect(result.unclaimed.map((c) => c.id)).toEqual(['k-legacy']);
    expect(result.rows[0].activeCredentials).toEqual([]);
  });

  it('签发留痕带进总览：这张用户级凭证签出过几张下游', () => {
    const result = buildPrincipalOverview({
      principals: [principal],
      userCredentials: [userCred({ id: 'uc_live', issuedCount: 7, lastIssuedAt: '2026-08-31T00:00:00Z' })],
      projectCredentials: [],
      grants: [],
      now: NOW,
    });
    const view = result.rows[0].activeCredentials[0];
    expect(view.issuedCount).toBe(7);
    expect(view.lastIssuedAt).toBe('2026-08-31T00:00:00Z');
  });
});

/**
 * 删项目要连带吊销它的授权 —— 发布当天拆验证现场时撞出来的。
 *
 * 用用户级凭证建了个探针项目（自动写了一条 created 授权），验完删掉项目，
 * whoami 里那条授权还在，而且因为项目没了连名字都显示不出来。授权本身不再
 * 授予任何东西（项目都没了），但它会在权限总览里堆成一排指向空气的芯片 ——
 * 而总览正是这次要让人「能看清、能撤销」的那一屏。
 */
describe('removeProject：授权跟着项目一起谢幕', () => {
  let tmpDir: string;
  let svc: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-grant-cascade-'));
    svc = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    svc.load();
    svc.addProject({ id: 'p-doomed', slug: 'doomed', name: '待删项目', kind: 'git' } as never);
    svc.addProject({ id: 'p-keep', slug: 'keep', name: '留着的项目', kind: 'git' } as never);
    svc.addPrincipal({
      id: 'pr_x', name: '某台机器', kind: 'machine', status: 'active',
      createdAt: new Date().toISOString(),
    });
    svc.addProjectGrant({
      id: 'pg_doomed', projectId: 'p-doomed', principalId: 'pr_x',
      origin: 'created', grantedAt: new Date().toISOString(),
    });
    svc.addProjectGrant({
      id: 'pg_keep', projectId: 'p-keep', principalId: 'pr_x',
      origin: 'approved', grantedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('删项目时它的授权被吊销，别的项目的授权原样不动', () => {
    const summary = svc.removeProject('p-doomed');
    expect(summary.projectGrants).toEqual(['pg_doomed']);

    const grants = svc.getProjectGrants();
    const doomed = grants.find((g) => g.id === 'pg_doomed');
    const keep = grants.find((g) => g.id === 'pg_keep');
    expect(doomed?.revokedAt).toBeTruthy();
    expect(doomed?.revokedBy).toBe('system:project-deleted');
    expect(keep?.revokedAt).toBeUndefined();
  });

  it('吊销而不是删除：总览里不再出现，审计行还留着', () => {
    svc.removeProject('p-doomed');
    // 留痕：行还在
    expect(svc.getProjectGrants().some((g) => g.id === 'pg_doomed')).toBe(true);
    // 但总览只列未吊销的，所以界面上立刻消失
    const overview = buildPrincipalOverview({
      principals: svc.getPrincipals(),
      userCredentials: svc.getUserCredentials(),
      projectCredentials: svc.getAllAgentKeysWithProject(),
      grants: svc.getProjectGrants(),
    });
    const row = overview.rows.find((r) => r.principal.id === 'pr_x');
    expect(row?.grants.map((g) => g.projectId)).toEqual(['p-keep']);
  });

  it('授权对该主体不再成立（自愈会重新要求页面批准）', () => {
    svc.removeProject('p-doomed');
    expect(hasActiveGrant(svc.getProjectGrants(), 'pr_x', 'p-doomed')).toBe(false);
    expect(hasActiveGrant(svc.getProjectGrants(), 'pr_x', 'p-keep')).toBe(true);
  });
});

/**
 * Codex 第一轮的三条 P1 —— 都不是逻辑写错，是**承诺与代码对不上**：
 * 界面逐字写着「停用后它名下所有凭证立刻不可用」，文档写着项目级凭据「用即续」，
 * 而鉴权路径只看密钥自己的 revokedAt 与一个固定到期日。这三条各自都能编译、
 * 各自都有测试、通读也挑不出，只有把「界面说什么」和「代码做什么」并排放才现形。
 */
describe('findAgentKeyForAuth：撤销当场生效、用一次就续期', () => {
  let tmpDir: string;
  let svc: StateService;
  const projectKey = 'cdsp_owned_' + 'a'.repeat(24);
  const legacyKey = 'cdsp_owned_' + 'b'.repeat(24);
  const sha = (v: string) => nodeCrypto.createHash('sha256').update(v).digest('hex');
  const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-auth-revoke-'));
    svc = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    svc.load();
    svc.addProject({ id: 'p1', slug: 'owned', name: '有主项目', kind: 'git' } as never);
    svc.addPrincipal({
      id: 'pr_a', name: '某台机器', kind: 'machine', status: 'active',
      createdAt: new Date().toISOString(),
    });
    svc.addProjectGrant({
      id: 'pg_a', projectId: 'p1', principalId: 'pr_a',
      origin: 'approved', grantedAt: new Date().toISOString(),
    });
    svc.addAgentKey('p1', {
      id: 'k_owned', label: '有主', hash: sha(projectKey), scope: 'rw',
      createdAt: new Date().toISOString(),
      principalId: 'pr_a', expiresAt: inDays(30),
    });
    // 存量密钥：没有主体、没有到期日 —— 下面每一条都要证明它不受影响
    svc.addAgentKey('p1', {
      id: 'k_legacy', label: '存量', hash: sha(legacyKey), scope: 'rw',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('停用主体后，它名下的项目级凭据立刻鉴权失败（界面就是这么写的）', () => {
    expect(svc.findAgentKeyForAuth(projectKey)).not.toBeNull();
    svc.setPrincipalStatus('pr_a', 'disabled');
    expect(svc.findAgentKeyForAuth(projectKey)).toBeNull();
    // 恢复后重新可用 —— 停用是可逆的，不是把密钥烧了
    svc.setPrincipalStatus('pr_a', 'active');
    expect(svc.findAgentKeyForAuth(projectKey)).not.toBeNull();
  });

  it('撤销项目授权后，该主体在这个项目上的凭据立刻失效', () => {
    expect(svc.findAgentKeyForAuth(projectKey)).not.toBeNull();
    svc.revokeProjectGrant('pg_a');
    expect(svc.findAgentKeyForAuth(projectKey)).toBeNull();
  });

  it('存量密钥不受主体与授权影响（零回归的那条线）', () => {
    svc.setPrincipalStatus('pr_a', 'disabled');
    svc.revokeProjectGrant('pg_a');
    expect(svc.findAgentKeyForAuth(legacyKey)).not.toBeNull();
  });

  it('用一次就把到期日往后推（否则一直在干活的 Agent 第 30 天被锁在门外）', () => {
    const before = svc.getState().projects![0].agentKeys!.find((k) => k.id === 'k_owned')!.expiresAt!;
    // 先把到期日改近，模拟已经用了一阵子
    svc.getState().projects![0].agentKeys!.find((k) => k.id === 'k_owned')!.expiresAt = inDays(3);
    svc.touchAgentKeyLastUsed('p1', 'k_owned');
    const after = svc.getState().projects![0].agentKeys!.find((k) => k.id === 'k_owned')!.expiresAt!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(inDays(29)));
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before) - 86400_000);
  });

  it('存量密钥用一次不会被凭空安上一个到期日', () => {
    svc.touchAgentKeyLastUsed('p1', 'k_legacy');
    const entry = svc.getState().projects![0].agentKeys!.find((k) => k.id === 'k_legacy')!;
    expect(entry.expiresAt).toBeUndefined();
    expect(entry.lastUsedAt).toBeTruthy();
  });
});

/**
 * 总览显示的状态必须与鉴权同一口径（Codex P2，同一形状第三次出现）。
 *
 * 停用主体 / 撤销授权之后鉴权会拒，而总览仍把那张凭据算进「有效凭证」——
 * 管理员刚点了停用，界面却告诉他对方还有 N 张有效凭证。改鉴权没改展示，
 * 与「改鉴权没改自检」是同一个洞的两个面。
 */
describe('权限总览：显示状态跟着实际能不能用走', () => {
  const now = Date.now();
  const iso = (d: number) => new Date(now + d * 86400_000).toISOString();

  const build = (opts: { principalStatus?: 'active' | 'disabled'; grantRevoked?: boolean }) =>
    buildPrincipalOverview({
      principals: [{
        id: 'pr_a', name: '某台机器', kind: 'machine',
        status: opts.principalStatus || 'active', createdAt: iso(-10),
      }],
      userCredentials: [],
      projectCredentials: [{
        id: 'ak1', label: '自助补发', hash: 'x', scope: 'rw',
        createdAt: iso(-1), expiresAt: iso(20),
        principalId: 'pr_a', projectId: 'p1', projectName: '演示项目',
      } as never],
      grants: [{
        id: 'pg1', projectId: 'p1', principalId: 'pr_a', origin: 'approved',
        grantedAt: iso(-5), ...(opts.grantRevoked ? { revokedAt: iso(-1) } : {}),
      }],
    });

  it('一切正常时算有效', () => {
    const row = build({}).rows[0];
    expect(row.activeCredentials).toHaveLength(1);
    expect(row.activeCredentials[0].status).toBe('active');
  });

  it('主体被停用后不再算有效凭证，状态写明是主体被停用', () => {
    const row = build({ principalStatus: 'disabled' }).rows[0];
    expect(row.activeCredentials).toHaveLength(0);
    expect(row.retiredCredentials[0].status).toBe('principal-disabled');
  });

  it('授权被撤后不再算有效凭证，状态写明是授权被撤', () => {
    const row = build({ grantRevoked: true }).rows[0];
    expect(row.activeCredentials).toHaveLength(0);
    expect(row.retiredCredentials[0].status).toBe('grant-revoked');
  });

  it('存量凭证没有主体，不受这两条影响（零回归）', () => {
    const out = buildPrincipalOverview({
      principals: [],
      userCredentials: [],
      projectCredentials: [{
        id: 'ak_legacy', hash: 'x', scope: 'rw', createdAt: iso(-400),
        projectId: 'p1', projectName: '演示项目',
      } as never],
      grants: [],
    });
    expect(out.unclaimed).toHaveLength(1);
    expect(out.unclaimed[0].status).toBe('active');
  });
});
