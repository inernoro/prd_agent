/**
 * 视觉创作消息展示层清洗测试
 *
 * 验证场景：
 * 1. 剥离生图意图前缀 "Generate an image based on the following description:"
 * 2. 剥离【引用图片（按顺序）】文字块 + "- @imgN: 文件名" 行（历史污染消息也要干净展示）
 * 3. 引用块中的 refId 提取到 blockRefIds（正文已内联的不重复）
 * 4. chip 标签清洗：绝不显示带扩展名的原始文件名
 *
 * 运行方式：pnpm -C prd-admin test visualMessageDisplay
 */

import { describe, it, expect } from 'vitest';
import { parseVisualMessageDisplay, cleanChipLabel } from '../visualMessageDisplay';

describe('parseVisualMessageDisplay — 展示层清洗', () => {
  it('普通文本原样保留', () => {
    const r = parseVisualMessageDisplay('画一只在草地上奔跑的柴犬');
    expect(r.text).toBe('画一只在草地上奔跑的柴犬');
    expect(r.blockRefIds).toEqual([]);
  });

  it('内联 @imgN 保留在原位置（就地渲染 chip）', () => {
    const r = parseVisualMessageDisplay('@img1 拿着 @img2 在 @img3 的背景里');
    expect(r.text).toBe('@img1 拿着 @img2 在 @img3 的背景里');
    expect(r.blockRefIds).toEqual([]);
  });

  it('剥离生图意图前缀', () => {
    const r = parseVisualMessageDisplay('Generate an image based on the following description:\n画一只猫');
    expect(r.text).toBe('画一只猫');
  });

  it('元数据 token 在前时生图前缀仍被剥离（历史消息格式）', () => {
    const r = parseVisualMessageDisplay(
      '(@size:1024x1024) (@model:gpt-image-1) Generate an image based on the following description:\n画一只猫'
    );
    expect(r.text).toBe('画一只猫');
    expect(r.text).not.toMatch(/Generate an image/i);
    expect(r.text).not.toContain('@size');
  });

  it('用户手写 "- @imgN: 指令" 列表行（无块头）整行保留', () => {
    const r = parseVisualMessageDisplay('- @img1: 保持面部不变\n- @img2: 换成夜景');
    expect(r.text).toContain('保持面部不变');
    expect(r.text).toContain('换成夜景');
    expect(r.blockRefIds).toEqual([]);
  });

  it('块内引用行剥离、块后的用户列表行保留', () => {
    const raw =
      '把左边的物体放到右边\n【引用图片（按顺序）】\n- @img1: a.png\n\n- @img2: 这行是用户写的指令';
    const r = parseVisualMessageDisplay(raw);
    expect(r.text).toContain('把左边的物体放到右边');
    expect(r.text).not.toContain('a.png');
    expect(r.text).toContain('这行是用户写的指令');
    expect(r.blockRefIds).toEqual([1]);
  });

  it('剥离【引用图片（按顺序）】块并提取 blockRefIds', () => {
    const raw = '把左边的物体放到右边\n\n【引用图片（按顺序）】\n- @img1: 76a9705d94b06dbb1a651f3ff16ad7e1.png\n- @img2: db3d9483aa.png';
    const r = parseVisualMessageDisplay(raw);
    expect(r.text).toBe('把左边的物体放到右边');
    expect(r.text).not.toContain('引用图片');
    expect(r.text).not.toContain('.png');
    expect(r.blockRefIds).toEqual([1, 2]);
  });

  it('无正文、仅引用块时 text 为空且 refId 全进 blockRefIds', () => {
    const raw = '【引用图片（按顺序）】\n- @img1: a.png\n- @img2: b.jpg';
    const r = parseVisualMessageDisplay(raw);
    expect(r.text).toBe('');
    expect(r.blockRefIds).toEqual([1, 2]);
  });

  it('正文已内联的 refId 不重复进 blockRefIds', () => {
    const raw = '让 @img1 变成水彩风\n\n【引用图片（按顺序）】\n- @img1: a.png\n- @img2: b.png';
    const r = parseVisualMessageDisplay(raw);
    expect(r.text).toContain('@img1');
    expect(r.blockRefIds).toEqual([2]);
  });

  it('@img1 内联不误吞 @img12（数字边界）', () => {
    const raw = '用 @img12 的风格\n\n【引用图片（按顺序）】\n- @img1: a.png\n- @img12: b.png';
    const r = parseVisualMessageDisplay(raw);
    expect(r.blockRefIds).toEqual([1]);
  });

  it('剥离裸 (@size:...) 与 (@model:...) token', () => {
    const r = parseVisualMessageDisplay('(@size:1024x1024) (@model:gpt-image-2) 画一座山');
    expect(r.text).toBe('画一座山');
  });

  it('历史全污染消息（前缀 + 引用块 + 文件名）展示后完全干净', () => {
    const raw =
      'Generate an image based on the following description:\n' +
      '生成周报封面\n\n' +
      '【引用图片（按顺序）】\n' +
      '- @img1: 76a9705d94b06dbb1a651f3ff16ad7e1.png\n' +
      '- @img2: 7cc0ce81b3.jpeg';
    const r = parseVisualMessageDisplay(raw);
    expect(r.text).toBe('生成周报封面');
    expect(r.text).not.toMatch(/Generate an image/i);
    expect(r.text).not.toContain('【');
    expect(r.text).not.toMatch(/\.(png|jpe?g)/i);
    expect(r.blockRefIds).toEqual([1, 2]);
  });

  it('空输入返回空结果', () => {
    expect(parseVisualMessageDisplay('')).toEqual({ text: '', blockRefIds: [] });
    expect(parseVisualMessageDisplay('   ')).toEqual({ text: '', blockRefIds: [] });
  });

  it('折叠多余空行', () => {
    const r = parseVisualMessageDisplay('第一段\n\n\n\n第二段');
    expect(r.text).toBe('第一段\n\n第二段');
  });
});

describe('cleanChipLabel — chip 标签清洗', () => {
  it('带扩展名的哈希文件名 → 截短主干，不含扩展名', () => {
    const label = cleanChipLabel('76a9705d94b06dbb1a651f3ff16ad7e1.png', 1);
    expect(label).toBe('76a9705d…');
    expect(label).not.toContain('.png');
  });

  it('短文件名 → 主干原样保留', () => {
    expect(cleanChipLabel('cat.png', 1)).toBe('cat');
  });

  it('普通描述文本原样保留', () => {
    expect(cleanChipLabel('手绘草图', 2)).toBe('手绘草图');
  });

  it('空标签回退为 图N', () => {
    expect(cleanChipLabel('', 3)).toBe('图3');
    expect(cleanChipLabel(undefined, 5)).toBe('图5');
  });

  it('refId 无效时回退为 图片', () => {
    expect(cleanChipLabel('', 0)).toBe('图片');
  });

  it('标签中的引用块标记被剥离', () => {
    const label = cleanChipLabel('周报封面【引用图片（按顺序）】- @img1: a.png', 1);
    expect(label).not.toContain('【');
    expect(label).not.toContain('@img');
    expect(label).toContain('周报封面');
  });
});
