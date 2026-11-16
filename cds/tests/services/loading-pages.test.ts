/**
 * loading-pages SSOT 契约（doc/debt.cds.md「CDS Loading Pages」 D2，2026-07-09）。
 *
 * 迁移纪律：页面从散落文件迁入 SSOT 时**只搬不改**——快照锁住输出，
 * 任何有意的样式调整必须显式更新快照（评审可见），杜绝「迁移顺手改样式」
 * 的静默漂移。另锁死旧 import 路径的 re-export 等价（forwarder 消费方不动）。
 */

import vm from 'node:vm';
import { buildGemStorySvg, buildWaitingGemSvg, WAITING_GEM_CSS } from '../../src/loading-pages/gem.js';
import { describe, expect, it } from 'vitest';
import { buildForwarderWaitingPageHtml, buildNginxWaitingHtml } from '../../src/loading-pages/index.js';
import { buildForwarderWaitingPageHtml as legacyExport } from '../../src/forwarder/waiting-page.js';

describe('loading-pages SSOT', () => {
  it('forwarder 等待页：旧 import 路径 re-export 与 SSOT 字节级等价', () => {
    expect(legacyExport()).toBe(buildForwarderWaitingPageHtml());
  });

  it('forwarder 等待页：关键结构锚点不漂移（2026-07-22 起含宝石核心叙事）', () => {
    const html = buildForwarderWaitingPageHtml();
    // 结构锚点（非全文快照，避免脆断；改这些等于改产品行为，须显式过评审）
    expect(html).toContain('<title>分支环境正在构建</title>');
    expect(html).toContain('CDS Waiting Room');
    expect(html).toContain('持续检测服务恢复');
    expect(html).toContain("cache:'no-store'");
    expect(html).toContain('scheduleProbe(2000)');
    // 宝石六芒(组装-碎裂叙事)是系统核心叙事,所有等待页前景必须携带
    expect(html).toContain('cds-gem-story');
    expect(html).toMatchSnapshot();
  });

  it('forwarder 等待页：上游从 503 恢复到 200 后自动刷新真实页面', async () => {
    const html = buildForwarderWaitingPageHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const scheduled: Array<() => void> = [];
    const statuses = [503, 200];
    let reloadCount = 0;
    let fetchCount = 0;
    const window = {
      location: {
        href: 'https://preview.example.com/video-agent',
        reload: () => { reloadCount += 1; },
      },
      setTimeout: (fn: () => void) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimeout: () => undefined,
      setInterval: () => 0,
    };
    const context = vm.createContext({
      window,
      URL,
      Date,
      document: { querySelector: () => ({ textContent: '' }) },
      fetch: async (_url: string, init: RequestInit) => {
        fetchCount += 1;
        expect(init.cache).toBe('no-store');
        return { status: statuses.shift() ?? 200 };
      },
    });

    vm.runInContext(script!, context);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCount).toBe(1);
    expect(reloadCount).toBe(0);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCount).toBe(2);
    expect(reloadCount).toBe(1);
  });

  it('nginx 等待页：单主题 token 块不再携带伪 light 分支', () => {
    const html = buildNginxWaitingHtml();
    expect(html).toContain('--bg-page:#0d1117');
    // 历史伪双主题：light media query 里是暗色值的完整复制，只会误导维护者
    expect(html).not.toContain('prefers-color-scheme:light');
    // CDS 自升级页 = 「CDS 重启中」核心场景,宝石(iris)替代旧圆圈 spinner
    expect(html).toContain('cds-gem-story');
    expect(html).not.toContain('class="spinner"');
    expect(html).toMatchSnapshot();
  });
});


describe('等待页六芒星', () => {
  it('复用十二个品牌切面及其相位，保留六个完整星尖，不增加镂空或边光覆盖层', () => {
    const original = buildGemStorySvg('galaxy', 40);
    const waiting = buildWaitingGemSvg(40);
    const points = (svg: string) => [...svg.matchAll(/points="([^"]+)"/g)].map(match => match[1]);
    const phases = (svg: string) => [...svg.matchAll(/--gi:(\d+)/g)].map(match => Number(match[1]));
    expect(points(waiting)).toEqual(points(original));
    expect(points(waiting)).toHaveLength(12);
    expect(phases(waiting)).toEqual(phases(original));
    expect(waiting.match(/class="cds-gem-story-facet cds-waiting-gem-core"/g)).toHaveLength(6);
    expect(waiting.match(/fill="#f8f8fb"/g)).toHaveLength(6);
    expect(waiting).not.toContain('<mask');
    expect(waiting).not.toContain('cds-waiting-gem-edge');
  });

  it('中央暗面使用不透明纯黑，外围沿用组装 / 呼吸 / 碎裂动作并支持减少动态效果', () => {
    expect(WAITING_GEM_CSS).toContain('animation:cds-gem-story var(--cds-gem-dur,2.9s)');
    expect(WAITING_GEM_CSS).toContain('animation-name:cds-waiting-core-black');
    expect(WAITING_GEM_CSS).toContain('43%,47%{opacity:1;fill:#000000;stroke:#000000}');
    expect(WAITING_GEM_CSS).toContain('88%{transform:scale(.5) rotate(-10deg);opacity:0}');
    expect(WAITING_GEM_CSS).toContain('@media(prefers-reduced-motion:reduce){.cds-waiting-gem .cds-gem-story-facet{animation:none;transform:none;opacity:1}}');
  });
});
