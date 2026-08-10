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
    ]) {
      const writes = persist.match(new RegExp(`${field}[:,]`, 'g')) ?? [];
      expect(writes.length, `${field} 应同时出现在写入与读回两侧`).toBeGreaterThanOrEqual(2);
    }
  });
});
