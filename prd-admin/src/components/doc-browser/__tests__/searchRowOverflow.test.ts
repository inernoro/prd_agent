/**
 * 搜索行不许右溢出的守卫。
 *
 * 这条来自一次真实缺陷：搜索行是「搜索框 + 命中跳转钮 + 继续跟随」三件，
 * 搜索框写了 `flex-1` 却没写 `min-w-0`——flex 子项的 `min-width` 默认是 `auto`，
 * 撑不小于内容的最小宽度（放大镜 + 输入框 + 命中计数）。于是在 390px 屏上整行右溢出，
 * 右边那颗按钮被视口切掉一半。
 *
 * 它不会让编译红、不会让任何行为测试红，只有把画板截出来对着看才发现
 * （predicate-and-wiring-discipline 形状 1：判据漏了一种输入——窄屏 + 三件同排）。
 * 所以按源码扫这一条：`flex-1` 的横排容器必须同时带 `min-w-0`。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'TranscriptKaraoke.tsx'),
  'utf8',
);

describe('搜索行在窄屏上不许右溢出', () => {
  it('搜索框既是 flex-1 又带 min-w-0，才能让出宽度给右侧两颗按钮', () => {
    const label = SRC.split('\n').find(line => line.includes('<label') && line.includes('flex-1'));
    expect(label, '找不到搜索框那个 flex-1 容器').toBeTruthy();
    expect(label, '缺 min-w-0：窄屏上这一行会把右侧按钮顶出视口').toContain('min-w-0');
  });

  it('右侧两颗按钮保持 flex-shrink-0，被压扁的应该是搜索框不是按钮', () => {
    // 稿面 B2 的命中导航是**一对**方向键，两颗都要在
    expect(SRC).toContain('aria-label="上一个命中"');
    expect(SRC).toContain('aria-label="下一个命中"');
    // 命中跳转钮与「继续跟随」都要 shrink-0，否则窄屏下它们会被压成一条缝
    const shrinkGuards = SRC.match(/flex-shrink-0/g) ?? [];
    expect(shrinkGuards.length).toBeGreaterThanOrEqual(2);
  });
});
