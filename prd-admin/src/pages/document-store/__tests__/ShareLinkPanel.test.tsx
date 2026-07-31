import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareLinkPanel } from '../ShareLinkPanel';
import type { DocumentStoreShareLink } from '@/services/contracts/documentStore';

function link(patch: Partial<DocumentStoreShareLink> = {}): DocumentStoreShareLink {
  return {
    id: 'l1', token: 'AbCdEfGh', storeId: 's1', storeName: 'MAP系统和设计',
    viewCount: 3, createdBy: 'u1', createdAt: '2026-07-30T00:00:00Z', isRevoked: false,
    ...patch,
  };
}

const base = {
  activeScope: 'entry' as const,
  storeName: 'MAP系统和设计',
  entryTitle: '周报-2026-W28-本周纵深',
  canPickEntry: true,
  shortLinkBusy: false,
  onCopy: vi.fn(),
  onSelectScope: vi.fn(),
  onShortLink: vi.fn(),
  onRevoke: vi.fn(),
};

describe('ShareLinkPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  });

  // 用户 2026-07-31：「我看到的是一个数字，分享统一以后数字分享不是常态」
  it('面板里给的是不可枚举的长链，即使这条分享已经有数字短链', () => {
    const html = renderToStaticMarkup(<ShareLinkPanel {...base} link={link({ shortSeq: 100 })} />);

    expect(html).toContain('https://example.test/s/lib/AbCdEfGh');
    // 输入框里绝不能出现 /s/100 这种可枚举地址
    expect(html).not.toContain('value="https://example.test/s/100"');
  });

  it('没生成过数字短链时显示「未生成 · 点击生成」，不占号也不展示数字', () => {
    const html = renderToStaticMarkup(<ShareLinkPanel {...base} link={link()} />);

    expect(html).toContain('未生成 · 点击生成');
    expect(html).not.toContain('/s/100');
  });

  it('用户主动生成过之后才显示数字短链，并可点击复制', () => {
    const html = renderToStaticMarkup(<ShareLinkPanel {...base} link={link({ shortSeq: 100 })} />);

    expect(html).toContain('/s/100 · 点击复制');
  });

  it('设置行显示当前范围/有效期/打开次数，撤销放在最后', () => {
    const html = renderToStaticMarkup(
      <ShareLinkPanel {...base} link={link({ viewCount: 7 })} />,
    );

    expect(html).toContain('分享范围');
    expect(html).toContain('只分享当前这篇');
    expect(html).toContain('永不过期');
    expect(html).toContain('7 次');
    expect(html.indexOf('撤销这条链接')).toBeGreaterThan(html.indexOf('数字短链'));
  });
});
