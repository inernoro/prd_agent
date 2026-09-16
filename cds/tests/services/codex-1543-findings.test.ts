/*
 * Codex 对 PR #1543 的四条 finding，每条一组用例，改回去就红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { countLiveAlarmChannels } from '../../src/services/alarm-channel.js';
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
    // 五条路由（读 / 建 / 改 / 删 / 演练）全部过门：读接口回 webhook 地址与密钥尾号，读也不能放
    expect(routes.split('denySystemAccess(req, res)').length - 1).toBe(4);
    expect(routes).toMatch(/router\.get\('\/cds-system\/alarm-channels', \(req, res\) => \{\s*if \(denySystemAccess\(req, res\)\) return;/);
    expect(routes).not.toContain('projectScopeOf(req)');
  });
});

describe('P1 通道存活按投递台账判', () => {
  it('最近一次投递失败的通道不算活；untested 算活；停用的不算；旧 MAP 通道同一口径', () => {
    expect(countLiveAlarmChannels([
      { enabled: true, status: 'healthy' },
      { enabled: true, status: 'untested' },
      { enabled: true, status: 'failing' },
      { enabled: true, status: 'unconfigured' },
      { enabled: false, status: 'healthy' },
    ], null)).toBe(2);
    expect(countLiveAlarmChannels([], { status: 'healthy' })).toBe(1);
    expect(countLiveAlarmChannels([], { status: 'failing' })).toBe(0);
    expect(countLiveAlarmChannels([], { status: 'unconfigured' })).toBe(0);
    expect(countLiveAlarmChannels([{ enabled: true, status: 'failing' }], { status: 'failing' })).toBe(0);
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
