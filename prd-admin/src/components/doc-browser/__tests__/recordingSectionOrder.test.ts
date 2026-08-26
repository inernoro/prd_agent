/**
 * 录音结果页的区块顺序与两个新部件的接线守卫。
 *
 * 为什么要这条：
 *   - 「一键整理」那块网格删掉之后，页面照样渲染、全量测试照样绿——只是选整理方式的
 *     入口没了，产出还在，用户看得到结果却找不到从哪生成（形状 2：只建一半）。
 *   - 它排在纪要/待办**后面**时同样不会红，但两级关系反了：读者先看见产出、
 *     翻到底才看见入口。第一轮 B3 判分丢的 25 分里，一半出在这个顺序上。
 *   - 「当前片段条」与「提问输入区」抽成了独立组件，抽完不接回去，
 *     产品那一屏就少了这两块，而对照台仍然摆得出来（判的是副本，形状 6）。
 *
 * 断言的是**顺序与接线**这件事本身，不逐字比对样式——改写法不该让守卫误红（形状 4a）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(HERE, '..', rel), 'utf8');
const KARAOKE = read('TranscriptKaraoke.tsx');

/** 取某段文本在源码里的位置；找不到直接让断言失败，而不是拿 -1 去比大小 */
function at(needle: string): number {
  const index = KARAOKE.indexOf(needle);
  expect(index, `源码里找不到「${needle}」`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('结果页区块顺序（稿面 B1 + B3 + P3 的并集）', () => {
  it('原文列表紧跟播放区，排在词云之前', () => {
    expect(at('搜索原文关键词')).toBeLessThan(at('>词云<'));
  });

  it('一键整理排在词云之后、会议纪要之前——入口在上、产出在下', () => {
    const understand = at('>词云<');
    const organize = at('<OrganizeStylePanel');
    const summary = at('>会议纪要<');
    const todo = at('>待办事项<');
    expect(organize).toBeGreaterThan(understand);
    expect(organize).toBeLessThan(summary);
    expect(summary).toBeLessThan(todo);
  });

  it('问这场录音在最后', () => {
    expect(at('>问这场录音<')).toBeGreaterThan(at('>待办事项<'));
  });
});

describe('抽出去的两个部件必须接回产品页', () => {
  it('折叠态播放条用的是 RecordingSegmentBar 本体，不是就地重画一份', () => {
    expect(KARAOKE).toContain("from '@/components/doc-browser/RecordingSegmentBar'");
    expect(KARAOKE).toContain('<RecordingSegmentBar');
  });

  it('提问输入区用的是 RecordingAskComposer 本体', () => {
    expect(KARAOKE).toContain("from '@/components/doc-browser/RecordingAskComposer'");
    expect(KARAOKE).toContain('<RecordingAskComposer');
  });

  it('对照台摆的也是这两份本体（判的不能是副本）', () => {
    const mock = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'dev', 'recordingConsistencyMock.tsx'), 'utf8');
    expect(mock).toContain('<RecordingSegmentBar');
    expect(mock).toContain('<RecordingAskComposer');
  });
});

describe('改一句原文时自动跟随必须让位', () => {
  it('正在编辑就不自动滚——光标还在框里，列表不该把这句滚走', () => {
    expect(KARAOKE).toMatch(/if \(editingIndex !== null\) return;/);
  });

  it('跟丢了要给得出「继续跟随播放」的浮动出口', () => {
    expect(KARAOKE).toContain('继续跟随播放');
    // 跟丢 = 手动滚过 或 正在改某一句；少判一种就有一半场景没有出口
    expect(KARAOKE).toMatch(/followPaused \|\| editingIndex !== null/);
  });
});
