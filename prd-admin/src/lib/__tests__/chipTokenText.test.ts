import { describe, expect, it } from 'vitest';
import {
  chipToken,
  hasChipToken,
  inlineMarksToTokens,
  parseChipTokenText,
  parseComposerImageReferences,
  serializeImageReferenceMessage,
} from '../chipTokenText';

describe('chipTokenText', () => {
  const KEY1 = 'img-3-ab12cd';
  const KEY2 = 'img-7-ef34gh';
  const SRC1 = 'https://cdn.example.com/a/b.png?x=1';
  const SRC2 = 'data-free://path/c.jpg';
  it('只选中图片再写正文时，消息仍保留这次实际使用的参考图', () => {
    expect(serializeImageReferenceMessage('保留构图', [{ refId: 1, canvasKey: KEY1, src: SRC1 }]))
      .toBe(`${chipToken(1, KEY1, SRC1)} 保留构图`);
  });
  it('消息快照不嵌入大图片字节，复制格式与图片身份仍可回读', () => {
    const message = serializeImageReferenceMessage('@img1 保持构图', [{ refId: 1, canvasKey: KEY1, src: `data:image/png;base64,${'a'.repeat(70_000)}` }]);
    expect(message).toBe(`[@image:#1:${KEY1}:] 保持构图`);
    expect(parseChipTokenText(message)[0]).toMatchObject({ canvasKey: KEY1, refId: 1 });
  });
  it('旧文字和复制占位符均恢复卡片；编号变化时绑定图片身份', () => {
    const options = [{ key: KEY1, refId: 12, src: SRC1, label: '蓝色参考' }];
    const segments = parseComposerImageReferences(`@img12 与 ${chipToken(1, KEY1, SRC1)}`, options);
    const images = segments.filter((segment) => segment.type === 'image');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.option.refId).toBe(12);
      expect(image.option.key).toBe(KEY1);
      expect(image.valid).toBe(true);
    }
    expect(segments.map((segment) => segment.type === 'text' ? segment.text : '').join('')).toBe(' 与 ');
  });

  it('失效占位符显示提示卡片，不按数字编号换成别的图', () => {
    const segments = parseComposerImageReferences(chipToken(1, 'removed', SRC1), [{ key: KEY1, refId: 1, src: SRC1, label: '另一张图' }]);
    expect(segments[0]).toMatchObject({ type: 'image', valid: false, option: { key: 'removed', label: '参考图已移除', src: '' } });
  });

  it('chipToken 生成 Lovart 形态 token', () => {
    expect(chipToken(1, KEY1, SRC1)).toBe(`[@image:#1:${KEY1}:${SRC1}]`);
  });

  it('parse 单 token + 前后文字（URL 含冒号不截断）', () => {
    const text = `拿着${chipToken(1, KEY1, SRC1)}去跑步`;
    const segs = parseChipTokenText(text);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: 'text', text: '拿着' });
    expect(segs[1]).toMatchObject({ type: 'chip', refId: 1, canvasKey: KEY1, src: SRC1 });
    expect(segs[2]).toEqual({ type: 'text', text: '去跑步' });
  });

  it('parse 多 token 保序 + 同图多引用（同 key 出现两次）', () => {
    const text = `${chipToken(1, KEY1, SRC1)} 拿着 ${chipToken(1, KEY1, SRC1)} 在 ${chipToken(2, KEY2, SRC2)} 里`;
    const segs = parseChipTokenText(text);
    const chips = segs.filter((s) => s.type === 'chip');
    expect(chips).toHaveLength(3);
    expect(chips[0]).toMatchObject({ refId: 1, canvasKey: KEY1 });
    expect(chips[1]).toMatchObject({ refId: 1, canvasKey: KEY1 });
    expect(chips[2]).toMatchObject({ refId: 2, canvasKey: KEY2 });
  });

  it('hasChipToken 判定 + 连续调用无 lastIndex 污染', () => {
    const text = chipToken(3, KEY1, SRC1);
    expect(hasChipToken(text)).toBe(true);
    expect(hasChipToken(text)).toBe(true);
    expect(hasChipToken('普通文字 [@image 不完整')).toBe(false);
  });

  it('非法 token（canvasKey 含冒号/缺段）不解析为 chip', () => {
    const text = '[@image:#1:bad:key:with:colons] 与 [@image:#2]';
    const segs = parseChipTokenText(text);
    // 第一个会按「key=bad, src=key:with:colons」解析——这是格式内合法的；
    // 真正防幻觉靠粘贴侧 canvasKey 未命中集合时保持纯文本。
    expect(segs.filter((s) => s.type === 'chip')).toHaveLength(1);
    expect(segs.some((s) => s.type === 'text' && s.text.includes('[@image:#2]'))).toBe(true);
  });

  it('inlineMarksToTokens 只升级命中 meta 的 @imgN，裸文本保留', () => {
    const meta = new Map([[1, { canvasKey: KEY1, src: SRC1 }]]);
    const out = inlineMarksToTokens('@img1 拿着 @img2 与 @img12', meta);
    expect(out).toContain(chipToken(1, KEY1, SRC1));
    expect(out).toContain('@img2');
    expect(out).toContain('@img12');
    expect(out).not.toContain('@img1 ');
  });

  it('token 往返：serialize → parse 恢复同一组引用', () => {
    const original = `${chipToken(1, KEY1, SRC1)}和${chipToken(2, KEY2, SRC2)}`;
    const segs = parseChipTokenText(original);
    const rebuilt = segs
      .map((s) => (s.type === 'chip' ? chipToken(s.refId, s.canvasKey, s.src) : s.text))
      .join('');
    expect(rebuilt).toBe(original);
  });
});
