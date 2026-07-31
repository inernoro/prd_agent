import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareDialog } from '../DocumentStorePage';

// 用户反馈（2026-07-31）：「分享单个，结果整个知识库都暴露了」「这个页面让人不够明白」。
// 弹窗必须把范围摆在最上面并用一句话说清可见范围——这两点钉死在测试里。
describe('ShareDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } });
  });

  it('顶栏进入且正读着一篇时：默认就是「只分享当前这篇」，不默认公开整库', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic={false}
        currentEntryId="e1" currentEntryTitle="以后怎么说" onClose={vi.fn()} />,
    );

    // 默认范围必须落在当前这篇：整库公开后果更大，不能当默认（用户 2026-07-31 明确要求）。
    // 面板第一行的范围说明就是默认范围的直接体现（弹窗打开、链接还在加载时就已可见）。
    expect(html).toContain('拿到链接的人只能看到《以后怎么说》这一篇，看不到知识库里的其他文档。');
    expect(html).not.toContain('拿到链接的人可以浏览「MAP系统和设计」里的全部文档。');
  });

  it('没打开文档时才回落到整库范围', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic={false} onClose={vi.fn()} />,
    );

    expect(html).toContain('拿到链接的人可以浏览「MAP系统和设计」里的全部文档。');
  });

  it('从文件树进入某篇：默认单篇范围，并直说看不到其他文档', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic
        entryId="e1" entryTitle="以后怎么说" onClose={vi.fn()} />,
    );

    expect(html).toContain('拿到链接的人只能看到《以后怎么说》这一篇，看不到知识库里的其他文档。');
    // 单篇范围下不能再摆整库公开页直链，否则又把「整库可访问」混进单篇语境
    expect(html).not.toContain('智识殿堂公开页');
  });

  it('已发布的库在整库范围下才展示智识殿堂公开页', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic onClose={vi.fn()} />,
    );

    expect(html).toContain('智识殿堂公开页');
    expect(html).toContain('https://example.test/library/s1');
  });
});

