/**
 * 移动首页双模板共享层：数据 hook + 快捷入口注册 + 格式化工具。
 *
 * 两个模板（早报 / 工作台）消费同一份真实数据，只在视觉表达上分叉：
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
import { getMobileFeed, getMobileStats, listRecentWork } from '@/services';
import type { RecentWorkItemDto } from '@/services';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';

export type MobileHomeTemplateKey = 'post' | 'console';

export const TEMPLATE_STORAGE_KEY = 'mobile-home-template-v1';

export function readTemplatePreference(): MobileHomeTemplateKey {
  try {
    const raw = sessionStorage.getItem(TEMPLATE_STORAGE_KEY);
    return raw === 'console' ? 'console' : 'post';
  } catch {
    return 'post';
  }
}

export function writeTemplatePreference(key: MobileHomeTemplateKey): void {
  try {
    sessionStorage.setItem(TEMPLATE_STORAGE_KEY, key);
  } catch {
    /* sessionStorage 不可用时静默降级为「不记忆」 */
  }
}

/* ───────────── 快捷入口（两个模板共用同一份注册，仅样式分叉） ───────────── */

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
  { key: 'visual-agent', title: '生图', desc: '文生图、图生图与配图', route: '/visual-agent', Icon: ImageIcon, accent: '#A78BFA' },
  { key: 'defect-agent', title: '缺陷', desc: '提交、跟踪与复盘问题', route: '/defect-agent', Icon: Bug, accent: '#FB7185' },
  { key: 'literary-agent', title: '文学创作', desc: '长文写作与润色', route: '/literary-agent', Icon: Feather, accent: '#34D399' },
  { key: 'marketplace', title: '海鲜市场', desc: '技能与配置市场', route: '/marketplace', Icon: Store, accent: '#FBBF24' },
  { key: 'my-assets', title: '我的资产', desc: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, accent: '#60A5FA' },
  { key: 'changelog', title: '更新中心', desc: '版本动态与周报', route: '/changelog', Icon: Newspaper, accent: '#F472B6' },
];

/** 「档案室 / 底蕴」入口：历史与沉淀类页面 */
export const ARCHIVE_ENTRIES: Array<{ key: string; title: string; desc: string; route: string }> = [
  { key: 'changelog', title: '更新中心', desc: '每周更新记录与发版历史', route: '/changelog' },
  { key: 'library', title: '智识殿堂', desc: '团队公开知识库与文章', route: '/library' },
  { key: 'learning-center', title: '学习中心', desc: '页面教程与掌握度', route: '/learning-center' },
];

/** 继续上次条目的 agent 元信息（图标 + 中文名） */
export const RECENT_AGENT_META: Record<string, { label: string; Icon: LucideIcon; accent: string }> = {
  'visual-agent': { label: '视觉创作', Icon: ImageIcon, accent: '#A78BFA' },
  'literary-agent': { label: '文学创作', Icon: Feather, accent: '#34D399' },
  'workflow-agent': { label: '工作流', Icon: FolderOpen, accent: '#7DD3FC' },
};

/* ───────────── 数据 hook ───────────── */

export interface MobileHomeData {
  feed: FeedItem[];
  stats: MobileStats | null;
  recentWork: RecentWorkItemDto[];
  changelogUnread: number;
  loading: boolean;
}

export function useMobileHomeData(): MobileHomeData {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<MobileStats | null>(null);
  const [recentWork, setRecentWork] = useState<RecentWorkItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const changelogUnread = useChangelogStore(selectUnreadCount);

  useEffect(() => {
    let alive = true;
    void loadCurrentWeek();
    (async () => {
      const [feedRes, statsRes, recentRes] = await Promise.all([
        getMobileFeed({ limit: 8 }),
        getMobileStats({ days: 7 }),
        listRecentWork({ limit: 8 }),
      ]);
      if (!alive) return;
      if (feedRes.success) setFeed(feedRes.data.items ?? []);
      if (statsRes.success) setStats(statsRes.data);
      if (recentRes.success) setRecentWork(recentRes.data.items ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadCurrentWeek]);

  return { feed, stats, recentWork, changelogUnread, loading };
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
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}

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
