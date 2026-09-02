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

  it('【关键】提交时把模型写回偏好，但**不等它**——跳转只等建工作区', () => {
    // 这条判据换过两次，两次都是被自己钉死的实现拦住的：
    //
    // v1 要求 await 紧贴着调用（前 60 字符内）→ 把它并进 Promise.all 就红了，
    //    而行为没变。形状 4a：断言实现的字面排布。
    // v2 改成「必须在跳转前被 await 掉」，理由是「编辑器会读同一份偏好，
    //    先跳后写就是竞态」。那个理由在交接包带上 modelId 之后**就不成立了**——
    //    本次用哪个模型完全由交接包决定，编辑器优先用它、不读偏好。
    //    而这句 await 的代价还在：偏好接口慢或不返回时，工作区早就建好了，
    //    用户还盯着不动的「生成中…」（Codex PR #1476 P2）。
    //
    // 所以现在钉的是新的不变量：写回照发，但跳转不等它。
    // 判据必须在**提交函数体内**判序——整份文件里 navigate(getEditorPath(ws.id))
    // 出现不止一次（列表卡片的 onOpen 也有一处），全文件搜会搜到那一处（形状 6）。
    const at = SUBMIT.indexOf('updateVisualAgentPreferences({ modelAuto: false, modelId })');
    expect(at, '提交路径应写回偏好').toBeGreaterThan(0);
    const navAt = SUBMIT.indexOf('navigate(getEditorPath(ws.id))');
    expect(navAt, '提交函数里应有跳转').toBeGreaterThan(0);
    // 发出去就不管：不许 await 它，也不许把它并进任何被 await 的聚合。
    expect(SUBMIT).toMatch(/void updateVisualAgentPreferences\(/);
    expect(SUBMIT, '不许 await 偏好写回').not.toMatch(/await\s+updateVisualAgentPreferences\(/);
    expect(SUBMIT, '也不许并进被 await 的 Promise.all').not.toMatch(/await Promise\.all\(/);
    // 跳转前必须等的只有建工作区那一个往返。
    expect(SUBMIT.slice(0, navAt)).toMatch(/await createVisualAgentWorkspace\(/);
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

  it('【关键】「暂不可用」的模型点不动，不只是压暗', () => {
    // 压暗 ≠ 点不了。上一版只调透明度，那一行照样能点中：选中之后交接包里带的
    // 就是一个没有健康成员的池，手机端把它过滤掉、静默退回「第一个可用池」——
    // 用户明明选了 A，花钱跑的是 B（Codex PR #1476 P1）。
    // 两件事都要断言：按钮真的 disabled，且点击回调自己也拦一道。
    const at = PAGE.indexOf('function ModelPickerButton');
    const body = PAGE.slice(at, PAGE.indexOf('\nfunction ', at + 10));
    expect(body).toMatch(/disabled=\{!opt\.enabled\}/);
    expect(body).toMatch(/onClick=\{\(\) => \{ if \(!opt\.enabled\) return;/);
  });

  it('【关键】文件夹按钮不假装能创建（后端还没有它）', () => {
    // 上一版点下去会弹取名框、让用户认真起个名、点「创建」，然后回一句
    // 「功能正在开发中」——一整套看着像真的流程，什么都没发生。而这条工具栏
    // 原来被 !isMobile 挡着，搬进标题行之后手机上也露出来了（Codex PR #1476 P2）。
    const at = PAGE.indexOf('新建文件夹');
    expect(at, '列表标题行应有文件夹入口').toBeGreaterThan(0);
    const btn = PAGE.slice(PAGE.lastIndexOf('<button', at), at + 200);
    expect(btn, '后端没有它之前必须是禁用的').toMatch(/\n\s*disabled\n/);
    // 那个空转的取名流程必须消失，不能只是把按钮禁掉、handler 还留着给别处调。
    expect(PAGE, '不许再有假装创建的占位流程').not.toContain('文件夹功能正在开发中');
  });

  it('尺寸 chip 不再是那枚靛蓝药丸，与同行控件同一档', () => {
    // 用户指着它说「这个地方是旧的」：整条行只有它带色块，也是整页唯一
    // 和品牌色无关的颜色。判据盯「按钮上不再有靛蓝底」，不锁具体样式写法。
    const btnAt = PANEL.indexOf('export function SizePickerButton');
    const btn = PANEL.slice(btnAt, btnAt + 1400);
    expect(btn).not.toContain('rgba(99, 102, 241');
  });
});
