import { describe, expect, it } from 'vitest';
import { describeTranscriptOutcome } from '../transcriptSegments';

const WITH_EVERYTHING = `# 用户访谈

## 摘要

导入是这一版最大的漏斗。

- [ ] 把导入拆成两步
- [ ] 补一条进度反馈

## 转录全文

**[00:00 - 00:03]** [主持人] 你第一次导入的时候最不确定的是什么？
**[00:03 - 00:06]** [受访者 A] 等待解析那 40 秒，我以为它卡死了。
**[00:06 - 00:09]** [主持人] 如果导入时能看到进度呢？
`;

const BARE = `# 现场速记

## 转录全文

**[00:04 - 00:09]** 先把桌子挪到窗边。
**[00:11 - 00:16]** 麦克风离得太近了。
`;

describe('describeTranscriptOutcome', () => {
  it('句数、说话人、纪要、待办四项都数自这份原文', () => {
    expect(describeTranscriptOutcome(WITH_EVERYTHING)).toEqual({
      sentences: 3,
      speakers: 2,
      hasSummary: true,
      hasTodos: true,
    });
  });

  it('没有说话人标签时说话人数是 0，不是「1 位」', () => {
    const bare = describeTranscriptOutcome(BARE);
    expect(bare.sentences).toBe(2);
    expect(bare.speakers).toBe(0);
    expect(bare.hasSummary).toBe(false);
    expect(bare.hasTodos).toBe(false);
  });

  it('空文档不会数出句子来', () => {
    expect(describeTranscriptOutcome('').sentences).toBe(0);
  });
});
