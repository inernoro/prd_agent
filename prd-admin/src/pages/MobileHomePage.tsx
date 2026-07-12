/**
 * 移动端首页（<768px）—— 定稿方向（2026-07-12 用户确认）：
 *
 *  浅色（默认）＝「工作台式」骨架 + 琥珀数据头带
 *    - 参照飞书/钉钉工作台：浅灰画布 #F2F3F7 托纯白卡，功能色只出现在图标块，
 *      红点徽章原生位；挂载期把 <html data-theme="light"> 打开让壳层跟随。
 *    - 参照 Stripe Dashboard：顶部一条 MAP 琥珀头带承载问候 + 一个关键大数字。
 *
 *  暗色（prefers-color-scheme: dark 跟随系统）＝「夜光式」形态
 *    - 参照 Linear 2025：#08090A 近黑底、0.5px 发丝边、字重 400-510、
 *      字距收紧；全页唯一亮色是 MAP 琥珀，当「手电筒」用（关键数字/live 点/徽章）。
 *
 *  结构（两形态同构）：头带或问候 → 继续上次 → 常用应用宫格 → 七日数据
 *  → 我的动态 → 推荐智能体货架 → 页脚。全部真实数据（useMobileHomeData）。
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
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl } from '@/lib/homepageAssetSlots';
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

const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Segoe UI", sans-serif';

/* ───────────── 双形态皮肤 token（浅=工作台，暗=夜光） ───────────── */

interface Skin {
  dark: boolean;
  canvas: string;
  card: string;
  cardBorder: string;
  cardShadow: string;
  text: string;
  text2: string;
  text3: string;
  hairline: string;
  amber: string;
  /** 宫格图标块：浅色=功能色实底白字；暗色=中性块彩色线稿（Linear 纪律） */
  tileBg: (tint: string) => string;
  tileFg: (tint: string) => string;
  tileBorder: string;
}

const LIGHT_SKIN: Skin = {
  dark: false,
  canvas: '#f7f7f8',
  card: '#ffffff',
  cardBorder: '#e9eaee',
  cardShadow: '0 1px 2px rgba(20,21,26,0.04)',
  text: '#18191c',
  text2: '#5f6167',
  text3: '#9a9ca3',
  hairline: '#f0f0f2',
  amber: '#d97a08',
  // 质感浅色(2026-07-12 二次纠偏):实底彩块读作 OA 老土,改 12% tint 底 + 彩色线稿
  tileBg: (tint) => `${tint}1f`,
  tileFg: (tint) => tint,
  tileBorder: 'transparent',
};

const DARK_SKIN: Skin = {
  dark: true,
  canvas: '#08090a',
  card: '#101113',
  cardBorder: 'rgba(255,255,255,0.09)',
  cardShadow: 'none',
  text: '#f7f8f8',
  text2: 'rgba(247,248,248,0.62)',
  text3: 'rgba(247,248,248,0.42)',
  hairline: 'rgba(255,255,255,0.07)',
  amber: '#f5a623',
  tileBg: () => '#16181b',
  tileFg: (tint) => tint,
  tileBorder: 'rgba(255,255,255,0.09)',
};

/* ───────────── 常用应用宫格（功能色注册） ───────────── */

const APP_GRID: Array<{ key: string; title: string; route: string; Icon: LucideIcon; tint: string }> = [
  { key: 'document-store', title: '知识库', route: '/document-store', Icon: BookOpen, tint: '#ff9f0a' },
  { key: 'report-agent', title: '周报', route: '/report-agent', Icon: FileText, tint: '#3370ff' },
  { key: 'visual-agent', title: '生图', route: '/visual-agent', Icon: ImageIcon, tint: '#9b6cff' },
  { key: 'defect-agent', title: '缺陷', route: '/defect-agent', Icon: Bug, tint: '#f54a45' },
  { key: 'literary-agent', title: '文学创作', route: '/literary-agent', Icon: Feather, tint: '#34c759' },
  { key: 'marketplace', title: '海鲜市场', route: '/marketplace', Icon: Store, tint: '#14b8c4' },
  { key: 'daily-post', title: '米多早报', route: '/daily-post', Icon: Newspaper, tint: '#c05b3c' },
  { key: 'changelog', title: '更新中心', route: '/changelog', Icon: Megaphone, tint: '#5aa9ff' },
];

/** 沉淀与档案：历史与个人资产类入口（首页加长，2026-07-12 用户要求） */
const ARCHIVE_ROWS: Array<{ key: string; title: string; desc: string; route: string; Icon: LucideIcon; tint: string }> = [
  { key: 'library', title: '智识殿堂', desc: '团队公开知识库与文章', route: '/library', Icon: Landmark, tint: '#a78bfa' },
  { key: 'learning-center', title: '学习中心', desc: '页面教程与掌握度', route: '/learning-center', Icon: GraduationCap, tint: '#34c759' },
  { key: 'my-assets', title: '我的资产', desc: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, tint: '#5aa9ff' },
  { key: 'my-shares', title: '我的分享', desc: '发出的分享链接管理', route: '/my/shares', Icon: Share2, tint: '#14b8c4' },
];

export default function MobileHomePage() {
  const navigate = useNavigate();
  const data = useMobileHomeData();
  const displayName = useAuthStore((s) => s.user?.displayName ?? '同事');
  // 全局移动明暗偏好:浅色默认,右上角按钮可切换;data-theme 由 AppShell 统一落。
  const themeMode = useMobileThemeStore((st) => st.mode);
  const toggleTheme = useMobileThemeStore((st) => st.toggle);
  const S = themeMode === 'dark' ? DARK_SKIN : LIGHT_SKIN;
  const now = useMemo(() => new Date(), []);
  const { weekday } = formatDateline(now);

  const headline = data.recentWork[0] ?? null;
  const restRecent = data.recentWork.slice(1, 3);

  return (
    <div
      className="h-full min-h-0 overflow-auto no-scrollbar"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        background: S.dark
          ? 'radial-gradient(70% 220px at 50% 0%, rgba(94,106,210,0.10), transparent 70%), #08090a'
          : S.canvas,
        color: S.text,
        fontFamily: SANS,
        overscrollBehavior: 'contain',
      }}
    >
      <main style={{ padding: '0 12px 112px', maxWidth: 720, margin: '0 auto' }}>
        {/* ── 头部：两形态同为安静问候行（橙色大色块已因「老土」撤下，
              琥珀只留给数字与按钮做点睛） ── */}
        <header style={{ padding: '14px 6px 4px' }}>
          <div className="flex items-center justify-between" style={{ gap: 10 }}>
            <span style={{ fontSize: S.dark ? 17 : 21, fontWeight: S.dark ? 510 : 700, letterSpacing: '-0.02em' }}>
              {greetingFor(now)}，{displayName}
            </span>
            <span className="flex items-center" style={{ gap: 8, flex: 'none' }}>
              <span style={{ fontSize: 12, color: S.text3 }}>
                {now.getMonth() + 1}月{now.getDate()}日 {weekday}
              </span>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={S.dark ? '切换到浅色' : '切换到暗色'}
                className="flex items-center justify-center active:opacity-60"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  border: `1px solid ${S.dark ? 'rgba(255,255,255,0.12)' : '#e9eaee'}`,
                  background: S.card,
                  color: S.text2,
                }}
              >
                {S.dark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </span>
          </div>
        </header>

        {/* ── 继续上次 ── */}
        {headline && (
          <Card S={S} title="继续上次">
            <button
              type="button"
              onClick={() => navigate(headline.route)}
              className="w-full flex items-center text-left active:opacity-70"
              style={{ gap: 10, padding: '2px 0', color: S.text }}
            >
              <TileIcon S={S} Icon={recentAgentMetaFor(headline.agentKey).Icon} tint={recentAgentMetaFor(headline.agentKey).accent} size={40} />
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ fontSize: 14.5, fontWeight: S.dark ? 510 : 600 }}>
                  {headline.title || '未命名工作'}
                </span>
                <span className="block" style={{ marginTop: 2, fontSize: 11.5, color: S.text3 }}>
                  {recentAgentMetaFor(headline.agentKey).label} · {formatRelativeTime(headline.lastActiveAt)}
                </span>
              </span>
              <span
                className="shrink-0"
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: S.dark ? '#101113' : S.amber,
                  background: S.dark ? S.amber : 'rgba(232,137,12,0.12)',
                  borderRadius: 8,
                  padding: '5px 13px',
                }}
              >
                继续
              </span>
            </button>
            {restRecent.map((item) => {
              const meta = recentAgentMetaFor(item.agentKey);
              return (
                <button
                  key={`${item.route}-${item.lastActiveAt}`}
                  type="button"
                  onClick={() => navigate(item.route)}
                  className="w-full flex items-center text-left active:opacity-70"
                  style={{ gap: 8, padding: '9px 0 0', marginTop: 9, borderTop: `1px solid ${S.hairline}`, color: S.text }}
                >
                  <span aria-hidden style={{ width: 5, height: 5, borderRadius: 99, background: meta.accent, flex: 'none' }} />
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
                    {item.title || '未命名工作'}
                  </span>
                  <span style={{ fontSize: 11, color: S.text3, flex: 'none' }}>
                    {meta.label} · {formatRelativeTime(item.lastActiveAt)}
                  </span>
                </button>
              );
            })}
          </Card>
        )}

        {/* ── 常用应用宫格 ── */}
        <Card S={S} title="常用应用" action={{ label: '全部', onClick: () => navigate('/ai-toolbox') }}>
          <div className="grid grid-cols-4" style={{ gap: '14px 6px', paddingTop: 2 }}>
            {APP_GRID.map((app) => {
              const Icon = app.Icon;
              return (
                <button
                  key={app.key}
                  type="button"
                  onClick={() => navigate(app.route)}
                  className="relative flex flex-col items-center transition-transform active:scale-[0.94]"
                  style={{ gap: 6, color: S.text }}
                >
                  {app.key === 'changelog' && data.changelogUnread > 0 && (
                    <span
                      style={{
                        position: 'absolute',
                        top: -5,
                        right: 6,
                        zIndex: 1,
                        minWidth: 16,
                        padding: '0 4px',
                        borderRadius: 99,
                        background: '#f54a45',
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                        lineHeight: '14px',
                        textAlign: 'center',
                      }}
                    >
                      {data.changelogUnread > 99 ? '99+' : data.changelogUnread}
                    </span>
                  )}
                  <TileIcon S={S} Icon={Icon} tint={app.tint} size={42} />
                  <span style={{ fontSize: 11, lineHeight: 1.2, color: S.dark ? S.text2 : S.text }}>{app.title}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* ── 七日数据 ── */}
        <Card S={S} title="近 7 日数据">
          <div className="grid grid-cols-4" style={{ paddingTop: 2 }}>
            {[
              { label: '会话', value: data.stats?.sessions ?? 0 },
              { label: '消息', value: data.stats?.messages ?? 0 },
              { label: '生图', value: data.stats?.imageGenerations ?? 0 },
              { label: 'Token', value: data.stats?.totalTokens ?? 0, hot: true },
            ].map((stat, idx) => (
              <div
                key={stat.label}
                style={{
                  textAlign: 'center',
                  borderLeft: idx > 0 ? `1px solid ${S.hairline}` : undefined,
                }}
              >
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: S.dark ? 510 : 700,
                    letterSpacing: '-0.01em',
                    fontVariantNumeric: 'tabular-nums',
                    color: stat.hot ? S.amber : S.text,
                  }}
                >
                  {data.loading ? '—' : formatCompactNumber(stat.value)}
                </div>
                <div style={{ marginTop: 2, fontSize: 10.5, color: S.text3 }}>{stat.label}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* ── 我的动态 ── */}
        <Card S={S} title="我的动态" action={{ label: '全部', onClick: () => navigate('/my-assets') }}>
          {data.feed.length === 0 ? (
            <div style={{ fontSize: 13, color: S.text2, padding: '2px 0' }}>
              使用知识库、周报、生图或缺陷后，动态会出现在这里
            </div>
          ) : (
            data.feed.slice(0, 8).map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.navigateTo)}
                className="w-full flex items-center text-left active:opacity-70"
                style={{
                  gap: 9,
                  padding: idx === 0 ? '2px 0 9px' : '9px 0',
                  borderTop: idx > 0 ? `1px solid ${S.hairline}` : undefined,
                  color: S.text,
                }}
              >
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: feedTint(item.type), flex: 'none' }} />
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                  {normalizeFeedTitle(item)}
                </span>
                <span style={{ fontSize: 11, color: S.text3, flex: 'none' }}>{formatRelativeTime(item.updatedAt)}</span>
              </button>
            ))
          )}
        </Card>

        {/* ── 推荐智能体货架 ── */}
        <RecommendedShelf S={S} onNavigate={(to) => navigate(to)} />

        {/* ── 沉淀与档案 ── */}
        <Card S={S} title="沉淀与档案">
          {ARCHIVE_ROWS.map((row, idx) => {
            const Icon = row.Icon;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => navigate(row.route)}
                className="w-full flex items-center text-left active:opacity-70"
                style={{
                  gap: 10,
                  padding: idx === 0 ? '2px 0 10px' : '10px 0',
                  borderTop: idx > 0 ? `1px solid ${S.hairline}` : undefined,
                  color: S.text,
                }}
              >
                <TileIcon S={S} Icon={Icon} tint={row.tint} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" style={{ fontSize: 13.5, fontWeight: S.dark ? 510 : 600 }}>
                    {row.title}
                  </span>
                  <span className="block truncate" style={{ marginTop: 1, fontSize: 11, color: S.text3 }}>
                    {row.desc}
                  </span>
                </span>
                <ChevronRight size={15} className="shrink-0" style={{ color: S.text3 }} />
              </button>
            );
          })}
        </Card>

        {/* ── 页脚 ── */}
        <footer style={{ marginTop: 26, textAlign: 'center', fontSize: 11, color: S.text3 }}>
          MAP · 每个成员，都有一支 AI 团队
        </footer>
      </main>
    </div>
  );
}

/** feed 类型 → 提示色（与宫格功能色同源） */
function feedTint(type: string): string {
  if (type === 'visual-workspace') return '#9b6cff';
  if (type === 'defect') return '#f54a45';
  return '#3370ff';
}

/* ───────────── 皮肤化基础件 ───────────── */

/** 白卡（浅）/ 发丝边暗卡（暗），带 13px 卡头 */
function Card({
  S,
  title,
  action,
  children,
}: {
  S: Skin;
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section
      style={{
        marginTop: 12,
        background: S.card,
        border: `${S.dark ? '0.5px' : '1px'} solid ${S.cardBorder}`,
        borderRadius: 14,
        padding: '12px 14px 13px',
        boxShadow: S.cardShadow,
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: S.dark ? 510 : 700, color: S.dark ? S.text2 : S.text }}>{title}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center active:opacity-60"
            style={{ gap: 2, fontSize: 12, color: S.text3 }}
          >
            {action.label}
            <ChevronRight size={13} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** 图标块：浅色=功能色实底白字（飞书语法）；暗色=中性块彩色线稿（Linear 语法） */
function TileIcon({ S, Icon, tint, size }: { S: Skin; Icon: LucideIcon; tint: string; size: number }) {
  return (
    <span
      className="shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        background: S.tileBg(tint),
        border: S.dark ? `0.5px solid ${S.tileBorder}` : undefined,
      }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} style={{ color: S.tileFg(tint) }} />
    </span>
  );
}

/* ───────────── 推荐智能体货架 ───────────── */

function RecommendedShelf({ S, onNavigate }: { S: Skin; onNavigate: (to: string) => void }) {
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const items = useMemo(
    () =>
      BUILTIN_TOOLS.filter((t) => t.kind === 'agent')
        .filter((t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only')
        .filter((t) => !APP_GRID.some((entry) => entry.route === t.routePath))
        .slice(0, 8),
    [],
  );
  if (items.length === 0) return null;

  return (
    <section style={{ marginTop: 12 }}>
      <div className="flex items-center justify-between" style={{ padding: '0 4px 8px' }}>
        <span style={{ fontSize: 13, fontWeight: S.dark ? 510 : 700, color: S.dark ? S.text2 : S.text }}>推荐智能体</span>
        <button
          type="button"
          onClick={() => onNavigate('/ai-toolbox')}
          className="inline-flex items-center active:opacity-60"
          style={{ gap: 2, fontSize: 12, color: S.text3 }}
        >
          全部
          <ChevronRight size={13} />
        </button>
      </div>
      <div
        className="flex overflow-x-auto"
        style={{
          gap: 10,
          margin: '0 -12px',
          padding: '0 12px 4px',
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorX: 'contain',
        }}
      >
        {items.map((item) => {
          const Icon = iconFor(item.icon);
          const accent = accentFor(item.agentKey);
          const coverUrl = cdnBase ? buildDefaultCoverUrl(cdnBase, item.agentKey) : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.routePath ?? `/ai-toolbox?item=${item.id}`)}
              className="shrink-0 flex items-center text-left transition-transform active:scale-[0.985]"
              style={{
                width: 250,
                gap: 10,
                padding: '11px 12px',
                borderRadius: 14,
                background: S.card,
                border: `${S.dark ? '0.5px' : '1px'} solid ${S.cardBorder}`,
                boxShadow: S.cardShadow,
                color: S.text,
              }}
            >
              <span
                className="shrink-0 flex items-center justify-center overflow-hidden"
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 11,
                  background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                }}
              >
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt=""
                    aria-hidden
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <Icon size={21} style={{ color: '#fff' }} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ fontSize: 13.5, fontWeight: S.dark ? 510 : 600 }}>
                  {item.name}
                </span>
                <span className="block truncate" style={{ marginTop: 2, fontSize: 11.5, color: S.text3 }}>
                  {item.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
