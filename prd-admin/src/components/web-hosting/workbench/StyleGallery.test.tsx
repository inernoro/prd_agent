import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DesignGenerationStyle } from '@/services/real/webPages';
import type { DesignSystemCatalog, DesignSystemItem } from '@/services/real/designSystems';
import type { PersonalStyle } from '@/services/real/personalStyles';
import {
  CUSTOM_STYLE_CARD_TEXT,
  CustomStyleCard,
  DESIGN_SYSTEM_KEY_PREFIX,
  PersonalStyleCard,
  StyleCard,
  StyleGallery,
  designSystemSelection,
  groupMoreStyles,
  personalSelection,
  presetSelection,
  personalCardAction,
  selectionAfterDelete,
  selectionStyleId,
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

const mine: PersonalStyle = {
  id: 'a'.repeat(32),
  styleId: `personal:${'a'.repeat(32)}`,
  name: '我的蓝调',
  instruction: '配色：底色 #f7f5f0，正文 #1f2328，强调色 #2f6feb。',
  swatches: ['#1f2328', '#f7f5f0', '#2f6feb'],
  fonts: ['Inter'],
  baseDesignSystemId: 'editorial',
  baseDesignSystemName: 'Editorial',
  baseDesignSystemAvailable: true,
  sourceSiteId: 'site-1',
  sourceSiteTitle: '季度复盘',
  sourceNote: null,
  systemFilledFields: ['instruction'],
  createdAt: '2026-09-25T00:00:00Z',
  updatedAt: '2026-09-25T00:00:00Z',
};

describe('我的风格：和预设并列，标「我的」，按 personal:<id> 交给服务端', () => {
  it('选择键就是 styleId，不与同名预设或目录项撞车；生成请求带 styleId', () => {
    const selection = personalSelection(mine);
    expect(selection).toEqual({
      kind: 'personal',
      key: `personal:${'a'.repeat(32)}`,
      styleId: `personal:${'a'.repeat(32)}`,
      designSystemId: 'editorial',
      name: '我的蓝调',
      swatches: mine.swatches,
    });
    expect(selection.key).not.toBe(presetSelection(preset).key);
    expect(selection.key).not.toBe(designSystemSelection(item('editorial', 'x')).key);

    expect(selectionStyleId(selection)).toBe(`personal:${'a'.repeat(32)}`);
    expect(selectionStyleId(presetSelection(preset))).toBe('editorial');
    expect(selectionStyleId(designSystemSelection(item('bento', 'x')))).toBeNull();
    expect(selectionStyleId(null)).toBeNull();
  });

  it('卡片带「我的」标记、名称与说明，缩略图用它自己的色块；点卡片选中，点编辑/删除不误选', () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const html = renderToStaticMarkup(
      <PersonalStyleCard style={mine} selected={false} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} />,
    );
    expect(html).toContain('>我的<');
    expect(html).toContain('我的蓝调');
    expect(html).toContain('data-style-kind="personal"');
    expect(html).toContain('background:#f7f5f0');
    expect(html).toContain('aria-label="编辑我的蓝调"');
    expect(html).toContain('aria-label="删除我的蓝调"');

    const card = PersonalStyleCard({ style: mine, selected: false, onSelect, onEdit, onDelete }) as ReactElement<{ onClick: () => void }>;
    card.props.onClick();
    expect(onSelect).toHaveBeenCalledWith(personalSelection(mine));
  });

  it('按描述建的风格没有色块就明说，不编一组颜色；骨架下线要挂出来', () => {
    const noSwatches = { ...mine, swatches: [], baseDesignSystemAvailable: false };
    const html = renderToStaticMarkup(
      <PersonalStyleCard style={noSwatches} selected onSelect={() => undefined} onEdit={() => undefined} onDelete={() => undefined} />,
    );
    expect(html).toContain('按描述生成，无色块');
    expect(html).toContain('骨架已下线');
    expect(html).toContain('aria-pressed="true"');
  });

  it('「做一个我的风格」入口可点、交给画廊打开创建弹窗；到上限时禁用并写明原因', () => {
    const onRequest = vi.fn();
    const card = CustomStyleCard({ onRequest }) as ReactElement<{ onClick: () => void; disabled: boolean }>;
    card.props.onClick();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(card.props.disabled).toBe(false);

    const html = renderToStaticMarkup(<CustomStyleCard onRequest={onRequest} />);
    expect(html).toContain(CUSTOM_STYLE_CARD_TEXT.title);
    expect(html).not.toContain('即将支持');

    const full = renderToStaticMarkup(<CustomStyleCard onRequest={onRequest} disabledReason="已经有 20 套，最多 20 套，先删掉一套不用的" />);
    expect(full).toContain('disabled=""');
    expect(full).toContain('最多 20 套');
  });

  it('画廊首帧：预设在前、我的风格紧跟其后（含新建入口）、更多风格在最后', () => {
    const html = renderToStaticMarkup(
      <StyleGallery selectedId={null} onSelect={() => undefined} title="标题" />,
    );
    expect(html).toContain('aspect-ratio:1200 / 760');
    const presetsAt = html.indexOf('预设风格');
    const mineAt = html.indexOf('aria-label="我的风格"');
    const createAt = html.indexOf(CUSTOM_STYLE_CARD_TEXT.title);
    const moreAt = html.indexOf('aria-label="更多风格"');
    expect(presetsAt).toBeGreaterThanOrEqual(0);
    expect(mineAt).toBeGreaterThan(presetsAt);
    expect(createAt).toBeGreaterThan(mineAt);
    expect(moreAt).toBeGreaterThan(createAt);
  });
});

describe('删掉选中的「我的风格」之后', () => {
  it('删的不是选中的那套：选择不动', () => {
    expect(selectionAfterDelete('editorial', 'personal:p1', [preset])).toEqual({ kind: 'keep' });
  });

  it('删的是选中的那套：退回默认预设', () => {
    expect(selectionAfterDelete('personal:p1', 'personal:p1', [preset])).toEqual({ kind: 'select', selection: presetSelection(preset) });
  });

  it('预设读不到或为空：清空选择，不留已删除的编号', () => {
    expect(selectionAfterDelete('personal:p1', 'personal:p1', null)).toEqual({ kind: 'clear' });
    expect(selectionAfterDelete('personal:p1', 'personal:p1', [])).toEqual({ kind: 'clear' });
  });
});

describe('骨架已下线的「我的风格」', () => {
  it('卡片主操作是打开编辑，不选中一个生成必然被拒的风格', () => {
    expect(personalCardAction({ baseDesignSystemAvailable: false })).toBe('edit');
    expect(personalCardAction({ baseDesignSystemAvailable: true })).toBe('select');
  });
});
