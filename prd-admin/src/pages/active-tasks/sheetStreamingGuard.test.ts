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
