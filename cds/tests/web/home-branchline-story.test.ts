/**
 * 首页 Branchline 叙事区的接线守卫（2026-09-16）。
 *
 * 场景组件是 .jsx，tsc 不会因为它没被引用而红；这里钉住三件删掉不会红的事：
 *  1. HomePage 真的挂了叙事区（五章、顶栏锚点 id 仍在，导航链接不会指向空气）；
 *  2. 场景不用 IntersectionObserver 的 rootMargin（2026-09-09 首页死机的根因就是它被转成 rem）；
 *  3. 场景只在进入视口时渲染、卸载时释放 renderer、尊重 reduced-motion——这三条是性能与可访问性契约，
 *     任何一条被"顺手简化"掉，页面照常渲染、测试照常绿。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const home = fs.readFileSync(path.join(WEB, 'pages/HomePage.tsx'), 'utf-8');
const scene = fs.readFileSync(path.join(WEB, 'components/effects/BranchlineScene.jsx'), 'utf-8');
const css = fs.readFileSync(path.join(WEB, 'pages/HomePage.css'), 'utf-8');

describe('首页 Branchline 叙事区', () => {
  it('HomePage 挂了叙事区，五章齐全，顶栏锚点仍有落点', () => {
    // Codex 2026-09-20 P2：three + postprocessing 不进首页主链路，滚到叙事区才下载
    expect(home, '场景必须 lazy 动态引入').toMatch(/lazy\(\(\) => import\('@\/components\/effects\/BranchlineScene'\)\)/);
    expect(home, '不许再静态引入').not.toMatch(/^import .*BranchlineScene/m);
    expect(home, '场景组件要等叙事区进入视口才挂载，否则 lazy 只是拆包不省下载').toMatch(/armed \? <BranchlineScene rootRef=\{rootRef\} \/> : null/);
    expect(home).toContain('<BranchlineStory onEnter={openAccessMode} />');
    const ids = [...home.matchAll(/^\s+id: '([a-z]+)', rail: '0(\d) /gm)].map((m) => m[1]);
    expect(ids).toEqual(['workflow', 'features', 'preview', 'observability', 'ship']);
    for (const anchor of ['workflow', 'features', 'observability']) {
      expect(home, `顶栏链接 #${anchor} 必须有同名章节承接`).toMatch(new RegExp(`goAnchor\\('${anchor}'\\)`));
    }
    expect(home, '旧的卡片分区不该残留').not.toContain('cdsh-bento-card');
  });

  it('场景由滚动进度驱动，不碰 IntersectionObserver 的 rootMargin', () => {
    expect(scene, '只抓代码用法：注释里解释「为什么不用它」是允许的').not.toMatch(/rootMargin\s*:/);
    expect(scene).toContain('getBoundingClientRect');
    expect(scene, '文案与进度轨由 data 属性接线，改 DOM 不走 setState').toContain("querySelectorAll('[data-cdsh-chapter]')");
    expect(home).toContain('data-cdsh-chapter');
    expect(home).toContain('data-cdsh-rail={i}');
  });

  it('只在视口内渲染、卸载即释放、尊重 reduced-motion', () => {
    expect(scene).toMatch(/inView = rect\.bottom > 0 && rect\.top < vh/);
    expect(scene).toContain("document.addEventListener('visibilitychange'");
    expect(scene).toContain('built.dispose()');
    expect(scene).toContain('renderer.dispose()');
    expect(scene).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    // Codex 2026-09-20 两条 P2：离屏时不许再排帧；reduced-motion 下时钟必须冻结，不只是关掉滚动插值
    expect(scene, '离屏的那一帧必须直接 return，不能再 requestAnimationFrame').toMatch(/if \(!inView\) \{[^}]*return; \}/);
    expect(scene, 'WebGL 构建必须发生在 inView 判定之后，停在 hero 的访客不建场景').toMatch(/if \(!inView\) \{[^}]*return; \}\s*\n\s*if \(!ensureBuilt\(\)\) return;/);
    expect(scene, '离屏后要有门铃把循环叫醒').toContain('new IntersectionObserver(');
    expect(scene, 'reduced-motion 下传给 render 的时钟要冻结').toMatch(/built\.render\(p, reduced \? 0 : now \* 0\.001/);
    expect(scene, 'reduced-motion 下画完一帧就停，不许按刷新率重绘相同画面').toMatch(/if \(!reduced\) raf = requestAnimationFrame\(frame\);/);
  });

  it('叙事区的类名在 HomePage 里只出现在叙事区（2026-09-18 撞车事故：cdsh-stage 与 hero 实况板列同名，hero 多出一块整屏黑）', () => {
    for (const cls of ['cdsh-story', 'cdsh-story-stage', 'cdsh-story-vignette', 'cdsh-chapters', 'cdsh-rail', 'cdsh-ch-pin', 'cdsh-ch-copy']) {
      const n = (home.match(new RegExp(`className="(?:[^"]* )?${cls}(?: [^"]*)?"`, 'g')) || []).length;
      expect(n, `${cls} 应只在叙事区用一次，多于一次就是和 hero 撞名`).toBe(1);
    }
    expect(home, 'hero 自己的 cdsh-stage 必须还在，叙事区不得复用它').toContain('className="cdsh-stage"');
    expect(css, '叙事区舞台的样式不得写在 .cdsh-stage 上').not.toMatch(/\.cdsh-stage \{[^}]*position: sticky/);
  });

  it('舞台 sticky、章节负外边距叠回一屏——这对组合是滚动叙事成立的前提', () => {
    expect(css).toMatch(/\.cdsh-story-stage \{[^}]*position: sticky;[^}]*height: 100vh;/);
    expect(css).toMatch(/\.cdsh-chapters \{[^}]*margin-top: -100vh;/);
    expect(css).toMatch(/\.cdsh-ch-pin \{[^}]*position: sticky;/);
    // 舞台要落在 hero 蜂窝层之下、章节文字要压在其上：叙事区容器一旦有 z-index 就成了层叠上下文，两者被迫同层
    expect(css, '.cdsh-story 不得声明 z-index').not.toMatch(/\.cdsh-story \{[^}]*z-index/);
    expect(css).toMatch(/\.cdsh-chapters \{[^}]*z-index: 2;/);
    expect(css, '蜂窝层要压在舞台之上').toMatch(/\.cdsh-bg\s*\{[^}]*z-index: 1;/);
  });
});

// three 0.184 直出画布时自己做 sRGB 编码；postprocessing 末端 EffectPass 默认再编码一次，暗部整体抬灰。
// 这条只能在真 WebGL 里量出来（中灰 #808080 出来是 #bcbcbc），单测量不了，只能钉住修法本身。
it('branchline scene disables the final pass output encoding (three already encodes)', () => {
  expect(scene).toMatch(/finalPass\.fullscreenMaterial\.encodeOutput = false/);
  // 色调映射在离屏合成路径里不生效，留着只会误导下一个人以为它在起作用
  expect(scene).not.toMatch(/toneMapping\s*=/);
});
