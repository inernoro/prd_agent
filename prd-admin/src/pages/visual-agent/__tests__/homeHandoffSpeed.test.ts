import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
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
const MOBILE = strip(readFileSync(resolve(ROOT, 'src/pages/visual-agent/MobileVisualAgentEditor.tsx'), 'utf8'));

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

  it('【关键】跳转前只等一个网络往返：建工作区', () => {
    // 这条判据的前两版都在守一个后来不成立的理由。
    //
    // v1「建工作区与写偏好并行发」、v2「偏好必须在跳转前落地」，理由都是
    // 「编辑器会读同一份偏好，先跳后写就是竞态」。交接包带上 modelId 之后，
    // 本次用哪个模型完全由交接包决定、编辑器不读偏好——理由没了，
    // 而那句 await 的代价还在：偏好接口慢或不返回时，工作区早已建好，
    // 用户还盯着不动的「生成中…」，正是这个 PR 要治的症状（Codex PR #1476 P2）。
    //
    // 现在钉真正的不变量：**跳转前只准等建工作区这一个往返**。
    const navAt = submitBody.indexOf('navigate(getEditorPath(ws.id))');
    expect(navAt, '提交函数里应有跳转').toBeGreaterThan(0);
    const before = submitBody.slice(0, navAt);
    expect(before).toMatch(/await createVisualAgentWorkspace\(/);
    // 偏好写回照发，但不等；也不许并进任何被 await 的聚合。
    expect(submitBody).toMatch(/void updateVisualAgentPreferences\(/);
    expect(before, '不许 await 偏好写回').not.toMatch(/await\s+updateVisualAgentPreferences\(/);
    expect(before, '不许把它并进被 await 的 Promise.all').not.toMatch(/await Promise\.all\(/);
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

  it('【关键】一个字都没存进去时不跳转，保住用户刚敲的那句话', () => {
    // 站点存储被禁用时两次 setItem 都抛。照旧跳转的话，画板是空的、
    // 而这边已经把输入清空——用户的话就没了，还得重打（Codex PR #1476 P2）。
    const at = submitBody.indexOf('if (!handoffStored)');
    expect(at, '应有「没存进去就别跳」的分支').toBeGreaterThan(0);
    const block = submitBody.slice(at, at + 400);
    expect(block).toContain('return;');
    // 且这个分支必须在跳转之前，否则形同虚设。
    expect(submitBody.indexOf('navigate(getEditorPath(ws.id))')).toBeGreaterThan(at);
    // 清空输入只能发生在跳转之后那条路径上。
    expect(submitBody.indexOf("setInputValue('')")).toBeGreaterThan(at);
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

describe('交接包有两个消费方，改一个就得改另一个', () => {
  // 这条守卫的由来：我给交接包加了 imageSize / modelId / 内联图三样，只教了桌面编辑器，
  // 手机编辑器照旧只认 assetId、只按「第一个可用池」挑模型。结果手机用户传的照片被
  // 整个忽略、模型也不是他选的那个——而这两件都要花钱（Codex PR #1476 两条 P1）。
  // 形状 3：同一份数据有两个读者，改一处忘一处。

  it('剥完注释还剩真代码（companion）', () => {
    expect(MOBILE).toContain('pendingInitRef');
  });

  it('【关键】只有这两个文件读交接包；多出第三个必须同步适配', () => {
    // 判据必须**先扫出真实消费方**再断言，不能拿一份写死的名单去过滤自己。
    //
    // 上一版是 `['A','B'].filter(读了交接包)` 然后 expect(length===2)：
    // 第三个消费方无论怎么加都进不了这个数组，守卫永远绿——而它宣传的正是
    // 「多出第三个必须同步适配」。一条不会红的守卫比没有守卫更糟：
    // 它让下一个人以为这件事已经有人盯着了（Codex PR #1476 P2，
    // 判据纪律形状 2：接线只建一半 + 形状 4：测试自己坏了）。
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
        return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
      });
    const SRC = resolve(ROOT, 'src');
    const PRODUCER = resolve(SRC, 'pages/visual-agent/VisualAgentWorkspaceListPage.tsx');
    const found = walk(SRC)
      .filter((f) => f !== PRODUCER && !f.includes('__tests__') && !/\.test\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes('visual_agent_init_'))
      .map((f) => f.slice(SRC.length + 1).split(sep).join('/'))
      .sort();
    // companion：扫描本身得能扫到东西，否则下面那条会对着空数组判绿。
    expect(found.length, '应至少扫到消费方；扫不到说明遍历/过滤写坏了').toBeGreaterThan(0);
    expect(found).toEqual([
      'pages/ai-chat/AdvancedVisualAgentTab.tsx',
      'pages/visual-agent/MobileVisualAgentEditor.tsx',
    ]);
  });

  it('【关键】手机端也认交接包里的模型，不再退回第一个可用池', () => {
    expect(MOBILE).toMatch(/data\.modelId/);
    expect(MOBILE).toMatch(/setPickedPoolId\(handedModelId\)/);
    // **读了还得读对**。上一版守卫到上一行为止就收工了，而那两行当时都成立：
    // 交接包确实读了、setPickedPoolId 确实调了——存进去的却是带前缀的选项 id
    // （`pool_xxx`），而 pickedPool 拿它跟原始池的 `id`（`xxx`）比，一次都比不中，
    // 照样退回第一个可用池。守卫找到了一份真实存在、写法完全合法的语句，
    // 就当成契约已经满足（形状 8：把不成立的证据当成证据）。
    // 所以这里改盯「转换真的发生了」，转换本身的行为由
    // visualAgentModelOptions.test.ts 用真 builder 断言。
    expect(MOBILE).toMatch(/poolIdFromVisualModelOptionId\(String\(data\.modelId/);
  });

  it('【关键】手机端把内联图先落盘再生成，不静默丢图跑纯文字', () => {
    expect(MOBILE).toMatch(/inlineImage: parsed\.inlineImage/);
    // 落盘要真的发生，并且结果要用作这次生成的参考图。
    const at = MOBILE.indexOf('if (!ref && pending.inlineImage?.src)');
    expect(at, '缺 assetId 时应先上传').toBeGreaterThan(0);
    const block = MOBILE.slice(at, at + 900);
    expect(block).toContain('uploadVisualAgentWorkspaceAsset');
    expect(block).toMatch(/ref = \{ assetId: a\.id/);
    // 失败要说出来，不能悄悄跑一次没有参考图的付费生成。
    expect(block).toMatch(/toast\.error\('参考图未能带入'/);
  });
});
