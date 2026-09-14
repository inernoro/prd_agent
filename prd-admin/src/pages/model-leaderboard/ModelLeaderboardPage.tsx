import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudDownload, ExternalLink, RefreshCw } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { glassBar } from '@/lib/glassStyles';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import {
  getModelLeaderboard,
  syncModelLeaderboard,
  type ModelLeaderboardEntry,
  type ModelLeaderboardSnapshot,
  type ModelMetric,
} from '@/services/real/modelLeaderboard';
import { ErrorBar, HeatCell, PlainCell, formatSigned, isOpenSource, orgMark } from './MetricCells';

/**
 * 模型排行榜（/model-leaderboard）。
 *
 * 数据是 arena.ai 的 Agent 榜，由后端每天同步一次落库，这里只读库——外站抖动不会传导给用户。
 *
 * ## 为什么是这个密度
 *
 * 第一版只显示「名次 / 模型 / 一个百分比 / 授权」，宽屏下三格是空的，进度条缩成一根细线。
 * 根因不是排版，是数据只抓了一个指标。榜单原页面每行有六个指标、会话数、单任务成本和单价，
 * 全都拿得到——补齐之后宽度自然被填满，也才够做选型判断（好用且不贵）。
 */

/** 表格列宽，与设计稿一致。行与表头共用同一个模板，改一处就得改两处的问题在这里被消掉。 */
const GRID = '92px minmax(240px, 1fr) 196px 136px 136px 136px 128px 124px 104px 88px 104px';

type RangeKey = 'all' | 'open';

export default function ModelLeaderboardPage() {
  const board = 'agent';
  const [range, setRange] = useState<RangeKey>('all');
  const [snapshot, setSnapshot] = useState<ModelLeaderboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 与后端 ModelLeaderboardAdminController 的 WritePermission 对齐，按权限判而不是按角色名
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const canSync = hasEffectivePermission(permissions, 'mds.write', isRoot);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getModelLeaderboard(board, 60);
    if (res.success && res.data) setSnapshot(res.data);
    else {
      setSnapshot(null);
      setError(res.error?.message ?? '榜单没读出来，稍后再试');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 手动拉一次。周期同步只在权威部署跑，分支预览上的库是空的，要看真实榜单就得点这里。 */
  const runSync = useCallback(async () => {
    setSyncing(true);
    const res = await syncModelLeaderboard();
    setSyncing(false);
    if (res.success && res.data) {
      const failed = res.data.boards.filter((b) => !b.ok);
      if (failed.length > 0) {
        toast.error(
          `同步未全部成功：${failed.map((b) => `${b.board}（${b.error ?? '未知原因'}）`).join('；')}`,
        );
      } else {
        toast.success('榜单已更新');
      }
      await load();
    } else {
      toast.error(res.error?.message ?? '同步没跑起来');
    }
  }, [load]);

  const entries = useMemo(
    () => (snapshot?.entries ?? []).filter((e) => (range === 'open' ? isOpenSource(e.license) : true)),
    [snapshot, range],
  );

  /**
   * 每一列自己的最大绝对值。热力与误差须都按列归一，不跨列比——
   * 「好评比」的 36% 和「工具幻觉」的 0.37% 本来就不是一个量纲，共用一把尺会让后者永远是空白。
   */
  const columnMax = useMemo(() => {
    const pick = (get: (e: ModelLeaderboardEntry) => ModelMetric | null) =>
      Math.max(...entries.map((e) => Math.abs(get(e)?.value ?? 0)), 0.0001);
    return {
      net: pick((e) => e.netImprovement),
      confirmed: pick((e) => e.confirmedSuccess),
      praise: pick((e) => e.praiseVsComplaint),
      steer: pick((e) => e.steerability),
    };
  }, [entries]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* ── 页头：沿用 PageHeader 的玻璃横条，但这页要把标题与副标题排成两行，故自绘 ── */}
      <div
        className="flex items-center gap-4 px-6 py-3.5 shrink-0"
        style={{ ...glassBar, borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}
      >
        <div className="flex flex-col gap-[3px] min-w-0">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[19px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
              模型排行榜
            </span>
            <span
              className="font-mono text-[10px] uppercase"
              style={{ letterSpacing: '0.1em', color: 'var(--text-muted)' }}
            >
              Agent Arena
            </span>
          </div>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            按「当 Agent 用好不好使」排名：工具调用可靠性、任务完成度、可操控性
          </span>
        </div>

        <div className="flex-1" />

        <div
          className="flex items-center gap-0.5 p-0.5 rounded-[10px]"
          style={{ background: 'var(--nested-block-bg)' }}
          role="group"
          aria-label="模型范围"
        >
          {([{ key: 'all', label: '全部' }, { key: 'open', label: '仅开源' }] as Array<{ key: RangeKey; label: string }>).map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className="h-[26px] px-[11px] rounded-[8px] text-[12px] font-medium transition-colors"
              style={{
                background: range === r.key ? 'var(--accent-gold)' : 'transparent',
                color: range === r.key ? 'var(--accent-on-gold)' : 'var(--text-secondary)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void load()}
          title="重新读取"
          aria-label="重新读取榜单"
          className="h-[28px] w-[28px] inline-flex items-center justify-center rounded-[8px] transition-colors"
          style={{ background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>

        {canSync && (
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={syncing}
            title="从 arena.ai 重新抓一次榜单"
            className="h-[28px] px-2.5 inline-flex items-center gap-1.5 rounded-[8px] text-[12px] font-medium transition-colors disabled:opacity-60"
            style={{ background: 'var(--nested-block-bg)', color: 'var(--text-secondary)' }}
          >
            <CloudDownload size={13} className={syncing ? 'animate-pulse' : ''} />
            {syncing ? '抓取中' : '立即同步'}
          </button>
        )}

        <TipsEntryButton className="shrink-0" />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          // 不给静止的「加载中」：等待必须有持续变化的内容（AGENTS.md 规则 6）
          <MapSectionLoader text="正在读取榜单" />
        ) : error ? (
          <EmptyNote title="榜单没读出来" body={error} />
        ) : !snapshot?.ready ? (
          <EmptyNote
            title="这个环境还没有榜单数据"
            body={
              canSync
                ? '每天一轮的自动同步只在正式部署上跑（同项目多个预览共用一个库，都去写会互相覆盖）。要在这里看真实榜单，点下面按钮手动抓一次。'
                : '每天一轮的自动同步还没跑到这个环境。可以找有「模型管理」权限的同事手动同步一次。'
            }
            action={
              canSync ? (
                <button
                  type="button"
                  onClick={() => void runSync()}
                  disabled={syncing}
                  className="mt-1 self-start h-[32px] px-3.5 inline-flex items-center gap-2 rounded-[9px] text-[13px] font-medium transition-colors disabled:opacity-60"
                  style={{ background: 'var(--accent-gold)', color: 'var(--accent-on-gold)' }}
                >
                  <CloudDownload size={14} className={syncing ? 'animate-pulse' : ''} />
                  {syncing ? '正在从 arena.ai 抓取…' : '立即同步一次'}
                </button>
              ) : undefined
            }
          />
        ) : entries.length === 0 ? (
          <EmptyNote
            title="这个范围里没有模型"
            body={range === 'open' ? '当前榜单里没有开源模型，切回「全部」看看。' : '榜单是空的。'}
          />
        ) : (
          <>
            <MetaStrip snapshot={snapshot} shown={entries.length} />

            <div className="overflow-x-auto">
              <div style={{ minWidth: 1360 }}>
                {/* 表头 */}
                <div
                  className="grid items-end px-6 pt-2.5 pb-2 font-mono text-[9.5px] uppercase shrink-0"
                  style={{
                    gridTemplateColumns: GRID,
                    letterSpacing: '0.09em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>名次</div>
                  <div>模型</div>
                  <div className="text-right" style={{ color: 'var(--accent-gold)' }}>净改进 ↓</div>
                  <div className="text-right">任务完成</div>
                  <div className="text-right">好评比</div>
                  <div className="text-right">可操控性</div>
                  <div className="text-right">命令恢复</div>
                  <div className="text-right">工具幻觉</div>
                  <div className="text-right">会话数</div>
                  <div className="text-right">单任务成本</div>
                  <div className="text-right">单价 $/M</div>
                </div>

                {entries.map((e, i) => (
                  <Row key={`${e.rank}-${e.name}`} entry={e} lead={i === 0} columnMax={columnMax} />
                ))}
              </div>
            </div>

            <Legend />
          </>
        )}
      </div>
    </div>
  );
}

/** 元信息条：数据从哪来、多新、多少样本。 */
function MetaStrip({ snapshot, shown }: { snapshot: ModelLeaderboardSnapshot; shown: number }) {
  const date = snapshot.fetchedAt
    ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未知';

  return (
    <div
      className="flex items-center px-6 py-[11px] text-[12px] shrink-0"
      style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <span className="inline-flex items-center gap-[7px]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
        <span className="font-mono" style={{ color: snapshot.stale ? 'var(--accent-gold)' : undefined }}>
          数据截至 {date}
          {snapshot.stale ? '（已超过两天没同步成功）' : ''}
        </span>
      </span>

      {snapshot.totalSessions != null && (
        <>
          <Divider />
          <span className="inline-flex items-center gap-[7px]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
            </svg>
            <span className="font-mono tabular-nums">{snapshot.totalSessions.toLocaleString('en-US')} 次会话</span>
          </span>
        </>
      )}

      <Divider />
      <span className="inline-flex items-center gap-[7px]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <span className="font-mono tabular-nums">
          {snapshot.total ?? shown} 个模型
          {shown !== (snapshot.total ?? shown) ? ` · 当前筛出 ${shown} 个` : ''}
        </span>
      </span>

      <div className="flex-1" />

      {snapshot.sourceUrl && (
        <a
          href={snapshot.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-[11.5px] hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>数据来源</span>
          <span style={{ color: 'var(--accent-gold)' }}>arena.ai</span>
          <ExternalLink size={11} style={{ color: 'var(--accent-gold)' }} />
        </a>
      )}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-3 mx-4" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />;
}

function Row({
  entry,
  lead,
  columnMax,
}: {
  entry: ModelLeaderboardEntry;
  lead: boolean;
  columnMax: { net: number; confirmed: number; praise: number; steer: number };
}) {
  const open = isOpenSource(entry.license);
  // 净改进那列用 44px 表示当列最大值——设计稿里榜首条正好是这个长度
  const netScale = 44 / columnMax.net;

  return (
    <div
      className="grid items-center px-6 transition-colors hover-bg-soft"
      style={{
        gridTemplateColumns: GRID,
        padding: lead ? '13px 24px' : '11px 24px',
        borderBottom: '1px solid var(--border-subtle)',
        background: lead ? 'color-mix(in srgb, var(--accent-gold) 5.5%, transparent)' : undefined,
      }}
    >
      {/* 名次 + 置信区间 */}
      <div className="flex flex-col gap-px">
        <span className="inline-flex items-baseline gap-1.5">
          <span
            className="font-mono font-bold leading-none tabular-nums"
            style={{ fontSize: lead ? 21 : 15, color: lead ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
          >
            {String(entry.rank).padStart(2, '0')}
          </span>
          <RankDelta delta={entry.rankDelta} />
        </span>
        {entry.rankLow != null && entry.rankHigh != null && (
          <span className="font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
            区间 {entry.rankLow}–{entry.rankHigh}
          </span>
        )}
      </div>

      {/* 模型 */}
      <div className="flex items-center gap-[11px] min-w-0">
        <span
          className="inline-flex items-center justify-center shrink-0 font-mono font-bold"
          style={{
            width: lead ? 26 : 24,
            height: lead ? 26 : 24,
            fontSize: lead ? 9 : 8.5,
            borderRadius: 7,
            background: lead ? 'color-mix(in srgb, var(--accent-gold) 16%, transparent)' : 'var(--nested-block-bg)',
            border: `1px solid ${lead ? 'color-mix(in srgb, var(--accent-gold) 40%, transparent)' : 'var(--border-subtle)'}`,
            color: lead ? 'var(--accent-gold)' : 'var(--text-muted)',
          }}
        >
          {orgMark(entry.organization)}
        </span>
        <span className="flex flex-col gap-px min-w-0">
          <span className="flex items-center gap-[7px] min-w-0">
            <span
              className="font-mono truncate"
              style={{
                fontSize: lead ? 14 : 13,
                fontWeight: lead ? 600 : 550,
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
              }}
            >
              {entry.name}
            </span>
            {open && (
              <span
                className="font-mono text-[8.5px] rounded-[4px] px-[5px] py-px shrink-0"
                style={{
                  letterSpacing: '0.08em',
                  color: 'var(--semantic-success-text)',
                  border: '1px solid color-mix(in srgb, var(--semantic-success-text) 40%, transparent)',
                }}
              >
                开源
              </span>
            )}
          </span>
          <span className="text-[10.5px] truncate" style={{ color: 'var(--text-muted)' }}>
            {entry.organization ?? '未知厂商'} · {open ? entry.license ?? '开源' : '闭源'}
          </span>
        </span>
      </div>

      {/* 净改进：误差须 + 数值 */}
      <div className="flex items-center gap-2.5 justify-end">
        {entry.netImprovement ? (
          <>
            <ErrorBar metric={entry.netImprovement} scale={netScale} lead={lead} />
            <span className="flex flex-col items-end gap-px" style={{ minWidth: 62 }}>
              <span
                className="font-mono tabular-nums"
                style={{
                  fontSize: lead ? 14.5 : 13.5,
                  fontWeight: lead ? 700 : 650,
                  color: entry.netImprovement.value < 0 ? 'var(--semantic-danger-text)' : 'var(--text-primary)',
                }}
              >
                {formatSigned(entry.netImprovement.value)}
              </span>
              <span className="font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
                {entry.netImprovement.margin != null ? `±${entry.netImprovement.margin.toFixed(2)}` : ''}
              </span>
            </span>
          </>
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </div>

      <HeatCell metric={entry.confirmedSuccess} max={columnMax.confirmed} />
      <HeatCell metric={entry.praiseVsComplaint} max={columnMax.praise} />
      <HeatCell metric={entry.steerability} max={columnMax.steer} />
      <PlainCell metric={entry.bashRecovery} />
      <PlainCell metric={entry.toolHallucination} />

      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {entry.sessions != null ? entry.sessions.toLocaleString('en-US') : '—'}
      </div>
      <div
        className="text-right font-mono text-[12px] tabular-nums"
        style={{ color: open ? 'var(--semantic-success-text)' : 'var(--text-secondary)' }}
      >
        {entry.costPerTask != null ? `$${entry.costPerTask.toFixed(2)}` : '—'}
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {entry.priceInput != null && entry.priceOutput != null
          ? `$${trimZero(entry.priceInput)} / $${trimZero(entry.priceOutput)}`
          : '—'}
      </div>
    </div>
  );
}

/**
 * 名次升降。
 *
 * delta 为 null 表示**不知道**（还没有上一份快照可比），这时什么都不画——
 * 不是画一个「持平」的横杠冒充「没变化」。0 才是真的持平。
 */
function RankDelta({ delta }: { delta: number | null }) {
  if (delta == null) return null;
  if (delta === 0) return <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>—</span>;
  const up = delta > 0;
  return (
    <span
      className="font-mono text-[10px] tabular-nums"
      style={{ color: up ? 'var(--semantic-success-text)' : 'var(--semantic-danger-text)' }}
      title={up ? `上升 ${delta} 名` : `下降 ${Math.abs(delta)} 名`}
    >
      {up ? '▲' : '▼'}
      {Math.abs(delta)}
    </span>
  );
}

/** 表尾图例：把误差须和名次区间的读法说清楚，而不是留一片空白。 */
function Legend() {
  return (
    <div
      className="flex items-center gap-5 flex-wrap px-6 py-3.5 text-[11.5px]"
      style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}
    >
      <span className="inline-flex items-center gap-2">
        <svg width="42" height="12" viewBox="0 0 42 12" aria-hidden="true">
          <line x1="0" y1="6" x2="42" y2="6" stroke="var(--border-subtle)" strokeWidth="1" />
          <rect x="0" y="4" width="24" height="4" rx="2" fill="color-mix(in srgb, var(--accent-gold) 70%, transparent)" />
          <line x1="19" y1="2" x2="19" y2="10" stroke="var(--text-muted)" strokeWidth="1.2" />
          <line x1="29" y1="2" x2="29" y2="10" stroke="var(--text-muted)" strokeWidth="1.2" />
          <line x1="19" y1="6" x2="29" y2="6" stroke="var(--text-muted)" strokeWidth="1" />
        </svg>
        <span>横条是分数，两端的须是 95% 置信区间——区间重叠的两个模型，名次差别不作数</span>
      </span>
      <span className="w-px h-3" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />
      <span>名次下方的「区间」同理：榜首的真实名次可能落在 1–4 之间</span>
      <div className="flex-1" />
      <span>每天 04:00 同步一次</span>
    </div>
  );
}

function trimZero(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v);
}

function EmptyNote({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div
      className="mt-6 mx-6 rounded-[12px] px-5 py-6 flex flex-col gap-2"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
      <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{body}</span>
      {action}
    </div>
  );
}
