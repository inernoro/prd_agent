import { createRequire } from 'node:module';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonitorViewNav } from '../../web/src/components/layout/MonitorViewNav';
import { readStatusLocation } from '../../web/src/lib/statusHome';

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');
const renderNav = (url: string): string => renderToStaticMarkup(
  createElement(MemoryRouter, { initialEntries: [url] }, createElement(MonitorViewNav)),
);

describe('监控二级导航使用真实系统路由', () => {
  it.each([
    ['/status', '监控总览'],
    ['/status?view=catalog', '监控列表'],
    ['/status?view=history', '处理记录'],
    ['/status?view=owner', '监控管理'],
    ['/status?view=all', '监控管理'],
    ['/status?target=monitor%40service', '监控列表'],
    ['/status?target=monitor%40service&incident=incident-1', '监控总览'],
  ])('%s 只高亮对应的实际入口', (url, label) => {
    const html = renderNav(url);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>${label}</a>`));
    expect(html).toContain('href="/status"');
    expect(html).toContain('href="/status?view=catalog"');
    expect(html).toContain('href="/status?view=history"');
    expect(html).toContain('href="/status?view=owner"');
  });

  it('新通知进入工作区，旧服务链接保留原来的详情路径', () => {
    expect(readStatusLocation(new URLSearchParams('target=monitor%40service&incident=incident-1')))
      .toEqual({ view: 'home', targetId: 'monitor@service' });
    expect(readStatusLocation(new URLSearchParams('target=monitor%40service')))
      .toEqual({ view: 'detail', targetId: 'monitor@service' });
  });
});
