import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 换了一条 Run 就必须丢掉上一条的对照表。
 *
 * 这个组件在历史列表与详情之间来回切时是不卸载的，plan 会留在上一条 Run 上；
 * 而拉取那个 effect 的 `|| plan` 又会因此判定「已经有了，不用拉」——于是屏幕上显示的是
 * A 的源站、条数、集合清单，按下开始却是拿 B 去跑。操作者正是照着这一屏做决定的。
 *
 * 本仓库前端没有 jsdom，起不了组件；源码扫描是唯一能钉住它的手段，而这个不变量
 * 删掉之后所有既有测试仍然全绿。
 */
describe('切换 Run 时重置运行态', () => {
  const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');

  /**
   * 只依赖 runId 的那几个 effect 的函数体。
   *
   * 不能只取第一个：拉详情那个 effect 的依赖也正好是 [runId]，且写在前面。
   * 取全部，再挑出真正做重置的那个（含 setPlan(null)），否则断言会去查错的块。
   */
  const runIdEffects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[runId\]\);/g)]
    .map((m) => m[1]);
  const resetBodies = runIdEffects.filter((body) => body.includes('setPlan(null)'));
  const resetBody = resetBodies[0] ?? '';

  it('恰好有一个 runId effect 负责重置（不是散在几处，也没被删掉）', () => {
    expect(resetBodies).toHaveLength(1);
  });

  /**
   * 逐个断言，不是只认 plan。
   *
   * 上一版只写了 `setPlan(null)`，另外三个运行态照样留在上一条 Run 上：`run` 让 B 的
   * 地址下显示 A 的详情（B 的 GET 失败就永远显示 A），`overwrite` 把为 A 勾的覆盖
   * 带进 B 变成一次没人打算做的破坏性写入，`error` 把 A 的报错挂在 B 头上。
   * 漏掉哪个都不会红，所以这里把整组钉死。
   */
  it.each([
    ['对照表', 'setPlan(null)'],
    ['Run 本身', 'setRun(null)'],
    ['覆盖开关', 'setOverwrite(false)'],
    ['错误条', "setError('')"],
  ])('runId 变了就清掉上一条的%s', (_label, call) => {
    expect(resetBody).toContain(call);
  });

  /**
   * 清 state 不够，上一条的 SSE 请求本身也得断。
   *
   * useSseStream 只在**组件卸载**时 abort，而这个页面在列表与详情之间来回切一直挂着，
   * url 变了它不会自己断。A 的流继续活着有两个后果：progress 事件把 A 画到 B 的地址下；
   * phase 恒为 streaming 使 isStreaming 恒真，下面那个重连 effect 认为「已经在流了」，
   * B 的流永远起不来。
   *
   * 必须是 reset() 不能是 abort()：abort 只断请求、phase 留在 streaming，
   * isStreaming 照样卡住。
   */
  it('runId 变了要把上一条的 SSE 流一起断掉（reset 而非 abort）', () => {
    expect(resetBody).toContain('sse.reset()');
    expect(resetBody).not.toContain('sse.abort()');
  });

  it('拉取对照表的 effect 仍然靠 plan 去重（所以上面那条不能少）', () => {
    expect(source).toContain("run.status !== 'pending' || plan");
  });
});
