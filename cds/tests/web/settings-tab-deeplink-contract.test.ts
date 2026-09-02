/**
 * CDS 系统设置页深链契约（2026-07-09，修「发布中心引导链接断头」）。
 *
 * 历史 bug：ReleaseCenterPage 空状态「先添加服务器」链到
 * `/cds-settings?tab=remote-hosts`，但 getInitialTab 只解析 #hash——
 * 新用户点了引导落到默认「更新与重启」tab，找不到远程主机配置。
 *
 * 契约：
 *   1. getInitialTab 支持 #hash（规范写法）+ ?tab= query fallback。
 *   2. 发布中心的引导深链使用 #hash 规范写法，不再有 ?tab= 变体。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/CdsSettingsPage.tsx'),
  'utf8',
);
const releaseSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseCenterPage.tsx'),
  'utf8',
);
const settingsIndexSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/lib/settingsSearchIndex.ts'),
  'utf8',
);

const inlineHostCreatorSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/release-center/InlineHostCreator.tsx'),
  'utf8',
);

describe('CDS 系统设置深链契约', () => {
  it('getInitialTab 兼容 ?tab= query 作为 #hash 的 fallback', () => {
    expect(settingsSource).toContain("window.location.hash.replace(/^#/, '')");
    expect(settingsSource).toContain("new URLSearchParams(window.location.search).get('tab')");
    // query 值同样要过 tabs 白名单校验，不许把任意字符串当 tab
    expect(settingsSource).toContain('tabs.some((tab) => tab.value === queryTab)');
  });

  it('发布中心引导深链使用 #hash 规范写法', () => {
    // 链接搬了家，契约没变：2026-07-29 起「去 CDS 系统设置管服务器」不再是
    // 发布中心空状态把人支走的主路径（用户原话：不允许操作用户跳来跳去），
    // 而是就地新建服务器面板里的一个次要入口。断言跟着链接走，仍然只认 #hash 写法。
    expect(inlineHostCreatorSource).toContain('/cds-settings#remote-hosts');
    expect(inlineHostCreatorSource).not.toContain('/cds-settings?tab=remote-hosts');
    expect(releaseSource).not.toContain('/cds-settings?tab=remote-hosts');
  });

  it('CDS 运维能力拆成四个可深链的独立页签', () => {
    expect(settingsSource).toContain("{ value: 'maintenance', label: 'CDS 更新'");
    expect(settingsSource).toContain("{ value: 'update-history', label: '自更新历史'");
    expect(settingsSource).toContain("{ value: 'docker-network', label: 'Docker 网络容量'");
    expect(settingsSource).toContain("{ value: 'danger', label: '危险操作'");
    expect(settingsSource).toContain('<TabsContent value="update-history">');
    expect(settingsSource).toContain('<TabsContent value="docker-network">');
    expect(settingsSource).toContain('<TabsContent value="danger">');
  });

  it('设置搜索结果指向拆分后的页签', () => {
    expect(settingsIndexSource).toContain("'update-history': '自更新历史'");
    expect(settingsIndexSource).toContain("'docker-network': 'Docker 网络容量'");
    expect(settingsIndexSource).toContain("danger: '危险操作'");
    expect(settingsIndexSource).toMatch(/id: 'sys:maintenance:update-history'[\s\S]*?tab: 'update-history'/);
    expect(settingsIndexSource).toMatch(/id: 'sys:docker-network:capacity'[\s\S]*?tab: 'docker-network'/);
    expect(settingsIndexSource).toMatch(/id: 'sys:danger:factory-reset'[\s\S]*?tab: 'danger'/);
  });
});

/**
 * 每个页签都得有自己的内容槽（2026-09-01，Codex 抓到的 P1）。
 *
 * 新增「权限总览」时，内容被塞进了 `TabsContent value="access-keys"` 里面。
 * Radix 只挂载 value 与当前页签相符的那个 TabsContent，所以点开权限总览是
 * **整页空白** —— 而组件、路由、接口全都好好的，编译过、测试全绿、页面也
 * 照常渲染，只有真的点进那个页签才看得出来。
 *
 * 判据钉的是结构不变量而不是「identity 这一个」：任何新页签漏配内容槽都会红。
 */
describe('CDS 系统设置：页签与内容槽一一对应', () => {
  const declared = Array.from(
    settingsSource.matchAll(/\{\s*value:\s*'([a-z-]+)'\s*,\s*label:/g),
  ).map((m) => m[1]);
  const mounted = Array.from(
    settingsSource.matchAll(/<TabsContent\s+value="([a-z-]+)"/g),
  ).map((m) => m[1]);

  it('解析到了真实的页签清单（判据不是恒真）', () => {
    expect(declared.length).toBeGreaterThan(8);
    expect(declared).toContain('identity');
    expect(mounted.length).toBeGreaterThan(8);
  });

  it('每个声明的页签都有自己的 TabsContent（漏配即整页空白）', () => {
    const missing = declared.filter((v) => !mounted.includes(v));
    expect(missing).toEqual([]);
  });

  it('没有多余的内容槽指向不存在的页签', () => {
    const orphan = mounted.filter((v) => !declared.includes(v));
    expect(orphan).toEqual([]);
  });
});

/**
 * 服务端把「主体被停用」「授权被撤」与「到期」分成三种状态之后，界面必须能把
 * 它们分别说出来 —— 否则管理员看到的是「过期于 —」（这两种情况根本没有到期
 * 时间），明明是他自己刚点的停用，界面却说不出原因（Codex 第四轮）。
 */
describe('权限总览：新增的失效原因要渲染得出来', () => {
  const tabSource = fs.readFileSync(
    path.resolve(process.cwd(), '../cds/web/src/pages/cds-settings/tabs/IdentityTab.tsx'),
    'utf8',
  );

  it('前端类型认得服务端返回的全部状态', () => {
    for (const status of ['principal-disabled', 'grant-revoked', 'expired', 'revoked', 'active']) {
      expect(tabSource, status).toContain(`'${status}'`);
    }
  });

  it('退役行不再把非 revoked 的一律当成到期', () => {
    expect(tabSource).toContain('retiredReason');
    expect(tabSource).toContain('主体已停用');
    expect(tabSource).toContain('授权已被撤销');
  });
});
