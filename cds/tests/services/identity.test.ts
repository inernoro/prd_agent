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

import { describe, it, expect } from 'vitest';
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
