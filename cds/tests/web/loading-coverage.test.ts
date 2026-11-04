import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { auditLoadingCoverage } from '../../scripts/loading-coverage-audit.mjs';
import { ContentLoading, type ContentLoadingVariant } from '../../web/src/components/skeletons/ContentLoading.js';
import { BranchDrawerSkeleton } from '../../web/src/components/branch/BranchDrawerSkeleton.js';
import { RelationCardSkeleton } from '../../web/src/components/branch/RelationCard.js';
import { RelationFlowSkeleton } from '../../web/src/components/branch/RelationFlowStrip.js';

import { AlarmChannelsPanel } from '../../web/src/pages/cds-settings/AlarmChannelsPanel.js';
import { HealthSection } from '../../web/src/pages/release-center/HealthSection.js';
import { AlarmIdentityPanel } from '../../web/src/pages/cds-settings/AlarmIdentityPanel.js';

const render = (component: Parameters<typeof createElement>[0], props?: object) => renderToStaticMarkup(createElement(component, props));

describe('内容加载覆盖守卫', () => {
  it('全量扫描内容等待分支，遗漏必须有可执行的位置而不是关键词数量', () => {
    const result = auditLoadingCoverage();
    expect(result.uncovered).toEqual([]);
    expect(result.counts.shared).toBeGreaterThanOrEqual(118);
    for (const file of [
      'pages/release-center/HealthSection.tsx', 'pages/cds-settings/AlarmIdentityPanel.tsx', 'pages/ReleaseConsolePage.tsx', 'pages/OverviewPage.tsx', 'pages/BranchRelationsPage.tsx', 'components/BranchDetailDrawer.tsx',
      'components/branch/DatabaseDirectoryDialog.tsx', 'components/env/EnvSetupDialog.tsx',
      'pages/AgentRequestsPage.tsx', 'pages/status/FunctionalEvidence.tsx',
      'pages/release-center/EvidenceSection.tsx', 'components/CommandPalette.tsx',
    ]) expect(result.sharedSites.some((site: { file: string }) => site.file === file), file).toBe(true);
  });

  it('能抓到新增的裸文字等待，骨架接入后才通过；按钮反馈不误计为缺口', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-loading-audit-'));
    const file = path.join(dir, 'DataPanel.tsx');
    try {
      fs.writeFileSync(file, `function DataPanel(){if(state.status === 'loading')return <div>正在读取</div>;return <button>{saving ? <Spinner/> : '保存'}</button>;}`);
      const result = auditLoadingCoverage(dir);
      expect(result.uncovered).toHaveLength(1);
      expect(result.uncovered[0].owner).toBe('DataPanel');
      fs.writeFileSync(file, `function DataPanel(){if(state.status === 'loading')return <ContentLoading label="读取内容"/>;return <button>{loading ? <Spinner/> : '保存'}</button>;}`);
      const covered = auditLoadingCoverage(dir);
      expect(covered.uncovered).toEqual([]);
      expect(covered.waits.some((row: { category: string }) => row.category === 'action')).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('待克隆项目的菜单动作不误计为内容加载，菜单外的裸等待仍报错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-loading-menu-audit-'));
    try {
      fs.writeFileSync(path.join(dir, 'CloneMenu.tsx'), `function CloneMenu(){return <div>{project.cloneStatus === 'pending' ? <DropdownItem onSelect={clone}>开始克隆</DropdownItem> : null}{loading ? <div>读取项目</div> : null}</div>;}`);
      const result = auditLoadingCoverage(dir);
      expect(result.waits.filter((row: { category: string }) => row.category === 'action')).toHaveLength(1);
      expect(result.uncovered).toHaveLength(1);
      expect(result.uncovered[0].condition).toBe('loading');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('共享内容骨架', () => {
  for (const variant of ['rows', 'table', 'panel', 'log', 'inline'] as ContentLoadingVariant[]) {
    it(`${variant} 使用共享轻呼吸、无交互占位，正常等待不显示重复说明`, () => {
      const html = render(ContentLoading, { label: '读取验收内容', variant });
      expect(html).toContain('aria-label="读取验收内容"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('cds-loading-skeleton-line');
      expect(html).not.toContain('>读取验收内容<');
      expect(html).not.toMatch(/<(?:button|input|a)\b/);
      expect(html).not.toContain('animate-spin');
    });
  }

  it('去掉图中加载说明，同时保留真正的失败说明', () => {
    for (const html of [render(BranchDrawerSkeleton, { status: 'running' }), render(RelationCardSkeleton, { variant: 'row' })]) {
      expect(html).not.toContain('通常 1 秒内完成');
      expect(html).not.toContain('分支详情到了就开始体检');
      expect(html).toContain('relation-strip-skeleton');
    }
    expect(render(RelationFlowSkeleton, { tone: 'bad', note: '读取失败，请重试' })).toContain('读取失败，请重试');
  });
});

describe('非 loading 命名的首载状态', () => {
  it('通知通道请求返回前不误报未配置', () => {
    const html = render(AlarmChannelsPanel);
    expect(html).toContain('aria-label="读取通知通道"');
    expect(html).not.toContain('出问题时不会有任何人被通知');
  });
  it('健康汇总未返回时不提前宣称没有配置检查地址', () => {
    const html = render(HealthSection, { envs: [], selected: undefined });
    expect(html).toContain('aria-label="读取发布健康数据"');
    expect(html).not.toContain('未配置健康检查地址');
    expect(html).not.toContain('读取中');
  });
  it('通知身份首载不暴露尚未填入的可编辑表单或假失败', () => {
    const html = render(AlarmIdentityPanel);
    expect(html).toContain('aria-label="读取通知身份"');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('暂未取得发送方式');
  });
});
