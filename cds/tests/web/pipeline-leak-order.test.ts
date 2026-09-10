/**
 * 首页对后端 LeakKind 字面量的依赖守卫（2026-09-10 重写）。
 *
 * 上一版守的是「前后端两份漏点严重度顺序表不许漂移」。2026-09-10 首页第三次重做后
 * 前端不再逐类渲染漏点卡，那两份表只剩后端一份，旧守卫的前提消失了——但**不能就此删掉**，
 * 因为它防的那类东西换了个位置又出现了：
 *
 * 首页要给每个项目挑一条真实的未验收分支名当示例，做法是从 `pipeline.leaks` 里
 * 按 `kind === 'deployed-not-accepted'` 过滤。这个字面量在前端是硬编码的，后端一旦改名，
 * 过滤结果恒为空——页面照常渲染、类型照常通过、测试照常绿，只是每个项目的分支名
 * 悄悄不见了。这正是 predicate-and-wiring-discipline 形状 2（链路只建一半，静默退化）。
 *
 * 所以本守卫改为：前端硬编码的每一个 LeakKind 字面量，必须在后端的 LeakKind 联合类型里存在。
 *
 * 2026-09-10 二次修订：首页换成厂房剖面后，那处依赖又换了形状——从 `l.kind === 'x'` 的
 * 比较式变成了 `pipeline.totalLeaks['x']` 的下标式。只认比较式的判据于是同时犯两个错：
 * 对真实存在的下标依赖视而不见，又因为「一条比较式都没有」而误报。这正是
 * predicate-and-wiring-discipline 形状 1（判据比它该管的范围窄，换个等价写法就漏）。
 * 现在两种写法都认，且不再要求「必须有依赖」——没有依赖是合法状态，守卫只管
 * 「出现的必须存在」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('首页引用的 LeakKind 字面量必须在后端存在', () => {
  const backend = read('src/services/acceptance-pipeline.ts');
  const panel = read('web/src/pages/reports/PipelinePanel.tsx');

  /** 后端 LeakKind 联合类型里声明的全部取值。 */
  const backendKinds = (() => {
    const block = backend.match(/export type LeakKind =([\s\S]*?);/);
    expect(block, '后端 LeakKind 联合类型没找到——改了名字就得来更新这条守卫').not.toBeNull();
    return new Set([...block![1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  })();

  it('后端 LeakKind 联合类型解析得出取值，且不为空', () => {
    expect(backendKinds.size).toBeGreaterThan(0);
  });

  it('前端出现的每个 kind 字面量都对得上后端，比较式与下标式都算', () => {
    // 两种写法都要认，少认一种就等于漏掉一半依赖：
    //   比较式  l.kind === 'deployed-not-accepted'
    //   下标式  pipeline.totalLeaks['report-missing-change-key']
    const used = [
      ...[...panel.matchAll(/kind\s*[!=]==\s*'([a-z-]+)'/g)].map((m) => m[1]),
      ...[...panel.matchAll(/(?:totalLeaks|leaks)\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]),
    ];
    // 没有依赖是合法状态（首页可以不引用任何 kind），所以这里不要求 used 非空。
    for (const kind of used) {
      expect(backendKinds.has(kind), `首页用了 '${kind}'，后端 LeakKind 里没有这一项`).toBe(true);
    }
  });
});
