import { describe, expect, it } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import type { PersonalStyle, PersonalStyleDraft } from '@/services/real/personalStyles';
import { runProvenanceText } from '../siteGenerateProgress';
import {
  createBlocker,
  createInput,
  derivableSites,
  deriveBlocker,
  formFromDraft,
  formFromStyle,
  parseFonts,
  systemFilledFields,
  updateInput,
  validatePersonalStyleForm,
} from './personalStyleModel';

const draft: PersonalStyleDraft = {
  name: '季度复盘风格',
  instruction: '配色：底色 #f7f5f0（浅色页面），正文 #1f2328，强调色 #c2410c。',
  swatches: ['#1f2328', '#f7f5f0', '#c2410c'],
  fonts: ['Noto Serif SC', 'Inter'],
  baseDesignSystemId: 'editorial',
  baseDesignSystemName: 'Editorial',
  baseReason: '按配色就近选：底色、正文与强调色和「Editorial」最接近',
  traits: [{ key: 'palette', label: '配色', value: '底色 #f7f5f0' }],
  evidence: '读了 1 段页内样式、0 个站内样式文件、0 处行内样式，共 40 条声明',
  sourceSiteId: 'site-1',
  sourceSiteTitle: '季度复盘',
  sourceNote: null,
  systemFilledFields: ['name', 'instruction', 'swatches', 'fonts', 'baseDesignSystemId'],
};

function site(patch: Partial<HostedSite>): HostedSite {
  return {
    id: 'site',
    title: '网页',
    entryFile: 'index.html',
    ownerUserId: 'u1',
    ...patch,
  } as HostedSite;
}

describe('创建流程：提取前', () => {
  it('网页或描述至少给一样才能提取；描述超长先拦', () => {
    expect(deriveBlocker(null, '  ') ?? '').toContain('选一张你自己的网页');
    expect(deriveBlocker(null, '') ?? '').toContain('写几句想要的风格');
    expect(deriveBlocker('site-1', '')).toBeNull();
    expect(deriveBlocker(null, '深色科技感')).toBeNull();
    expect(deriveBlocker(null, 'x'.repeat(501))).toContain('500');
  });

  it('只列自己创建的 HTML 网页，PDF / 视频包装站不能拿来提取', () => {
    const sites = [
      site({ id: 'a' }),
      site({ id: 'b', ownerUserId: 'u2' }),
      site({ id: 'c', wrappedAssetType: 'pdf' }),
      site({ id: 'd', wrappedAssetType: 'markdown' }),
      site({ id: 'e', entryFile: 'slides/index.htm' }),
      site({ id: 'f', entryFile: 'video.mp4' }),
    ];
    expect(derivableSites(sites, 'u1').map((s) => s.id)).toEqual(['a', 'd', 'e']);
  });

  it('到上限时不能再新建并说清原因', () => {
    expect(createBlocker(19, 20)).toBeNull();
    expect(createBlocker(20, 20)).toContain('最多 20 套');
  });
});

describe('创建流程：审阅与保存', () => {
  it('系统填的字段，用户一改就不再标「系统填写」，没改的仍标', () => {
    const form = formFromDraft(draft);
    expect(systemFilledFields(draft, form)).toEqual(draft.systemFilledFields);

    const edited = { ...form, name: '我的复盘风', swatches: ['#1f2328', '#ffffff', '#c2410c'] };
    expect(systemFilledFields(draft, edited)).toEqual(['instruction', 'fonts', 'baseDesignSystemId']);

    // 大小写与字体分隔符不同但语义相同，不算改过。
    const same = { ...form, swatches: form.swatches.map((c) => c.toUpperCase()), fontsText: 'Noto Serif SC, Inter' };
    expect(systemFilledFields(draft, same)).toEqual(draft.systemFilledFields);
  });

  it('保存时带上来源与仍由系统填写的字段，字体按逗号拆开', () => {
    const form = { ...formFromDraft(draft), name: '  我的复盘风  ' };
    const input = createInput(draft, form);
    expect(input).toMatchObject({
      name: '我的复盘风',
      fonts: ['Noto Serif SC', 'Inter'],
      sourceSiteId: 'site-1',
      sourceSiteTitle: '季度复盘',
      baseDesignSystemId: 'editorial',
    });
    expect(input.systemFilledFields).not.toContain('name');
    expect(parseFonts('A，B、A\nC')).toEqual(['A', 'B', 'C']);
  });

  it('校验口径与后端一致：名称、说明、色块、骨架写坏了就不让保存', () => {
    const form = formFromDraft(draft);
    expect(validatePersonalStyleForm(form)).toBeNull();
    expect(validatePersonalStyleForm({ ...form, name: ' ' })).toContain('名字');
    expect(validatePersonalStyleForm({ ...form, name: 'a"b' })).toContain('双引号');
    expect(validatePersonalStyleForm({ ...form, instruction: '' })).toContain('不能为空');
    expect(validatePersonalStyleForm({ ...form, instruction: 'x'.repeat(1501) })).toContain('1500');
    expect(validatePersonalStyleForm({ ...form, swatches: ['#fff', '#000', '#123456'] })).toContain('#rrggbb');
    expect(validatePersonalStyleForm({ ...form, swatches: [] })).toBeNull();
    expect(validatePersonalStyleForm({ ...form, baseDesignSystemId: '' })).toContain('骨架');
  });
});

describe('运行出处', () => {
  it('用我的风格生成的运行，出处照样写「风格：<我的风格名>」（名称由服务端冻结进运行）', () => {
    expect(runProvenanceText({ styleName: '我的蓝调', promptFingerprint: '0123456789ab' })).toBe('风格：我的蓝调 · 提示词版本 01234567');
  });
});

describe('编辑 / 重命名', () => {
  const style: PersonalStyle = {
    id: 'a'.repeat(32),
    styleId: `personal:${'a'.repeat(32)}`,
    name: '我的蓝调',
    instruction: '只用黑白两色',
    swatches: [],
    fonts: [],
    baseDesignSystemId: 'minimal',
    baseDesignSystemName: 'Minimal',
    baseDesignSystemAvailable: true,
    sourceSiteId: null,
    sourceSiteTitle: null,
    sourceNote: '黑白极简',
    systemFilledFields: ['instruction'],
    createdAt: '',
    updatedAt: '',
  };

  it('只提交改过的字段；什么都没改就不发请求', () => {
    const form = formFromStyle(style);
    expect(updateInput(style, form)).toBeNull();
    expect(updateInput(style, { ...form, name: '黑白' })).toEqual({ name: '黑白' });
    expect(updateInput(style, { ...form, baseDesignSystemId: 'bento', fontsText: 'Inter' })).toEqual({
      baseDesignSystemId: 'bento',
      fonts: ['Inter'],
    });
  });
});
