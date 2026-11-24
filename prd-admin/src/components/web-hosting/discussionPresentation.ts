import type { HostedSiteCommentDto } from '../../services/real/webPages';

type ThreadLocation = { group: string; paragraph: number };
type ThreadGroup = { key: string; title: string; order: number; threads: HostedSiteCommentDto[] };

export function groupDiscussionThreads(threads: HostedSiteCommentDto[], locations?: Readonly<Record<string, ThreadLocation>>) {
  const groups = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    const location = locations?.[thread.id];
    const key = !thread.anchor ? 'page' : location?.group ?? `${thread.anchor.pagePath}:${thread.anchor.selector}`;
    const present = groups.get(key);
    if (present) {
      present.threads.push(thread);
      continue;
    }
    const order = !thread.anchor ? 0 : location?.paragraph ?? Number.MAX_SAFE_INTEGER;
    groups.set(key, { key, order, title: !thread.anchor ? '整页' : location ? `第 ${order} 段` : '原文位置', threads: [thread] });
  }
  return [...groups.values()].sort((a, b) => a.order - b.order);
}
