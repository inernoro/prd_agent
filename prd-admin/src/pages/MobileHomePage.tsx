/**
 * 移动端首页（<768px）—— App Store「Today」加厚版（2026-07-14 重构）。
 *
 * 从原「工作台/夜光」自研双皮肤整体迁到 App Store 设计系统 SSOT：
 *   头部「今日」大标题 → 继续上次 → 今日精选轮播 → 常用应用宫格
 *   → 近 7 日数据 → 每日小技巧 → 我的动态 → 推荐智能体货架 → 沉淀与档案。
 * 全部真实数据（useMobileHomeData / BUILTIN_TOOLS / APP_GRID）；
 * 双皮肤走 useAppStoreColors（暗=纯黑 #000，浅=#f2f2f7），字号/间距/圆角走 AS_* token。
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Bug,
  ChevronRight,
  Feather,
  FileText,
  FolderOpen,
  GraduationCap,
  Image as ImageIcon,
  Landmark,
  Megaphone,
  Moon,
  Newspaper,
  Share2,
  Store,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { useMobileThemeStore } from '@/stores/mobileThemeStore';
import {
  formatCompactNumber,
  formatDateline,
  formatRelativeTime,
  greetingFor,
  normalizeFeedTitle,
  recentAgentMetaFor,
  useMobileHomeData,
} from '@/pages/mobile-home/shared';
import {
  AppStoreSectionHeader,
  AppStoreResumeCard,
  AppStoreFeaturedCarousel,
  AppStoreGrid,
  AppStoreShelf,
  AppStoreTipCard,
  AppStoreAppIcon,
  type FeaturedItem,
} from '@/components/mobile/appStore';
import { AS_COLOR, AS_TYPE, AS_SPACE, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';

/* ───────────── 常用应用宫格（功能色注册） ───────────── */

const APP_GRID: Array<{ key: string; title: string; route: string; Icon: LucideIcon; tint: string }> = [
  { key: 'document-store', title: '知识库', route: '/document-store', Icon: BookOpen, tint: AS_COLOR.orange },
  { key: 'report-agent', title: '周报', route: '/report-agent', Icon: FileText, tint: AS_COLOR.blue },
  { key: 'visual-agent', title: '生图', route: '/visual-agent', Icon: ImageIcon, tint: AS_COLOR.purple },
  { key: 'defect-agent', title: '缺陷', route: '/defect-agent', Icon: Bug, tint: AS_COLOR.red },
  { key: 'literary-agent', title: '文学创作', route: '/literary-agent', Icon: Feather, tint: AS_COLOR.green },
  { key: 'marketplace', title: '海鲜市场', route: '/marketplace', Icon: Store, tint: AS_COLOR.teal },
  { key: 'daily-post', title: '米多早报', route: '/daily-post', Icon: Newspaper, tint: AS_COLOR.orange },
  { key: 'changelog', title: '更新中心', route: '/changelog', Icon: Megaphone, tint: AS_COLOR.indigo },
];

/** 沉淀与档案：历史与个人资产类入口 */
const ARCHIVE_ROWS: Array<{ key: string; title: string; desc: string; route: string; Icon: LucideIcon; tint: string }> = [
  { key: 'library', title: '智识殿堂', desc: '团队公开知识库与文章', route: '/library', Icon: Landmark, tint: AS_COLOR.purple },
  { key: 'learning-center', title: '学习中心', desc: '页面教程与掌握度', route: '/learning-center', Icon: GraduationCap, tint: AS_COLOR.green },
  { key: 'my-assets', title: '我的资产', desc: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, tint: AS_COLOR.blue },
  { key: 'my-shares', title: '我的分享', desc: '发出的分享链接管理', route: '/my/shares', Icon: Share2, tint: AS_COLOR.teal },
];

export default function MobileHomePage() {
  const navigate = useNavigate();
  const data = useMobileHomeData();
  const displayName = useAuthStore((s) => s.user?.displayName ?? '同事');
  const themeMode = useMobileThemeStore((st) => st.mode);
  const toggleTheme = useMobileThemeStore((st) => st.toggle);
  const isDark = themeMode === 'dark';
  const C = useAppStoreColors();
  const now = useMemo(() => new Date(), []);
  const { weekday } = formatDateline(now);

  const headline = data.recentWork[0] ?? null;

  // 智能体列表（移动可用），供精选轮播 + 推荐货架
  const agentTools = useMemo(
    () =>
      BUILTIN_TOOLS.filter((t) => t.kind === 'agent').filter(
        (t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only',
      ),
    [],
  );

  const featuredItems: FeaturedItem[] = useMemo(() => {
    const eyebrows = ['为你推荐', '高效创作', '团队热门'];
    return agentTools.slice(0, 3).map((t, i) => ({
      key: t.id,
      eyebrow: eyebrows[i] ?? '推荐',
      title: t.name,
      subtitle: t.description,
      accent: accentFor(t.agentKey),
      footer: { Icon: iconFor(t.icon), name: t.name, tagline: 'MAP 智能体' },
      onClick: () => navigate(t.routePath ?? `/ai-toolbox?item=${t.id}`),
      pillLabel: '打开',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentTools]);

  const shelfItems = useMemo(
    () =>
      agentTools
        .filter((t) => !APP_GRID.some((a) => a.route === t.routePath))
        .slice(0, 8)
        .map((t) => ({
          key: t.id,
          Icon: iconFor(t.icon),
          accent: accentFor(t.agentKey),
          title: t.name,
          subtitle: t.description,
          pillLabel: '打开',
          onClick: () => navigate(t.routePath ?? `/ai-toolbox?item=${t.id}`),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentTools],
  );

  const gridItems = APP_GRID.map((a) => ({
    key: a.key,
    Icon: a.Icon,
    accent: { from: a.tint, to: a.tint },
    label: a.title,
    onClick: () => navigate(a.route),
  }));

  const feedTint = (type: string): string =>
    type === 'visual-workspace' ? C.purple : type === 'defect' ? C.red : C.blue;

  const stats = [
    { label: '会话', value: data.stats?.sessions ?? 0, hot: false },
    { label: '消息', value: data.stats?.messages ?? 0, hot: false },
    { label: '生图', value: data.stats?.imageGenerations ?? 0, hot: false },
    { label: 'Token', value: data.stats?.totalTokens ?? 0, hot: true },
  ];

  return (
    <div
      className="h-full min-h-0 overflow-auto no-scrollbar"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        background: C.bg,
        color: C.label,
        fontFamily: AS_FONT_FAMILY,
        overscrollBehavior: 'contain',
      }}
    >
      <main style={{ padding: '0 0 112px', maxWidth: 720, margin: '0 auto' }}>
        {/* ── 头部：今日大标题 + 主题切换 ── */}
        <header
          className="flex items-start justify-between"
          style={{ padding: `10px ${AS_SPACE.gutter}px 0`, gap: 12 }}
        >
          <div className="min-w-0">
            <div style={{ ...AS_TYPE.heroSubtitle, color: C.labelSecondary }}>
              {greetingFor(now)}，{displayName} · {now.getMonth() + 1}月{now.getDate()}日 {weekday}
            </div>
            <h1 style={{ ...AS_TYPE.heroTitle, color: C.label, margin: '2px 0 0' }}>今日</h1>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={isDark ? '切换到浅色' : '切换到暗色'}
            className="shrink-0 flex items-center justify-center active:opacity-60 transition-opacity"
            style={{
              width: 36,
              height: 36,
              marginTop: 6,
              borderRadius: 999,
              border: `1px solid ${C.hairline}`,
              background: C.surface,
              color: C.labelSecondary,
            }}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </header>

        {/* ── 继续上次 ── */}
        {headline && (
          <div style={{ marginTop: 20 }}>
            <AppStoreResumeCard
              Icon={recentAgentMetaFor(headline.agentKey).Icon}
              accent={{
                from: recentAgentMetaFor(headline.agentKey).accent,
                to: recentAgentMetaFor(headline.agentKey).accent,
              }}
              title={headline.title || '未命名工作'}
              subtitle={`${recentAgentMetaFor(headline.agentKey).label} · ${formatRelativeTime(headline.lastActiveAt)}`}
              pillLabel="继续"
              onClick={() => navigate(headline.route)}
            />
          </div>
        )}

        {/* ── 今日精选轮播 ── */}
        {featuredItems.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <AppStoreSectionHeader title="今日精选" caption="编辑为你挑的智能体" />
            <AppStoreFeaturedCarousel items={featuredItems} aspect="16 / 11" />
          </div>
        )}

        {/* ── 常用应用宫格 ── */}
        <div style={{ marginTop: 30 }}>
          <AppStoreSectionHeader title="常用应用" onShowAll={() => navigate('/ai-toolbox')} />
          <AppStoreGrid items={gridItems} columns={4} />
        </div>

        {/* ── 近 7 日数据 ── */}
        <div style={{ marginTop: 30 }}>
          <AppStoreSectionHeader title="近 7 日数据" />
          <div style={{ padding: `0 ${AS_SPACE.gutter}px` }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                background: C.card,
                border: `1px solid ${C.hairline}`,
                borderRadius: AS_SPACE.shelfCardRadius,
                padding: '16px 4px',
              }}
            >
              {stats.map((s, idx) => (
                <div
                  key={s.label}
                  style={{ textAlign: 'center', borderLeft: idx > 0 ? `1px solid ${C.separator}` : undefined }}
                >
                  <div
                    style={{
                      ...AS_TYPE.itemTitle,
                      fontWeight: 700,
                      color: s.hot ? C.orange : C.label,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {data.loading ? '—' : formatCompactNumber(s.value)}
                  </div>
                  <div style={{ ...AS_TYPE.caption, color: C.labelTertiary, marginTop: 3 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── 每日小技巧 ── */}
        <div style={{ marginTop: 30 }}>
          <AppStoreSectionHeader title="每日小技巧" />
          <AppStoreTipCard
            Icon={BookOpen}
            accent={{ from: AS_COLOR.orange, to: AS_COLOR.yellow }}
            title="知识库支持双链 [[]]"
            desc="在任意文档里输入 [[ 就能引用另一篇，底部自动出现「被引用」反向链接。"
            actionLabel="去看看"
            onAction={() => navigate('/document-store')}
          />
        </div>

        {/* ── 我的动态 ── */}
        <div style={{ marginTop: 30 }}>
          <AppStoreSectionHeader title="我的动态" onShowAll={() => navigate('/my-assets')} />
          <div style={{ padding: `0 ${AS_SPACE.gutter}px` }}>
            <div
              style={{
                background: C.card,
                border: `1px solid ${C.hairline}`,
                borderRadius: AS_SPACE.shelfCardRadius,
                padding: '4px 14px',
              }}
            >
              {data.feed.length === 0 ? (
                <div style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary, padding: '12px 0' }}>
                  使用知识库、周报、生图或缺陷后，动态会出现在这里
                </div>
              ) : (
                data.feed.slice(0, 8).map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.navigateTo)}
                    className="w-full flex items-center text-left active:opacity-60 transition-opacity"
                    style={{ gap: 10, padding: '12px 0', borderTop: idx > 0 ? `1px solid ${C.separator}` : undefined }}
                  >
                    <span
                      aria-hidden
                      style={{ width: 7, height: 7, borderRadius: 99, background: feedTint(item.type), flex: 'none' }}
                    />
                    <span className="min-w-0 flex-1 truncate" style={{ ...AS_TYPE.itemSubtitle, color: C.label }}>
                      {normalizeFeedTitle(item)}
                    </span>
                    <span style={{ ...AS_TYPE.caption, color: C.labelTertiary, flex: 'none' }}>
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── 推荐智能体货架 ── */}
        {shelfItems.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <AppStoreSectionHeader title="推荐智能体" onShowAll={() => navigate('/ai-toolbox')} />
            <AppStoreShelf items={shelfItems} />
          </div>
        )}

        {/* ── 沉淀与档案 ── */}
        <div style={{ marginTop: 30 }}>
          <AppStoreSectionHeader title="沉淀与档案" />
          <div style={{ padding: `0 ${AS_SPACE.gutter}px` }}>
            <div
              style={{
                background: C.card,
                border: `1px solid ${C.hairline}`,
                borderRadius: AS_SPACE.shelfCardRadius,
                padding: '4px 14px',
              }}
            >
              {ARCHIVE_ROWS.map((row, idx) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => navigate(row.route)}
                  className="w-full flex items-center text-left active:opacity-60 transition-opacity"
                  style={{ gap: 12, padding: '10px 0', borderTop: idx > 0 ? `1px solid ${C.separator}` : undefined }}
                >
                  <AppStoreAppIcon Icon={row.Icon} accent={{ from: row.tint, to: row.tint }} size={38} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" style={{ ...AS_TYPE.itemTitle, color: C.label }}>
                      {row.title}
                    </span>
                    <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary, marginTop: 1 }}>
                      {row.desc}
                    </span>
                  </span>
                  <ChevronRight size={17} className="shrink-0" style={{ color: C.labelTertiary }} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── 页脚 ── */}
        <footer style={{ marginTop: 32, textAlign: 'center', ...AS_TYPE.caption, color: C.labelTertiary }}>
          MAP · 每个成员，都有一支 AI 团队
        </footer>
      </main>
    </div>
  );
}
