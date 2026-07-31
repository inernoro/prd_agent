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

  it('从顶栏进入：默认整库范围，并直说会公开全部文档', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic={false}
        currentEntryId="e1" currentEntryTitle="以后怎么说" onClose={vi.fn()} />,
    );

    expect(html).toContain('分享范围');
    expect(html).toContain('拿到链接的人可以浏览「MAP系统和设计」里的全部文档。');
    // 当前正在读的那篇要能一键切过去，不必回文件树右键才能单篇分享
    expect(html).toContain('只分享当前这篇');
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

  it('没有打开文档时，「只分享一篇」不可点并说明原因', () => {
    const html = renderToStaticMarkup(
      <ShareDialog storeId="s1" storeName="MAP系统和设计" isPublic={false} onClose={vi.fn()} />,
    );

    expect(html).toContain('只分享一篇（未打开文档）');
    expect(html).toContain('先打开一篇文档，才能单独分享它');
  });
});
