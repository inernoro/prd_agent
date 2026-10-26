import type { DirectoryUser } from '@/services/real/directory';

export type PastedMemberMatch = {
  name: string;
  status: 'pending' | 'matched' | 'ambiguous' | 'missing' | 'limited' | 'error';
  candidates: DirectoryUser[];
  userId?: string;
};

export function uniquePastedMemberNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

export function mergeMemberIds(selected: string[], added: string[]): string[] {
  return [...new Set([...selected, ...added])];
}

// 现有目录接口使用正则检索，姓名必须按字面量发送，不能把括号等当作表达式。
export function memberSearchQuery(name: string): string {
  return name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchPastedMember(name: string, users: DirectoryUser[], limit = 50): PastedMemberMatch {
  const normalized = name.trim().toLocaleLowerCase();
  const uniqueUsers = [...new Map(users.map((user) => [user.userId, user])).values()];
  const exact = uniqueUsers.filter((user) => user.displayName.trim().toLocaleLowerCase() === normalized);
  // 缺姓仅支持中文姓名后缀，至少两个字，最多省略两个姓氏字；不做谐音或错字猜测。
  const suffix = /^[\u3400-\u9fff]{2,}$/u.test(normalized)
    ? uniqueUsers.filter((user) => {
        const fullName = user.displayName.trim();
        const omitted = fullName.length - normalized.length;
        return omitted >= 1 && omitted <= 2 && fullName.endsWith(normalized);
      })
    : [];
  const candidates = exact.length ? exact : suffix;
  if (users.length >= limit) return { name, status: 'limited', candidates };
  if (candidates.length === 1) return { name, status: 'matched', candidates, userId: candidates[0].userId };
  return { name, status: candidates.length ? 'ambiguous' : 'missing', candidates };
}
