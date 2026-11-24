import type { RecentWorkItemDto } from '@/services/contracts/homeRecentWork';

/**
 * 为首页在办工作生成稳定 React key。
 *
 * route 不是工作实例标识，同一智能体可以返回多条相同路径的工作。优先用现有
 * 业务字段组成身份；只有业务字段也完全重复时，才用同身份条目的出现次序兜底。
 */
export function withRecentWorkReactKeys(items: RecentWorkItemDto[]) {
  const occurrences = new Map<string, number>();

  return items.map((item) => {
    const businessKey = JSON.stringify([
      item.agentKey,
      item.route,
      item.title,
      item.lastActiveAt,
    ]);
    const occurrence = occurrences.get(businessKey) ?? 0;
    occurrences.set(businessKey, occurrence + 1);

    return {
      item,
      reactKey: occurrence === 0 ? businessKey : `${businessKey}#${occurrence}`,
    };
  });
}
