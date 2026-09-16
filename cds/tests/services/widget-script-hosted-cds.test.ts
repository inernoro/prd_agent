/**
 * 徽章的托管态（CDS 托管 CDS，2026-09-16）。
 *
 * 用户看到预览实例页面底部并排两条：父实例注入的绿色 sha 徽章 + 子实例自己画的橙色
 * 「预览实例」pill。合并的做法是让父实例在注入时就知道这条分支起的是 CDS 预览实例，
 * 徽章自己长成「CDS 托管 CDS」变体；子实例侦测到徽章存在就不再画 pill。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildWidgetScript } from '../../src/widget-script.js';
import { profileHostsPreviewInstance } from '../../src/services/preview-instance.js';

describe('buildWidgetScript 托管态', () => {
  it('默认不是托管态：普通项目的徽章一个字都不变', () => {
    const script = buildWidgetScript('b', 'feature/x', 'abc123', '极速');
    expect(script).toContain('var HOSTED_CDS=false;');
  });
  it('托管态：深绿变体、首段「CDS 托管 CDS」、末尾提示禁用，展开面板不给部署按钮', () => {
    const script = buildWidgetScript('b', 'claude/x', 'abc123', '发布', true);
    expect(script).toContain('var HOSTED_CDS=true;');
    expect(script).toContain("if(HOSTED_CDS)badgeClass+=' is-hosted-cds';");
    expect(script).toContain('<span class="cds-hosted-label">CDS 托管 CDS</span>');
    expect(script).toContain('部署 / docker 已禁用');
    // 三处部署入口（模式选择 / 逐服务更新 / 全量更新）都被 HOSTED_CDS 闸住
    expect(script).toContain('for(var mi=0;mi<profiles.length&&!HOSTED_CDS;mi++)');
    expect(script).toContain('for(var i=0;i<profiles.length&&!HOSTED_CDS;i++)');
    expect(script).toContain('if(profiles.length>1&&!HOSTED_CDS)');
    // 托管态的 CSS 只有一处定义，且不是蓝色 sha 高亮
    expect(script).toContain('#cds-widget .cds-badge.is-hosted-cds .cds-sha{');
  });
});

describe('profileHostsPreviewInstance', () => {
  it('看 profile.env 里 compose 声明的 CDS_PREVIEW_INSTANCE，取值口径与子实例自己的判定同源', () => {
    expect(profileHostsPreviewInstance({ env: { CDS_PREVIEW_INSTANCE: '1' } })).toBe(true);
    expect(profileHostsPreviewInstance({ env: { CDS_PREVIEW_INSTANCE: 'true' } })).toBe(true);
    expect(profileHostsPreviewInstance({ env: { CDS_PREVIEW_INSTANCE: '0' } })).toBe(false);
    expect(profileHostsPreviewInstance({ env: {} })).toBe(false);
    expect(profileHostsPreviewInstance(undefined)).toBe(false);
  });
  it('项目环境变量也能声明，但 profile 自己写了就以 profile 为准', () => {
    expect(profileHostsPreviewInstance({}, { CDS_PREVIEW_INSTANCE: '1' })).toBe(true);
    expect(profileHostsPreviewInstance({ env: { CDS_PREVIEW_INSTANCE: '0' } }, { CDS_PREVIEW_INSTANCE: '1' })).toBe(false);
  });
});

describe('接线守卫：父实例注入时真的判了，子实例真的让位了', () => {
  it('proxy.ts 把 hostedCds 传进了 buildWidgetScript', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/proxy.ts'), 'utf8');
    expect(src).toMatch(/buildWidgetScript\([\s\S]*?hostedCds,\s*\)/);
    expect(src).toContain('profileHostsPreviewInstance(');
  });
  it('AppShell 只在没有父徽章（#cds-widget）时才画自己的 pill', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/layout/AppShell.tsx'), 'utf8');
    expect(src).toContain('{previewInstance && !hostWidgetPresent && (');
    expect(src).toContain("document.getElementById('cds-widget')");
    // pill 单独出现时的文案与父徽章同一套（都叫「CDS 托管 CDS」），不再是橙色警告
    expect(src).toContain('CDS 托管 CDS · 预览实例');
    expect(src).not.toContain('CDS 预览实例 — 仅用于验收 CDS 自身改动');
  });
});
