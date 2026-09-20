import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimatePages } from '../MdToPptAgentPage';

const page = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');

/**
 * 上一轮为了不撑爆 sessionStorage，把知识正文从快照里剥掉了，注释还写着「正文只参与
 * estimatePages，而调整路径走 targetPagesOverride」——那句话只对「调整」这一半成立。
 * 首轮生成走的正是 estimatePages，正文没了篇幅就没了：用户选好一篇长文档、刷新、再发送，
 * 页数被估成最低的 4 页，而服务端是严格按客户端给的页数执行的（Codex P2，2026-09-15）。
 *
 * 修法是只扔正文、留篇幅：估算需要的从来只是长度。
 */
describe('刷新之后知识条目的篇幅还在', () => {
  it('估算把「手里没有正文但知道多长」的部分算进去', () => {
    const longBody = 'x'.repeat(7000);

    // 正文在手：约 7000 字 → 10 页。
    const withBody = estimatePages(longBody);
    expect(withBody).toBe(10);

    // 正文被剥掉、篇幅补回来：结论必须一致。
    expect(estimatePages('', 7000)).toBe(withBody);

    // 什么都不补就是这条缺陷本身：塌到最低档。
    expect(estimatePages('')).toBe(8);
    expect(estimatePages('请生成'), '空正文 + 短指令会塌到最低 4 页').toBe(4);
  });

  it('负数或缺省的额外篇幅不影响原有行为', () => {
    expect(estimatePages('内容'.repeat(2000))).toBe(estimatePages('内容'.repeat(2000), 0));
    expect(estimatePages('内容'.repeat(2000), -100)).toBe(estimatePages('内容'.repeat(2000)));
  });

  it('显式页数仍然优先于任何篇幅估算', () => {
    expect(estimatePages('严格生成 2 页', 999999)).toBe(2);
  });

  it('落盘时留下篇幅，估算时补回篇幅（两头都接上了）', () => {
    // companion：确实还在剥正文。
    expect(page).toContain("content: ''");
    expect(page, '剥掉正文却没留下篇幅，刷新后长文档会被估成最低页数')
      .toContain('contentChars: ref.content ? ref.content.length : (ref.contentChars ?? 0)');
    expect(page, '估算处没有把恢复条目的篇幅补回来')
      .toContain('estimatePages(userText + attachmentText + kbContext, restoredKbChars)');
  });
});
