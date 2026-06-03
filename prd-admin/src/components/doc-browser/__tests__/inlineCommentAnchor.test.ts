import { describe, it, expect } from 'vitest';
import { locateInSegments } from '../InlineCommentOverlay';

// 行内评论锚定核心算法测试（纯逻辑，无 DOM 依赖，跟随本项目 node 环境单测约定）。
// locateInSegments 把评论的 selectedText 在「各文本节点 data」序列里做去空白匹配，
// 返回起止片段下标与片段内偏移；DOM → Range 的映射由 findTextRange 适配（真机验收坐标）。

describe('locateInSegments（行内评论锚定核心匹配）', () => {
  it('单片段内匹配，偏移精确', () => {
    // 这(0)是(1)一(2)段(3)验(4)收(5)报(6)告(7)
    const hit = locateInSegments(['这是一段验收报告的正文内容'], '验收报告');
    expect(hit).toEqual({ startSeg: 0, startOff: 4, endSeg: 0, endOff: 7 });
  });

  it('跨片段匹配（行内元素 <strong> 把文本拆成多个文本节点）', () => {
    const hit = locateInSegments(['通过', '条件', '验收'], '通过条件验收');
    expect(hit).toEqual({ startSeg: 0, startOff: 0, endSeg: 2, endOff: 1 });
  });

  it('忽略空白差异（选区跨块带换行/空格）', () => {
    const hit = locateInSegments(['标题段落', '下一段落'], '标题段落 \n 下一段落');
    expect(hit).toEqual({ startSeg: 0, startOff: 0, endSeg: 1, endOff: 3 });
  });

  it('片段内含空白时偏移仍对齐原始字符', () => {
    // "a b 验 收 c" → 验在 index 4，收在 index 6
    const hit = locateInSegments(['a b 验 收 c'], '验收');
    expect(hit).toEqual({ startSeg: 0, startOff: 4, endSeg: 0, endOff: 6 });
  });

  it('命中首个出现位置（重复词只锚第一个）', () => {
    const hit = locateInSegments(['重复词在这，重复词又现'], '重复词');
    expect(hit?.startOff).toBe(0);
  });

  it('找不到 → null', () => {
    expect(locateInSegments(['无关内容'], '不存在的句子')).toBeNull();
  });

  it('过短（少于 2 个非空白字符）不锚定', () => {
    expect(locateInSegments(['a b c'], ' x ')).toBeNull();
  });

  it('多处出现 + contextBefore：锚到前文吻合的那一处（非首次）', () => {
    // 'AAA中间BBB中间CCC'：'中间' 出现两次（去空白 hay 下标 3 与 8）
    const hit = locateInSegments(['AAA中间BBB中间CCC'], '中间', 'xxxBBB');
    expect(hit).toEqual({ startSeg: 0, startOff: 8, endSeg: 0, endOff: 9 });
  });

  it('多处出现但无 contextBefore：仍取首个（向后兼容）', () => {
    const hit = locateInSegments(['AAA中间BBB中间CCC'], '中间');
    expect(hit).toEqual({ startSeg: 0, startOff: 3, endSeg: 0, endOff: 4 });
  });
});
