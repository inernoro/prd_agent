import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { useAuthStore } from '@/stores/authStore';
import { getLauncherCatalog, resolveCatalogId } from '@/lib/launcherCatalog';

/**
 * 带记账的跳转：打开智能体的地方一律走这里。
 *
 * 「你常用的」排序来自 `agentSwitcherStore` 的打开次数（服务端持久化）。
 * 记账点漏一个，那条路径的启动就永远不计数——这个洞已经被 review 抓过三次：
 * 先是首页瓦片、再是在办工作条、最后是整个移动首页（桌面收敛成一个出口之后，
 * 手机上点开的智能体照旧不计数，于是桌面的「你常用的」漏掉了用户手机上最常用的那些）。
 *
 * 所以出口只留这一个，两端共用：谁要跳转，谁把入口信息一起给。
 * 不带 `entry` 的调用表示"这不是打开某个智能体"（例如跳到列表页），照常跳、不记账。
 *
 * **目录闸也在这里**：id 落不到目录里就只跳转、不记账。
 * 记一个 findLauncherItem 查不到的 id 等于往使用统计里灌垃圾——Cmd+K 最近使用
 * 会把它丢掉，usageCounts 却一直在涨。这道闸原先写在桌面首页的调用处，
 * 结果移动端的「米多早报」照样记了个目录里没有的 id（同一个洞第二次）。
 * 放进出口本身，调用方就没有忘记它的机会。
 */
export interface TrackedEntry {
  id: string;
  agentKey?: string;
  name: string;
  icon?: string;
}

export type TrackedNavigate = (route: string, entry?: TrackedEntry) => void;

export function useTrackedNavigate(): TrackedNavigate {
  const navigate = useNavigate();
  const permissions = useAuthStore((s) => s.permissions ?? []);
  const isRoot = useAuthStore((s) => s.isRoot);
  const catalog = useMemo(() => getLauncherCatalog({ permissions, isRoot }), [permissions, isRoot]);

  return useCallback((route: string, entry?: TrackedEntry) => {
    // 规范 id 由 resolveCatalogId 解析：agentKey 与目录 id 故意不同名的有好几个
    // （/task-tree 的 appKey 是 task-tree-agent），只按 agentKey 查会解析失败，
    // 而失败在这里的后果是**整条记录被丢掉**——比记个幽灵 id 还糟。
    const canonicalId = entry ? resolveCatalogId(catalog, { id: entry.id, agentKey: entry.agentKey, route }) : undefined;
    if (entry && canonicalId) {
      useAgentSwitcherStore.getState().addRecentVisit({
        id: canonicalId,
        agentKey: entry.agentKey ?? '',
        agentName: entry.name,
        title: entry.name,
        path: route,
        icon: entry.icon,
      });
    }
    navigate(route);
  }, [navigate, catalog]);
}
