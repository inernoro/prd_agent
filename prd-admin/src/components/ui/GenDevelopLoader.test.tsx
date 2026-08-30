import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenDevelopLoader, GLOBAL_CSS, framePath, metaLevel, phaseOf } from './GenDevelopLoader';

const EST_MS = 40_000; // getGenAvgMs 的首样本兜底

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
    expect(GLOBAL_CSS).toMatch(/\.gen-dev__develop\{[^}]*animation:gen-dev-pass/);
  });

  it('呼吸动画乘上进度变量，不写死 opacity', () => {
    // 动画在层叠里压过 inline style：关键帧若直接写 opacity，
    // 进度驱动的粗细格交叉淡入会被整个吃掉，看着像「格子永远那么浓」。
    expect(GLOBAL_CSS).toMatch(/@keyframes gen-dev-breathe\{[^}]*calc\(var\(--gen-dev-latent,1\) \* \.62\)/);
    expect(GLOBAL_CSS).toMatch(/50%\{opacity:var\(--gen-dev-latent,1\)\}/);
  });

  it('潜像是共享的 data-URI，不是每张卡几百个各带动画的格子', () => {
    // 画布上同时十几张占位卡时，这条决定还有没有帧预算。
    expect(GLOBAL_CSS).toContain('background-image:url("data:image/svg+xml,');
    const html = renderToStaticMarkup(
      <GenDevelopLoader createdAt={Date.now()} screenW={420} screenH={420} worldW={1024} worldH={1024} />,
    );
    // 整个潜像层就两个节点（粗 + 细），不是每格一个 div。
    expect(html.match(/gen-dev__latent--/g)).toHaveLength(2);
    expect(html).not.toContain('gen-dev__cell');
  });

  it('尺寸相关的量全部按屏幕像素计量（复用画布逐帧更新的 --invZoom）', () => {
    for (const decl of ['font-size:calc(12.5px * var(--invZoom,1))', 'stroke-width:calc(2px * var(--invZoom,1))']) {
      expect(GLOBAL_CSS).toContain(decl);
    }
    // 插入距离同时按百分比封顶：纯屏幕像素在极小卡片上会把 left+right 加到超过卡宽，
    // 整行塌成零宽度然后静默消失。
    expect(GLOBAL_CSS).toContain('left:min(calc(14px * var(--invZoom,1)),10%)');
  });

  it('配色全部走 --gen-wait-* token，组件内零硬编码颜色', () => {
    // 潜像 data-URI 里的两个浅色是图片像素、不是主题面，另算。
    const withoutMosaic = GLOBAL_CSS.replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, 'MOSAIC');
    expect(withoutMosaic).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutMosaic).not.toMatch(/rgba?\(/);
  });
});
