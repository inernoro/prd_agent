/**
 * 两条录音全屏路由的**接线**守卫。
 *
 * 为什么要它：路由建好、在 navRegistry 登记好、页面组件也写好了，但如果没有任何地方
 * `navigate` 过去，用户就只能靠手敲 URL 到达——编译过、导航覆盖测试也绿，只有真的
 * 用一遍才发现少了半条路（predicate-and-wiring-discipline 形状 2）。处理页此前正是
 * 这种状态（Codex P2 抓到）。
 *
 * 判据只认「navRegistry 之外的源码里出现了这条路径的跳转」，所以把跳转删掉这条会红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** navRegistry 是「这条路由存在」的声明处，不能拿它当「有人走进去」的证据 */
const files = walk(SRC).filter(f => !f.endsWith(join('app', 'navRegistry.tsx')));
const sources = files.map(f => readFileSync(f, 'utf-8'));

describe('录音全屏路由的接线', () => {
  it('扫描到的源码不是空集（判据本身不是恒真）', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('结果页有地方跳过去', () => {
    const hits = sources.filter(src => /navigate\(\s*`[^`]*\/recording\/\$\{[^`]*`\s*\)/.test(src));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('处理页有地方跳过去（不能只在路由表里存在）', () => {
    const hits = sources.filter(src => /\/recording\/\$\{[^`]*\}\/processing/.test(src));
    expect(hits.length).toBeGreaterThan(0);
  });
});

/*
 * 路由上那个 storeId 只是「从哪一屏点进来的」，不等于条目的归属库（换库保存、
 * 从「最近」进来、深链被转发都会让两者不同）。拿它查库名会把「已保存到「某库」」
 * 写成另一个库，返回和「去看结果」也会把人送错地方。结果页上一轮已经改成认条目，
 * 处理页当时漏了（Codex 第十八轮 P2）——两屏都得认条目，所以判据一次覆盖两屏。
 */
describe('归属库认条目，不认路由参数', () => {
  const pages = ['RecordingResultPage.tsx', 'RecordingProcessingPage.tsx'];
  it.each(pages)('%s 用条目自己说的库去查库名与导航', (name) => {
    const src = readFileSync(join(SRC, 'pages', 'document-store', name), 'utf-8');
    // 条目的 storeId 参与推导（路由参数只做加载完成前的退路）
    expect(src).toMatch(/(entry|entryRes\.data)\??\.?storeId/);
    // 导航目标不再直接插路由参数
    expect(src).not.toMatch(/navigate\(`\/document-store\/\$\{storeId/);
  });
});
