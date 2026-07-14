/**
 * 移动端首页（<768px）—— 「摘要」仪表盘（iOS 健康摘要风,2026-07-15 定稿）。
 *
 * 设计决策（用户拍板）:
 *  - 视觉语言 = Apple（iOS 系统色 / SF / 纯黑#000·白#f2f2f7 双皮肤 / 白卡 / squircle）
 *  - 布局 = 工具的脸,不是商店的脸:无海报大卡、无页内大标题/日期（AppShell 已有顶栏,不重复 chrome）
 *  - 内容排序 = 你的工作优先:继续上次 → 常用应用 → 近7日 → 动态;智能体降级为底部紧凑货架
 * 全部真实数据（useMobileHomeData / BUILTIN_TOOLS）;近7日无按日序列,只展示聚合数,不编造迷你图。
 */
import type { ReactNode } from 'react';
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
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { useMobileThemeStore } from '@/stores/mobileThemeStore';
import {
  formatCompactNumber,
  formatRelativeTime,
  normalizeFeedTitle,
  recentAgentMetaFor,
  useMobileHomeData,
} from '@/pages/mobile-home/shared';
import { AppStoreGrid, AppStoreAppIcon, AppStorePill } from '@/components/mobile/appStore';
import { AS_COLOR, AS_TYPE, AS_SPACE, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';

/* ───────────── 常用应用宫格（iOS 系统色注册） ───────────── */

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
  const themeMode = useMobileThemeStore((st) => st.mode);
  const toggleTheme = useMobileThemeStore((st) => st.toggle);
  const isDark = themeMode === 'dark';
  const C = useAppStoreColors();

  const headline = data.recentWork[0] ?? null;
  const restRecent = data.recentWork.slice(1, 3);

  // 智能体（移动可用、且不在宫格里的）→ 底部紧凑货架,降级为配角
  const agentChips = useMemo(
    () =>
      BUILTIN_TOOLS.filter((t) => t.kind === 'agent')
        .filter((t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only')
        .filter((t) => !APP_GRID.some((a) => a.route === t.routePath))
        .slice(0, 8),
    [],
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

  // 近7日聚合数（后端无按日序列,不编造迷你图）,数字按指标染 iOS 系统色
  const stats = [
    { label: '会话', value: data.stats?.sessions ?? 0, color: C.blue },
    { label: '消息', value: data.stats?.messages ?? 0, color: C.green },
    { label: '生图', value: data.stats?.imageGenerations ?? 0, color: C.purple },
    { label: 'Token', value: data.stats?.totalTokens ?? 0, color: C.orange },
  ];

  const cardStyle = { background: C.card, border: `1px solid ${C.hairline}`, borderRadius: 16 } as const;

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
      <main style={{ padding: '4px 0 112px', maxWidth: 720, margin: '0 auto' }}>

        {/* ── 继续上次（主角;标题行右侧带主题切换,规则:首页可切换明暗） ── */}
        {headline && (
          <Section
            C={C}
            title="继续上次"
            right={
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={isDark ? '切换到浅色' : '切换到暗色'}
                className="flex items-center justify-center active:opacity-60 transition-opacity"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: `1px solid ${C.hairline}`,
                  background: C.card,
                  color: C.labelSecondary,
                }}
              >
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            }
          >
            <div style={{ ...cardStyle, padding: 14 }}>
              <button
                type="button"
                onClick={() => navigate(headline.route)}
                className="w-full flex items-center gap-3 text-left active:opacity-60 transition-opacity"
              >
                <AppStoreAppIcon
                  Icon={recentAgentMetaFor(headline.agentKey).Icon}
                  accent={{ from: recentAgentMetaFor(headline.agentKey).accent, to: recentAgentMetaFor(headline.agentKey).accent }}
                  size={46}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" style={{ ...AS_TYPE.itemTitle, color: C.label }}>
                    {headline.title || '未命名工作'}
                  </span>
                  <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary, marginTop: 2 }}>
                    {recentAgentMetaFor(headline.agentKey).label} · {formatRelativeTime(headline.lastActiveAt)}
                  </span>
                </span>
                <AppStorePill label="继续" onClick={(e) => { e.stopPropagation(); navigate(headline.route); }} />
              </button>
              {restRecent.map((item) => {
                const meta = recentAgentMetaFor(item.agentKey);
                return (
                  <button
                    key={`${item.route}-${item.lastActiveAt}`}
                    type="button"
                    onClick={() => navigate(item.route)}
                    className="w-full flex items-center gap-2.5 text-left active:opacity-60 transition-opacity"
                    style={{ padding: '10px 2px 0', marginTop: 10, borderTop: `1px solid ${C.separator}` }}
                  >
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: meta.accent, flex: 'none' }} />
                    <span className="min-w-0 flex-1 truncate" style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary }}>
                      {item.title || '未命名工作'}
                    </span>
                    <span style={{ ...AS_TYPE.caption, color: C.labelTertiary, flex: 'none' }}>
                      {meta.label} · {formatRelativeTime(item.lastActiveAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── 常用应用 ── */}
        <Section C={C} title="常用应用" action={{ label: '全部', onClick: () => navigate('/ai-toolbox') }}>
          <div style={{ ...cardStyle, padding: '16px 0' }}>
            <AppStoreGrid items={gridItems} columns={4} />
          </div>
        </Section>

        {/* ── 近 7 日 ── */}
        <Section C={C} title="近 7 日">
          <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', padding: '16px 4px' }}>
            {stats.map((s, idx) => (
              <div key={s.label} style={{ textAlign: 'center', borderLeft: idx > 0 ? `1px solid ${C.separator}` : undefined }}>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    color: s.color,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {data.loading ? '—' : formatCompactNumber(s.value)}
                </div>
                <div style={{ ...AS_TYPE.caption, color: C.labelSecondary, marginTop: 3 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 我的动态 ── */}
        <Section C={C} title="我的动态" action={{ label: '全部', onClick: () => navigate('/my-assets') }}>
          <div style={{ ...cardStyle, padding: '4px 14px' }}>
            {data.feed.length === 0 ? (
              <div style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary, padding: '12px 0' }}>
                使用知识库、周报、生图或缺陷后，动态会出现在这里
              </div>
            ) : (
              data.feed.slice(0, 6).map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.navigateTo)}
                  className="w-full flex items-center text-left active:opacity-60 transition-opacity"
                  style={{ gap: 10, padding: '12px 0', borderTop: idx > 0 ? `1px solid ${C.separator}` : undefined }}
                >
                  <span aria-hidden style={{ width: 7, height: 7, borderRadius: 99, background: feedTint(item.type), flex: 'none' }} />
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
        </Section>

        {/* ── 智能体:降级为紧凑横滑货架（非核心,放低放小） ── */}
        {agentChips.length > 0 && (
          <>
            <div
              className="flex items-end justify-between"
              style={{ padding: `28px ${AS_SPACE.gutter}px 10px`, gap: 12 }}
            >
              <span style={{ ...AS_TYPE.itemTitle, color: C.labelSecondary }}>试试这些智能体</span>
              <button
                type="button"
                onClick={() => navigate('/ai-toolbox')}
                className="active:opacity-60 transition-opacity"
                style={{ ...AS_TYPE.itemSubtitle, color: C.blue }}
              >
                全部
              </button>
            </div>
            <div
              className="flex overflow-x-auto"
              style={{
                gap: 10,
                padding: `0 ${AS_SPACE.gutter}px 4px`,
                scrollbarWidth: 'none',
                WebkitOverflowScrolling: 'touch',
                overscrollBehaviorX: 'contain',
              }}
            >
              {agentChips.map((t) => {
                const Icon = iconFor(t.icon);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => navigate(t.routePath ?? `/ai-toolbox?item=${t.id}`)}
                    className="shrink-0 flex items-center text-left active:opacity-60 transition-opacity"
                    style={{ ...cardStyle, gap: 10, padding: '10px 14px 10px 10px' }}
                  >
                    <AppStoreAppIcon Icon={Icon} accent={accentFor(t.agentKey)} size={36} />
                    <span className="whitespace-nowrap" style={{ ...AS_TYPE.itemSubtitle, fontWeight: 600, color: C.label }}>
                      {t.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── 沉淀与档案 ── */}
        <Section C={C} title="沉淀与档案">
          <div style={{ ...cardStyle, padding: '4px 14px' }}>
            {ARCHIVE_ROWS.map((row, idx) => (
              <button
                key={row.key}
                type="button"
                onClick={() => navigate(row.route)}
                className="w-full flex items-center text-left active:opacity-60 transition-opacity"
                style={{ gap: 12, padding: '10px 0', borderTop: idx > 0 ? `1px solid ${C.separator}` : undefined }}
              >
                <AppStoreAppIcon Icon={row.Icon} accent={{ from: row.tint, to: row.tint }} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, fontWeight: 600, color: C.label }}>
                    {row.title}
                  </span>
                  <span className="block truncate" style={{ ...AS_TYPE.caption, color: C.labelSecondary, marginTop: 1 }}>
                    {row.desc}
                  </span>
                </span>
                <ChevronRight size={16} className="shrink-0" style={{ color: C.labelTertiary }} />
              </button>
            ))}
          </div>
        </Section>

        {/* ── 页脚 ── */}
        <footer style={{ marginTop: 30, textAlign: 'center', ...AS_TYPE.caption, color: C.labelTertiary }}>
          MAP · 每个成员，都有一支 AI 团队
        </footer>
      </main>
    </div>
  );
}

/* ───────────── 区块壳:紧凑标题（AS_TYPE.groupTitle 20px）+ 可选行动点/右侧插槽 ───────────── */

function Section({
  C,
  title,
  action,
  right,
  children,
}: {
  C: ReturnType<typeof useAppStoreColors>;
  title: string;
  action?: { label: string; onClick: () => void };
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ padding: `0 ${AS_SPACE.gutter}px`, marginTop: 24 }}>
      <div className="flex items-end justify-between" style={{ marginBottom: 10, gap: 12 }}>
        <span style={{ ...AS_TYPE.groupTitle, color: C.label }}>{title}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="active:opacity-60 transition-opacity"
            style={{ ...AS_TYPE.pill, fontWeight: 400, color: C.blue }}
          >
            {action.label}
          </button>
        )}
        {right}
      </div>
      {children}
    </section>
  );
}
