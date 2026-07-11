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

describe('CDS 系统设置深链契约', () => {
  it('getInitialTab 兼容 ?tab= query 作为 #hash 的 fallback', () => {
    expect(settingsSource).toContain("window.location.hash.replace(/^#/, '')");
    expect(settingsSource).toContain("new URLSearchParams(window.location.search).get('tab')");
    // query 值同样要过 tabs 白名单校验，不许把任意字符串当 tab
    expect(settingsSource).toContain('tabs.some((tab) => tab.value === queryTab)');
  });

  it('发布中心引导深链使用 #hash 规范写法', () => {
    expect(releaseSource).toContain('/cds-settings#remote-hosts');
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
