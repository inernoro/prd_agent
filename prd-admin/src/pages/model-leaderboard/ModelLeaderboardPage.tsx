import { useCallback, useEffect, useState } from 'react';
import { CloudDownload, ExternalLink, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  getModelLeaderboard,
  syncModelLeaderboard,
  LEADERBOARD_BOARDS,
  type ModelLeaderboardEntry,
  type ModelLeaderboardSnapshot,
} from '@/services/real/modelLeaderboard';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { toast } from '@/lib/toast';

/** 「仅开源」筛选认这些授权字样之外的一切为闭源。 */
const PROPRIETARY = /proprietary/i;

type RangeKey = 'all' | 'open';

/**
 * 模型排行榜（/model-leaderboard）。
 *
 * 数据是 arena.ai 的 Agent 榜，由后端每天同步一次落库，这里只读库——外站抖动不会传导给用户。
 * Agent 榜量的是工具调用可靠性、任务完成度、可操控性，比通用盲测更贴本平台的场景。
 */
export default function ModelLeaderboardPage() {
  const [board, setBoard] = useState<string>('agent');
  const [range, setRange] = useState<RangeKey>('all');
  const [snapshot, setSnapshot] = useState<ModelLeaderboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // 与后端 ModelLeaderboardAdminController 的 WritePermission 对齐，
  // 按权限判而不是按角色名——角色名只是权限的一种来源，前后端各判一套迟早对不上。
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const canSync = hasEffectivePermission(permissions, 'mds.write', isRoot);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    const res = await getModelLeaderboard(target, 60);
    if (res.success && res.data) {
      setSnapshot(res.data);
    } else {
      setSnapshot(null);
      setError(res.error?.message ?? '榜单没读出来，稍后再试');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(board);
  }, [board, load]);

  /**
   * 手动拉一次。周期同步只在权威部署跑，分支预览上的库是空的，
   * 要在预览环境看真实榜单就得点这里。要去打外站，所以按钮全程给状态。
   */
  const runSync = useCallback(async () => {
    setSyncing(true);
    const res = await syncModelLeaderboard();
    setSyncing(false);
    if (res.success && res.data) {
      const { succeeded, total } = res.data;
      const failed = res.data.boards.filter((b) => !b.ok);
      if (failed.length > 0) {
        // 部分失败要说清哪个榜、为什么，不要笼统报「部分成功」
        toast.error(`同步完成 ${succeeded}/${total}，失败：${failed.map((b) => `${b.board}（${b.error ?? '未知原因'}）`).join('；')}`);
      } else {
        toast.success(`榜单已更新`);
      }
      await load(board);
    } else {
      toast.error(res.error?.message ?? '同步没跑起来');
    }
  }, [board, load]);

  const entries = (snapshot?.entries ?? []).filter((e) =>
    range === 'open' ? !PROPRIETARY.test(e.license ?? 'Proprietary') : true,
  );

  const currentBoard = LEADERBOARD_BOARDS.find((b) => b.key === board);
  const maxScore = entries.length > 0 ? Math.max(...entries.map((e) => Math.abs(e.score))) : 1;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <PageHeader
        title="模型排行榜"
        description={
          currentBoard
            ? `${currentBoard.label}榜 · ${currentBoard.hint}`
            : '公开模型榜单'
        }
        // 只有一个分榜时不摆切换器——没得选就别假装能选
        tabs={
          LEADERBOARD_BOARDS.length > 1
            ? LEADERBOARD_BOARDS.map((b) => ({ key: b.key, label: b.label }))
            : undefined
        }
        activeTab={board}
        onTabChange={setBoard}
        actions={
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1 rounded-[10px] p-0.5"
              style={{ background: 'var(--nested-block-bg)' }}
              role="group"
              aria-label="模型范围"
            >
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'open', label: '仅开源' },
                ] as Array<{ key: RangeKey; label: string }>
              ).map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r.key)}
                  aria-pressed={range === r.key}
                  className="px-2.5 h-[26px] text-[12px] font-medium rounded-[8px] transition-colors"
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
              onClick={() => void load(board)}
              title="重新读取"
              aria-label="重新读取榜单"
              className="h-[28px] w-[28px] inline-flex items-center justify-center rounded-[8px] transition-colors"
              style={{ color: 'var(--text-muted)', background: 'var(--nested-block-bg)' }}
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
                style={{ color: 'var(--text-secondary)', background: 'var(--nested-block-bg)' }}
              >
                <CloudDownload size={13} className={syncing ? 'animate-pulse' : ''} />
                {syncing ? '抓取中' : '立即同步'}
              </button>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto px-4 pb-8">
        {loading ? (
          // 不给静止的「加载中」：长度未知的等待必须有持续变化的内容（AGENTS.md 规则 6）
          <MapSectionLoader text="正在读取榜单" />
        ) : error ? (
          <EmptyNote title="榜单没读出来" body={error} />
        ) : !snapshot?.ready ? (
          <EmptyNote
            title="这个环境还没有榜单数据"
            body={
              canSync
                ? '每天一轮的自动同步只在正式部署上跑（同项目多个预览共用一个库，都去写会互相覆盖）。要在这里看真实榜单，点下面按钮手动抓一次。'
                : '每天一轮的自动同步还没跑到这个环境。可以找管理员手动同步一次。'
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
            body={range === 'open' ? '当前榜单前 60 名里没有开源模型，切回「全部」看看。' : '榜单是空的。'}
          />
        ) : (
          <>
            <SourceLine snapshot={snapshot} shown={entries.length} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <Th className="text-left w-[64px]">名次</Th>
                    <Th className="text-left">模型</Th>
                    <Th className="text-right w-[180px]">
                      {board === 'agent' ? '净改进' : '得分'}
                    </Th>
                    <Th className="text-right w-[96px]">授权</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <Row key={`${e.rank}-${e.name}`} entry={e} maxScore={maxScore} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2 text-[10px] font-medium uppercase tracking-wider whitespace-nowrap ${className}`}
      style={{
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-subtle)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      {children}
    </th>
  );
}

function Row({ entry, maxScore }: { entry: ModelLeaderboardEntry; maxScore: number }) {
  const lead = entry.rank === 1;
  const isOpen = !PROPRIETARY.test(entry.license ?? 'Proprietary');
  const width = Math.max(5, (Math.abs(entry.score) / maxScore) * 100);

  return (
    <tr
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: lead ? 'var(--bg-card)' : 'transparent',
      }}
    >
      <td className="px-3 py-3 whitespace-nowrap">
        <span className="inline-flex items-baseline gap-1.5">
          <span
            className="font-bold tabular-nums"
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: lead ? 18 : 14,
              color: lead ? 'var(--accent-gold)' : 'var(--text-secondary)',
            }}
          >
            {String(entry.rank).padStart(2, '0')}
          </span>
          <RankDelta delta={entry.rankDelta} />
        </span>
      </td>

      <td className="px-3 py-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className="truncate"
            style={{
              color: 'var(--text-primary)',
              fontSize: lead ? 15 : 13.5,
              fontWeight: lead ? 600 : 550,
            }}
          >
            {entry.name}
          </span>
          <span
            className="text-[10px] truncate"
            style={{
              color: 'var(--text-muted)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {entry.organization ?? '未知厂商'}
          </span>
        </div>
      </td>

      <td className="px-3 py-3">
        <div className="flex items-center gap-2.5 justify-end">
          <span
            className="rounded-full overflow-hidden shrink-0"
            style={{ width: 64, height: lead ? 7 : 5, background: 'var(--nested-block-bg)' }}
          >
            <span
              className="block h-full rounded-full"
              style={{
                width: `${width.toFixed(1)}%`,
                background: 'var(--accent-gold)',
                opacity: lead ? 1 : 0.55,
                transition: 'width 620ms cubic-bezier(.4,0,.2,1)',
              }}
            />
          </span>
          <span
            className="tabular-nums text-right"
            style={{
              minWidth: 62,
              color: 'var(--text-primary)',
              fontWeight: 600,
              fontSize: 12.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {entry.score > 0 ? '+' : ''}
            {entry.score.toFixed(2)}%
          </span>
          {/* 误差范围是榜单原始值的一部分，给了才知道这个名次有多确定 */}
          <span
            className="tabular-nums text-[10px]"
            style={{
              minWidth: 44,
              color: 'var(--text-muted)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {entry.margin != null ? `±${entry.margin.toFixed(2)}%` : ''}
          </span>
        </div>
      </td>

      <td className="px-3 py-3 text-right whitespace-nowrap">
        <span
          className="text-[11px]"
          style={{ color: isOpen ? 'var(--accent-gold)' : 'var(--text-muted)' }}
          title={entry.license ?? undefined}
        >
          {isOpen ? '开源' : '闭源'}
        </span>
      </td>
    </tr>
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
  if (delta === 0) {
    return (
      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        —
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className="text-[10px] tabular-nums"
      style={{ color: up ? 'var(--semantic-success-text)' : 'var(--semantic-danger-text)' }}
      title={up ? `上升 ${delta} 名` : `下降 ${Math.abs(delta)} 名`}
    >
      {up ? '▲' : '▼'}
      {Math.abs(delta)}
    </span>
  );
}

/** 数据来源与日期。陈旧时说清陈旧，不让用户以为看的是今天的数。 */
function SourceLine({
  snapshot,
  shown,
}: {
  snapshot: ModelLeaderboardSnapshot;
  shown: number;
}) {
  const date = snapshot.fetchedAt
    ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未知';

  return (
    <div
      className="flex items-center gap-x-3 gap-y-1 flex-wrap py-3 text-[11.5px]"
      style={{ color: 'var(--text-muted)' }}
    >
      <span>
        共 {snapshot.total ?? shown} 个模型
        {shown !== (snapshot.total ?? shown) ? `，当前筛出 ${shown} 个` : ''}
      </span>
      <span aria-hidden="true">·</span>
      <span style={{ color: snapshot.stale ? 'var(--accent-gold)' : undefined }}>
        {snapshot.stale ? `数据截至 ${date}，已超过两天没同步成功` : `数据截至 ${date}`}
      </span>
      {snapshot.sourceUrl && (
        <a
          href={snapshot.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 ml-auto hover:underline"
          style={{ color: 'var(--text-secondary)' }}
        >
          数据来源 arena.ai
          <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

function EmptyNote({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="mt-6 rounded-[12px] px-5 py-6 flex flex-col gap-2"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </span>
      <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {body}
      </span>
      {action}
    </div>
  );
}
