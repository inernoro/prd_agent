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
    expect(home).toContain("from '@/components/effects/BranchlineScene'");
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
  });
});
