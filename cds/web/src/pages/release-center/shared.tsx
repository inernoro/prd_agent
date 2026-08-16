/**
 * 发布中心共用的小件与文案映射。
 *
 * 颜色全部走主题 token（cds-surface-raised / hairline / muted-foreground /
 * hsl(var(--destructive)) 等）或 Tailwind 的双主题变体，禁止任何暗色字面量 —— 见
 * .claude/rules/cds-theme-tokens.md：白天主题下这些卡片必须照样看得清。
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { shouldFollowLog } from '@/lib/releaseDialogAddress';

export type Tone = 'ok' | 'warn' | 'bad' | 'live' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-transparent bg-ok-soft text-ok',
  warn: 'border-transparent bg-warn-soft text-warn',
  bad: 'border-transparent bg-bad-soft text-bad',
  live: 'border-transparent bg-primary text-primary-foreground',
  muted: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
};

const LED_CLASS: Record<Tone, string> = {
  ok: 'bg-ok ring-ok/25',
  warn: 'bg-warn ring-warn/25',
  bad: 'bg-bad ring-bad/25',
  live: 'bg-primary ring-primary/25',
  muted: 'bg-muted-foreground/60 ring-muted-foreground/15',
};

export function Chip({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

/** 健康灯。语义靠色 + 旁边的文字双通道传达，不只靠颜色（色觉障碍兜底）。 */
export function Led({ tone }: { tone: Tone }): JSX.Element {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ring-[3px] ${LED_CLASS[tone]}`} />;
}

export function CodeText({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <span className={`font-mono text-xs tabular-nums ${className}`}>{children}</span>;
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{children}</span>;
}

export function InfoBlock({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 p-3 text-sm">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function healthTone(status: string): Tone {
  if (status === 'healthy') return 'ok';
  if (status === 'failed') return 'bad';
  return 'muted';
}

export function runTone(status: string): Tone {
  if (status === 'failed' || status === 'rollback_failed') return 'bad';
  if (status === 'success' || status === 'rollback_success') return 'ok';
  if (status === 'queued' || status === 'running' || status === 'healthchecking' || status === 'rollback_running') return 'warn';
  return 'muted';
}

const STATUS_LABELS: Record<string, string> = {
  healthy: '健康',
  failed: '异常',
  unknown: '未知',
  queued: '排队中',
  running: '发布中',
  healthchecking: '检查上线地址',
  success: '发布成功',
  rollback_running: '回滚中',
  rollback_success: '回滚成功',
  rollback_failed: '回滚失败',
  可用: '可用',
  已停用: '已停用',
};

/** 健康状态与发布状态共用 'failed'，但两处该说的话不同，所以分成两个函数。 */
export function healthLabel(status: string): string {
  if (status === 'healthy') return '健康';
  if (status === 'failed') return '探测异常';
  return '未监测';
}

export function statusLabel(status: string): string {
  if (status === 'failed') return '发布失败';
  return STATUS_LABELS[status] || status;
}

export function StatusPill({ status }: { status: string }): JSX.Element {
  return <Chip tone={runTone(status)}>{statusLabel(status)}</Chip>;
}

export function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatClock(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

export function formatResponseTime(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(value)} ms`;
}

/** 发布耗时。起止任一缺失就返回空串，让调用方整段不显示，而不是显示一个 0。 */
export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return '';
  const from = Date.parse(startedAt);
  const to = Date.parse(finishedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '';
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** 可用率。null / undefined 一律「未监测」，绝不显示成 0%。 */
export function formatAvailability(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未监测';
  return `${(value * 100).toFixed(value >= 0.9995 ? 0 : 2)}%`;
}

/**
 * 发布日志窗格（发布中弹窗与发布记录弹窗共用一份，判据不分裂）。
 *
 * 两条硬性行为，都来自 2026-07-30 用户截图返工：
 * 1. **自动跟到最新**：新日志到达且用户本就贴在底部时，滚动条自动吸底；
 *    用户往上翻（离底 >48px，判定见 shouldFollowLog）就暂停跟随，
 *    右下角出现「回到最新」。不许在用户读旧日志时把他拽走。
 * 2. **长行折行**：`whitespace-pre-wrap break-all`。git 进度条这类不换行长行
 *    曾把整个弹窗内容撑宽、右半屏被裁掉（「输入框不见了」「步骤 2/4/6 消失」）。
 *    日志宁可折行也不许横向撑破布局。
 */
export function ReleaseLogPane({ text, className = '', style }: { text: string; className?: string; style?: CSSProperties }): JSX.Element {
  const paneRef = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const syncFollowing = (next: boolean): void => {
    followingRef.current = next;
    setFollowing(next);
  };

  useEffect(() => {
    const pane = paneRef.current;
    if (pane && followingRef.current) pane.scrollTop = pane.scrollHeight;
  }, [text]);

  const jumpToLatest = (): void => {
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
    syncFollowing(true);
  };

  return (
    <div className={`relative min-h-0 min-w-0 ${className}`} style={style}>
      <pre
        ref={paneRef}
        onScroll={() => {
          const pane = paneRef.current;
          if (!pane) return;
          syncFollowing(shouldFollowLog(pane.scrollTop, pane.scrollHeight, pane.clientHeight));
        }}
        className="h-full max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
      >
        {text || '等待发布日志...'}
      </pre>
      {!following ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 py-1 text-xs shadow-sm hover:bg-[hsl(var(--surface-sunken))]"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          回到最新
        </button>
      ) : null}
    </div>
  );
}
