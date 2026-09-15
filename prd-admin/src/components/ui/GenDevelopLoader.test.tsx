import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenDevelopLoader, GLOBAL_CSS, HEAD_LEN, framePath, metaLevel, phaseOf } from './GenDevelopLoader';

const EST_MS = 40_000; // getGenAvgMs 的首样本兜底

/** 组件不写死颜色，取值都在 tokens.css，所以要断言取值就得去那里读。 */
const TOKENS = readFileSync(resolve(__dirname, '../../styles/tokens.css'), 'utf8');
function readToken(name: string): string {
  const hits = [...TOKENS.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  expect(hits.length, `tokens.css 里找不到 ${name}`).toBeGreaterThan(0);
  return hits[hits.length - 1][1].trim(); // 后写的赢
}

describe('metaLevel：底边一行按屏幕尺寸逐段脱落', () => {
  it.each([
    [420, 420, 'full'],
    [240, 120, 'full'],
    [239, 400, 'phase'],
    [160, 88, 'phase'],
    [159, 400, 'time'],
    [96, 56, 'time'],
    [95, 400, 'pip'],
    [400, 55, 'pip'],
    [0, 0, 'pip'],
  ])('%s×%s → %s', (w, h, expected) => {
    expect(metaLevel(w, h)).toBe(expected);
  });

  it('区间是半开且连续的：任何尺寸只落进一档，不靠「窄的优先」这种默认约定', () => {
    // 240/160/96 三个断点各取两侧一像素，确认没有空档也没有重叠。
    for (const [w, h] of [[240, 120], [239, 120], [160, 88], [159, 88], [96, 56], [95, 56]]) {
      expect(['full', 'phase', 'time', 'pip']).toContain(metaLevel(w, h));
    }
    expect(metaLevel(240, 120)).not.toBe(metaLevel(239, 120));
    expect(metaLevel(160, 88)).not.toBe(metaLevel(159, 88));
    expect(metaLevel(96, 56)).not.toBe(metaLevel(95, 56));
  });
});

describe('phaseOf：告诉用户现在在做什么，不只是等了几秒', () => {
  it.each([
    [0, '排队中'],
    [4, '构图'],
    [22, '显影'],
    [70, '收尾'],
  ])('进度 %s%% → %s', (pct, expected) => {
    expect(phaseOf(pct, false, 'image')).toBe(expected);
  });

  it('超时压过一切阶段词', () => {
    expect(phaseOf(95, true, 'image')).toBe('即将完成');
    expect(phaseOf(0, true, 'image')).toBe('即将完成');
  });

  it('分层模式恒为「图层分离中」，不套用生图的阶段词', () => {
    expect(phaseOf(0, false, 'layer')).toBe('图层分离中');
    expect(phaseOf(80, true, 'layer')).toBe('图层分离中');
  });
});

describe('framePath：从正上方出发顺时针合拢的圆角矩形', () => {
  it('起点与终点都在上边中点，四个角各一段弧', () => {
    const d = framePath(420, 420, 16);
    expect(d.startsWith('M 210 1')).toBe(true);
    expect(d.endsWith('H 210')).toBe(true);
    expect(d.match(/ A /g)).toHaveLength(4);
    // sweep-flag 恒为 1：y 轴向下的坐标系里，这才是顺时针。
    expect(d.match(/A 16 16 0 0 1 /g)).toHaveLength(4);
  });

  it('画框内缩到选择框里侧——否则卡片一选中，进度就整个看不见了', () => {
    // 选择框是 max(2, 4 * invZoom) 世界像素的描边，屏幕上约 4~6px，贴边画的画框会被它整个盖住。
    const inset = framePath(420, 420, 10, 12);
    expect(inset.startsWith('M 210 12')).toBe(true);
    // 右上角那段弧的终点落在 (x1, y0+r) = (408, 22)：四条边整体内缩 12。
    expect(inset).toContain('A 10 10 0 0 1 408 22');
    expect(inset.endsWith('H 210')).toBe(true);
  });

  it('极窄卡片上圆角自动收敛，不会画出自相交的路径', () => {
    const d = framePath(20, 400, 16);
    // r 被 w/2-1 夹住，否则左右两段弧会越过中线交叉。
    expect(d).toContain('A 9 9 0 0 1');
    expect(d).not.toContain('A 16 16');
  });
});

describe('GenDevelopLoader 渲染', () => {
  const render = (props: Parameters<typeof GenDevelopLoader>[0]) =>
    renderToStaticMarkup(<GenDevelopLoader {...props} />);

  it('大卡片给全量三段：尺寸 · 阶段 · 剩余时间', () => {
    const html = render({
      createdAt: Date.now() - 12_000,
      screenW: 420,
      screenH: 420,
      worldW: 1024,
      worldH: 1024,
      sizeLabel: '1024 × 1024',
    });
    expect(html).toContain('1024 × 1024');
    expect(html).toContain('显影');
    expect(html).toContain('还需约 28s');
  });

  it('中等卡片先丢尺寸段（Frame 头部本来就写着尺寸）', () => {
    const html = render({
      createdAt: Date.now() - 12_000,
      screenW: 200,
      screenH: 200,
      worldW: 1024,
      worldH: 1024,
      sizeLabel: '1024 × 1024',
    });
    expect(html).not.toContain('1024 × 1024');
    expect(html).toContain('显影');
    expect(html).toContain('还需约 28s');
  });

  it('小卡片只剩剩余时间', () => {
    const html = render({ createdAt: Date.now() - 12_000, screenW: 120, screenH: 120, sizeLabel: '1024 × 1024' });
    expect(html).not.toContain('显影');
    expect(html).toContain('还需约 28s');
  });

  it('最小档只剩一个点和画框，但那个点必须还在', () => {
    const html = render({ createdAt: Date.now() - 12_000, screenW: 60, screenH: 60, worldW: 1024, worldH: 1024 });
    expect(html).not.toContain('还需约');
    expect(html).toContain('gen-dev__pip');
    // 画框是唯一一个任何尺寸都不退场的进度载体。
    expect(html).toContain('gen-dev__arc');
  });

  it('超时翻成琥珀色并改说「已 Ns」，不再假装还在倒计时', () => {
    const html = render({
      createdAt: Date.now() - (EST_MS + 8_000),
      screenW: 420,
      screenH: 420,
      worldW: 1024,
      worldH: 1024,
    });
    expect(html).toContain('即将完成');
    expect(html).toContain('已 48s');
    expect(html).toContain('gen-dev__arc--over');
  });

  it('进度封顶 95%：出图替换占位才算 100%，不做「卡 93%」式假精确', () => {
    const html = render({
      createdAt: Date.now() - 10 * EST_MS,
      screenW: 420,
      screenH: 420,
      worldW: 1024,
      worldH: 1024,
    });
    // dashoffset = 100 - pct，封顶后恒为 5。
    expect(html).toContain('stroke-dashoffset="5"');
    expect(html).not.toContain('stroke-dashoffset="0"');
  });

  it('分层模式在**任何**缩放档都留着 frame-layering-badge 钩子', () => {
    // scripts/smoke/visual-layering.mjs 要求这个钩子每一档都在场，缺席即判红
    //（缺了那一档等于没测重叠）。底边一行整体收起时也不能把它一起收掉。
    for (const [screenW, screenH] of [[420, 420], [200, 200], [120, 120], [40, 40]]) {
      const html = render({ createdAt: Date.now(), screenW, screenH, worldW: 1024, worldH: 1024, mode: 'layer' });
      expect(html, `${screenW}×${screenH} 缺少分层钩子`).toContain('data-testid="frame-layering-badge"');
    }
  });

  it('内缩量按屏幕像素给，且不许把画框缩成卡中央的小盒子', () => {
    // 7/zoom 在极低缩放下会大到离谱，所以按卡片尺寸 6% 封顶。
    const big = render({ createdAt: Date.now(), screenW: 360, screenH: 360, worldW: 1024, worldH: 1024 });
    const tiny = render({ createdAt: Date.now(), screenW: 51, screenH: 51, worldW: 1024, worldH: 1024 });
    // 360px 屏幕宽 → zoom 0.352 → 内缩 7/0.352 ≈ 19.9 世界像素（未触顶）。
    expect(big).toMatch(/d="M 512 19\.\d/);
    // 51px 屏幕宽 → 7/0.0498 = 140 会触 6% 上限 61.44。
    expect(tiny).toMatch(/d="M 512 61\.44/);
  });

  it('非画布宿主（不传屏幕尺寸）按全量显示', () => {
    const html = render({ createdAt: Date.now() - 12_000, sizeLabel: '1024 × 1024', worldW: 800, worldH: 600 });
    expect(html).toContain('1024 × 1024');
    expect(html).toContain('显影');
  });
});

describe('动效声明纪律', () => {
  it('动画只写在样式表里，不写进 inline style', () => {
    // inline 声明压过作者样式表，@media (prefers-reduced-motion) 里的 animation:none
    // 会被静默无视——那是一条看着有、其实从不生效的无障碍逃生门。
    const html = renderToStaticMarkup(
      <GenDevelopLoader createdAt={Date.now()} screenW={420} screenH={420} worldW={1024} worldH={1024} />,
    );
    expect(html).not.toMatch(/style="[^"]*animation/);
    expect(GLOBAL_CSS).toContain('@media (prefers-reduced-motion:reduce)');
    expect(GLOBAL_CSS).toMatch(/\.gen-dev__glare\{[^}]*animation:gen-dev-sweep/);
  });

  it('画框上只有一处光，且它就钉在进度的最前端', () => {
    // 用户看着上一版直接问「两根光柱分别代表什么意思」：那时画框上有两处等亮等粗的光——
    // 进度描边的头，和一颗独立绕圈的光点。一个画框只该有一个光，它的位置就是进度。
    expect(GLOBAL_CSS, '独立绕圈的那颗光点已退场').not.toContain('gen-dev__runner');
    expect(GLOBAL_CSS, '位移动画一起退场，头不许自己跑').not.toContain('gen-dev-run ');
    // 头靠呼吸活着（进度一秒才走 2%，肉眼近乎静止），不靠位移。
    expect(GLOBAL_CSS).toMatch(/\.gen-dev__head\{[^}]*animation:gen-dev-pulse/);
    expect(GLOBAL_CSS).toMatch(/@keyframes gen-dev-pulse\{[^}]*opacity/);
  });

  it('头部的 dash 相位跟着进度走，而不是一个常数', () => {
    // 判据必须能分辨「真的贴在描边前端」和「碰巧画了一小段」：两个不同进度渲染出来的
    // dashoffset 必须不同，且差值恰好等于进度差。常数相位会让它退化成静止的装饰。
    const html = (elapsedSec: number) =>
      renderToStaticMarkup(
        <GenDevelopLoader
          createdAt={Date.now() - elapsedSec * 1000}
          screenW={420}
          screenH={420}
          worldW={1024}
          worldH={1024}
        />,
      );
    const offsetOf = (h: string) => {
      const m = /class="gen-dev__head"[^>]*stroke-dashoffset="([\d.]+)"/.exec(h);
      expect(m, 'gen-dev__head 必须在场并带 stroke-dashoffset').toBeTruthy();
      return Number(m![1]);
    };
    const pctOf = (h: string) => {
      const m = /class="gen-dev__arc[^"]*"[^>]*stroke-dashoffset="([\d.]+)"/.exec(h);
      return 100 - Number(m![1]);
    };
    const a = html(10);
    const b = html(40);
    expect(offsetOf(a) - offsetOf(b)).toBeCloseTo(pctOf(b) - pctOf(a), 6);
    expect(offsetOf(a)).not.toBe(offsetOf(b));
    // dash 周期恒为 100，offset 才能与进度线性对应。
    expect(a).toContain(`stroke-dasharray="${HEAD_LEN} ${100 - HEAD_LEN}"`);
  });

  it('动的只有一件大而慢的东西：斜向柔光，两端移出容器', () => {
    // 「高级」的来源是一件大而慢的东西在动、别的都不抢戏，不是层数多。
    // v1 叠了两级潜像马赛克 + 暗角 + 竖向窄带，九层堆一起就从「轻」掉到「厚」。
    // 宽度从 92% 收到 58%：铺满整张卡的那一版看着是均匀一层雾，读不出「有东西在走」。
    expect(GLOBAL_CSS).toMatch(/\.gen-dev__glare\{[^}]*width:58%/);
    expect(GLOBAL_CSS).toMatch(/@keyframes gen-dev-sweep\{from\{transform:translate3d\(-110%,0,0\)\}/);
    expect(GLOBAL_CSS).toContain('translate3d(210%,0,0)');
    // 退场的那几层不许悄悄回来。
    // 注：gen-dev-breathe 这个名字被中心辉光复用了（v1 里它是潜像格的呼吸），不在退场清单里。
    for (const gone of ['gen-dev__latent', 'gen-dev__vignette', 'data:image/svg+xml']) {
      expect(GLOBAL_CSS, `${gone} 已随 v2 退场`).not.toContain(gone);
    }
  });

  it('卡面是近乎透明的一层，不是一块黑砖', () => {
    // 底纱压太狠画布点阵是干净了，但卡片会变沉——v1 压到 0.56 就是这么丢掉「轻」的。
    const veil = readToken('--gen-wait-veil');
    const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(veil)?.[1]);
    expect(alpha, `--gen-wait-veil = ${veil}`).toBeLessThanOrEqual(0.2);
  });

  it('尺寸相关的量全部按屏幕像素计量（复用画布逐帧更新的 --invZoom）', () => {
    expect(GLOBAL_CSS).toContain('font-size:calc(12.5px * var(--invZoom,1))');
    // 画框上每一条描边都要按屏幕像素恒定，漏一条它就会在低倍下先消失。
    // 逐条列名字而不是只挑一条：只挑一条时，新加的那条漏了判据也不会红。
    for (const [cls, px] of [['halo', '8px'], ['arc', '3px'], ['head', '4.5px']] as const) {
      const rule = new RegExp(`\\.gen-dev__${cls}\\{[^}]*stroke-width:calc\\(${px.replace('.', '\\.')} \\* var\\(--invZoom,1\\)\\)`);
      expect(GLOBAL_CSS, `.gen-dev__${cls} 的描边宽度应按屏幕像素恒定`).toMatch(rule);
    }
    // 插入距离同时按百分比封顶：纯屏幕像素在极小卡片上会把 left+right 加到超过卡宽，
    // 整行塌成零宽度然后静默消失。
    expect(GLOBAL_CSS).toContain('left:min(calc(14px * var(--invZoom,1)),10%)');
  });

  it('配色全部走 --gen-wait-* token，组件内零硬编码颜色', () => {
    // 只看会生效的声明：注释里引用用户原话（「只显示 #D97757 的」）不是硬编码颜色，
    // 但若不剥注释，判据会因为一句解释而变红——那是判据错，不是代码错。
    const declarations = GLOBAL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(declarations).not.toMatch(/rgba?\(/);
    // 剥注释不能把判据剥没了：确认剥完还剩着真正的声明。
    expect(declarations).toContain('stroke:var(--gen-wait-progress)');
  });
});

describe('【关键】底边那行必须夹在画布可见区域内', () => {
  // 这条是从 main 的 GenSweepLoader.test.tsx 搬过来的（那边守的是同一件事）。
  // 本分支把 GenSweepLoader 整个换成了 GenDevelopLoader，如果只删不搬，
  // 合并的净效果就是把 main 那个修复悄悄删掉——而且不会有任何测试变红。
  // 卡片被画布边缘裁掉一半时，这行字会跑到看不见的地方，用户只剩一张
  // 什么都不说的图在转。
  const LOADER = readFileSync(resolve(__dirname, './GenDevelopLoader.tsx'), 'utf8');
  const CANVAS = readFileSync(resolve(__dirname, '../../pages/ai-chat/AdvancedVisualAgentTab.tsx'), 'utf8');

  it('夹紧走共享算术，不在组件里另写一份', () => {
    expect(LOADER).toMatch(/generationProgressPlacement\(rect,/);
  });

  it('画布里两处等待态都把裁切容器传进来了', () => {
    // 普通生图 + Frame 分层两处。少接一处那一处就静默失去夹紧。
    const usages = CANVAS.match(/<GenDevelopLoader\b[\s\S]*?\/>/g) ?? [];
    expect(usages.length, '画布应有两处 GenDevelopLoader').toBe(2);
    for (const usage of usages) expect(usage).toContain('viewportRef={stageRef}');
  });
});
