/**
 * 项目设置 →「数据库隔离」页签。
 *
 * 三层：
 *   1. **渲染冒烟**：拿一份后端形状的视图渲染一次，断言第一屏是那句判断、逐服务能看到
 *      来源与会改写的 key、保存前的影响面提示说清了「继承的分支变、覆盖的分支不变」。
 *   2. **接线守卫**：页签在类型、导航、面板、搜索索引四处同时登记（少一处只会静默不在）。
 *   3. **分支抽屉守卫**：分支侧仍保留高级覆盖，但必须标出「项目默认 / 本分支覆盖」、
 *      给「恢复继承」入口、并把用户指回项目设置的新页签。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DbIsolationPanel,
  changedServices,
  dbIsolationHeadline,
  type DbIsolationView,
} from '../../web/src/pages/project-settings/DbIsolationTab.js';
import { PROJECT_SETTINGS_INDEX, PROJECT_TAB_LABELS } from '../../web/src/lib/settingsSearchIndex.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function view(overrides: Partial<DbIsolationView> = {}): DbIsolationView {
  return {
    projectId: 'demo',
    readOnly: false,
    services: [
      { profileId: 'api', name: 'API', dockerImage: 'node:20', dbScope: 'shared', dbScopeSource: 'default', dbEnvKeys: ['CDS_POSTGRES_DB'], branchOverrideCount: 1 },
      { profileId: 'web', name: 'Web', dockerImage: 'nginx:alpine', dbScope: 'shared', dbScopeSource: 'default', dbEnvKeys: [], branchOverrideCount: 0 },
      { profileId: 'worker', name: 'Worker', dockerImage: 'node:20', dbScope: 'per-branch', dbScopeSource: 'explicit', dbEnvKeys: ['CDS_MYSQL_DATABASE'], branchOverrideCount: 0 },
    ],
    branchOverrides: [
      { branchId: 'demo-feat-x', branch: 'feat/x', overrides: { api: 'shared' } },
    ],
    summary: { services: 3, shared: 2, perBranch: 1, branches: 4, branchesWithOverride: 1 },
    ...overrides,
  };
}

function render(v: DbIsolationView, draft?: Record<string, 'shared' | 'per-branch'>): string {
  const d = draft ?? Object.fromEntries(v.services.map((s) => [s.profileId, s.dbScope]));
  return renderToStaticMarkup(createElement(DbIsolationPanel, {
    view: v,
    draft: d as Record<string, 'shared' | 'per-branch'>,
    saving: false,
    error: '',
    onDraftChange: () => {},
    onSave: () => {},
  }));
}

describe('数据库隔离面板：渲染出来的东西', () => {
  it('第一屏是一句判断，数字挂在句子里', () => {
    const html = render(view());
    expect(html).toContain('2 个服务共享库、1 个分支独立库');
    expect(html).toContain('4 条分支，其中 1 条有本分支覆盖，不受项目默认影响');
  });

  it('全共享 / 全独立 / 无服务各有各的结论，不是一句「整体正常」', () => {
    expect(dbIsolationHeadline({ summary: { services: 2, shared: 2, perBranch: 0, branches: 1, branchesWithOverride: 0 } }).headline)
      .toContain('全部共享库');
    expect(dbIsolationHeadline({ summary: { services: 2, shared: 0, perBranch: 2, branches: 1, branchesWithOverride: 0 } }).headline)
      .toContain('全部分支独立库');
    expect(dbIsolationHeadline({ summary: { services: 0, shared: 0, perBranch: 0, branches: 0, branchesWithOverride: 0 } }).headline)
      .toContain('还没有服务配置');
  });

  it('逐服务：看得到来源、会改写的 key、没声明库名变量的警告、分支覆盖数', () => {
    const html = render(view());
    expect(html).toContain('默认值');
    expect(html).toContain('CDS_POSTGRES_DB');
    expect(html).toContain('CDS_MYSQL_DATABASE');
    expect(html).toContain('没声明库名变量，切分支独立库不会改写任何东西');
    expect(html).toContain('1 条分支覆盖');
    // 两档都是可点的 radio，批量按钮也在
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('全部设为共享库');
    expect(html).toContain('全部设为分支独立库');
  });

  it('保存前把影响面说清：继承的分支变、覆盖的分支不变、重新部署后生效', () => {
    const html = render(view(), { api: 'per-branch', web: 'shared', worker: 'per-branch' });
    expect(html).toContain('所有继承项目配置的分支');
    expect(html).toContain('本项目 4 条分支');
    expect(html).toContain('重新部署后生效');
    expect(html).toContain('已有本分支覆盖的服务档位（1 条分支）保持不变');
    expect(html).toContain('保存 1 项改动');
    expect(html).toContain('未保存：共享库 变为 分支独立库');
  });

  it('没有改动时按钮说「没有改动」，草稿只算真变化', () => {
    const html = render(view());
    expect(html).toContain('没有改动');
    expect(changedServices(view(), { api: 'shared', web: 'shared', worker: 'per-branch' })).toEqual({});
    expect(changedServices(view(), { api: 'per-branch', web: 'shared', worker: 'shared' })).toEqual({ api: 'per-branch', worker: 'shared' });
  });

  it('本分支覆盖单独成节，列出分支与它钉住的档位', () => {
    const html = render(view());
    expect(html).toContain('本分支覆盖');
    expect(html).toContain('feat/x');
    expect(html).toContain('api：共享库');
    expect(html).toContain('/branch-panel/demo-feat-x');
  });

  it('托管交付项目只读：说明原因，不给保存按钮', () => {
    const html = render(view({ readOnly: true, readOnlyReason: '托管交付项目的服务配置由 CDS 自动生成' }));
    expect(html).toContain('托管交付项目的服务配置由 CDS 自动生成');
    expect(html).not.toContain('写入项目默认');
  });

  it('颜色一律走 token，不许出现写死的色值', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/project-settings/DbIsolationTab.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });
});

describe('数据库隔离 tab 的四处登记', () => {
  const page = fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/ProjectSettingsPage.tsx'), 'utf8');

  it('类型、左侧导航（数据组）、面板三处都登记了', () => {
    expect(page).toMatch(/\|\s*'db-isolation'/);
    expect(page).toContain("{ value: 'db-isolation', label: '数据库隔离'");
    expect(page).toContain('<TabsContent value="db-isolation">');
    expect(page).toContain('<DbIsolationTab projectId={project.id} onToast={setToast} />');
    // 它是数据类设置，必须落在「数据」组里，而不是塞回大杂烩
    const dataGroup = /label:\s*'数据',\s*items:\s*\[([\s\S]*?)\]/.exec(page);
    expect(dataGroup, '项目设置里找不到「数据」组').toBeTruthy();
    expect(dataGroup![1]).toContain("'db-isolation'");
  });

  it('设置搜索找得到：搜「数据库隔离」「分支独立库」「dbScope」都命中并指向 db-isolation', () => {
    for (const q of ['数据库隔离', '分支独立库', 'dbscope', 'per-branch']) {
      const hit = PROJECT_SETTINGS_INDEX.filter(
        (e) => e.tab === 'db-isolation'
          && (e.label.includes(q) || e.keywords.some((k) => k.toLowerCase().includes(q.toLowerCase()))),
      );
      expect(hit.length, `搜「${q}」应能命中数据库隔离`).toBeGreaterThan(0);
    }
    expect(PROJECT_TAB_LABELS['db-isolation']).toBe('数据库隔离');
  });
});

describe('分支抽屉：高级覆盖保留，但来源必须可辨、可恢复、指回项目设置', () => {
  const drawer = fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/BranchDetailDrawer.tsx'), 'utf8');

  it('标出「项目默认」与「本分支覆盖」两种来源，并给机器可读属性', () => {
    expect(drawer).toContain('数据库：本分支覆盖 ·');
    expect(drawer).toContain('数据库：项目默认 ·');
    expect(drawer).toContain("data-db-scope-source={dbScopeOverride !== undefined ? 'branch-override' : 'project-default'}");
  });

  it('有覆盖时给「恢复继承」入口，走的是清空 override（scope 为空串）', () => {
    // 「恢复继承」四个字在 toast 文案里也出现过，锚到按钮自己的 title 上。
    const idx = drawer.indexOf('title="删掉本分支的数据库隔离覆盖');
    expect(idx).toBeGreaterThan(0);
    const around = drawer.slice(Math.max(0, idx - 400), idx + 200);
    expect(around).toContain("onSetProfileDbScope(profile, '')");
    expect(around).toContain('恢复继承');
  });

  it('把用户指回项目设置 → 数据库隔离 的深链', () => {
    expect(drawer).toContain('#db-isolation');
    expect(drawer).toContain('项目设置 → 数据库隔离');
  });
});
