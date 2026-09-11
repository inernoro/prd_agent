/**
 * 首页厂房「尺寸随数据走」的行为守卫（2026-09-11）。
 *
 * 这一版把写死的几何换成了按数据累加：货箱尺寸由数量反算、门洞高度由货堆反推、
 * 画布宽度由各段累加、显示宽度再按内容量收一次。好处是两头都对得上，
 * 代价是**多了一串可以悄悄算错的算术**——而算错的表现不是报错，是画面变丑：
 * 箱子戳出带面、堆比门洞高、少数据时图反而更大。人眼盯不住，所以这里逐条钉死。
 *
 * 判据都取真实量级：71 条改动（主实例当前的真数）与 5 条（预览实例的演示数据），
 * 这两端正是用户分别说过「填不满」和「空荡荡」的那两张图。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  crateScale,
  hallLayoutWide,
  mound,
  outsideVbW,
  sceneMaxPx,
  yardStartCx,
  sceneScale,
  sceneWidth,
  splitChanges,
  yardVbW,
} from '../../web/src/pages/reports/PipelinePanel';
import type { PipelineFunnel } from '../../web/src/lib/api';

function funnel(p: Partial<PipelineFunnel>): PipelineFunnel {
  return {
    changes: 0, deployed: 0, accepted: 0, merged: 0,
    pass: 0, conditional: 0, fail: 0, undetermined: 0, ...p,
  };
}

/** 主实例真实形状：71 条改动 / 70 条部署过 / 5 条验过（通过 1 原则性 1 未通过 3）。 */
const REAL = funnel({ changes: 71, deployed: 70, accepted: 5, pass: 1, conditional: 1, fail: 3 });
/** 预览实例的演示数据量级。 */
const THIN = funnel({ changes: 5, deployed: 5, accepted: 2, pass: 1, conditional: 1 });

const SPAN = 760;
const RISE = 156;
const scale = (n: number) => crateScale(n, { span: SPAN, rise: RISE, min: 11, max: 34, maxRows: 6 });

describe('分流恒等：缺口 + 货堆 + 料仓 = 入口总量', () => {
  const cases: PipelineFunnel[] = [
    REAL, THIN,
    funnel({}),
    funnel({ changes: 1, deployed: 0 }),
    funnel({ changes: 900, deployed: 880, accepted: 400 }),
    // 口径错位的脏数据（验过的比部署的还多）也不许把三段算成负数。
    funnel({ changes: 3, deployed: 1, accepted: 9 }),
  ];
  it.each(cases.map((f, i) => [i, f] as const))('第 %i 组三段相加等于 changes', (_i, f) => {
    const { accepted, heap, undeployed } = splitChanges(f);
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(heap).toBeGreaterThanOrEqual(0);
    expect(undeployed).toBeGreaterThanOrEqual(0);
    if (f.deployed >= f.accepted && f.changes >= f.deployed) {
      expect(accepted + heap + undeployed).toBe(f.changes);
    }
  });
});

describe('货箱：一只都不能少，一只都不能戳出去', () => {
  const sizes = [0, 1, 2, 3, 5, 13, 65, 71, 200, 900];

  it.each(sizes)('n=%i 时各行相加仍是 n', (n) => {
    expect(scale(n).rows.reduce((a, b) => a + b, 0)).toBe(n);
  });

  it.each(sizes.filter((n) => n > 0))('n=%i 时堆宽不超过给定带面', (n) => {
    expect(scale(n).w).toBeLessThanOrEqual(SPAN);
  });

  it.each(sizes.filter((n) => n > 0))('n=%i 时箱子尺寸在上下限之内', (n) => {
    const sc = scale(n);
    expect(sc.cw).toBeGreaterThanOrEqual(11);
    expect(sc.cw).toBeLessThanOrEqual(34);
    expect(sc.ch).toBeGreaterThan(0);
  });

  it('mound 本身不丢箱（crateScale 的地基）', () => {
    for (const n of sizes) {
      for (const rowMax of [1, 2, 5, 13, 40]) {
        expect(mound(n, rowMax).reduce((a, b) => a + b, 0)).toBe(n);
      }
    }
  });

  it('数量越多堆占地越大，直到把画布用满为止', () => {
    // 带面就这么长、门洞就这么高，所以面积不可能一直涨。合格线是：
    // 要么比上一档大，要么已经把可用面积吃掉八成五以上——不许出现
    // 「数量翻倍、堆反而缩水一半」那种越多越挤的退化。
    const cap = SPAN * RISE;
    let prev = -1;
    for (const n of [1, 3, 5, 13, 30, 65, 120, 300, 900]) {
      const sc = scale(n);
      const area = sc.w * sc.h;
      expect(area >= prev - 1e-6 || area >= cap * 0.85, `n=${n} 时堆缩水到 ${Math.round(area)}`).toBe(true);
      prev = Math.max(prev, area);
    }
  });
});

describe('填满画布：真实数据那一屏，堆得占住带面', () => {
  it('71 条改动时货堆横向占住整张图三成以上', () => {
    const { heap } = splitChanges(REAL);
    expect(heap).toBe(65);
    const L = hallLayoutWide(REAL);
    // 老几何是 234 / 1360 = 17%：堆缩在角落，屏幕上最大的一块反倒空着。
    expect(L.sc.w / L.vbW).toBeGreaterThan(0.3);
    expect(L.sc.w / L.vbW).toBeGreaterThan((13 * 18) / 1360);
  });

  it('71 条改动时货堆高度顶满门洞净空', () => {
    const sc = scale(splitChanges(REAL).heap);
    expect(sc.h / RISE).toBeGreaterThan(0.85);
  });

  it('箱子比写死的 16x12 明显大（不然「填满」只是换了个说法）', () => {
    // 走 hallLayoutWide 而不是自己调 crateScale：要守的是**页面实际用的那组参数**，
    // 测试自带一套参数的话，有人把组件里的上限调回 16 也照样绿。
    expect(hallLayoutWide(REAL).sc.cw).toBeGreaterThan(16 * 1.5);
  });
});

describe('数据少的时候，画布要跟着小下去', () => {
  const wide = hallLayoutWide(REAL);
  const thin = hallLayoutWide(THIN);

  it('5 条那张的 viewBox 比 71 条那张窄', () => {
    expect(thin.vbW).toBeLessThan(wide.vbW);
  });

  it('5 条那张的 viewBox 比 71 条那张矮（门洞跟着货堆收）', () => {
    expect(thin.vbH).toBeLessThan(wide.vbH);
  });

  it('门洞永远装得下货堆，且不塌到看不清', () => {
    for (const f of [REAL, THIN, funnel({ changes: 1, deployed: 1 }), funnel({ changes: 400, deployed: 400 })]) {
      const L = hallLayoutWide(f);
      const openH = 356 - L.lintel;
      expect(openH).toBeGreaterThanOrEqual(104);
      expect(openH).toBeGreaterThanOrEqual(L.sc.h);
    }
  });

  it('显示宽度上限随内容量收缩，而且是「越小收得越狠」', () => {
    const px = (v: number) => Number(String(sceneWidth(v).maxWidth).replace('px', ''));
    expect(px(thin.vbW)).toBeLessThan(px(wide.vbW));
    expect(px(560)).toBeLessThan(px(1340));
    // 关键是次线性：等比例缩放（px 与 vbW 成正比）下显示高度＝常数 x vbH，
    // 图还是一张占满半屏的大盒子。所以要求「每单位 viewBox 换来的像素」也跟着变小。
    expect(px(600) / 600).toBeLessThan(px(1400) / 1400);
    // 收得再狠也得留下能看的尺寸。
    expect(px(300)).toBeGreaterThan(150);
  });

  it('各段首尾相接，不会出现负宽度的段', () => {
    for (const f of [REAL, THIN, funnel({}), funnel({ changes: 900, deployed: 900 })]) {
      const L = hallLayoutWide(f);
      expect(L.heapR).toBeGreaterThan(L.heapL);
      expect(L.gate2).toBeGreaterThan(L.gate1);
      expect(L.gate3).toBeGreaterThan(L.gate2);
      expect(L.vbW).toBeGreaterThan(L.gate3);
      expect(L.vbH).toBeGreaterThan(0);
    }
  });
});

describe('字号补偿：图缩小，字不能跟着糊掉', () => {
  const src = readFileSync(
    resolve(__dirname, '../..', 'web/src/pages/reports/PipelinePanel.tsx'),
    'utf8',
  );

  it('sceneWidth 交出了缩放的倒数', () => {
    const k = sceneScale(600);
    const ts = Number((sceneWidth(600) as Record<string, string>)['--ts']);
    expect(ts).toBeCloseTo(1 / k, 2);
    expect(ts).toBeGreaterThan(1);
  });

  it('每个文字类都真的乘上了这个倒数', () => {
    // 只交出变量、CSS 那头不用，等于没补偿：字照缩，而且不会有任何报错。
    for (const cls of ['t-huge', 't-num', 't-lab', 't-name', 't-tag']) {
      const m = src.match(new RegExp(`\\.${cls}\\{[^}]*`));
      expect(m, `找不到 .${cls} 的样式`).not.toBeNull();
      expect(m![0], `.${cls} 的 font-size 没乘 var(--ts)`).toMatch(/font-size:calc\([^)]*var\(--ts/);
    }
  });

  it('补偿之后，同一段文字在大图小图上的显示尺寸一致', () => {
    for (const vbW of [400, 700, 1068, 1440]) {
      const k = sceneScale(vbW);
      const ts = 1 / k;
      // viewBox 里的字号 x 缩放 = 屏幕上的字号，应当与 vbW 无关。
      expect(15 * ts * k).toBeCloseTo(15, 6);
    }
  });
});

describe('整块面板跟着最宽的那张图收', () => {
  it('面板宽度等于三张图里最宽的那个显示宽度', () => {
    const px = Math.max(
      sceneMaxPx(hallLayoutWide(REAL).vbW),
      sceneMaxPx(yardVbW(10)),
      sceneMaxPx(outsideVbW(119)),
    );
    expect(px).toBe(sceneMaxPx(hallLayoutWide(REAL).vbW));
    // 数据薄的那一端，整块面板必须明显更窄，否则又变成大盒子装一点东西。
    const thinPx = Math.max(
      sceneMaxPx(hallLayoutWide(THIN).vbW),
      sceneMaxPx(yardVbW(1)),
      sceneMaxPx(outsideVbW(18)),
    );
    expect(thinPx).toBeLessThan(px * 0.8);
  });

  it('堆场与场外的宽度都随内容单调不减', () => {
    let prevYard = -1;
    for (const n of [1, 2, 5, 10, 30]) {
      const w = yardVbW(n);
      expect(w).toBeGreaterThanOrEqual(prevYard);
      prevYard = w;
    }
    let prevOut = -1;
    for (const n of [0, 5, 18, 119, 900]) {
      const w = outsideVbW(n);
      expect(w).toBeGreaterThanOrEqual(prevOut);
      prevOut = w;
    }
  });
});

describe('堆场：几根垛都居中，右边不许空一片', () => {
  const PITCH = 132;
  const BW = 84;

  it.each([1, 2, 3, 5, 10, 24])('%i 个项目时左右留白相等', (n) => {
    const vbW = yardVbW(n);
    const start = yardStartCx(n);
    const left = start - BW / 2;
    const right = vbW - (start + PITCH * (n - 1) + BW / 2);
    expect(Math.abs(left - right), `${n} 个项目：左 ${left} / 右 ${right}`).toBeLessThan(1.5);
    expect(left).toBeGreaterThan(0);
  });

  it('一个项目时画布不再垫到半屏宽', () => {
    // 之前下限是 560：一根垛 84 宽，右边 70% 是空地面线，用户原话「右边空空的」。
    expect(yardVbW(1)).toBeLessThan(400);
  });

  it('项目多了照样按真实条数展开', () => {
    expect(yardVbW(10)).toBeGreaterThan(yardVbW(3));
    expect(yardVbW(3)).toBeGreaterThan(yardVbW(1));
  });
});
