import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 分层链路的接线守卫。
 *
 * 为什么需要它：上一版的判定函数单测全绿，真机上却 0 命中——因为绿的只是纯函数，
 * 「采样 → 判定 → 回写画布 → 面板渲染」这条线是死是活，没有任何测试说得上话。
 * 把回写那几行删掉，全量测试依旧全绿（.claude/rules/predicate-and-wiring-discipline.md 形状 2）。
 *
 * 本文件断言的是**这条线接着**。它不能证明判定准不准（那是 layerContentAnalysis.test.ts
 * 拿真实产物像素在做的事），但能保证判定的结果确实流到了用户眼前。
 */

const ROOT = resolve(__dirname, '../../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

const TAB = 'src/pages/ai-chat/AdvancedVisualAgentTab.tsx';
const PANEL = 'src/pages/ai-chat/components/SemanticLayerPanel.tsx';
const PERSIST = 'src/lib/visualAgentCanvasPersist.ts';

describe('分层内容判定的接线', () => {
  const tab = read(TAB);

  it('画布页真的调用了判定编排函数', () => {
    expect(tab).toContain('buildLayerContentVerdicts');
    expect(tab).toMatch(/buildLayerContentVerdicts\(\{/);
  });

  it('判定结果被写回画布（否则算了等于没算）', () => {
    expect(tab).toMatch(/layerContentKind:\s*verdict\.kind/);
    expect(tab).toMatch(/layerCoverage:\s*verdict\.stats\s*\?\s*verdict\.stats\.coverage\s*:\s*undefined/);
  });

  it('判定样本取自上传返回值，不回头去画布上捞（会读到没刷新的旧值）', () => {
    // 真机实测（用户截图）：最后一层永远停在「正在识别内容…」。根因是这里读 canvasRef，
    // 而 setCanvas 还没刷进 ref，最后一层拿到的仍是模型直出的跨域直链且没有 sha；
    // 对象存储不给 CORS 头，读像素必然被拦。
    expect(tab).toMatch(/layerSamples\.push\(\{\s*key:\s*layerKeyAt\(index\),\s*src:\s*asset\.url,\s*sha256:\s*asset\.sha256/);
    expect(tab).toMatch(/layers:\s*layerSamples/);
    expect(tab).not.toMatch(/layers:\s*Array\.from\(\{\s*length:\s*remoteLayers\.length/);
  });

  it('采样失败的那层要出「内容未识别」，不许永远停在进行时', () => {
    const analysis = read('src/lib/layerContentAnalysis.ts');
    expect(analysis).toMatch(/verdicts\.push\(\{\s*key:\s*layer\.key,\s*kind:\s*'layer',\s*stats:\s*null/);
    expect(analysis).toContain("return '内容未识别'");
  });

  it('判定用的是生产采样器，不是测试桩', () => {
    expect(tab).toMatch(/sampler:\s*sampleLayerRgba/);
  });

  it('面板每行的第二行走统一的文案函数，不再各写各的', () => {
    const panel = read(PANEL);
    expect(panel).toContain('export function layerRowSecondaryText');
    expect(panel).toMatch(/\{layerRowSecondaryText\(layer\)\}/);
  });

  it('行副标题来自内容判定，不再是每行都一样的来源文本', () => {
    // 回归钉子：subtitle 一旦改回 aiLayerSubtitle(...prompt)，各行会重新显示同一串文字。
    expect(tab).toMatch(/subtitle:[\s\S]{0,160}describeLayerContent\(/);
    expect(tab).not.toMatch(/subtitle:\s*aiLayerSubtitle\(cleanDisplayTitle\(layer\.prompt\)\)/);
  });

  it('面板拿得到「本次请求了几层」，才解释得清数字为什么对不上', () => {
    expect(tab).toMatch(/requestedLayerCount=\{/);
    expect(read(PANEL)).toMatch(/requestedLayerCount\s*!==\s*layers\.length/);
  });

  it('重新拆分会带上重拆标记，不会命中上一次的幂等键', () => {
    expect(tab).toMatch(/attempt:\s*Date\.now\(\)/);
    expect(read('src/lib/layeredPsd.ts')).toMatch(/attemptSuffix\(input\.attempt\)/);
  });

  it('同一张图可以反复拆：不许再有「已有图层就直接复用」的短路', () => {
    // 用户原话：「不应该绑定，我想拆多次，这应该没问题啊」。
    // 旧实现在发起前先看画布上有没有该原图的图层，有就弹「已复用 N 个可编辑图层，
    // 无需再次调用模型」直接 return——于是同一张图这辈子只能拆一次。
    // 只看会执行的行——注释里写着「当初为什么删掉它」，那段说明本身不该让守卫变红。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).not.toMatch(/已复用/);
    expect(code).not.toMatch(/无需再次调用模型/);
    expect(code).not.toMatch(/分层结果已在画布中/);
  });

  it('【关键】重拆不许删掉上一轮的结果，也不许改动原图', () => {
    // 2026-08-11 用户反馈：「我重新生成新的图层时候，他居然将原来的清理掉了？这是bug吗」——是。
    // 每次分层都是在右边多长出一份副本；原图与既往副本都必须原封不动。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).not.toMatch(/previous\.filter\(\(candidate\) => !\(\s*candidate\.layerSourceKey/);
    expect(code).not.toMatch(/layerRole: 'source' as const/);
    // 落位必须先挑一块空地，而不是拿原图那块矩形当锚点。
    expect(code).toMatch(/planLayeredCopyRect\(\{\s*source:\s*sourceItem,\s*occupied:\s*canvasRef\.current\s*\}\)/);
    expect(code).toMatch(/planSemanticLayerFrame\(sourceItem,\s*count,\s*layerLayoutMode,\s*copyRect\)/);
  });

  it('【关键】Cmd+G 编组 / Cmd+Shift+G 解组真的接上了键盘', () => {
    // 这两条只写函数不接键盘，等于没做——而且删掉接线全量测试照样绿（形状 2）。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/isMod && e\.shiftKey && !e\.altKey && isG/);
    expect(code).toMatch(/isMod && !e\.shiftKey && !e\.altKey && isG/);
    expect(code).toMatch(/groupSelection\(\)/);
    expect(code).toMatch(/ungroupSelection\(\)/);
    // 解组必须真的能撤掉 Frame：frameId 抹掉即可，且收集 Frame 时不许再拿 layerGroupId 兜底，
    // 兜底会让解组对 AI 分层组完全失效（框还在，用户以为快捷键坏了）。
    expect(read('src/lib/semanticLayerFrame.ts')).not.toMatch(/item\.frameId \?\? item\.layerGroupId/);
  });

  it('【关键】Frame 与多选都能直接导出 PSD', () => {
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/exportFrameAsPsd\(frame\.id/);
    expect(code).toMatch(/exportElementsAsPsd\(selectedKeys/);
    expect(code).toMatch(/exportSelectionAsZip\(\)/);
    // 通用 Frame 导出必须复用同一个 PSD 写层实现，不许另写一套。
    expect(read('src/lib/layeredPsd.ts')).toMatch(/buildLayeredPsdDocument\(\{ source: flattened, layers \}\)/);
  });

  it('【关键】点「AI 分层」要先给用户说话的机会', () => {
    // 2026-08-11 原话：「由于我点击之后就开拆了，所以没有输入自然语言的地方」。
    const bar = read('src/components/visual-agent/ImageQuickActionBar.tsx');
    expect(bar).toContain('LayerIntentBubble');
    expect(bar).toMatch(/setLayerIntentOpen\(\(open\) => !open\)/);
    // 但不能因此变慢：输入框自动聚焦、回车即开拆。
    expect(bar).toMatch(/inputRef\.current\?\.focus\(\)/);
    expect(bar).toMatch(/e\.key === 'Enter'[\s\S]{0,80}onSubmit\(value\.trim\(\)\)/);
    // 意图要真的传到分层调用上，不能只存在输入框里。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/onLayer=\{\(intent\) =>/);
    expect(code).toMatch(/intent,/);
  });

  it('【关键】Frame 头部是可以整组拖走的抓手', () => {
    // 2026-08-11 用户标注：「图层要能选中一起拖拽」。叠放之后各部件精确重合，
    // 逐个 shift 点选很别扭，Frame 头部才是那个自然的抓手。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/data-frame-handle=\{frame\.id\}/);
    // 必须真的接进既有的多选拖拽机制（keys 传整组），而不是另写一套只挪一个。
    expect(code).toMatch(/dragItemsRef\.current = \{[\s\S]{0,420}keys,\n/);
    expect(code).toMatch(/const keys = frame\.layerKeys;/);
  });

  it('【关键】不许把能力标识当模型名显示，也不许承诺做不到的层数上限', () => {
    // 2026-08-11 用户截图：面板写着「本组由 image-layering 拆分」——那是能力标识不是模型，
    // 用户据此判断不了任何东西；旁边还写着「最多拆 3 层」而模型实际给了 4 层。
    const panel = read(PANEL);
    expect(panel).toContain('export function isCapabilityId');
    expect(panel).toMatch(/isCapabilityId\(usedModel\)/);
    expect(panel).toMatch(/能力路由，具体模型由网关决定/);
    // 「最多」是个做不到的承诺，层数只能是期望值。
    expect(panel).not.toMatch(/>最多拆</);
    expect(panel).toMatch(/>期望拆</);
  });

  it('【关键】等待动效不许用 background-position 百分比做循环', () => {
    // 那个百分比是相对「容器宽 - 背景宽」算的，背景比容器宽时分母为负，
    // 一圈走的距离和平铺周期对不上，每圈结尾都要跳一下
    //（2026-08-11 用户原话：每次进行到最后一点总是抽搐一下）。
    const loader = read('src/components/ui/GenSweepLoader.tsx');
    expect(loader).not.toMatch(/animation:gen-sweep-move[\s\S]{0,200}background-position/);
    expect(loader).toMatch(/@keyframes gen-sweep-move\{from\{transform:translate3d/);
    // 两端都要完全移出容器，接缝才在画面外。
    expect(loader).toMatch(/translate3d\(-1[0-9]{2}%,0,0\)/);
    expect(loader).toMatch(/prefers-reduced-motion/);
  });

  it('【关键】透明裁剪必须接到画布上，不能只在导出时生效', () => {
    // 这条守卫是补上一次的漏：boundsToCanvasRect 建好了、单测全绿，却全仓无人调用
    // （形状 2：建了一半）。于是画布上每个部件仍是满幅方块，用户圈图指出「这才是
    // 非透明最小矩形」。判据必须盯住「产物真的被裁了」+「落位用的是包围盒」。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/trimLayerToContent\(/);
    expect(code).toMatch(/boundsToCanvasRect\(\{/);
    // 裁剪后的像素要作为新资产上传，否则画布框变小了、图还是满幅，会被压扁。
    expect(code).toMatch(/data:\s*trimmed\.dataUrl/);
    // 全透明层如实标注，不静默丢弃也不当普通层摆上去。
    expect(code).toMatch(/layerContentKind:\s*'empty' as const/);
  });
});

describe('读图必须带登录凭据', () => {
  const psd = read('src/lib/layeredPsd.ts');

  it('同源资产端点是 [Authorize] 的，两条 fetch 读像素的路都要带 token', () => {
    // 真机实测（2026-08-10）：裸 fetch 拿 401，分层判定静默失败，
    // 面板上「正在识别内容…」永远停着；导出 PSD 走同一条读图路径，同样会栽。
    expect(psd).toContain('export function readableImageFetchHeaders');
    expect(psd).toMatch(/fetch\(url,\s*\{\s*mode:\s*'cors',\s*headers:\s*readableImageFetchHeaders\(url\)\s*\}\)/);
    expect(read('src/lib/layerContentAnalysis.ts')).toMatch(/headers:\s*readableImageFetchHeaders\(url\)/);
  });

  it('只给同源地址加 Bearer，跨域外链不许带凭据', () => {
    expect(psd).toMatch(/if \(!sameOrigin\) return \{\};/);
  });
});

describe('画布持久化只许有一份实现', () => {
  it('页面从 lib 引入持久化函数，自己不再留一份拷贝', () => {
    const tab = read(TAB);
    expect(tab).toMatch(/canvasToPersistedV1[\s\S]{0,200}from '@\/lib\/visualAgentCanvasPersist'/);
    // 历史事故：页面里另有一份实现在跑，而单测跑的是 lib 那份，两份漂移到
    // lib 缺了图层显隐/次序等字段，「分层持久化」实际上从来没被测过。
    expect(tab).not.toMatch(/^function canvasToPersistedV1/m);
    expect(tab).not.toMatch(/^function persistedV1ToCanvas/m);
  });

  it('持久化写入与读回覆盖同一组图层字段（漏一个就是刷新后丢状态）', () => {
    const persist = read(PERSIST);
    for (const field of [
      'layerGroupId', 'layerSourceKey', 'layerIndex', 'layerRole',
      'layerHidden', 'layerOpacity', 'layerZ',
      'layerContentKind', 'layerCoverage', 'layerRequestedCount', 'userResized',
      // 原位（最小外接矩形）必须落盘：不存的话刷新后从「平铺」切回「原位」就放不回去了。
      'layerHomeX', 'layerHomeY', 'layerHomeW', 'layerHomeH',
      'layerModel', 'layerIntent',
    ]) {
      const writes = persist.match(new RegExp(`${field}[:,]`, 'g')) ?? [];
      expect(writes.length, `${field} 应同时出现在写入与读回两侧`).toBeGreaterThanOrEqual(2);
    }
  });
});
