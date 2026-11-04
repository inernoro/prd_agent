import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsContentSkeleton, SettingsLoadingContext } from '../../web/src/components/skeletons/SettingsSkeleton';
import { LoadingBlock } from '../../web/src/pages/cds-settings/components';
import { AuthTab } from '../../web/src/pages/cds-settings/tabs/AuthTab';
import { OverviewTab } from '../../web/src/pages/cds-settings/tabs/OverviewTab';
import { StorageTab } from '../../web/src/pages/cds-settings/tabs/StorageTab';
import fs from 'node:fs';
import path from 'node:path';

const render = (node: ReactNode) => renderToStaticMarkup(node);
const settings = (node: ReactNode) => createElement(SettingsLoadingContext.Provider, { value: true }, node);
const geometryMarkup = (markup: string) => markup.replace(/aria-label="[^"]*"/g, '');

describe('设置代码和数据只使用一副内容骨架', () => {
  for (const [name, Page] of [['登录认证', AuthTab], ['设置概览', OverviewTab], ['存储设置', StorageTab]] as const) {
    it(`${name}初始数据等待与代码等待轮廓相同`, () => {
      expect(geometryMarkup(render(settings(createElement(Page))))).toBe(geometryMarkup(render(createElement(SettingsContentSkeleton))));
    });
  }

  it('继承设置作用域时保留具体读取标签，但不再返回四横条', () => {
    const html = render(settings(createElement(LoadingBlock, { label: '读取认证状态' })));
    expect(html).toBe(render(createElement(SettingsContentSkeleton, { label: '读取认证状态' })));
  });

  it('其他页面和显式退出作用域的预览/弹窗保持原轮廓', () => {
    const original = render(createElement(LoadingBlock, { label: '读取列表' }));
    const excluded = render(settings(createElement(SettingsLoadingContext.Provider, { value: false }, createElement(LoadingBlock, { label: '读取列表' }))));
    expect(excluded).toBe(original);
    expect(original).not.toContain('data-settings-content-skeleton');
    for (const file of ['tabs/LoadingPagesTab.tsx', 'components/UserProjectAccessDialog.tsx']) {
      expect(fs.readFileSync(path.resolve('web/src/pages/cds-settings', file), 'utf8')).toContain('<SettingsLoadingContext.Provider value={false}>');
    }
  });
});
