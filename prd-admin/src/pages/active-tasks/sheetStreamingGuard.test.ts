import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 流还没完就不许确认。
 *
 * 事故形状：确认按钮只看 `hasDrafts`，第一条草稿一到就可点。点下去只把「已经到的那几条」
 * 建成任务，却把**全部**选中的建议标记成已吸取、顺带 abort 掉剩下的流 ——
 * 后面才生成的条目从此找不回来，它们的来源建议也一并从收件箱消失。
 *
 * 这条没法用渲染测试兜住（要真跑一条 SSE 流才能让 streaming 为 true），
 * 所以钉在源码上：两个 sheet 的 confirmDisabled 必须把 streaming 算进去。
 * 2026-09-16 Codex review 抓到。
 */
describe('两个浮层的确认按钮', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf-8');

  it.each([
    ['SuggestionsSheet.tsx'],
    ['ImportSheet.tsx'],
  ])('%s 在流式进行中禁用确认', (file) => {
    const src = read(file);

    // 先确认这个文件真有 streaming 这个概念，否则下面的断言是空转
    expect(src).toContain("const streaming = phase === 'connecting' || phase === 'streaming'");

    const line = src.split('\n').find((l) => l.includes('confirmDisabled='));
    expect(line, `${file} 里找不到 confirmDisabled`).toBeTruthy();
    expect(line, `${file} 的 confirmDisabled 没把 streaming 算进去`).toContain('streaming');
  });

  it('吸取那条还有一道运行时兜底，禁用态被碰掉也不会丢数据', () => {
    const src = read('SuggestionsSheet.tsx');
    const body = src.slice(src.indexOf('const onConfirm'));
    expect(body.slice(0, 400)).toContain('if (streaming) return;');
  });
});

/**
 * 一条没建上就别收摊。
 *
 * 事故形状：只看「成了几条 > 0」就关窗，于是没建上的那几条连同 AI 刚拆出来的结果
 * 一起消失 —— 用户既看不到失败、也没有重试的路，而那段拆解是花了几十秒生成的。
 * 两个浮层是同一个形状，所以钉在一起：先修了其中一个、另一个漏掉，正是第三轮 review
 * 又把它捞出来的原因。
 */
describe('两个浮层的批量建任务', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf-8');

  it.each([
    ['SuggestionsSheet.tsx'],
    ['ImportSheet.tsx'],
  ])('%s 有一条没成就把它留在表上，不关窗', (file) => {
    const src = read(file);
    const body = src.slice(src.indexOf('const onConfirm'), src.indexOf('const onConfirm') + 1600);

    expect(body, `${file} 没有把失败的那几条收集起来`).toContain('failed');
    expect(body, `${file} 没有在有失败时提前返回（会继续走到关窗）`).toMatch(/if \(failed\.length > 0\)[\s\S]*?return;/);
  });
});

/**
 * 建任务那几秒不许关窗。
 *
 * 事故形状：`abort()` 只掐得断 SSE，掐不断底下正在排队跑的 `createActiveTask` 与最后
 * 那次标记已吸取。用户按取消 / 点遮罩 / 敲 ESC，窗关了，活照建、建议照了结 ——
 * 他以为自己取消了，其实没有。三条关闭路径在 TaskSheet 里走的是同一个 onClose，
 * 所以只要传进去的那个函数先看一眼写入状态就够。
 */
describe('两个浮层的关闭按钮', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf-8');

  it.each([
    ['SuggestionsSheet.tsx', 'busy'],
    ['ImportSheet.tsx', 'saving'],
  ])('%s 在写入进行中不许关闭', (file, flag) => {
    const src = read(file);

    // 传给 TaskSheet 的必须是那个带守卫的函数，不是原来的内联 abort+onClose
    expect(src, `${file} 的 onClose 没走 onRequestClose`).toContain('onClose={onRequestClose}');

    const at = src.indexOf('const onRequestClose');
    expect(at, `${file} 里找不到 onRequestClose`).toBeGreaterThan(-1);
    const body = src.slice(at, at + 320);
    expect(body, `${file} 的 onRequestClose 没看写入状态 ${flag}`).toContain(`if (${flag})`);
    expect(body, `${file} 的 onRequestClose 写入中没有提前返回`).toMatch(/if \([a-z]+\) \{[^}]*return;/);
  });

  it('重新生成时行号不重置 —— 键跨代唯一，才不用去清那两个 ref', () => {
    // 这两个 ref 拿行号当键，而行号原来每次重拆都从 0 数起。于是新一代的第一行
    // 又叫 s1，两条路都错：把它当成「已经建过」跳过（任务没建、来源却标成已吸取），
    // 或者连 doneIds 一起清掉（忘了上一趟真建出来的那几条，provenance 断掉）。
    // 根在键会重复，不在清不清。行号一直往上加，两个问题同时消失。
    const src = read('SuggestionsSheet.tsx');
    const at = src.indexOf('const onAbsorb');
    const body = src.slice(at, at + 900);
    expect(body, 'onAbsorb 又把行号重置了，s1 会跨代重复').not.toContain('seq.current = 0');
    expect(body, '行号不重置就不该再清 builtKeys').not.toContain('builtKeys.current.clear()');
    expect(body, '行号不重置就不该再清 doneIds').not.toContain('doneIds.current = []');
    // 行号确实在一直往上加
    expect(src).toContain('seq.current += 1');
  });
});

/**
 * 看板设置必须有人调用。
 *
 * 事故形状（`predicate-and-wiring-discipline` 形状 2）：`getBoardSettings` /
 * `saveBoardSettings` 封装好了、后端端点也在，但全前端没有一处调用它。于是
 * 「匿名看板三档可见性、可以整个关掉」这句承诺只兑现了后端那一半 —— 管理员既关不掉
 * 它，也改不了档位。这种缺陷不会报错、页面照常渲染、测试照常绿，
 * 只有真去找这个开关的人才会发现它不存在。
 */
describe('看板设置的接线', () => {
  it('两个设置接口都有页面在用，不是只建了一半', () => {
    const sheet = readFileSync(resolve(__dirname, 'BoardSettingsSheet.tsx'), 'utf-8');
    expect(sheet).toContain('getBoardSettings');
    expect(sheet).toContain('saveBoardSettings');
    // 四项设置都要给得出来，少一项就等于那一项仍然只能打接口改
    for (const field of ['anonymousEnabled', 'anonymousMode', 'blockedEscalateMinutes', 'heavyStackThreshold']) {
      expect(sheet, `设置面板没给 ${field}`).toContain(field);
    }

    // 而这张面板自己也得有人挂上去 —— 否则只是把「建了一半」挪了个位置
    const team = readFileSync(resolve(__dirname, 'TeamBoardPage.tsx'), 'utf-8');
    expect(team, '团队页没有挂设置面板').toContain('<BoardSettingsSheet');
    expect(team, '团队页没有打开设置面板的入口').toContain('setSettingsOpen(true)');
  });
});

/**
 * 写入期的保护要盖到最后一步。
 *
 * 事故形状：`setBusy(false)` 放在建任务循环之后、`markSuggestionsAbsorbed` 之前，
 * 于是「不许关窗」只盖住了建任务那几秒，标记那几秒又露出来了 —— 而恰恰是标记
 * 没落地时关窗最伤：任务已进队列，来源建议却还挂在收件箱里，再吸一次就是重复任务。
 * 这是上一轮那条修复没修干净的地方。
 */
describe('吸取浮层的写入保护范围', () => {
  it('busy 一直盖到标记已吸取结束，不在中途放开', () => {
    const src = readFileSync(resolve(__dirname, 'SuggestionsSheet.tsx'), 'utf-8');
    const at = src.indexOf('const onConfirm');
    const mark = src.indexOf('markSuggestionsAbsorbed(', at);
    expect(mark, '找不到标记调用').toBeGreaterThan(at);

    // 建任务循环结束到标记调用之间，不许出现 setBusy(false)——
    // 那几行里出现它，就等于保护在标记开始前就撤了
    const loopEnd = src.indexOf('doneIds.current = created;', at);
    const between = src.slice(loopEnd, mark);
    const 提前放开 = between.split('setBusy(false)').length - 1;
    // 允许的只有「提前 return 的那两条分支各自放开」，它们都在 return 之前
    const returns = between.split('return;').length - 1;
    expect(提前放开, 'busy 在标记开始前就被放开了').toBeLessThanOrEqual(returns);
  });
});

/**
 * 匿名面板的「没有开放」要能撤回来。
 *
 * 事故形状（形状 10）：这一屏每分钟轮询一次，中间任何一次网络抖动都会把 closed 置上，
 * 而它原来再也不会被放下 —— 面板明明开着，这一屏却永久停在「这个面板没有开放」，
 * 只能靠用户自己刷新页面。一次抖动换来一个看起来像「管理员关掉了」的永久状态。
 */
describe('匿名面板的恢复', () => {
  it('轮询成功要把「没有开放」撤回来', () => {
    const src = readFileSync(resolve(__dirname, 'PublicBoardPage.tsx'), 'utf-8');
    const at = src.indexOf('const load = useCallback');
    const body = src.slice(at, at + 700);
    expect(body).toContain('setClosed(true)');
    expect(body, '成功分支没有把 closed 复位').toContain('setClosed(false)');
  });
});

/**
 * 债务那一块得有出口。
 *
 * 事故形状（形状 2，与看板设置同一个）：`closeDebt` 封装好了、后端端点也在，
 * 但全前端没有一处调用它。列表只隐藏已经 closed 的那些，而把一条标成 closed 的
 * 入口只有 REST 端点 —— 于是下半屏只进不出，欠着的只会越堆越多。
 */
describe('债务的了结入口', () => {
  it('了结这个动作真的接进了界面，不是只有封装', () => {
    const src = readFileSync(resolve(__dirname, 'DebtSection.tsx'), 'utf-8');
    expect(src, 'DebtSection 没引 closeDebt').toContain('closeDebt');
    expect(src, 'closeDebt 没有被真的调用').toMatch(/closeDebt\(\s*d\.id\s*\)/);

    // 认领、放回、转成我的活、了结 —— 四个动作都得在
    for (const fn of ['claimDebt', 'releaseDebt', 'convertDebt', 'closeDebt']) {
      expect(src, `${fn} 没接进界面`).toContain(fn);
    }
  });
});
