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
  });

  it('【关键】拆分途中把 Frame 拖走，后到的图层要跟着走', () => {
    // 2026-08-11 用户实测：「在拆分进行时，我把正在渲染的拆分 frame 移动到了另一个地方，
    // 拆分的图层居然在最开始的 frame 位置渲染」。根因是落位坐标在开跑那一刻由
    // planLayeredCopyRect 定死，几十秒后到达的图层仍照着它落地。
    // 判据盯住「落位三处都读实时原点」——这条线断掉，纯函数单测一个都不会红（形状 2）。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).toMatch(/createLiveGroupOrigin\(groupId,\s*copyRect\)/);
    expect(code).toMatch(/const currentRect = \(\) => readLiveRect\(canvasRef\.current\)/);
    // 三处落位：铺占位卡、裁剪后回写、收尾对镜头。任一处漏掉都会把那一部分拽回原地。
    expect(code).toMatch(/planSemanticLayerFrame\(sourceItem,\s*count,\s*layerLayoutMode,\s*currentRect\(\)\)/);
    expect(code).toMatch(/const anchorRect = currentRect\(\);/);
    expect(code).toMatch(/const finalRect = currentRect\(\);/);
    // 回归钉子：copyRect 只许当种子，不许再直接拿去落位。
    expect(code).not.toMatch(/planSemanticLayerFrame\([^)]*copyRect\)/);
    expect(code).not.toMatch(/canvasX:\s*copyRect\./);
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

  it('【关键】等待动效循环走 transform，不许用 background-position 百分比', () => {
    // 那个百分比是相对「容器宽 - 背景宽」算的，背景比容器宽时分母为负，
    // 一圈走的距离和平铺周期对不上，每圈结尾都要跳一下
    //（2026-08-11 用户原话：每次进行到最后一点总是抽搐一下）。
    // 2026-08-30 两轮改版后判据仍是这一条：v1 的竖向显影带、v2 换回的 92% 宽斜向柔光，
    // 都必须用 transform 平移且两端完全移出容器。用户对 v1 的评价是「以前的版本更高级」，
    // 拆下来主因是表面太沉、动的那道太窄——但「怎么循环」这条从来没变过。
    const loader = read('src/components/ui/GenDevelopLoader.tsx');
    expect(loader).not.toMatch(/animation:gen-dev-sweep[\s\S]{0,200}background-position/);
    expect(loader).toMatch(/@keyframes gen-dev-sweep\{from\{transform:translate3d/);
    // 两端都要完全移出容器，接缝才在画面外（带宽 92%，−110% / 210% 两端都在画外）。
    expect(loader).toMatch(/translate3d\(-110%,0,0\)/);
    expect(loader).toMatch(/translate3d\(210%,0,0\)/);
    expect(loader).toMatch(/prefers-reduced-motion/);
  });

  it('【关键】等待态占位卡的边框只由 loader 画一次', () => {
    // 描边即进度，按屏幕像素恒定；调用方若再画一条世界坐标的 1px border，
    // 两条边低倍下会错开半像素、看着发毛，而且那条 border 在 30% 以下本来就已经看不见了。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const styleAt = code.indexOf("style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}");
    expect(styleAt, '等待态占位卡应自己不画底纱和边框，全部交给 loader').toBeGreaterThan(0);
    const running = code.slice(styleAt, styleAt + 900);
    expect(running).toContain('<GenDevelopLoader');
    expect(running).toMatch(/mode=\{it\.layerRole === 'layer' \? 'layer' : 'image'\}/);
    expect(running).not.toMatch(/border:\s*'1px solid/);
    // 尺寸/阶段/剩余时间合并进 loader 底边一行之后，调用方不许再自己摆反缩放标签，
    // 否则又回到「四件东西抢同一张卡」（PR #1458 打补丁的那个局面）。
    expect(running).not.toMatch(/scale\(var\(--invZoom\)\)/);
  });

  it('【关键】等待态与产物互斥，loader 永远不会压在已生成的图上', () => {
    // 底边那行的对比度判据是按「暗底纱 + 暗渐变」算的，前提是它下面**没有图**。
    // 一旦哪天 loader 和 <img> 能同时在场，那个前提就塌了，判据会变成不成立的证据
    //（判据纪律形状 8）。这里把互斥钉死在结构上。
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const at of [...code.matchAll(/<GenDevelopLoader/g)].map((m) => m.index ?? 0)) {
      const branch = code.slice(Math.max(0, at - 600), at);
      expect(branch, 'loader 必须挂在 status === \'running\' 这一支上').toMatch(/status === 'running' \?/);
    }
    // 产物分支读的是 it.src，且和 running 分支是同一条三元链上的不同支。
    expect(code).toMatch(/status === 'running' \?[\s\S]{0,2000}: it\.src \?/);
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

  it('【关键】三条读图路一条都不许漏掉取头函数', () => {
    // 原来只守住 loadImageData 与内容判定两条，导出前自检那条是裸 fetch，
    // 于是自检对每一层都报 401 不可读，而真正的导出其实是好的——自检比被检的还不准
    // （Codex PR #1363 P2）。判据改为「本文件里所有 fetch 都带 readableImageFetchHeaders」，
    // 这样以后新增第四条读图路漏了也会红（形状 3：判据分裂后各自漂移）。
    const bare = psd.split('\n').filter((line) => /\bfetch\(/.test(line) && !/readableImageFetchHeaders/.test(line));
    expect(bare, `这些 fetch 没带凭据：\n${bare.join('\n')}`).toEqual([]);
  });
});

describe('分层导出取满幅原件', () => {
  const tab = read(TAB);

  it('【关键】导出用满幅版，不是画布上那张裁剪版', () => {
    // 裁剪是给画布用的（好抓好拖）；导出链路按原图尺寸对齐叠放，喂裁剪版会被
    // 拉伸铺满整张画布。实测：覆盖 14% 的层在 PSD 里占到 1021x1024（Codex PR #1363 P1）。
    expect(tab).toMatch(/source: layer\.originalSrc \|\| layer\.src/);
    expect(tab).toMatch(/sha256: layer\.originalSha256 \|\| layer\.sha256/);
    // 裁剪时必须把满幅原件留下来，否则上面两行取到的还是裁剪版。
    expect(tab).toMatch(/originalSrc: asset\.url/);
    expect(tab).toMatch(/originalSha256: asset\.sha256/);
    // 还要落盘：不存的话刷新之后导出悄悄退回错的那版（snapshot-fallback）。
    // 这里不套用「数出现次数」那套启发式——持久化键 layerOriginalSrc 与运行时字段
    // originalSrc 名字不一样，计数会把「写了也读了」误判成漏读。直接分别断言两侧。
    const persist = read(PERSIST);
    expect(persist).toMatch(/layerOriginalSrc: it\.originalSrc/);
    expect(persist).toMatch(/layerOriginalSha256: it\.originalSha256/);
    expect(persist).toMatch(/originalSrc: typeof ext\.layerOriginalSrc === 'string'/);
    expect(persist).toMatch(/originalSha256: typeof ext\.layerOriginalSha256 === 'string'/);
  });

  it('【关键】现拆现导那条分支也取满幅——三个出口一个都不许漏', () => {
    // 这一条是上一版守卫漏掉的那个出口。上一版逐个列举「我知道的导出入口」，
    // 于是第三个入口（画布还没有图层时右键导出 → 先拆再导，吃的是 decomposeImageIntoFrame
    // 的返回值）一路全绿地喂着裁剪版（Codex PR #1363 P1 第二次指同一件事）。
    // 教训是守不变量、不守清单：凡是喂给 PSD 的层地址，一律必须是满幅那一版。
    expect(tab).toMatch(/layerSources\.push\(\{ name, source: asset\.url/);
    // 反向锁死：退回裁剪版就红。没有这一条，把上面那行改回去仍然全绿。
    expect(tab).not.toMatch(/source: trimmedAsset\?\.url/);
  });

  it('【关键】裁剪落位读的是「裁完那一刻」的组原点，不是裁之前的', () => {
    // 裁剪要解码整张图、裁完还要上传，这两拍之间用户完全可能把 Frame 拖走。
    // 组原点若在 await 之前读，这一层就按拖走之前的坐标落位——和用户报的
    // 「拖走了图层还回原位渲染」同一个症状，只是窗口更窄（Codex PR #1363 P2）。
    // 判据是源码顺序：读原点必须排在裁剪那次 await 之后。
    const trimAwait = tab.indexOf('await trimLayerToContent(');
    const readOrigin = tab.indexOf('const anchorRect = currentRect();');
    expect(trimAwait).toBeGreaterThan(0);
    expect(readOrigin).toBeGreaterThan(0);
    expect(readOrigin).toBeGreaterThan(trimAwait);
  });

  it('【关键】编辑产物要继承 frameId，否则它不算 Frame 成员', () => {
    // 编组身份只认 frameId（layerGroupId 兜底已去掉，否则解组后刷新会复活）。
    // 少带这一个字段，编辑产物在画布上看得见，Frame 导出与包围盒却仍按原图层算。
    expect(tab).toMatch(/frameId: sourceItem\.frameId,\s*\n\s*layerGroupId: sourceItem\.layerGroupId/);
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

describe('上传落位：只新增、不替换，且贴着锚点对齐', () => {
  const tab = read(TAB);
  const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  it('【关键】上传永远是新增，选中态不再吞掉用户原来那张图', () => {
    // 2026-08-31 用户原话：「选中图上传不要替换了，而是新增一张新的图」，并把旧行为
    // 判成「原始需求的问题很大，有很大的 bug」——选中一张图再拖一张进来，原图当场消失、
    // 无法撤销，用户根本没表达过「替换」的意图。
    expect(code, '替换分支已整条退场').not.toContain('已替换当前选中图片');
    // mode 选项曾经是替换的开关（'auto' 命中单图 + 单选就替换）；替换没了它也不该留，
    // 否则下一个人会以为还有一条替换路径可走。
    expect(code).toMatch(/const onUploadImages = async \(files: File\[\]\) => \{/);
    expect(code).not.toMatch(/mode\?: 'auto' \| 'add'/);
  });

  it('【关键】对齐落位真的接进了上传路径，不是一个没人调的模块', () => {
    // 形状 2：新建的判定函数最容易「建了一半」——模块写好、单测全绿、没有任何人 import。
    expect(code).toMatch(/findAlignedFreeTopLeft[\s\S]{0,160}from '@\/lib\/canvasPlacement'/);
    const at = code.indexOf('const aligned = anchor ? findAlignedFreeTopLeft(');
    expect(at, '上传落位应先试对齐位').toBeGreaterThan(0);
    const near = code.slice(at, at + 700);
    // 对齐位取不到时必须退回最近空位，不许硬塞一个重叠位置。
    expect(near).toMatch(/aligned \?\? findNearestFreeTopLeft\(/);
    // 链式：下一张贴着上一张，多张一次上传排成一行而不是各找各的空格。
    expect(near).toMatch(/anchor = \{ x: pos\.x, y: pos\.y, w, h \}/);
  });

  it('【关键】锚点取的是选中项的真实坐标，选多张/无坐标时不硬凑', () => {
    const at = code.indexOf('let anchor: PlacementRect | null =');
    expect(at, '锚点应从选中项算出').toBeGreaterThan(0);
    const near = code.slice(at, at + 420);
    expect(near).toMatch(/selectedKeys\.length !== 1/);
    expect(near).toMatch(/typeof x !== 'number' \|\| typeof y !== 'number'/);
    expect(near).toMatch(/if \(!w \|\| !h\) return null;/);
  });
});

describe('生成中的占位卡不许被系统自动选中', () => {
  it('【关键】任何 status: \'running\' 的占位卡后面都不许跟一个自动选中', () => {
    // 2026-08-31 用户看着一张正在生成的卡说「这三个边框给用户感觉就挺累的，
    // 我倾向于只显示 #D97757 的」——三条线是：蓝色选择框、灰色底轨、赤陶进度弧。
    // 底轨在 loader 里删掉了；蓝框则是因为生成一开始就把占位卡自动选中了。
    // 那是系统替用户做的决定：他选的是参考图，没说要选这张还没画出来的。
    // 三条生成路径各写了一份自动选中，所以判据扫全文件，不盯某一处。
    const tab = read(TAB);
    const code = tab.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const runningAt = [...code.matchAll(/status: 'running'/g)].map((m) => m.index!);
    expect(runningAt.length, '至少应扫到几处占位卡创建').toBeGreaterThanOrEqual(2);
    for (const at of runningAt) {
      const after = code.slice(at, at + 700);
      expect(
        after,
        `第 ${at} 处占位卡后面跟了自动选中——生成中的卡不许被系统选中`
      ).not.toMatch(/set(Selection|SelectionWithoutChip|SelectedKeys)\(\[/);
    }
  });

  it('【关键】画框上只有 #D97757 一种颜色，没有灰色底轨', () => {
    const loader = read('src/components/ui/GenDevelopLoader.tsx');
    expect(loader, '灰色底轨已退场').not.toContain('gen-dev__track');
    expect(loader, '底轨的 token 也一起退场').not.toContain('--gen-wait-track');
    // 头是同色提亮，不是奶白——奶白会被读成「另一个东西」，而它只是这条线的头。
    const tokens = read('src/styles/tokens.css');
    expect(tokens).toMatch(/--gen-wait-head:\s*#[0-9A-Fa-f]{6};/);
    expect(tokens).not.toMatch(/--gen-wait-track:/);
  });
});

describe('首页背景：素材来源与浅色主题的两条接线', () => {
  const LATENT = 'src/components/effects/LatentField.tsx';
  const PAGE = 'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx';
  const GLOBALS = 'src/styles/globals.css';

  it('浅色主题整层隐藏背景照片——class 和 CSS 规则必须同时在，缺一层就静默失效', () => {
    // 形状 8：一处声明看着有，另一处没接上，页面照常渲染、测试照常绿，
    // 只有真人在浅色下打开才发现整页糊成一片灰。两边都断言。
    //
    // 断言前先剥注释：第一版直接 toContain，结果**解释这条规则的那句注释**自己就把断言喂饱了
    // ——把 className 删掉测试照样绿（形状 4a：断言的是字面存在，不是行为）。
    const latent = read(LATENT).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(latent).toContain('className="backdrop-photo-layer"');
    // 剥注释这一步本身也要有判据：剥完还得剩下真实代码，否则正则写坏了会把整份源码吃掉，
    // 上面那条断言就永远失败——那是另一种坏（假红），同样得拦。
    expect(latent).toContain('export function BackdropPhoto');

    // 规则可能是「A, B { display:none }」的并列选择器，所以取整条规则再逐个查，
    // 不假设 class 后面紧跟着 {（第一版正是这么写的，一加并列选择器就假红）。
    const rule = read(GLOBALS).match(/\[data-theme="light"\][^{]*\{[^}]*display:\s*none[^}]*\}/);
    expect(rule?.[0]).toContain('.backdrop-photo-layer');
    // 印相台里那一格照片同理：近黑素材落在奶白纸上是一团脏，两处都得关。
    expect(rule?.[0]).toContain('.plate__photo');
  });

  it('背景素材取随包清单，不再取项目封面（白底产品图压暗后整页变平灰）', () => {
    const page = read(PAGE);
    expect(page).toContain('BACKDROP_CATALOG');
    // coverAssets 仍用于项目卡的封面拼图，但不许再流进背景池。
    const backdropBlock = page.slice(page.indexOf('const backdropAssets'), page.indexOf('const backdrop ='));
    expect(backdropBlock).not.toContain('coverAssets');
  });

  it('暗罩强度按素材来源分档，不是所有图共用一个写死的值', () => {
    // 随包素材本来就暗、用户生成的深浅不可控，共用一个值必然有一头是错的。
    expect(read(PAGE)).toMatch(/<BackdropPhoto[^/]*dim=\{dimFor\(/s);
  });
});
