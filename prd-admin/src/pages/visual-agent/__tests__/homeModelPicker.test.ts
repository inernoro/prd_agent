import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 首页工具行的模型/尺寸接线。
 *
 * 这三条都属于「删掉之后页面照常渲染、测试照常绿」的那种半截接线（形状 2），
 * 所以必须有源码守卫盯着，而不是指望下次通读能看出来。
 */
const ROOT = resolve(__dirname, '../../../..');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');

const PAGE = strip(readFileSync(resolve(ROOT, 'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx'), 'utf8'));
const PANEL = strip(readFileSync(resolve(ROOT, 'src/components/visual-agent/SizePickerPanel.tsx'), 'utf8'));

describe('首页能看见并选择绘图模型', () => {
  it('剥完注释还剩真代码（companion：防止下面几条对着空字符串判绿）', () => {
    expect(PAGE).toContain('function QuickInputBox');
    expect(PANEL).toContain('export function SizePickerPanel');
  });

  it('【关键】模型 chip 真的挂进了工具行，不是只定义没使用', () => {
    expect(PAGE).toContain('function ModelPickerButton');
    expect(PAGE).toMatch(/<ModelPickerButton\s/);
    expect(PAGE).toMatch(/modelOptions=\{modelOptions\}/);
    expect(PAGE).toMatch(/onModelChange=\{onModelChange\}/);
  });

  it('【关键】默认模型来自账号偏好，不是每次回到自动', () => {
    // 三段优先级：上次用的 → 服务端默认池 → 第一个可用。
    // 少了第一段，用户每次回首页都要重选——那正是这次要修的问题。
    expect(PAGE).toContain('visualAgentPreferences?.modelId');
    expect(PAGE).toMatch(/options\.find\(\(o\) => o\.id === preferred && o\.enabled\)/);
    expect(PAGE).toMatch(/options\.find\(\(o\) => o\.enabled && o\.isDefault\)/);
  });

  it('【关键】提交时把模型写回偏好，且 await 之后才跳转', () => {
    // 先跳转再写就是竞态：编辑器挂载时读同一份偏好，可能读到上一次的值，
    // 用户会看到「首页选了 A，进去却是 B」。判据盯 await 与顺序。
    const at = PAGE.indexOf('updateVisualAgentPreferences({ modelAuto: false, modelId })');
    expect(at, '提交路径应写回偏好').toBeGreaterThan(0);
    expect(PAGE.slice(at - 60, at)).toContain('await');
    const navAt = PAGE.indexOf('navigate(getEditorPath(ws.id))', at);
    expect(navAt, '写回偏好必须发生在跳转之前').toBeGreaterThan(at);
  });

  it('【关键】尺寸跟着模型走：拉 adapter-info，并把清单传给尺寸表', () => {
    expect(PAGE).toContain('getVisualAgentAdapterInfo(modelCode)');
    // 查询必须用池内实际上游模型 ID，用池 ID 查不到适配器、尺寸会被错误清空。
    expect(PAGE).toMatch(/currentModel\?\.actualModelId \|\| currentModel\?\.modelName/);
    expect(PAGE).toMatch(/availableSizes=\{availableSizes\}/);
    expect(PANEL).toMatch(/availableSizes\?: SizesByResolution \| null/);
  });

  it('【关键】拿不到尺寸清单时退回静态表，不假装知道', () => {
    // no-rootless-tree：适配器没命中 / 该模型尺寸语义不适用 → 明确置 null。
    expect(PAGE).toMatch(/res\.data\.sizesNotApplicable !== true/);
    expect(PAGE).toContain('setAvailableSizes(null)');
    expect(PANEL).toMatch(/flattenSizes\(availableSizes\)\.length > 0 \? availableSizes : null/);
  });

  it('尺寸 chip 不再是那枚靛蓝药丸，与同行控件同一档', () => {
    // 用户指着它说「这个地方是旧的」：整条行只有它带色块，也是整页唯一
    // 和品牌色无关的颜色。判据盯「按钮上不再有靛蓝底」，不锁具体样式写法。
    const btnAt = PANEL.indexOf('export function SizePickerButton');
    const btn = PANEL.slice(btnAt, btnAt + 1400);
    expect(btn).not.toContain('rgba(99, 102, 241');
  });
});
