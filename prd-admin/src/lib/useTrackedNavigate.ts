import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { migrateLegacyNavId } from '@/lib/launcherCatalog';

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
  return useCallback((route: string, entry?: TrackedEntry) => {
    if (entry) {
      useAgentSwitcherStore.getState().addRecentVisit({
        // 首页历史上用过 __xxx__ 形态，统一交给 migrateLegacyNavId 归一到命令面板同款 id
        id: migrateLegacyNavId(entry.agentKey || entry.id),
        agentKey: entry.agentKey ?? '',
        agentName: entry.name,
        title: entry.name,
        path: route,
        icon: entry.icon,
      });
    }
    navigate(route);
  }, [navigate]);
}
