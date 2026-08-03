/**
 * 移动首页 + 米多早报（/daily-post）共享层：数据 hook + 快捷入口注册 + 格式化工具。
 *
 * 两个页面消费同一份真实数据，只在视觉表达上分叉：
 *  - getMobileStats  近 7 日使用统计（会话/消息/生图/Token）
 *  - listRecentWork  「继续上次」工作现场（与桌面首页同一后端口径）
 *  - getMobileFeed   我的动态
 *  - changelog 未读数（更新中心徽章）
 */
import { useEffect, useState } from 'react';
import {
  BookOpen,
  Bug,
  Feather,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Newspaper,
  Store,
  type LucideIcon,
} from 'lucide-react';
import { listRecentWork } from '@/services';
import type { RecentWorkItemDto } from '@/services';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';
import { useHomePulse } from '@/lib/homePulse';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';

/* ───────────── 快捷入口（首页与早报共用同一份注册，仅样式分叉） ───────────── */

export interface QuickEntry {
  key: string;
  title: string;
  desc: string;
  route: string;
  Icon: LucideIcon;
  accent: string;
}

/** 8 个移动端可用的高频入口（均为 mobileCompatibility full/未受限路由） */
export const QUICK_ENTRIES: QuickEntry[] = [
  { key: 'document-store', title: '知识库', desc: '文档沉淀与资料管理', route: '/document-store', Icon: BookOpen, accent: '#FFB340' },
  { key: 'report-agent', title: '周报', desc: '生成、整理与审阅周报', route: '/report-agent', Icon: FileText, accent: '#7DD3FC' },
  { key: 'visual-agent', title: '生图', desc: '文生图、图生图与配图', route: '/visual-agent', Icon: ImageIcon, accent: '#D97757' },
  { key: 'defect-agent', title: '缺陷', desc: '提交、跟踪与复盘问题', route: '/defect-agent', Icon: Bug, accent: '#FB7185' },
  { key: 'literary-agent', title: '文学创作', desc: '长文写作与润色', route: '/literary-agent', Icon: Feather, accent: '#34D399' },
  { key: 'marketplace', title: '海鲜市场', desc: '技能与配置市场', route: '/marketplace', Icon: Store, accent: '#FBBF24' },
  { key: 'my-assets', title: '我的资产', desc: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, accent: '#60A5FA' },
  { key: 'changelog', title: '更新中心', desc: '版本动态与周报', route: '/changelog', Icon: Newspaper, accent: '#4FD1C5' },
];

/** 「档案室 / 底蕴」入口：历史与沉淀类页面 */
export const ARCHIVE_ENTRIES: Array<{ key: string; title: string; desc: string; route: string }> = [
  { key: 'changelog', title: '更新中心', desc: '每周更新记录与发版历史', route: '/changelog' },
  { key: 'library', title: '智识殿堂', desc: '团队公开知识库与文章', route: '/library' },
  { key: 'learning-center', title: '学习中心', desc: '页面教程与掌握度', route: '/learning-center' },
];

/** 继续上次条目的 agent 元信息（图标 + 中文名）。
 * 后端 recent-work 实际会返回 document-store 等 key（真实预览取证发现），
 * 未覆盖的 key 由 recentAgentMetaFor 兜底成「智能体」而非裸英文。 */
export const RECENT_AGENT_META: Record<string, { label: string; Icon: LucideIcon; accent: string }> = {
  'visual-agent': { label: '视觉创作', Icon: ImageIcon, accent: '#D97757' },
  'literary-agent': { label: '文学创作', Icon: Feather, accent: '#34D399' },
  'workflow-agent': { label: '工作流', Icon: FolderOpen, accent: '#7DD3FC' },
  'document-store': { label: '知识库', Icon: BookOpen, accent: '#FFB340' },
  'defect-agent': { label: '缺陷管理', Icon: Bug, accent: '#FB7185' },
  'report-agent': { label: '周报', Icon: FileText, accent: '#7DD3FC' },
};

export function recentAgentMetaFor(agentKey: string): { label: string; Icon: LucideIcon; accent: string } {
  return RECENT_AGENT_META[agentKey] ?? { label: '智能体', Icon: FolderOpen, accent: '#FF9F0A' };
}

/* ───────────── 数据 hook ───────────── */

export interface MobileHomeData {
  feed: FeedItem[];
  stats: MobileStats | null;
  recentWork: RecentWorkItemDto[];
  changelogUnread: number;
  loading: boolean;
  /** 用量没取到（网络 / 服务不可用），不是「用量为零」 */
  statsFailed: boolean;
  /** 动态没取到，不是「还没有动态」 */
  feedFailed: boolean;
  /** 请求成功但后端有来源查挂了：列表不完整 */
  feedDegraded: boolean;
  /** 重新拉一次「近 7 日 + 我的动态」 */
  reload: () => void;
}

/**
 * 移动首页数据。近 7 日与我的动态直接复用 `lib/homePulse`——
 * 两端同一个 hook，数字对不上和「失败被渲染成空」这两类问题只需要修一处。
 * 「继续上次」是移动端独有的，留在本地。
 */
export function useMobileHomeData(): MobileHomeData {
  const pulse = useHomePulse(8);
  const [recentWork, setRecentWork] = useState<RecentWorkItemDto[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const changelogUnread = useChangelogStore(selectUnreadCount);

  useEffect(() => {
    let alive = true;
    void loadCurrentWeek();
    (async () => {
      const recentRes = await listRecentWork({ limit: 8 });
      if (!alive) return;
      if (recentRes.success) setRecentWork(recentRes.data.items ?? []);
      setRecentLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadCurrentWeek]);

  return {
    feed: pulse.feed,
    stats: pulse.stats,
    recentWork,
    changelogUnread,
    loading: pulse.loading || recentLoading,
    statsFailed: pulse.statsFailed,
    feedFailed: pulse.feedFailed,
    feedDegraded: pulse.feedDegraded,
    reload: pulse.reload,
  };
}

/* ───────────── 格式化 ───────────── */

export function normalizeFeedTitle(item: FeedItem): string {
  if (item.type === 'visual-workspace') return `生成了一张配图：${item.title}`;
  if (item.type === 'defect') return `更新了缺陷：${item.title}`;
  return `更新了知识内容：${item.title}`;
}

export function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '刚刚';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  if (diff < 48 * 60 * 60_000) return '昨天';
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}

/** 大数字压缩显示：12480 → 1.2万；980 → 980 */
// 紧凑计数的 SSOT 在 lib/homePulse（桌面首页同样消费），这里只做转出
export { formatCompactNumber } from '@/lib/homePulse';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function formatDateline(now: Date): { dateText: string; weekday: string } {
  return {
    dateText: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    weekday: `星期${WEEKDAYS[now.getDay()]}`,
  };
}

export function greetingFor(now: Date): string {
  const h = now.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
