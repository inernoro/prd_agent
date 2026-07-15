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
import { AgentCardArtwork, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';
import {
  formatCompactNumber,
  formatRelativeTime,
  normalizeFeedTitle,
  recentAgentMetaFor,
  useMobileHomeData,
} from '@/pages/mobile-home/shared';
import { AppStoreGrid, AppStoreAppIcon, AppStorePillLabel } from '@/components/mobile/appStore';
import { AS_COLOR, AS_TYPE, AS_SPACE, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';

/* ───────────── 常用应用宫格（iOS 双色渐变——平色显廉价,渐变才是 iOS icon 质感） ───────────── */

type Grad = { from: string; to: string };

const APP_GRID: Array<{ key: string; title: string; route: string; Icon: LucideIcon; accent: Grad }> = [
  { key: 'document-store', title: '知识库', route: '/document-store', Icon: BookOpen, accent: { from: AS_COLOR.orange, to: '#FFB340' } },
  { key: 'report-agent', title: '周报', route: '/report-agent', Icon: FileText, accent: { from: AS_COLOR.blue, to: AS_COLOR.indigo } },
  { key: 'visual-agent', title: '生图', route: '/visual-agent', Icon: ImageIcon, accent: { from: AS_COLOR.purple, to: AS_COLOR.indigo } },
  { key: 'defect-agent', title: '缺陷', route: '/defect-agent', Icon: Bug, accent: { from: AS_COLOR.red, to: AS_COLOR.pink } },
  { key: 'literary-agent', title: '文学创作', route: '/literary-agent', Icon: Feather, accent: { from: AS_COLOR.green, to: AS_COLOR.teal } },
  { key: 'marketplace', title: '海鲜市场', route: '/marketplace', Icon: Store, accent: { from: '#32ADE6', to: AS_COLOR.teal } },
  { key: 'daily-post', title: '米多早报', route: '/daily-post', Icon: Newspaper, accent: { from: '#C05B3C', to: AS_COLOR.orange } },
  { key: 'changelog', title: '更新中心', route: '/changelog', Icon: Megaphone, accent: { from: AS_COLOR.indigo, to: AS_COLOR.purple } },
];

/** 沉淀与档案：历史与个人资产类入口 */
const ARCHIVE_ROWS: Array<{ key: string; title: string; desc: string; route: string; Icon: LucideIcon; accent: Grad }> = [
  { key: 'library', title: '智识殿堂', desc: '团队公开知识库与文章', route: '/library', Icon: Landmark, accent: { from: AS_COLOR.purple, to: AS_COLOR.indigo } },
  { key: 'learning-center', title: '学习中心', desc: '页面教程与掌握度', route: '/learning-center', Icon: GraduationCap, accent: { from: AS_COLOR.green, to: AS_COLOR.teal } },
  { key: 'my-assets', title: '我的资产', desc: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, accent: { from: AS_COLOR.blue, to: AS_COLOR.teal } },
  { key: 'my-shares', title: '我的分享', desc: '发出的分享链接管理', route: '/my/shares', Icon: Share2, accent: { from: '#32ADE6', to: AS_COLOR.blue } },
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
    accent: a.accent,
    label: a.title,
    badge: a.key === 'changelog' && data.changelogUnread > 0 ? data.changelogUnread : undefined,
    onClick: () => navigate(a.route),
  }));

  const feedTint = (type: string): string =>
    type === 'visual-workspace' ? C.purple : type === 'defect' ? C.red : C.blue;

  // 近7日:聚合大数 + 真实按日序列(后端 /api/mobile/stats 的 daily,按用户时区切日)。
  // 指标口径 2026-07-15 用户拍板:会话/消息是桌面 PRD 解读时代的死指标(恒 0),
  // 换成当前真实用量——AI 调用(LLM 请求)/ 生图 / 缺陷 / Token。
  const daily = data.stats?.daily ?? [];
  const stats = [
    { label: 'AI 调用', value: data.stats?.aiCalls ?? 0, color: C.blue, series: daily.map((d) => d.aiCalls ?? 0) },
    { label: '生图', value: data.stats?.imageGenerations ?? 0, color: C.purple, series: daily.map((d) => d.imageGenerations) },
    { label: '缺陷', value: data.stats?.defects ?? 0, color: C.red, series: daily.map((d) => d.defects ?? 0) },
    { label: 'Token', value: data.stats?.totalTokens ?? 0, color: C.orange, series: daily.map((d) => d.tokens) },
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

        {/* ── 主题切换必须无条件可达(Codex P2:不能被 recentWork 空态吞掉唯一的明暗开关) ── */}
        {(() => {
          const themeToggle = (
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
          );
          if (!headline) {
            return (
              <div className="flex justify-end" style={{ padding: `8px ${AS_SPACE.gutter}px 0` }}>
                {themeToggle}
              </div>
            );
          }
          return (
          <Section
            C={C}
            title="继续上次"
            right={themeToggle}
          >
            <div style={{ ...cardStyle, padding: 14 }}>
              <button
                type="button"
                onClick={() => navigate(headline.route)}
                className="w-full flex items-center gap-3 text-left active:opacity-60 transition-opacity"
              >
                <AppStoreAppIcon
                  Icon={recentAgentMetaFor(headline.agentKey).Icon}
                  accent={accentFor(headline.agentKey)}
                  size={46}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" style={{ ...AS_TYPE.itemTitle, color: C.label }}>
                    {headline.title || '未命名工作'}
                  </span>
                  <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, color: C.labelSecondary, marginTop: 2 }}>
                    {recentAgentMetaFor(headline.agentKey).label}
                    {headline.progressLabel ? ` · ${headline.progressLabel}` : ''} · {formatRelativeTime(headline.lastActiveAt)}
                  </span>
                  {/* 诚实进度条:仅带状态机的实体有 progress(如缺陷),没有就不画 */}
                  {headline.progress != null && (
                    <span
                      aria-hidden
                      className="block"
                      style={{ height: 4, borderRadius: 2, background: C.separator, marginTop: 8, overflow: 'hidden' }}
                    >
                      <span
                        className="block"
                        style={{
                          height: '100%',
                          width: `${Math.round(Math.max(0, Math.min(1, headline.progress)) * 100)}%`,
                          background: C.blue,
                          borderRadius: 2,
                        }}
                      />
                    </span>
                  )}
                </span>
                {/* span 版药丸:外层整卡已是 button,内部不得再嵌 button(Codex P2,非法 DOM) */}
                <AppStorePillLabel label="继续" />
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
                    {/* 右侧只留相对时间——真实标题偏长,带上 agent 名会把标题挤没(demo 差距复盘) */}
                    <span style={{ ...AS_TYPE.caption, color: C.labelTertiary, flex: 'none' }}>
                      {formatRelativeTime(item.lastActiveAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
          );
        })()}

        {/* ── 常用应用 ── */}
        <Section C={C} title="常用应用" action={{ label: '全部', onClick: () => navigate('/ai-toolbox') }}>
          <div style={{ ...cardStyle, padding: '16px 0' }}>
            <AppStoreGrid items={gridItems} columns={4} />
          </div>
        </Section>

        {/* ── 近 7 日（健康摘要式:大数 + 真实七日迷你柱） ── */}
        <Section C={C} title="近 7 日">
          <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '18px 14px', padding: '16px 14px' }}>
            {stats.map((s) => (
              <div key={s.label}>
                <div style={{ ...AS_TYPE.caption, fontSize: 12, color: C.labelSecondary }}>{s.label}</div>
                <div className="flex items-end justify-between" style={{ marginTop: 5, gap: 8 }}>
                  <span
                    style={{
                      fontSize: 24,
                      fontWeight: 700,
                      letterSpacing: '-0.02em',
                      lineHeight: 1,
                      // 0 值不上鲜艳色——亮蓝色的"0"比灰色的"0"更扎眼
                      color: s.value > 0 ? s.color : C.labelTertiary,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {data.loading ? '—' : formatCompactNumber(s.value)}
                  </span>
                  {s.series.length > 0 && <MiniBars series={s.series} color={s.color} trackColor={C.pillBg} />}
                </div>
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
                const hasArtwork = hasAgentCardArtwork(t.agentKey);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => navigate(t.routePath ?? `/ai-toolbox?item=${t.id}`)}
                    className={`group relative shrink-0 overflow-hidden text-left active:opacity-60 transition-opacity ${hasArtwork ? 'flex flex-col justify-between' : 'flex items-center'}`}
                    style={hasArtwork
                      ? {
                          width: 196,
                          height: 126,
                          padding: 11,
                          borderRadius: 16,
                          border: '1px solid var(--media-card-border)',
                          background: 'var(--media-card-base)',
                        }
                      : { ...cardStyle, gap: 10, padding: '10px 14px 10px 10px' }}
                  >
                    {hasArtwork ? (
                      <>
                        <AgentCardArtwork agentKey={t.agentKey} compact />
                        <span className="relative z-10 flex w-full items-start justify-between gap-2">
                          <span
                            className="line-clamp-2"
                            style={{ maxWidth: '54%', fontSize: 15, fontWeight: 700, lineHeight: 1.18, color: 'var(--text-on-media)' }}
                          >
                            {t.name}
                          </span>
                          <AgentCardTask agentKey={t.agentKey} compact dense />
                        </span>
                        <span className="relative z-10 flex min-w-0 items-center gap-1 overflow-hidden">
                          {t.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="shrink-0 rounded-full border px-2 py-1 font-medium leading-none"
                              style={{
                                fontSize: 10,
                                color: 'var(--media-card-tag-text)',
                                background: 'var(--media-card-tag-bg)',
                                borderColor: 'var(--media-card-tag-border)',
                              }}
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      </>
                    ) : (
                      <>
                        <AppStoreAppIcon Icon={Icon} accent={accentFor(t.agentKey)} size={36} />
                        <span className="whitespace-nowrap" style={{ ...AS_TYPE.itemSubtitle, fontWeight: 600, color: C.label }}>
                          {t.name}
                        </span>
                      </>
                    )}
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
                <AppStoreAppIcon Icon={row.Icon} accent={row.accent} size={34} />
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

/* ───────────── 七日迷你柱(Apple 健身/屏幕时间图表范式) ─────────────
 * 每天一根全高浅轨道 + 从底部升起的填充:0 日=纯轨道(不再是一排丑点),
 * 尖刺分布也有型;sqrt 缩放让偏态数据的小值仍可见。真实数据,不造假。 */

function MiniBars({ series, color, trackColor }: { series: number[]; color: string; trackColor: string }) {
  const max = Math.max(...series, 0);
  return (
    <span aria-hidden className="flex items-end shrink-0" style={{ gap: 3, height: 24 }}>
      {series.map((v, i) => {
        const fill = max > 0 && v > 0 ? Math.max(5, Math.round(Math.sqrt(v / max) * 24)) : 0;
        return (
          <span
            key={i}
            className="relative block overflow-hidden"
            style={{ width: 5, height: 24, borderRadius: 2.5, background: trackColor }}
          >
            {fill > 0 && (
              <span
                className="absolute left-0 right-0 bottom-0 block"
                style={{ height: fill, borderRadius: 2.5, background: color }}
              />
            )}
          </span>
        );
      })}
    </span>
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
