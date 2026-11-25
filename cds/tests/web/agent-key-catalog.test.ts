/**
 * Agent Key 管理页的说明函数（web/src/lib/agentKeyCatalog.ts）。
 *
 * 签发预览、签发回执、列表详情都调用 describeAgentKey；这里守住它说的话：
 * 范围、能做 / 不能做、到期、风险等级，以及来源不靠猜。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  accessShort,
  describeAgentKey,
  expiryChoiceToIso,
  sourceSentence,
  sourceSteps,
  statusText,
  type AgentKeyAccessView,
} from '../../web/src/lib/agentKeyCatalog';

const project = (permission: AgentKeyAccessView['permission'] = 'full'): AgentKeyAccessView => ({
  scope: 'project', projects: [{ id: 'p1', name: 'Alpha' }], canCreateProjects: false, permission,
});
const NOW = Date.parse('2026-11-25T00:00:00Z');

describe('describeAgentKey', () => {
  it('单项目完整读写：中风险，说清不能访问其他项目与数据库写入要审批', () => {
    const d = describeAgentKey({ access: project(), expiry: 'never' }, 5, NOW);
    expect(d.scope).toBe('只能访问 Alpha');
    expect(d.can).toContain('修改构建配置与项目环境变量');
    expect(d.cannot).toEqual(expect.arrayContaining(['不能访问其他项目', '写数据库时，每次都要等系统所有者批准']));
    expect(d.expiry).toBe('永久有效，直到被吊销');
    expect(d.risk.level).toBe('mid');
  });

  it('全部项目一律高风险，并说明包括以后新建的项目', () => {
    const d = describeAgentKey({ access: { scope: 'all', projects: [], canCreateProjects: false, permission: 'full' }, expiry: 'never' }, 7, NOW);
    expect(d.scope).toContain('当前 7 个');
    expect(d.scope).toContain('以后新建的项目也包括在内');
    expect(d.risk.level).toBe('high');
  });

  it('只读模块权限是低风险，且明说不能部署或改配置', () => {
    const d = describeAgentKey({ access: project('planning-read'), expiry: 'never' }, 5, NOW);
    expect(d.can).toEqual(['读取工程规划与债务']);
    expect(d.cannot).toContain('不能部署分支，不能修改构建配置或环境变量');
    expect(d.risk.level).toBe('low');
  });

  it('仅创建新项目：不能碰现有项目，一次性授权要说明只能用一次', () => {
    const d = describeAgentKey({ access: { scope: 'create', projects: [], canCreateProjects: true, permission: 'full', oneTime: true }, expiry: 'never' }, 3, NOW);
    expect(d.scope).toContain('不能访问任何现有项目');
    expect(d.cannot).toEqual(expect.arrayContaining(['不能读取或修改任何现有项目', '建成第一个项目后自动吊销，只能用一次']));
    expect(d.risk.level).toBe('mid');
  });

  it('存量全局 Key 没有授权范围：如实说明是旧版全权', () => {
    const d = describeAgentKey({ access: { scope: 'all', projects: [], canCreateProjects: true, permission: 'full', legacyFullAccess: true }, expiry: 'never' }, 2, NOW);
    expect(d.can[0]).toContain('旧版全权');
    expect(accessShort({ scope: 'all', projects: [], canCreateProjects: true, permission: 'full', legacyFullAccess: true })).toBe('全部项目 · 旧版全权');
  });

  it('到期说明区分固定与滑动续期', () => {
    expect(describeAgentKey({ access: project(), expiry: 'fixed', expiresAt: '2026-12-02T00:00:00Z' }, 1, NOW).expiry).toContain('还剩 7 天');
    expect(describeAgentKey({ access: project(), expiry: 'sliding', expiresAt: '2026-12-20T00:00:00Z' }, 1, NOW).expiry).toContain('每次使用自动续期');
    expect(describeAgentKey({ access: project(), expiry: 'fixed', expiresAt: '2026-11-20T00:00:00Z' }, 1, NOW).expiry).toContain('已于');
  });
});

describe('来源与状态文案', () => {
  it('Agent 申请经批准：写出 Agent 与批准人', () => {
    expect(sourceSentence({ type: 'agent', via: 'access-request', agentName: 'Codex', approvedBy: 'alice' })).toBe('Codex 申请，alice 批准');
  });
  it('来源未记录不推测签发人，只交代账号字段这一事实', () => {
    const source = { type: 'unknown' as const, recordedAccount: 'bob' };
    expect(sourceSentence(source)).toBe('签发时未记录来源，账号字段为 bob');
    expect(sourceSteps(source).join('')).toContain('无法确认是本人签发还是批准了 Agent 申请');
  });
  it('即将过期的 Key 给出剩余时间', () => {
    expect(statusText({ status: { code: 'expiring', usable: true }, expiresAt: '2026-11-27T00:00:00Z' }, NOW)).toBe('2 天后过期');
    expect(statusText({ status: { code: 'expiring', usable: true }, expiresAt: '2026-11-25T05:00:00Z' }, NOW)).toBe('5 小时后过期');
    expect(statusText({ status: { code: 'grant-revoked', usable: false } }, NOW)).toBe('项目授权已收回');
  });
});

describe('有效期选择', () => {
  it('永久不提交到期时间，天数换算成具体时间，指定日期取当天 23:59', () => {
    expect(expiryChoiceToIso('never', '', NOW)).toBeUndefined();
    expect(expiryChoiceToIso('7', '', NOW)).toBe('2026-12-02T00:00:00.000Z');
    expect(expiryChoiceToIso('date', '2026-12-31', NOW)).toBe(new Date('2026-12-31T23:59:00').toISOString());
    expect(expiryChoiceToIso('date', '', NOW)).toBeNull();
    expect(expiryChoiceToIso('date', '2026-01-01', NOW)).toBeNull();
  });
});

describe('接线：说明只有一个来源', () => {
  it('签发预览、回执与列表详情都调用 describeAgentKey，页面里没有第二份说明拼装', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../web/src/pages/cds-settings/tabs/AccessKeysTab.tsx'), 'utf8');
    // 三处：签发表单预览、签发回执、列表行详情（另一处是结果未知时的请求快照摘要）。
    expect(page.match(/describeAgentKey\(/g)?.length).toBeGreaterThanOrEqual(4);
    // 列表状态来自服务端判定，页面不再用 revokedAt 自己推「有效」。
    expect(page).not.toMatch(/revokedAt \? '已吊销' : .*'有效'/);
    expect(page).toContain('/api/global-agent-keys/catalog');
  });
});
