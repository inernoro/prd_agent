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
    expect(tab).toMatch(/layerCoverage:\s*verdict\.stats\.coverage/);
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
