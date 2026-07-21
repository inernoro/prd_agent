import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MapBrandMark } from './MapBrandMark';

describe('MapBrandMark', () => {
  it('使用可缩放的路径节点标识，不回退到文字 favicon 图片', () => {
    const html = renderToStaticMarkup(<MapBrandMark />);

    expect(html).toContain('data-testid="map-brand-mark"');
    expect(html).toContain('aria-label="MAP"');
    expect(html).toContain('<title>MAP</title>');
    expect(html.match(/<circle/g)).toHaveLength(3);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('favicon.png');
  });

  it('展开侧栏时显示完整品牌文字', () => {
    const html = renderToStaticMarkup(<MapBrandMark expanded />);

    expect(html).toContain('>MAP</span>');
    expect(html).toContain('智能体平台');
  });
});
