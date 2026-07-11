/**
 * 移动首页模板 A「米多早报」—— 米多刊系（report-design-system）纸墨基因的移动落地。
 *
 * 视觉语言：暖纸底 + 油墨字 + 衬线标题 + mono 小标 + 硬投影 + 赭红身份色（对齐日报纸）。
 * 挂载期间把 <html data-theme="light"> 打开（与 report-agent 详情页同一模式），
 * 让 AppShell 顶栏 / 底部 Tab 一起进入纸面语境；卸载即恢复。
 *
 * 信息结构（有信息、有密度、有操作、有历史）：
 *  报头 masthead → 期号 dateline → 头条·继续上次 → 今日数字 stat-row
 *  → 快捷通道（8 入口索引）→ 我的动态 → 档案室（更新中心/智识殿堂/学习中心）→ 刊尾
 */
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  ARCHIVE_ENTRIES,
  QUICK_ENTRIES,
  recentAgentMetaFor,
  formatCompactNumber,
  formatDateline,
  formatRelativeTime,
  greetingFor,
  normalizeFeedTitle,
  type MobileHomeData,
} from './shared';

/* 刊系纸墨 token（SSOT：.claude/rules/report-design-system.md §1.1，赭红=日报身份色） */
const PAPER = '#f7f1e8';
const PAPER_2 = '#fffdf8';
const INK = '#211d18';
const INK_2 = 'rgba(33,29,24,0.74)';
const INK_3 = 'rgba(33,29,24,0.48)';
const LINE = 'rgba(33,29,24,0.14)';
const LINE_2 = 'rgba(33,29,24,0.30)';
const TERRA = '#c05b3c';

const SERIF = '"Source Serif 4", "Songti SC", "Noto Serif SC", "STSong", serif';
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Segoe UI", sans-serif';

export default function MorningPostTemplate({
  data,
  switcher,
}: {
  data: MobileHomeData;
  switcher: ReactNode;
}) {
  const navigate = useNavigate();
  const displayName = useAuthStore((s) => s.user?.displayName ?? '同事');
  const now = useMemo(() => new Date(), []);
  const { dateText, weekday } = formatDateline(now);

  // 纸面语境：整个 AppShell（顶栏/底部 Tab）跟随进入白天 token。
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    return () => {
      if (prev) root.setAttribute('data-theme', prev);
      else root.removeAttribute('data-theme');
    };
  }, []);

  const headline = data.recentWork[0] ?? null;
  const restRecent = data.recentWork.slice(1, 4);

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        background: PAPER,
        color: INK,
        fontFamily: SANS,
        overscrollBehavior: 'contain',
      }}
    >
      <main style={{ padding: '10px 18px 112px' }}>
        {/* ── 报头 masthead ── */}
        <header>
          <div className="flex items-start justify-between" style={{ gap: 12 }}>
            <div className="flex items-center" style={{ gap: 10 }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 40,
                  height: 40,
                  background: TERRA,
                  color: PAPER_2,
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  boxShadow: `3px 3px 0 ${INK}`,
                }}
              >
                MAP
              </span>
              <div>
                <div style={{ fontFamily: SERIF, fontSize: 26, lineHeight: 1.05, fontWeight: 800, letterSpacing: '0.02em' }}>
                  米多早报
                </div>
                <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 9, letterSpacing: '0.18em', color: INK_3 }}>
                  MAP MORNING POST
                </div>
              </div>
            </div>
            {switcher}
          </div>
          <div aria-hidden style={{ marginTop: 12, borderTop: `2.5px solid ${INK}` }} />
          <div aria-hidden style={{ marginTop: 2, borderTop: `1px solid ${INK}` }} />
        </header>

        {/* ── 期号 dateline ── */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: '8px 2px',
            borderBottom: `1px solid ${LINE_2}`,
            fontFamily: MONO,
            fontSize: 11,
            color: INK_2,
          }}
        >
          <span>
            {dateText} · <b style={{ color: TERRA }}>{weekday}</b>
          </span>
          <span>
            {displayName}，{greetingFor(now)}
          </span>
        </div>

        {/* ── 头条：继续上次 ── */}
        <Kicker zh="继续上次" en="CONTINUE" />
        {headline ? (
          <>
            <button
              type="button"
              onClick={() => navigate(headline.route)}
              className="w-full text-left transition-transform active:scale-[0.99]"
              style={{
                background: PAPER_2,
                border: `1px solid ${LINE_2}`,
                boxShadow: `4px 4px 0 rgba(33,29,24,0.16)`,
                padding: '14px 14px 12px',
                color: INK,
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: TERRA }}>
                {recentAgentMetaFor(headline.agentKey).label}
                {' · '}
                {formatRelativeTime(headline.lastActiveAt)}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontFamily: SERIF,
                  fontSize: 21,
                  lineHeight: 1.3,
                  fontWeight: 800,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {headline.title || '未命名工作'}
              </div>
              <div className="flex items-center" style={{ marginTop: 8, gap: 4, fontSize: 12, color: INK_2 }}>
                回到工作现场
                <ChevronRight size={13} style={{ color: TERRA }} />
              </div>
            </button>
            {restRecent.length > 0 && (
              <div style={{ marginTop: 8, borderTop: `1px solid ${LINE}` }}>
                {restRecent.map((item) => {
                  const meta = recentAgentMetaFor(item.agentKey);
                  return (
                    <button
                      key={`${item.route}-${item.lastActiveAt}`}
                      type="button"
                      onClick={() => navigate(item.route)}
                      className="w-full min-h-[44px] flex items-center text-left active:opacity-70"
                      style={{ gap: 8, padding: '9px 2px', borderBottom: `1px solid ${LINE}`, color: INK }}
                    >
                      <span aria-hidden style={{ width: 5, height: 5, background: TERRA, flex: 'none' }} />
                      <span className="truncate" style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
                        {item.title || '未命名工作'}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: INK_3, flex: 'none' }}>
                        {meta.label} · {formatRelativeTime(item.lastActiveAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div
            style={{
              border: `1px dashed ${LINE_2}`,
              padding: '14px',
              fontSize: 13,
              color: INK_2,
              background: PAPER_2,
            }}
          >
            今天还没有进行中的工作。从下方「快捷通道」开始，回来时这里会记住你的现场。
          </div>
        )}

        {/* ── 今日数字 stat-row ── */}
        <Kicker zh="七日数据" en="LAST 7 DAYS" />
        <div
          className="grid grid-cols-4"
          style={{ borderTop: `2px solid ${INK}`, borderBottom: `1px solid ${LINE_2}` }}
        >
          {[
            { label: '会话', value: data.stats?.sessions ?? 0 },
            { label: '消息', value: data.stats?.messages ?? 0 },
            { label: '生图', value: data.stats?.imageGenerations ?? 0 },
            { label: 'Token', value: data.stats?.totalTokens ?? 0 },
          ].map((stat, idx) => (
            <div
              key={stat.label}
              style={{
                padding: '10px 6px 9px',
                textAlign: 'center',
                borderLeft: idx > 0 ? `1px solid ${LINE}` : undefined,
              }}
            >
              <div style={{ fontFamily: SERIF, fontSize: 22, lineHeight: 1.1, fontWeight: 800, color: idx === 0 ? TERRA : INK }}>
                {data.loading ? '—' : formatCompactNumber(stat.value)}
              </div>
              <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: INK_3 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 5, fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', color: INK_3 }}>
          数据来自我的使用记录 · 近 7 日
        </div>

        {/* ── 快捷通道：8 入口索引 ── */}
        <Kicker zh="快捷通道" en="QUICK INDEX" />
        <div className="grid grid-cols-2" style={{ borderTop: `2px solid ${INK}` }}>
          {QUICK_ENTRIES.map((entry, idx) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => navigate(entry.route)}
              className="min-h-[58px] flex items-start text-left active:opacity-70"
              style={{
                gap: 8,
                padding: '10px 8px 10px 2px',
                borderBottom: `1px solid ${LINE}`,
                borderLeft: idx % 2 === 1 ? `1px solid ${LINE}` : undefined,
                paddingLeft: idx % 2 === 1 ? 10 : 2,
                color: INK,
                position: 'relative',
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  fontWeight: 700,
                  color: TERRA,
                  lineHeight: '18px',
                  flex: 'none',
                }}
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0">
                <span className="flex items-center" style={{ gap: 6 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>{entry.title}</span>
                  {entry.key === 'changelog' && data.changelogUnread > 0 && (
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 9,
                        fontWeight: 700,
                        color: PAPER_2,
                        background: TERRA,
                        padding: '1px 5px',
                        lineHeight: '13px',
                      }}
                    >
                      {data.changelogUnread > 99 ? '99+' : data.changelogUnread} 新
                    </span>
                  )}
                </span>
                <span
                  className="block truncate"
                  style={{ marginTop: 2, fontSize: 11, lineHeight: 1.35, color: INK_3 }}
                >
                  {entry.desc}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* ── 我的动态 ── */}
        <Kicker
          zh="我的动态"
          en="MY FEED"
          action={{ label: '全部', onClick: () => navigate('/my-assets') }}
        />
        {data.feed.length === 0 ? (
          <div style={{ border: `1px dashed ${LINE_2}`, padding: 14, fontSize: 13, color: INK_2, background: PAPER_2 }}>
            使用知识库、周报、生图或缺陷后，你的足迹会登上这一版。
          </div>
        ) : (
          <div style={{ borderTop: `2px solid ${INK}` }}>
            {data.feed.slice(0, 6).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.navigateTo)}
                className="w-full min-h-[48px] flex items-center text-left active:opacity-70"
                style={{ gap: 8, padding: '10px 2px', borderBottom: `1px solid ${LINE}`, color: INK }}
              >
                <span aria-hidden style={{ width: 5, height: 5, background: TERRA, flex: 'none' }} />
                <span className="truncate" style={{ flex: 1, fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
                  {normalizeFeedTitle(item)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: INK_3, flex: 'none' }}>
                  {formatRelativeTime(item.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── 档案室：历史与沉淀 ── */}
        <Kicker zh="档案室" en="ARCHIVE" />
        <div style={{ borderTop: `2px solid ${INK}` }}>
          {ARCHIVE_ENTRIES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => navigate(entry.route)}
              className="w-full min-h-[52px] flex items-center text-left active:opacity-70"
              style={{ gap: 10, padding: '11px 2px', borderBottom: `1px solid ${LINE}`, color: INK }}
            >
              <span className="min-w-0" style={{ flex: 1 }}>
                <span className="flex items-center" style={{ gap: 6 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 800 }}>{entry.title}</span>
                  {entry.key === 'changelog' && data.changelogUnread > 0 && (
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: TERRA }} />
                  )}
                </span>
                <span className="block" style={{ marginTop: 2, fontSize: 11, color: INK_3 }}>
                  {entry.desc}
                </span>
              </span>
              <ChevronRight size={15} style={{ color: LINE_2, flex: 'none' }} />
            </button>
          ))}
        </div>

        {/* ── 刊尾 colophon ── */}
        <footer style={{ marginTop: 26, textAlign: 'center' }}>
          <div aria-hidden style={{ borderTop: `1px solid ${INK}` }} />
          <div aria-hidden style={{ marginTop: 2, borderTop: `2.5px solid ${INK}` }} />
          <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 9, letterSpacing: '0.16em', color: INK_3 }}>
            MAP · 米多智能体生态平台
          </div>
          <div style={{ marginTop: 4, fontFamily: SERIF, fontSize: 12, color: INK_2 }}>
            每个成员，都有一支 AI 团队
          </div>
        </footer>
      </main>
    </div>
  );
}

/** 栏目眉：mono + 宽字距 + 身份色，右侧可挂动作 */
function Kicker({
  zh,
  en,
  action,
}: {
  zh: string;
  en: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-baseline justify-between" style={{ marginTop: 24, marginBottom: 8 }}>
      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', color: TERRA }}>
        {zh} · {en}
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex items-center active:opacity-60"
          style={{ gap: 2, fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em', color: INK_2 }}
        >
          {action.label}
          <ChevronRight size={11} />
        </button>
      )}
    </div>
  );
}
