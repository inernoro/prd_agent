/*
 * Codex 对 PR #1543 的四条 finding，每条一组用例，改回去就红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AlarmLedger, countLiveAlarmChannels } from '../../src/services/alarm-channel.js';
import { assertUnscopedAdmin } from '../../src/services/unscoped-admin-guard.js';
import { assertUnscopedAdmin as fromProjects } from '../../src/routes/projects.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const codeOf = (src: string): string => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

describe('P1 通知通道接口只许非作用域管理员（读也拦）', () => {
  it('项目级 key、create-only 全局 key、带作用域全局 key 都拒；管理员会话与全权全局 key 放行', () => {
    expect(assertUnscopedAdmin({ cdsProjectKey: { projectId: 'p' } })?.status).toBe(403);
    expect(assertUnscopedAdmin({ cdsAccess: { keyId: 'k', access: { projects: [] } as never } })?.body.error).toBe('scoped_key_forbidden');
    expect(assertUnscopedAdmin({ cdsAccess: { keyId: 'k', access: { projects: ['a'] } as never } })?.status).toBe(403);
    expect(assertUnscopedAdmin({})).toBeNull();
    expect(assertUnscopedAdmin({ cdsAccess: { keyId: 'k', access: { projects: 'all' } as never } })).toBeNull();
  });

  it('projects.ts 与通知通道路由用的是同一份判定，不是各抄一份', () => {
    expect(fromProjects).toBe(assertUnscopedAdmin);
    const routes = codeOf(read('../../src/routes/alarm-channels.ts'));
    expect(routes).toContain("from '../services/unscoped-admin-guard.js'");
    // 通道读写、演练和通知历史全部过门；建和改共用 write。
    expect(routes.split('denySystemAccess(req, res)').length - 1).toBe(5);
    expect(routes).toMatch(/router\.get\('\/cds-system\/alarm-deliveries', async \(req, res\) => \{\s*if \(denySystemAccess\(req, res\)\) return;/);
    expect(routes).toMatch(/router\.get\('\/cds-system\/alarm-channels', \(req, res\) => \{\s*if \(denySystemAccess\(req, res\)\) return;/);
    expect(routes).not.toContain('projectScopeOf(req)');
  });
});

describe('P1 通道存活按投递台账判：只有成功投递过的才算', () => {
  it('healthy 算活；untested / failing / unconfigured / 停用的都不算；旧 MAP 通道同一口径', () => {
    expect(countLiveAlarmChannels([
      { enabled: true, status: 'healthy' },
      { enabled: true, status: 'untested' },
      { enabled: true, status: 'failing' },
      { enabled: true, status: 'unconfigured' },
      { enabled: false, status: 'healthy' },
    ], null)).toBe(1);
    expect(countLiveAlarmChannels([], { status: 'healthy' })).toBe(1);
    expect(countLiveAlarmChannels([], { status: 'untested' })).toBe(0);
    expect(countLiveAlarmChannels([], { status: 'failing' })).toBe(0);
    expect(countLiveAlarmChannels([{ enabled: true, status: 'failing' }], { status: 'failing' })).toBe(0);
  });

  it('最近一次投递结果随配置持久化：新进程的空台账读到旧记录，已验证过的通道不退回「未知」', () => {
    const persisted: Record<string, unknown> = {};
    const ledger = new AlarmLedger({ persist: (id, last) => { persisted[id] = last; } });
    const channel = { id: 'c1', name: '手机', kind: 'bark', enabled: true, events: [], projects: [] };
    expect(ledger.view(channel, true).status).toBe('untested');
    ledger.record('c1', { ok: true, status: 200 }, 'drill', 1000);
    expect(persisted.c1).toMatchObject({ ok: true, kind: 'drill', at: 1000 });
    // 模拟重启：新台账、配置里带着持久化的那条
    const fresh = new AlarmLedger();
    const view = fresh.view({ ...channel, lastDelivery: persisted.c1 as never }, true);
    expect(view.status).toBe('healthy');
    expect(view.last).toMatchObject({ ok: true, at: 1000 });
    // 持久化的失败同样保留
    const failed = new AlarmLedger();
    expect(failed.view({ ...channel, lastDelivery: { at: 2, ok: false, kind: 'alert', reason: 'HTTP 500' } }, true).status).toBe('failing');
  });

  it('index.ts 的台账带持久化回写；编辑通道时保留 lastDelivery', () => {
    const index = codeOf(read('../../src/index.ts'));
    expect(index).toMatch(/new AlarmLedger\(\{[\s\S]{0,400}upsertAlarmChannel\(\{ \.\.\.channel, lastDelivery: last \}\)/);
    const routes = codeOf(read('../../src/routes/alarm-channels.ts'));
    expect(routes).toContain('next.lastDelivery = previous.lastDelivery');
  });
});

describe('P1 旧 MAP 通道凭据接口与演练同一道非作用域管理员门', () => {
  it('alarm-notify 读 / 写与演练都过 denySystemAlarmAccess，且不再只看项目 Key', () => {
    const uptime = codeOf(read('../../src/routes/uptime.ts'));
    expect(uptime).toContain("from '../services/unscoped-admin-guard.js'");
    expect(uptime.split('denySystemAlarmAccess(req, res)').length - 1).toBe(3);
    expect(uptime).toMatch(/router\.get\('\/cds-system\/alarm-notify', \(req, res\) => \{\s*if \(denySystemAlarmAccess\(req, res\)\) return;/);
    expect(uptime).toMatch(/router\.put\('\/cds-system\/alarm-notify', \(req, res\) => \{\s*if \(denySystemAlarmAccess\(req, res\)\) return;/);
    expect(uptime).not.toContain("res.status(403).json({ error: '通知通道属于 CDS 系统设置，项目级 Key 不可读写' })");
  });
});

describe('P1 自检本身失败不许抹掉已登记的监控', () => {
  it('路由的兜底分支回 503（发现器按打不通处理、保持监控不动），不再回 200 + 空 checks', () => {
    const index = codeOf(read('../../src/index.ts'));
    const route = index.slice(index.indexOf('app.get(SELF_CHECK_PATH,'));
    const catchBlock = route.slice(route.indexOf('} catch (err) {'), route.indexOf('} catch (err) {') + 600);
    expect(catchBlock).toContain('status(503)');
    expect(catchBlock).not.toMatch(/status\(200\)[\s\S]{0,200}checks: \{\}/);
  });
});

describe('P2 通知通道编辑器带启用开关', () => {
  const panel = codeOf(read('../../web/src/pages/cds-settings/AlarmChannelsPanel.tsx'));
  it('草稿有 enabled、请求体带 enabled、界面有开关', () => {
    expect(panel).toMatch(/enabled: c\.enabled/);
    expect(panel).toMatch(/const base = \{[^}]*enabled: d\.enabled/);
    expect(panel).toMatch(/type="checkbox" checked=\{draft\.enabled\}/);
  });
});
