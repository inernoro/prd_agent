import { describe, expect, it } from 'vitest';
import { detectMentionQuery, extractMentionIds } from '@/components/MentionTextarea';

describe('MentionTextarea helpers', () => {
  const users = [
    { userId: 'u1', displayName: '张三', username: 'zhangsan' },
    { userId: 'u2', displayName: '李四', username: 'lisi' },
  ];

  it('detects mention query before caret', () => {
    expect(detectMentionQuery('你好 @张', 5)).toBe('张');
    expect(detectMentionQuery('你好 @张 世界', 6)).toBeNull();
    expect(detectMentionQuery('@', 1)).toBe('');
  });

  it('extracts mention ids from comment text', () => {
    expect(extractMentionIds('请 @张三 看一下', users)).toEqual(['u1']);
    expect(extractMentionIds('@张三 @李四 一起评审', users)).toEqual(['u1', 'u2']);
  });
});
