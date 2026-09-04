/**
 * 「配置说的 / 实测到的」三列（收敛 0）。
 *
 *   1. 渲染：第一屏是一句带数字的判断；mismatch 行原因标红且写明「容器未按当前配置重新部署」；
 *      probe-failed 行「连上的库」列显示失败原因，不显示配置值；探测超过 10 分钟标过期并灰掉。
 *   2. 接线守卫：三个入口（配置检查器 / 分支设置 / 项目设置数据库隔离页签）都挂了这块。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DbProbeTable,
  dbProbeAge,
  dbProbeHeadline,
  type DbProbeReport,
  type DbProbeServiceResult,
} from '../../web/src/components/branch/DbProbePanel.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date('2026-09-03T08:00:00.000Z');
const T = NOW.toISOString();

function svc(o: Partial<DbProbeServiceResult> & { profileId: string }): DbProbeServiceResult {
  return {
    profileName: o.profileId,
    configured: { dbScope: 'per-branch', dbScopeSource: 'baseline', engine: 'mysql', dbName: 'app_feat_x', envKeys: ['CDS_MYSQL_DATABASE'], infraId: 'mysql' },
    container: { containerName: `cds-${o.profileId}`, status: 'running', running: true, dbName: 'app_feat_x', inspectedAt: T },
    live: { attempted: true, ok: true, currentDb: 'app_feat_x', serverVersion: '8.0.36', objectCount: 12, credentialSource: 'app-url', probedAt: T },
    verdict: 'match', reasons: [],
    ...o,
  };
}

function report(services: DbProbeServiceResult[], probedAt = T): DbProbeReport {
  const c = (v: string) => services.filter((s) => s.verdict === v).length;
  return {
    branchId: 'b', projectId: 'p', branch: 'feat/x', probedAt, services,
    summary: { services: services.length, match: c('match'), mismatch: c('mismatch'), notRunning: c('not-running'), probeFailed: c('probe-failed'), noDb: c('no-db') },
  };
}

const render = (r: DbProbeReport, now = NOW): string => renderToStaticMarkup(createElement(DbProbeTable, { report: r, now }));

describe('三列表：渲染出来的东西', () => {
  it('一致时第一屏是一句带数字的判断，三列都是实测值，带版本与表数', () => {
    const html = render(report([svc({ profileId: 'api' })]));
    expect(html).toContain('1 个服务实测到的库与配置说的一致');
    expect(html).toContain('配置说的');
    expect(html).toContain('容器持有');
    expect(html).toContain('连上的库');
    expect(html).toContain('v8.0.36');
    expect(html).toContain('12 个表/集合');
    expect(html).toContain('应用连接串凭据');
    expect(html).toContain('data-db-probe-verdict="match"');
    expect(html).toContain('刚刚实测');
  });

  it('mismatch：原因标红，写明容器未按当前配置重新部署，配置值与容器值并排可见', () => {
    const html = render(report([svc({
      profileId: 'api',
      configured: { dbScope: 'shared', dbScopeSource: 'default', engine: 'mysql', dbName: 'app', envKeys: ['CDS_MYSQL_DATABASE'], infraId: 'mysql' },
      verdict: 'mismatch',
      reasons: ['容器实际持有 app_feat_x，配置说的是 app（共享库）：容器未按当前配置重新部署，重新部署后才会一致'],
    })]));
    expect(html).toContain('1 个服务实测到的库与配置说的不一致');
    expect(html).toContain('data-db-probe-verdict="mismatch"');
    expect(html).toContain('容器未按当前配置重新部署');
    expect(html).toMatch(/text-destructive[^>]*>\s*<li/);
    expect(html).toContain('>app<');
    expect(html).toContain('>app_feat_x<');
  });

  it('probe-failed：连上的库那列显示失败原因，不拿配置值冒充', () => {
    const html = render(report([svc({
      profileId: 'api',
      live: { attempted: true, ok: false, currentDb: null, serverVersion: null, objectCount: null, credentialSource: 'app-url', error: 'Access denied for user app', probedAt: T },
      verdict: 'probe-failed',
      reasons: ['实测失败：Access denied for user app。容器 env 写的是 app_feat_x，但没能连上确认'],
    })]));
    expect(html).toContain('未连上：Access denied for user app');
    expect(html).toContain('没能连上确认');
    expect(html).toContain('data-db-probe-verdict="probe-failed"');
  });

  it('not-running：容器列显示状态，连上的库列显示未实测', () => {
    const html = render(report([svc({
      profileId: 'api',
      container: { containerName: 'cds-api', status: 'exited', running: false, dbName: null, inspectedAt: T },
      live: { attempted: false, ok: false, currentDb: null, serverVersion: null, objectCount: null, credentialSource: null, probedAt: T },
      verdict: 'not-running', reasons: ['容器 cds-api 未运行（状态 exited），无法实测'],
    })]));
    expect(html).toContain('容器 exited');
    expect(html).toContain('未实测');
    expect(html).toContain('容器没在跑');
  });

  it('实测超过 10 分钟：标「可能已过期」并把实测列灰掉', () => {
    const old = new Date(NOW.getTime() - 11 * 60 * 1000).toISOString();
    const html = render(report([svc({ profileId: 'api' })], old));
    expect(html).toContain('11 分钟前实测，可能已过期');
    expect(html).toContain('data-db-probe-stale="true"');
    expect(html).toContain('opacity-60');
    expect(dbProbeAge(old, NOW)).toEqual({ label: '11 分钟前实测，可能已过期', stale: true });
    expect(dbProbeAge(T, NOW)).toEqual({ label: '刚刚实测', stale: false });
  });

  it('头条：没服务 / 全无库 / 有失败 各说各的，不是一句「整体正常」', () => {
    expect(dbProbeHeadline(report([]))).toContain('没有可实测的数据库');
    expect(dbProbeHeadline(report([svc({ profileId: 'web', verdict: 'no-db' })]))).toContain('有疑似数据库变量但无法识别');
    const na = report([svc({ profileId: 'a' }), svc({ profileId: 'web', verdict: 'not-applicable' })]);
    na.summary.notApplicable = 1;
    expect(dbProbeHeadline(na)).toBe('1 个服务实测到的库与配置说的一致；1 个服务不涉及数据库。');
    const html = renderToStaticMarkup(createElement(DbProbeTable, { report: na, now: NOW }));
    expect(html).toContain('data-db-probe-verdict="not-applicable"');
    expect(html).toContain('不涉及数据库');
    expect(dbProbeHeadline(report([svc({ profileId: 'a' }), svc({ profileId: 'b', verdict: 'probe-failed' })]))).toContain('1 个服务没能连上确认，1 个一致');
  });

  it('颜色一律走 token', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/branch/DbProbePanel.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });
});

describe('三个入口都挂了实测列（删掉任一处不会红，所以要守）', () => {
  const read = (f: string): string => fs.readFileSync(path.join(CDS_ROOT, f), 'utf8');

  it('配置检查器（EffectiveConfigPanel）挂了 DbProbePanel', () => {
    const s = read('web/src/components/branch/EffectiveConfigPanel.tsx');
    expect(s).toContain("from '@/components/branch/DbProbePanel'");
    expect(s).toContain('<DbProbePanel branchId={branchId}');
  });

  it('分支抽屉「分支设置」在数据库档位下拉旁挂了 DbProbePanel', () => {
    const s = read('web/src/components/BranchDetailDrawer.tsx');
    expect(s).toContain("from '@/components/branch/DbProbePanel'");
    const settings = s.slice(s.indexOf('function SettingsPanel('));
    expect(settings).toContain('<DbProbePanel branchId={branch.id}');
  });

  it('项目设置「数据库隔离」页签有「各分支实测」节，逐分支可实测', () => {
    const s = read('web/src/pages/project-settings/DbIsolationTab.tsx');
    expect(s).toContain("from '@/components/branch/DbProbePanel'");
    expect(s).toContain('各分支实测');
    expect(s).toContain('实测全部分支');
    expect(s).toMatch(/<DbProbePanel[\s\S]*autoLoad=\{false\}/);
  });
});
