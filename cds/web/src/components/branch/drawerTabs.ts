/**
 * 分支详情抽屉的页签定义（SSOT）。
 *
 * 单独成文件是为了让加载骨架（BranchDrawerSkeleton）与抽屉本体共用同一张表：
 * 骨架期的页签条与数据到达后的页签条必须一字不差，否则加载完成那一帧会「换一副骨架」。
 *
 * 方案 A「六问」分类（2026-07-26 用户拍板，9 页签收敛为 6）：每个页签回答一个问题。
 *   总览=现在怎么样（原详情 + 指标并入）；运行=跑着几个怎么分流；
 *   部署=发生过什么发布（构建日志内联到每条部署，不再跳页签）；
 *   日志=容器在说什么（只留持续流：容器/系统/Webhook/HTTP，构建模式移除归部署）；
 *   配置=下次怎么跑（生效变量 + 配置检查器 + 分支设置三分区）；资源=数据在哪。
 * 分类原则：一次性记录跟事件走、持续流水跟对象走、读与写同域合并。
 */
export type DrawerTab = 'overview' | 'run' | 'deployments' | 'services' | 'logs' | 'variables' | 'config' | 'metrics' | 'settings';

export const drawerTabs: Array<{ key: DrawerTab; label: string; planned?: boolean }> = [
  { key: 'overview', label: '总览' },
  { key: 'run', label: '运行' },
  { key: 'deployments', label: '部署' },
  { key: 'logs', label: '日志' },
  { key: 'config', label: '配置' },
  { key: 'services', label: '资源' },
];

/** 页签按钮的样式（骨架期与真实页签共用，保证两帧之间一像素不跳） */
export const DRAWER_TAB_BUTTON_CLASS = 'relative inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-sm transition-colors';
export const DRAWER_TAB_NAV_CLASS = 'cds-branch-detail-tabs sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3';
