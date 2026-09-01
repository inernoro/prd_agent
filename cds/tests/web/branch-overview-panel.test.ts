import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 总览面板（2026-09-01 视觉化重排）的三条守卫。
 *
 * 三条都属于「改坏了照样编译、照样渲染、通读也挑不出」的那一类，只有真人盯着
 * 看五秒才发现，所以必须机械钉住（predicate-and-wiring-discipline）。
 */

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const PANEL = fs.readFileSync(path.join(SRC, 'components/branch/OverviewPanel.tsx'), 'utf8');
const DRAWER = fs.readFileSync(path.join(SRC, 'components/BranchDetailDrawer.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

describe('总览面板接线（形状 2：建了一半不会红）', () => {
  it('抽屉真的在渲染 OverviewPanel，不是只 import 不用', () => {
    expect(DRAWER).toContain("from '@/components/branch/OverviewPanel'");
    expect(DRAWER).toMatch(/<OverviewPanel\s/);
  });

  it('旧的八方块与「每服务一张大卡」已经删掉，不是新旧并存', () => {
    expect(DRAWER).not.toContain('OverviewTile');
    // 旧监控面板整块搬走后，抽屉里不该再留 ServiceMetricCard / Sparkline 这套
    expect(DRAWER).not.toMatch(/function\s+ServiceMetricCard\s*\(/);
    expect(DRAWER).not.toMatch(/function\s+Sparkline\s*\(/);
  });

  it('入口卡只有一处（原先抽屉头部与总览计数各说各话）', () => {
    expect(DRAWER).not.toContain('应用已上线');
    expect(PANEL).toContain('function EntryCards');
  });
});

describe('系列色跟实体走，不跟名次走', () => {
  /**
   * 真实缺陷的回归：第一版按当前 CPU 排名选取并赋色，指标每 5s 刷一次，
   * 两个服务用量一接近，颜色 / 图例列序 / 堆叠层序就跟着名次来回换——
   * 同一个服务这一秒橙色下一秒蓝色，图一直在抖，也没法拿颜色认服务。
   */
  it('排序判据是服务名字典序，不是用量', () => {
    expect(PANEL).toContain('a.svc.profileId.localeCompare(b.svc.profileId)');
    const pickedBlock = PANEL.slice(PANEL.indexOf('const picked = useMemo'), PANEL.indexOf('const sampleCount'));
    expect(pickedBlock).not.toMatch(/sort\([^)]*ring\.cpu/);
    expect(pickedBlock).not.toMatch(/sort\([^)]*ring\.mem/);
  });

  it('色位固定五档、不循环；第 6 个及以后并入「其他」', () => {
    expect(PANEL).toContain('const SERIES_SLOTS = 5');
    expect(PANEL).toContain('其他');
    // 取模循环会让第 6 个服务和第 1 个撞成同一个色
    expect(PANEL).not.toMatch(/SERIES_SLOTS\s*\]/);
    expect(PANEL).not.toMatch(/%\s*SERIES_VARS\.length/);
  });

  it('语义四色不参与系列配色（否则「第 4 个服务」会跟「警告」撞色）', () => {
    const seriesDef = PANEL.slice(PANEL.indexOf('const seriesColor'), PANEL.indexOf('const seriesColor') + 200);
    for (const status of ['--ok', '--warn', '--bad', '--info']) {
      expect(seriesDef).not.toContain(status);
    }
  });
});

describe('系列色 token 两个主题都定义', () => {
  it('--series-1..5 各出现两次（dark 一次、light 一次）', () => {
    for (let i = 1; i <= 5; i += 1) {
      const count = (CSS.match(new RegExp(`--series-${i}:`, 'g')) || []).length;
      expect(count, `--series-${i} 应在 dark 与 light 各定义一次，实际 ${count} 次`).toBe(2);
    }
  });

  it('图表用的是 token，不是写死的十六进制', () => {
    expect(PANEL).toContain('hsl(var(--series-');
    // 面积 / 图例色条不许出现裸 hex
    expect(PANEL.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  });
});

describe('内存按绝对值展示（百分比在没配 mem_limit 的机器上恒为 0）', () => {
  it('环形缓冲存了绝对字节', () => {
    expect(PANEL).toContain('memBytes');
    expect(DRAWER).toContain('stats.memUsedBytes');
  });

  it('脚注解释了为什么不给百分比', () => {
    expect(PANEL).toContain('mem_limit');
  });
});
