import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DesignGenerationStyle } from '@/services/real/webPages';
import type { DesignSystemCatalog, DesignSystemItem } from '@/services/real/designSystems';
import {
  CUSTOM_STYLE_CARD_TEXT,
  CustomStyleCard,
  DESIGN_SYSTEM_KEY_PREFIX,
  StyleCard,
  StyleGallery,
  designSystemSelection,
  groupMoreStyles,
  presetSelection,
} from './StyleGallery';

function item(id: string, category: string): DesignSystemItem {
  return {
    id,
    name: id,
    category,
    summary: `${id} summary`,
    swatches: { bg: 'var(--bg-base)', fg: 'var(--text-primary)', accent: 'var(--accent-primary)' },
    fonts: { display: 'serif', body: 'serif' },
    sampleUrl: `/api/design-artifacts/design-systems/${id}/sample`,
  };
}

const catalog: DesignSystemCatalog = {
  engine: { name: 'open-design', version: '0.21.1', image: 'ghcr.io/nexu-io/od:0.21.1', generatedAt: '2026-09-24T00:00:00Z' },
  count: 5,
  categories: [
    { name: 'Creative & Artistic', count: 3 },
    { name: 'Starter', count: 1 },
    { name: 'Layout & Structure', count: 1 },
  ],
  items: [
    item('editorial', 'Creative & Artistic'),
    item('storytelling', 'Creative & Artistic'),
    item('artistic', 'Creative & Artistic'),
    item('warm-editorial', 'Starter'),
    item('bento', 'Layout & Structure'),
  ],
};

const preset: DesignGenerationStyle = {
  id: 'editorial',
  name: '编辑刊物',
  description: '报刊式排版',
  designSystemId: 'editorial',
  swatches: ['#1f1a16', '#fbf7f0', '#9a5a2f'],
  sampleUrl: '/api/design-artifacts/design-systems/editorial/sample',
  enabled: true,
  isDefault: true,
  builtIn: true,
};

describe('更多风格分组', () => {
  it('按后端给的分类顺序分组，去掉已是预设的设计系统，空分组不出现', () => {
    const groups = groupMoreStyles(catalog, new Set(['editorial', 'warm-editorial']));
    expect(groups.map((group) => group.category)).toEqual(['Creative & Artistic', 'Layout & Structure']);
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['storytelling', 'artistic']);
  });
});

describe('选择回调', () => {
  it('预设按 styleId 作为 key；目录项加前缀，不与同名预设撞车', () => {
    expect(presetSelection(preset)).toEqual({ kind: 'preset', key: 'editorial', styleId: 'editorial', designSystemId: 'editorial', name: '编辑刊物' });
    const fromCatalog = designSystemSelection(item('editorial', 'Creative & Artistic'));
    expect(fromCatalog.key).toBe(`${DESIGN_SYSTEM_KEY_PREFIX}editorial`);
    expect(fromCatalog.key).not.toBe(presetSelection(preset).key);
  });

  it('点卡片与键盘 Enter / 空格都把这张卡的选择交给 onSelect；其它键不触发', () => {
    const onSelect = vi.fn();
    const selection = presetSelection(preset);
    const card = StyleCard({ selection, selected: false, description: preset.description, sampleDesignSystemId: 'editorial', onSelect }) as ReactElement<{
      onClick: () => void;
      onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
      'aria-pressed': boolean;
    }>;
    card.props.onClick();
    card.props.onKeyDown({ key: 'Enter', preventDefault: () => undefined });
    card.props.onKeyDown({ key: ' ', preventDefault: () => undefined });
    card.props.onKeyDown({ key: 'a', preventDefault: () => undefined });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenCalledWith(selection);
    expect(card.props['aria-pressed']).toBe(false);
  });

  it('选中态可见：aria-pressed 与强调色描边', () => {
    const html = renderToStaticMarkup(
      <StyleCard selection={presetSelection(preset)} selected description="d" sampleDesignSystemId="editorial" onSelect={() => undefined} />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('var(--accent-primary)');
    expect(html).toContain('编辑刊物');
  });
});

describe('做一个我的风格：只是入口，写明即将支持', () => {
  it('点击交给调用方处理，卡片上写清「即将支持」且不假装能用', () => {
    const onRequest = vi.fn();
    const card = CustomStyleCard({ onRequest }) as ReactElement<{ onClick: () => void }>;
    card.props.onClick();
    expect(onRequest).toHaveBeenCalledTimes(1);

    const html = renderToStaticMarkup(<CustomStyleCard onRequest={onRequest} />);
    expect(html).toContain(CUSTOM_STYLE_CARD_TEXT.title);
    expect(html).toContain('即将支持');
    expect(CUSTOM_STYLE_CARD_TEXT.description).toContain('还没有上线');
  });

  it('画廊首帧：预设区是卡片骨架，末尾一定有「做一个我的风格」入口', () => {
    const html = renderToStaticMarkup(
      <StyleGallery selectedId={null} onSelect={() => undefined} onRequestCustomStyle={() => undefined} title="标题" />,
    );
    expect(html).toContain('预设风格');
    expect(html).toContain('更多风格');
    expect(html).toContain('aspect-ratio:1200 / 760');
    expect(html.lastIndexOf(CUSTOM_STYLE_CARD_TEXT.title)).toBeGreaterThan(html.indexOf('更多风格'));
  });
});
