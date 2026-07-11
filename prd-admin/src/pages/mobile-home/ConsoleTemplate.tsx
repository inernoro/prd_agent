/**
 * 移动首页模板 B「夜航工作台」—— 暗色但有层次的高密度控制台。
 *
 * 与旧版首页的差别：
 *  - 背景不再硬编码近黑渐变，交给 AppShell 的 .app-aurora（跟随主题深浅档位），
 *    页面只负责表面层（分层卡片 + 琥珀光晕点缀），告别「黑黢黢一坨」。
 *  - 信息密度翻倍：问候行 + 四格指标 + 继续上次 + 8 宫格入口 + 动态 + 推荐智能体。
 *  - 全部区块接真实数据（getMobileStats / listRecentWork / getMobileFeed / changelog 未读）。
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ChevronRight } from 'lucide-react';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl } from '@/lib/homepageAssetSlots';
import { AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import {
  QUICK_ENTRIES,
  recentAgentMetaFor,
  formatCompactNumber,
  formatDateline,
  formatRelativeTime,
  greetingFor,
  normalizeFeedTitle,
  type MobileHomeData,
} from './shared';

const AMBER = '#FF9F0A';
const SURFACE = 'rgba(255,255,255,0.07)';
const SURFACE_STRONG = 'rgba(255,255,255,0.11)';
const HAIRLINE = 'rgba(255,255,255,0.10)';
const HAIRLINE_SOFT = 'rgba(255,255,255,0.07)';
const TEXT_PRIMARY = 'rgba(245,245,247,0.96)';
const TEXT_SECONDARY = 'rgba(245,245,247,0.72)';
const TEXT_TERTIARY = 'rgba(245,245,247,0.5)';
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export default function ConsoleTemplate({
  data,
  switcher,
}: {
  data: MobileHomeData;
  switcher: ReactNode;
}) {
  const navigate = useNavigate();
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const displayName = useAuthStore((s) => s.user?.displayName ?? '同事');
  const now = useMemo(() => new Date(), []);
  const { dateText, weekday } = formatDateline(now);

  const recommendedAgents = useMemo(
    () =>
      BUILTIN_TOOLS.filter((t) => t.kind === 'agent')
        .filter((t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only')
        .filter((t) => !QUICK_ENTRIES.some((entry) => entry.route === t.routePath))
        .slice(0, 5),
    [],
  );

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        color: TEXT_PRIMARY,
        fontFamily: AS_FONT_FAMILY,
        overscrollBehavior: 'contain',
      }}
    >
      <main style={{ padding: '8px 16px 112px' }}>
        {/* ── 问候行 ── */}
        <header className="flex items-start justify-between" style={{ gap: 12 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: TEXT_TERTIARY }}>
              {dateText} · {weekday}
            </div>
            <h1 style={{ margin: '4px 0 0', fontSize: 27, lineHeight: 1.12, fontWeight: 800 }}>
              {greetingFor(now)}，{displayName}
            </h1>
          </div>
          {switcher}
        </header>

        {/* ── 四格指标（近 7 日真实数据） ── */}
        <section
          className="grid grid-cols-4 overflow-hidden"
          style={{
            marginTop: 16,
            borderRadius: 16,
            background: SURFACE_STRONG,
            border: `1px solid ${HAIRLINE}`,
            boxShadow: '0 14px 34px rgba(0,0,0,0.22)',
          }}
        >
          {[
            { label: '会话', value: data.stats?.sessions ?? 0, hot: true },
            { label: '消息', value: data.stats?.messages ?? 0 },
            { label: '生图', value: data.stats?.imageGenerations ?? 0 },
            { label: 'Token', value: data.stats?.totalTokens ?? 0 },
          ].map((stat, idx) => (
            <div
              key={stat.label}
              style={{
                padding: '12px 6px 10px',
                textAlign: 'center',
                borderLeft: idx > 0 ? `1px solid ${HAIRLINE_SOFT}` : undefined,
                background: stat.hot
                  ? 'radial-gradient(circle at 50% 0%, rgba(255,159,10,0.16), transparent 72%)'
                  : undefined,
              }}
            >
              <div
                style={{
                  fontSize: 21,
                  lineHeight: 1.1,
                  fontWeight: 800,
                  fontVariantNumeric: 'tabular-nums',
                  color: stat.hot ? AMBER : TEXT_PRIMARY,
                }}
              >
                {data.loading ? '—' : formatCompactNumber(stat.value)}
              </div>
              <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: TEXT_TERTIARY }}>
                {stat.label}
              </div>
            </div>
          ))}
        </section>
        <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', color: TEXT_TERTIARY }}>
          近 7 日 · 我的使用记录
        </div>

        {/* ── 继续上次 ── */}
        {data.recentWork.length > 0 && (
          <>
            <SectionTitle title="继续上次" />
            <div
              className="flex overflow-x-auto"
              style={{
                gap: 10,
                margin: '0 -16px',
                padding: '0 16px 4px',
                scrollbarWidth: 'none',
                WebkitOverflowScrolling: 'touch',
                overscrollBehaviorX: 'contain',
              }}
            >
              {data.recentWork.slice(0, 6).map((item) => {
                const meta = recentAgentMetaFor(item.agentKey);
                const Icon = meta.Icon;
                const accent = meta.accent;
                return (
                  <button
                    key={`${item.route}-${item.lastActiveAt}`}
                    type="button"
                    onClick={() => navigate(item.route)}
                    className="shrink-0 text-left transition-transform active:scale-[0.98]"
                    style={{
                      width: 200,
                      borderRadius: 14,
                      background: SURFACE,
                      border: `1px solid ${HAIRLINE_SOFT}`,
                      borderTop: `2px solid ${accent}`,
                      padding: '10px 12px',
                      color: TEXT_PRIMARY,
                    }}
                  >
                    <div className="flex items-center" style={{ gap: 6 }}>
                      <Icon size={13} style={{ color: accent }} />
                      <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: TEXT_TERTIARY }}>
                        {meta.label} · {formatRelativeTime(item.lastActiveAt)}
                      </span>
                    </div>
                    <div
                      className="truncate"
                      style={{ marginTop: 6, fontSize: 14, fontWeight: 700, lineHeight: 1.25 }}
                    >
                      {item.title || '未命名工作'}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── 快捷入口 8 宫格 ── */}
        <SectionTitle title="快捷入口" />
        <div
          className="grid grid-cols-4 overflow-hidden"
          style={{ borderRadius: 16, background: SURFACE, border: `1px solid ${HAIRLINE_SOFT}` }}
        >
          {QUICK_ENTRIES.map((entry, idx) => {
            const Icon = entry.Icon;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => navigate(entry.route)}
                className="relative min-h-[74px] flex flex-col items-center justify-center transition-transform active:scale-[0.97]"
                style={{
                  borderRight: idx % 4 < 3 ? `1px solid ${HAIRLINE_SOFT}` : undefined,
                  borderBottom: idx < 4 ? `1px solid ${HAIRLINE_SOFT}` : undefined,
                  color: TEXT_PRIMARY,
                  padding: '9px 4px',
                }}
              >
                {entry.key === 'changelog' && data.changelogUnread > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 10,
                      minWidth: 15,
                      padding: '0 4px',
                      borderRadius: 999,
                      background: AMBER,
                      color: '#1a1206',
                      fontFamily: MONO,
                      fontSize: 9,
                      fontWeight: 800,
                      lineHeight: '15px',
                      textAlign: 'center',
                    }}
                  >
                    {data.changelogUnread > 99 ? '99+' : data.changelogUnread}
                  </span>
                )}
                <Icon size={22} strokeWidth={1.9} style={{ color: entry.accent }} />
                <span style={{ marginTop: 7, fontSize: 12, lineHeight: 1.15, color: TEXT_SECONDARY }}>
                  {entry.title}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── 我的动态 ── */}
        <SectionTitle title="我的动态" actionLabel="全部" onAction={() => navigate('/my-assets')} />
        {data.feed.length === 0 ? (
          <div
            className="flex items-center gap-3"
            style={{
              minHeight: 72,
              borderRadius: 14,
              background: SURFACE,
              border: `1px solid ${HAIRLINE_SOFT}`,
              padding: '0 14px',
            }}
          >
            <Activity size={18} style={{ color: AMBER, flex: 'none' }} />
            <div style={{ fontSize: 13, color: TEXT_SECONDARY }}>
              使用知识库、周报、生图或缺陷后，动态会出现在这里
            </div>
          </div>
        ) : (
          <div style={{ borderRadius: 14, background: SURFACE, border: `1px solid ${HAIRLINE_SOFT}`, overflow: 'hidden' }}>
            {data.feed.slice(0, 5).map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.navigateTo)}
                className="w-full min-h-[50px] flex items-center text-left transition-colors active:bg-white/10"
                style={{
                  gap: 10,
                  padding: '9px 12px',
                  color: TEXT_PRIMARY,
                  borderBottom: idx < Math.min(data.feed.length, 5) - 1 ? `1px solid ${HAIRLINE_SOFT}` : undefined,
                }}
              >
                <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: AMBER, flex: 'none' }} />
                <span className="truncate" style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>
                  {normalizeFeedTitle(item)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: TEXT_TERTIARY, flex: 'none' }}>
                  {formatRelativeTime(item.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── 推荐智能体 ── */}
        {recommendedAgents.length > 0 && (
          <>
            <SectionTitle title="推荐智能体" actionLabel="全部" onAction={() => navigate('/ai-toolbox')} />
            <div
              className="flex overflow-x-auto"
              style={{
                gap: 10,
                margin: '0 -16px',
                padding: '0 16px 4px',
                scrollbarWidth: 'none',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {recommendedAgents.map((item) => {
                const Icon = iconFor(item.icon);
                const accent = accentFor(item.agentKey);
                const coverUrl = cdnBase ? buildDefaultCoverUrl(cdnBase, item.agentKey) : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.routePath ?? `/ai-toolbox?item=${item.id}`)}
                    className="shrink-0 text-left transition-transform active:scale-[0.98]"
                    style={{
                      width: 148,
                      minHeight: 108,
                      borderRadius: 14,
                      background: SURFACE,
                      border: `1px solid ${HAIRLINE_SOFT}`,
                      padding: 12,
                      color: TEXT_PRIMARY,
                    }}
                  >
                    <div
                      className="flex items-center justify-center overflow-hidden"
                      style={{
                        width: 40,
                        height: 40,
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
                        <Icon size={20} style={{ color: '#fff' }} />
                      )}
                    </div>
                    <div className="truncate" style={{ marginTop: 9, fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>
                      {item.name}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11.5,
                        lineHeight: 1.35,
                        color: TEXT_SECONDARY,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {item.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── 刊尾 ── */}
        <footer style={{ marginTop: 28, textAlign: 'center' }}>
          <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.16em', color: TEXT_TERTIARY }}>
            MAP · 米多智能体生态平台
          </div>
        </footer>
      </main>
    </div>
  );
}

function SectionTitle({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between" style={{ marginTop: 22, marginBottom: 10 }}>
      <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.15, fontWeight: 800, color: TEXT_PRIMARY }}>{title}</h2>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="min-h-[36px] inline-flex items-center gap-1 transition-opacity active:opacity-60"
          style={{ color: TEXT_SECONDARY, fontSize: 13, fontWeight: 500 }}
        >
          {actionLabel}
          <ChevronRight size={15} />
        </button>
      )}
    </div>
  );
}
