import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteCardMetrics } from './SiteCardMetrics';

describe('卡片底部统计的信息保留', () => {
  it('尚未返回的统计保留未知状态，不伪装成零', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics />);
    for (const text of ['编辑次数暂不可用', '访问统计暂不可用', '访客统计暂不可用']) expect(html).toContain(text);
    expect(html.match(/—/g)).toHaveLength(3);
  });
  it('已知零值在三个统计项中都显示', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics activity={{ editCount: 0, isNew: false }}
      traffic={{ all: { visits: 0, visitors: 0 }, external: { visits: 0, visitors: 0 }, activeShareLinks: 0 }} />);
    expect(html).toContain('已编辑 0 次');
    expect(html).toContain('全部访问 0 次');
    expect(html).toContain('全部访客 0 位');
    expect(html).not.toContain('有效链接');
    expect(html).not.toContain('—');
  });
  it('访问沿用全部访问口径，删除重复的分享数', () => {
    const html = renderToStaticMarkup(<SiteCardMetrics
      traffic={{ all: { visits: 12345, visitors: 6789 }, external: { visits: 2, visitors: 1 }, activeShareLinks: 3 }} />);
    expect(html).toContain('全部访问 12345 次');
    expect(html).toContain('全部访客 6789 位');
    expect(html).not.toContain('有效链接');
  });
});
