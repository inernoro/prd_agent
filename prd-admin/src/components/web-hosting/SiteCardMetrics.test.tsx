import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteCardMetrics } from './SiteCardMetrics';

describe('卡片底部统计的信息保留', () => {
  it('尚未返回的统计保留未知状态，不伪装成零', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics />);
    for (const text of ['编辑次数暂不可用', '访问统计暂不可用', '访客统计暂不可用', '分享统计暂不可用']) expect(html).toContain(text);
    expect(html.match(/—/g)).toHaveLength(4);
  });
  it('已知零值在四个统计项中都显示', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics activity={{ editCount: 0, isNew: false }}
      traffic={{ all: { visits: 0, visitors: 0 }, external: { visits: 0, visitors: 0 }, activeShareLinks: 0 }} />);
    expect(html).toContain('已编辑 0 次');
    expect(html).toContain('全部访问 0 次');
    expect(html).toContain('全部访客 0 位');
    expect(html).toContain('有效链接 0 条');
    expect(html).not.toContain('—');
  });
  it('访问沿用全部访问口径，分享优先使用同一份权威统计', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics activeLinks={99}
      traffic={{ all: { visits: 12345, visitors: 6789 }, external: { visits: 2, visitors: 1 }, activeShareLinks: 3 }} />);
    expect(html).toContain('全部访问 12345 次');
    expect(html).toContain('全部访客 6789 位');
    expect(html).toContain('有效链接 3 条');
    expect(html).not.toContain('有效链接 99 条');
  });
  it('访问尚未知时仍可展示已知的有效分享数', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics activeLinks={2} />);
    expect(html).toContain('有效链接 2 条');
    expect(html).toContain('访问统计暂不可用');
  });
});
