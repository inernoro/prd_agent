import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiUrl } from '@/lib/api';

/**
 * 项目设置 → 周期备份。
 *
 * 这一屏只回答一个问题：**这个项目的备份，要不要我管。**
 *
 * 所以版面是「一句判断 + 需要管的展开 + 不用管的各收成一行 + 页脚一行」。
 * 失败原因收进详情，不铺在第一屏——上一版把十一段原因全摆出来，重点当场被冲没了
 * （用户原话：「用户不知道重点在哪里」）。
 *
 * 判定不在这里做：状态、结论、体检那几句话全部来自后端
 * `GET /api/projects/:id/backup-health`（判据在 services/backup-panel.ts）。
 * 前端只负责把它们摆好——同一个判据前后端各写一份，就是下一次漂移的起点。
 */

type BackupTargetStatus =
  | 'failed' | 'artifact-missing' | 'not-in-last-round' | 'offsite-only' | 'partial' | 'unsupported' | 'ok';

interface BackupPanelTarget {
  id: string;
  status: BackupTargetStatus;
  reason: string | null;
  bytes: number | null;
  offsite: boolean;
  lastSuccessAt: string | null;
  fileCount: number;
}

interface BackupHealthFinding {
  id: string;
  severity: 'ok' | 'warn' | 'critical';
  message: string;
}

interface BackupPanelResponse {
  lastRoundAt: string | null;
  nextRoundEstimatedAt: string | null;
  localVerifiedAt: string | null;
  remoteVerifiedAt: string | null;
  verdict: { tone: 'ok' | 'warn' | 'bad'; headline: string; subline: string | null };
  targets: BackupPanelTarget[];
  files: { count: number; bytes: number };
  directory: string;
  directoryExists: boolean;
  findings: BackupHealthFinding[];
}

/** 每一档在界面上叫什么、用哪个语义色。措辞与后端那套判据一一对应。 */
const STATUS_META: Record<BackupTargetStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  failed: { label: '没备出来', tone: 'bad' },
  // 备出来了、文件却不在盘上——和「没备出来」同一档：真要恢复时手上都没有那份文件。
  'artifact-missing': { label: '产物不在了', tone: 'bad' },
  // 服务在跑，上一轮却没备到它——可能是刚建的，也可能当时容器停着。
  'not-in-last-round': { label: '上轮没备到', tone: 'warn' },
  'offsite-only': { label: '仅本机', tone: 'warn' },
  partial: { label: '范围有限', tone: 'warn' },
  unsupported: { label: '还备不了', tone: 'muted' },
  ok: { label: '正常', tone: 'ok' },
};

const DOT_CLASS: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  muted: 'bg-muted-foreground',
};

const TEXT_CLASS: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-muted-foreground',
};

function formatBytes(value?: number | null): string {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 「3 小时前」。读者要的是隔了多久，不是哪一天。 */
function since(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 「约 3 小时后」。给不出就返回 null——不编一个时间出来。 */
function until(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return '就在这一会儿';
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  return `约 ${Math.round(minutes / 60)} 小时后`;
}

/** 一个目标一行。点开才看原因——第一屏只回答「要不要管」。 */
function TargetRow({ target }: { target: BackupPanelTarget }): JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[target.status];
  const last = since(target.lastSuccessAt);
  // 这一轮有产物就报大小，没有就报「上一次成功是多久前」——两者都答不上来才写「无副本」。
  const trailing = target.bytes != null
    ? formatBytes(target.bytes)
    : last
      ? `上次 ${last}`
      : '无副本';

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[8px_minmax(0,1fr)_auto_16px] items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 sm:grid-cols-[8px_minmax(0,1fr)_96px_88px_16px]"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[meta.tone]}`} />
        <span className="truncate font-mono text-[13px]">{target.id}</span>
        <span className={`text-xs ${TEXT_CLASS[meta.tone]}`}>{meta.label}</span>
        <span className="hidden text-right font-mono text-xs text-muted-foreground sm:inline">{trailing}</span>
        {open
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open ? (
        <div className="cds-surface-sunken space-y-1.5 border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
          {target.reason ? (
            <p className="whitespace-pre-wrap break-words font-mono leading-relaxed">{target.reason}</p>
          ) : (
            <p>这一轮没有异常说明。</p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              最近一次成功{' '}
              <span className="font-mono text-foreground">
                {/* 从盘上的文件名推出来的。推不出来就说不知道，不拿这一轮的时间顶替。 */}
                {target.lastSuccessAt ? `${since(target.lastSuccessAt)}（${new Date(target.lastSuccessAt).toLocaleString()}）` : '不知道'}
              </span>
            </span>
            <span>
              这一轮产物 <span className="font-mono text-foreground">{formatBytes(target.bytes)}</span>
            </span>
            <span>
              离机副本 <span className="font-mono text-foreground">{target.offsite ? '有' : '无'}</span>
            </span>
            <span>
              盘上留存 <span className="font-mono text-foreground">{target.fileCount} 份</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 不需要此刻处理的那些，收成一行；想看再展开。 */
function CollapsedGroup({
  label, targets, tone, sunken,
}: {
  label: string;
  targets: BackupPanelTarget[];
  tone: 'ok' | 'muted';
  sunken?: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (targets.length === 0) return null;
  return (
    <div className={`overflow-hidden rounded-md border border-border ${sunken ? 'cds-surface-sunken' : 'cds-surface-raised'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] hover:bg-muted/40"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`} />
        <span className={`flex-1 ${tone === 'muted' ? 'text-muted-foreground' : ''}`}>{label}</span>
        {open
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground transition-transform" />}
      </button>
      {open ? (
        <div className="border-t border-border">
          {targets.map((t) => <TargetRow key={t.id} target={t} />)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 摆版面的那一半。**与取数分开**，是为了让渲染能被真的断言一次：
 * `renderToStaticMarkup` 不跑 effect，取数写在同一个组件里的话，测试只能看到
 * 一个「加载中」——那种绿灯什么都没证明（形状 4b）。
 */
export function BackupPanel({
  data, busy, onRefresh,
}: {
  data: BackupPanelResponse;
  busy?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  // 「需要你管的」= 除了正常与「这类还备不了」之外的全部。写成排除法而不是逐个列举：
  // 后端再加一档时，它会自动落进这一组，而不是从界面上凭空消失（形状 2）。
  const needsAttention = data.targets.filter((t) => t.status !== 'ok' && t.status !== 'unsupported');
  const normal = data.targets.filter((t) => t.status === 'ok');
  const unsupported = data.targets.filter((t) => t.status === 'unsupported');
  const VerdictIcon = data.verdict.tone === 'ok' ? ShieldCheck : data.verdict.tone === 'warn' ? TriangleAlert : ShieldAlert;
  const verdictSurface = data.verdict.tone === 'ok' ? 'bg-ok-soft' : data.verdict.tone === 'warn' ? 'bg-warn-soft' : 'bg-bad-soft';
  const verdictInk = data.verdict.tone === 'ok' ? 'text-ok' : data.verdict.tone === 'warn' ? 'text-warn' : 'text-bad';
  const lastRound = since(data.lastRoundAt);
  const nextRound = until(data.nextRoundEstimatedAt);
  const offsiteCount = data.targets.filter((t) => t.offsite).length;
  const producedCount = data.targets.filter((t) => t.bytes != null).length;
  // 严重的排前面，页脚只摆一条：页脚是「顺带一提」，不是第二块结论区。
  const topFinding = data.findings.find((f) => f.severity === 'critical') ?? data.findings[0] ?? null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">周期备份</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            CDS 每 6 小时自动导出一次这个项目的数据服务，本机留一份、离机再传一份。这里是最近一轮的结果。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} 刷新
        </Button>
      </div>

      {/* 结论条：一句判断 + 一行支撑。原因不在这里，在每行的详情里 */}
      <div className={`flex items-start gap-3 rounded-md border border-border px-4 py-3.5 ${verdictSurface}`}>
        <VerdictIcon className={`mt-0.5 h-5 w-5 shrink-0 ${verdictInk}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold leading-7">{data.verdict.headline}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>上一轮 <span className="font-mono text-foreground">{lastRound ?? '不知道'}</span></span>
            {nextRound ? <span>下一轮 <span className="font-mono text-foreground">{nextRound}</span></span> : null}
            {producedCount > 0 ? (
              <span>离机 <span className="font-mono text-foreground">{producedCount} 份里 {offsiteCount} 份</span></span>
            ) : null}
            {data.verdict.subline ? <span>{data.verdict.subline}</span> : null}
          </div>
        </div>
      </div>

      {needsAttention.length > 0 ? (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <h4 className="text-[13px] font-semibold">需要你管的</h4>
            <span className="text-xs text-muted-foreground">{needsAttention.length} 个</span>
          </div>
          <div className="cds-surface-raised overflow-hidden rounded-md border border-border">
            {needsAttention.map((t) => <TargetRow key={t.id} target={t} />)}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <CollapsedGroup label={`${normal.length} 个目标正常，最近一轮都有副本`} targets={normal} tone="ok" />
        <CollapsedGroup label={`${unsupported.length} 个服务这类还备不了`} targets={unsupported} tone="muted" sunken />
      </div>

      {data.targets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {data.directoryExists
            ? '这个项目还没有一条周期备份记录。它要么刚建不久（首轮在启动 10 分钟后），要么名下还没有能备份的数据服务。'
            : '备份目录还不存在——也就是这台 CDS 一份周期备份都还没产出过。'}
        </div>
      ) : null}

      {/* 文件与体检退到页脚一行。要看的人点得到，不看的人不被它占屏 */}
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          备份文件 <span className="font-mono text-foreground">{data.files.count} 个</span>
          {data.files.bytes > 0 ? <span className="font-mono"> · {formatBytes(data.files.bytes)}</span> : null}
        </span>
        {topFinding ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${topFinding.severity === 'critical' ? 'bg-bad' : topFinding.severity === 'warn' ? 'bg-warn' : 'bg-ok'}`} />
            <span className="truncate">每日体检：{topFinding.message}</span>
          </span>
        ) : null}
        <span className="truncate font-mono opacity-70">{data.directory}</span>
      </div>
    </div>
  );
}

export function BackupTab({ projectId }: { projectId: string }): JSX.Element {
  const [data, setData] = useState<BackupPanelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/backup-health`), { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) {
        setError(`加载失败：${body?.error || res.status}`);
        return;
      }
      setError(null);
      setData(body as BackupPanelResponse);
    } catch (err) {
      setError(`加载异常：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <ErrorBlock message={error} />;
  if (!data) return <LoadingBlock label="加载周期备份…" />;
  return <BackupPanel data={data} busy={busy} onRefresh={() => void refresh()} />;
}
