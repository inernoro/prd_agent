import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 接线守卫：阶段二那批「可见性」功能里，有两处是**一行接线**决定整条链路可不可见的。
 *
 * 事故值（本 PR 真实发生过，全量测试全绿却功能不可见）：
 *   - `UptimeMonitorService` 的 state 源少一行 `getReleaseTargets`，生产目标永远
 *     不产生探测目标 —— 状态页看不到任何生产行，而所有存活监控单测照常全绿，
 *     因为它们注入的是自己造的 state 桩。
 *   - `GET /releases/center` 的 row 少一行 `releaseEstimate`，耗时台账照常在攒，
 *     前端 CenterRow.releaseEstimate 恒为 undefined，发布中心永远显示
 *     「正在积累历史耗时数据」。而前端做了优雅退化，页面既不报错也不白屏。
 *
 * 两处的共性：**删掉不会红，只会静默退化**。行为测试测不到（一个在 bootstrap、
 * 一个的前端有兜底），所以只能用源码扫描把接线本身钉住。
 *
 * releaseEstimate 另有行为用例（tests/routes/releases-center-eta.test.ts）；
 * 这里再钉一次是为了在有人「顺手把路由拆成 helper」时也拦得住。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relativePath), 'utf8');
}

describe('阶段二可见性功能的接线不许掉', () => {
  it('存活监控的 state 源接了生产发布目标', () => {
    const source = read('src/index.ts');
    const at = source.indexOf('new UptimeMonitorService(');
    expect(at).toBeGreaterThan(-1);
    // 只看构造调用之后的一小段，避免文件里别处出现同名字符串造成假绿。
    const ctorWindow = source.slice(at, at + 900);
    expect(ctorWindow).toContain('getReleaseTargets');
    expect(ctorWindow).toContain('stateService.getReleaseTargets()');
  });

  it('发布中心的每行都带 ETA 估算', () => {
    const source = read('src/routes/releases.ts');
    expect(source).toContain('releaseEstimate');
    expect(source).toContain('getReleaseEstimate(target.id)');
  });

  /**
   * 第三处同族接线：`setReleaseHealthSource`。摘掉它不会红——发布中心的健康列
   * 会恒为「存活监控未启用」，页面照常渲染、测试照常全绿，只是生产健康永远
   * 显示不出来。行为用例（tests/routes/releases-center-health-snapshot.test.ts）
   * 注入的是自己的 source 桩，测不到真实 bootstrap 有没有接上。
   */
  it('发布中心的健康快照源在 bootstrap 里接上了存活监控', () => {
    const source = read('src/index.ts');
    const at = source.indexOf('setReleaseHealthSource(');
    expect(at).toBeGreaterThan(-1);
    const window = source.slice(at, at + 700);
    expect(window).toContain('uptimeMonitor.getRecord(');
  });
});
