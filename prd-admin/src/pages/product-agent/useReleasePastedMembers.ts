import { useCallback, useEffect, useRef, useState } from 'react';
import { searchDirectoryUsers } from '@/services/real/directory';
import { matchPastedMember, memberSearchQuery, uniquePastedMemberNames, type PastedMemberMatch } from './releaseMemberMatching';

/** 仅处理申领草稿的选人提示，不修改产品团队、账号或权限。 */
export function useReleasePastedMembers(enabled: boolean, onMatched: (ids: string[]) => void) {
  const [matches, setMatches] = useState<PastedMemberMatch[]>([]);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { sequence.current += 1; controller.current?.abort(); }, [enabled]);

  const identify = useCallback((names: string[]) => {
    if (!enabled) return;
    const current = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const pending = uniquePastedMemberNames(names);
    setMatches(pending.map((name) => ({ name, status: 'pending', candidates: [] })));
    let next = 0;
    const worker = async () => {
      while (current === sequence.current && next < pending.length) {
        const name = pending[next++];
        let result: PastedMemberMatch;
        try {
          const response = await searchDirectoryUsers(memberSearchQuery(name), 50, { signal: request.signal, timeoutMs: 10000 });
          result = response.success
            ? matchPastedMember(name, response.data.items)
            : { name, status: 'error', candidates: [] };
        } catch {
          result = { name, status: 'error', candidates: [] };
        }
        if (current !== sequence.current) return;
        setMatches((previous) => previous.map((item) => item.name === name ? result : item));
        if (result.userId) onMatched([result.userId]);
      }
    };
    // 独立于方案/应用加载，先粘贴或后选应用都使用同一份草稿成员。
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  }, [enabled, onMatched]);

  const choose = (name: string, userId: string) => {
    const match = matches.find((item) => item.name === name);
    if (!match?.candidates.some((user) => user.userId === userId)) return;
    setMatches((previous) => previous.map((item) => item.name === name ? { ...item, status: 'matched', userId } : item));
    onMatched([userId]);
  };

  return { matches, identify, choose, pendingCount: matches.filter((item) => item.status === 'pending').length };
}
