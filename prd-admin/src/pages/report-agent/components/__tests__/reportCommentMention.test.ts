import { describe, expect, it } from 'vitest';
import { detectMentionQuery } from '@/components/MentionTextarea';
import { toMentionUsers } from '../ReportCommentComposer';
import type { ReportTeamMember } from '@/services/contracts/reportAgent';

function member(partial: Partial<ReportTeamMember>): ReportTeamMember {
  return {
    id: partial.userId ?? 'm1',
    teamId: 't1',
    userId: partial.userId ?? 'u1',
    role: 'member',
    joinedAt: '2026-08-19T00:00:00Z',
    ...partial,
  } as ReportTeamMember;
}

describe('周报评论 @ 候选', () => {
  it('把团队成员映射成 @ 候选', () => {
    const users = toMentionUsers([
      member({ userId: 'u-yang', userName: '杨锐聪', avatarFileName: 'a.png' }),
    ]);
    expect(users).toEqual([{ userId: 'u-yang', displayName: '杨锐聪', avatarFileName: 'a.png' }]);
  });

  it('剔除没有名字的成员，避免下拉里出现一串 userId', () => {
    const users = toMentionUsers([
      member({ userId: 'u-1', userName: '杨锐聪' }),
      member({ userId: 'u-2', userName: '   ' }),
      member({ userId: 'u-3' }),
    ]);
    expect(users.map((u) => u.userId)).toEqual(['u-1']);
  });

  it('名字两端空格被裁掉（要与服务端按 @名字 解析的口径一致）', () => {
    expect(toMentionUsers([member({ userId: 'u-1', userName: ' 杨锐聪 ' })])[0].displayName).toBe('杨锐聪');
  });
});

describe('@ 检索词识别（决定下拉何时出现）', () => {
  it('光标紧跟 @ 时给出空检索词，列出全部候选', () => {
    expect(detectMentionQuery('请 @', 4)).toBe('');
  });

  it('继续输入时按已输入的部分过滤', () => {
    expect(detectMentionQuery('请 @杨', 5)).toBe('杨');
  });

  it('@ 后打了空格即视为输入结束，不再弹下拉', () => {
    expect(detectMentionQuery('请 @杨锐聪 关注', 9)).toBeNull();
  });

  it('正文里没有 @ 时不弹下拉', () => {
    expect(detectMentionQuery('这周进度正常', 6)).toBeNull();
  });
});
