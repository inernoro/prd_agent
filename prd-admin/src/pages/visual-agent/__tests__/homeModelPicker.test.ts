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

/** 提交函数体。判「先后顺序」必须在这个范围内判，全文件搜会搜到别处的同名调用。 */
const SUBMIT = (() => {
  const at = PAGE.indexOf('const onQuickSubmit');
  return at < 0 ? '' : PAGE.slice(at, PAGE.indexOf('\n  };', at));
})();

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

  it('【关键】提交时把模型写回偏好，且跳转前一定已经落地', () => {
    // 先跳转再写就是竞态：编辑器挂载时读同一份偏好，可能读到上一次的值，
    // 用户会看到「首页选了 A，进去却是 B」。
    //
    // 判据只盯两件事：写回存在、且在跳转之前被 await 掉。**不盯 await 紧贴着它**——
    // 上一版要求 await 出现在调用前 60 个字符内，等到这个调用被并进 Promise.all
    // （和建工作区并行，省一个往返）就红了，而它其实仍然在跳转前落地。
    // 形状 4a：断言实现的字面排布，会拦住不改变行为的重构。
    // 必须在**提交函数体内**判序。整份文件里 navigate(getEditorPath(ws.id)) 出现不止一次
    // （列表卡片的 onOpen 也有一处，且在提交函数之后）——从全文件搜就会搜到那一处，
    // 于是把写偏好挪到跳转之后这条守卫照样绿。形状 6：判据读到的不是它以为的那一处。
    const at = SUBMIT.indexOf('updateVisualAgentPreferences({ modelAuto: false, modelId })');
    expect(at, '提交路径应写回偏好').toBeGreaterThan(0);
    const navAt = SUBMIT.indexOf('navigate(getEditorPath(ws.id))');
    expect(navAt, '提交函数里应有跳转').toBeGreaterThan(0);
    expect(navAt, '写回偏好必须发生在跳转之前').toBeGreaterThan(at);
    // 跳转之前那一段里必须有 await 把它等掉（直接 await，或并进一个被 await 的 Promise.all）。
    expect(SUBMIT.slice(0, navAt)).toMatch(/await (Promise\.all\(|updateVisualAgentPreferences)/);
  });

  it('【关键】模型随交接包一起交给编辑器，不只靠偏好接口', () => {
    // updateVisualAgentPreferences 失败时**返回 { success:false } 而不是 reject**
    // （apiRequest 统一约定，AGENTS.md 规则 #7），所以 .catch() 接不住普通失败。
    // 只靠那次写，写失败时编辑器会读到上一次的模型，用户在首页选了 A 却用 B
    // 跑了一次要花钱的生成（Codex PR #1476 P1）。交接包直接带上就不依赖它。
    expect(SUBMIT).toMatch(/const payload = \{[^}]*modelId/);
    const TAB = strip(readFileSync(resolve(ROOT, 'src/pages/ai-chat/AdvancedVisualAgentTab.tsx'), 'utf8'));
    expect(TAB).toMatch(/handedModelIdRef\.current = handedModelId/);
    // 且服务端偏好不得把它覆盖回去。
    expect(TAB).toMatch(/if \(!handedModelIdRef\.current\) \{/);
  });

  it('【关键】尺寸跟着模型走：拉 adapter-info，并把清单传给尺寸表', () => {
    expect(PAGE).toContain('getVisualAgentAdapterInfo(modelCode)');
    // 查询必须用池内实际上游模型 ID，用池 ID 查不到适配器、尺寸会被错误清空。
    expect(PAGE).toMatch(/currentModel\?\.actualModelId \|\| currentModel\?\.modelName/);
    expect(PAGE).toMatch(/availableSizes=\{availableSizes\}/);
    expect(PANEL).toMatch(/availableSizes\?: SizesByResolution \| null/);
  });

  it('【关键】换模型先丢掉上一个模型的尺寸清单，再去拉新的', () => {
    // 不清空的话，新请求回来之前面板端的还是上一个模型的档位。这段窗口里点发送，
    // 交出去的尺寸属于另一个模型，后端归一化会把输出悄悄改掉（Codex PR #1476 P2）。
    // 判据盯顺序：清空必须发生在发起请求之前，写在 .then 里救不了那段窗口。
    const at = PAGE.indexOf('const modelCode = currentModel?.actualModelId');
    expect(at, '应有按模型拉尺寸的 effect').toBeGreaterThan(0);
    const effect = PAGE.slice(at, PAGE.indexOf('}, [currentModel]);', at));
    const clearAt = effect.indexOf('setAvailableSizes(null);\n    void getVisualAgentAdapterInfo');
    expect(clearAt, '发起请求之前必须先清空上一个模型的清单').toBeGreaterThan(0);
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
