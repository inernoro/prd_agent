import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「点发送后卡在首页很久」的接线。
 *
 * 这几条都属于「改回去也不会红」的那种：页面照常渲染、生成照常出图，
 * 只是用户又要对着不动的按钮多等十几秒。所以必须有源码守卫钉住。
 */
const ROOT = resolve(__dirname, '../../../..');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');

const PAGE = strip(readFileSync(resolve(ROOT, 'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx'), 'utf8'));
const TAB = strip(readFileSync(resolve(ROOT, 'src/pages/ai-chat/AdvancedVisualAgentTab.tsx'), 'utf8'));

const submitBody = (() => {
  const at = PAGE.indexOf('const onQuickSubmit');
  expect(at, '提交函数应存在').toBeGreaterThan(0);
  return PAGE.slice(at, PAGE.indexOf('\n  };', at));
})();

describe('首页点发送后立刻进画板', () => {
  it('剥完注释还剩真代码（companion：防止下面几条对着空字符串判绿）', () => {
    expect(PAGE).toContain('function QuickInputBox');
    expect(TAB).toContain('const inlineCanvasItem');
    expect(submitBody).toContain('createVisualAgentWorkspace');
  });

  it('【关键】提交路径不再等参考图上传', () => {
    // 一张手机照片转 base64 要多传三分之一体积，这个往返就是「卡很久」的长杆。
    // 图交给画板，由它生成前的落盘逻辑上传。
    expect(submitBody).not.toContain('uploadVisualAgentWorkspaceAsset');
  });

  it('【关键】建工作区与写偏好并行发，不串成两个往返', () => {
    const at = submitBody.indexOf('Promise.all');
    expect(at, '两个互不依赖的往返应并行').toBeGreaterThan(0);
    const block = submitBody.slice(at, at + 600);
    expect(block).toContain('createVisualAgentWorkspace');
    expect(block).toContain('updateVisualAgentPreferences');
  });

  it('【关键】偏好仍在跳转之前落地（不能为了快把竞态放回来）', () => {
    // 编辑器挂载时读同一份偏好，先跳转再写，用户会看到「首页选了 A，进去却是 B」。
    const prefAt = submitBody.indexOf('updateVisualAgentPreferences');
    const navAt = submitBody.indexOf('navigate(getEditorPath(ws.id))');
    expect(prefAt).toBeGreaterThan(0);
    expect(navAt, '写偏好必须发生在跳转之前').toBeGreaterThan(prefAt);
    expect(submitBody.slice(0, prefAt)).toContain('await');
  });

  it('【关键】参考图的像素尺寸要量出来并交给画板', () => {
    // 缺了它，画布上这张卡在落位那一刻没有真实体积，新生成的图会压上去。
    expect(submitBody).toContain('measureDataUrl(selectedImage.previewUrl)');
    expect(submitBody).toMatch(/imageSize/);
    expect(TAB).toContain('initialImageSizeRef');
    expect(TAB).toMatch(/data\.imageSize/);
  });

  it('【关键】首页带入的图必须直接递给发送，不靠 setState 刷新', () => {
    // setCanvas / setSelectedKeys 是异步的，同一拍调 sendText 读到的是旧画布，
    // 解析器找不到这张图就一个 ref 都不给——第一次生成静默变成纯文字，
    // 用户在首页传的照片被整个忽略（Codex PR #1476 P1）。
    // 这条接线删掉之后页面照常渲染、也照常出图，只是出的图跟参考图无关，
    // 所以必须有守卫盯着。
    const at = TAB.indexOf('void sendText(initialPrompt.text');
    expect(at, '首页带入应走 sendText').toBeGreaterThan(0);
    const call = TAB.slice(at, at + 320);
    expect(call).toMatch(/extraCanvas:\s*pendingItem/);
    expect(call).toMatch(/selectedKeysOverride:\s*pendingKey/);
    // 发送端要真的把它并进解析用的画布，并且回查实体也走同一份合并结果，
    // 否则解析出了 ref 却拿不到实体，imageRefs 依旧是空的。
    expect(TAB).toMatch(/mergeSendCanvas\(canvas, opts\?\.extraCanvas\)/);
    expect(TAB).toMatch(/sendCanvas\.find\(\(c\) => c\.key === ref\.canvasKey\)/);
    expect(TAB).toMatch(/selectedKeys:\s*sendSelectedKeys/);
  });

  it('交接包写不进 sessionStorage 时不能整个提交挂掉', () => {
    // dataURL 可能有好几 MB，超配额会抛。
    expect(submitBody).toMatch(/try\s*\{[\s\S]{0,200}sessionStorage\.setItem/);
  });
});

describe('画布落位：新图贴着参考图排', () => {
  it('【关键】生成路径用对齐落位，不是只有最近空位搜索', () => {
    const at = TAB.indexOf('const alignedPos =');
    expect(at, '生成路径应先试对齐车道').toBeGreaterThan(0);
    expect(TAB.slice(at, at + 400)).toMatch(/findAlignedFreeTopLeft\(existingRects, genW, genH, refRect\)/);
    expect(TAB.slice(at, at + 400)).toMatch(/alignedPos \?\? findNearestFreeTopLeft\(/);
  });

  it('【关键】碰撞表只有一处口径，不许再手写 ?? 1', () => {
    // 生成 / 上传 / 拖入三处各写一遍时，改一处漏两处；而且 `?? 1` 等于把那个元素
    // 从碰撞检测里删掉。收敛到 occupiedRects 之后，这个写法一次都不该再出现。
    expect(TAB).not.toMatch(/w: x\.w \?\? 1, h: x\.h \?\? 1/);
    expect(TAB.match(/const existingRects = occupiedRects\(prev\);/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('【关键】首页带入的参考图必须落位，否则当不了锚点', () => {
    const at = TAB.indexOf('const inlinePos = findNearestFreeTopLeft(');
    expect(at, '带入的参考图应显式落位').toBeGreaterThan(0);
    const item = TAB.slice(TAB.indexOf('const inlineCanvasItem'), TAB.indexOf('setCanvas((prev) => [...prev, inlineCanvasItem])'));
    expect(item).toContain('x: inlinePos.x');
    expect(item).toContain('y: inlinePos.y');
  });

  it('没有 assetId 的带入图标 pending，交给生成前的落盘逻辑', () => {
    const item = TAB.slice(TAB.indexOf('const inlineCanvasItem'), TAB.indexOf('setCanvas((prev) => [...prev, inlineCanvasItem])'));
    expect(item).toMatch(/syncStatus: 'pending'/);
    expect(TAB).toContain("refForInit.syncStatus !== 'synced'");
  });
});
