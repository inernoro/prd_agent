/**
 * 缺陷归因简报弹窗。
 *
 * 回答的问题：最近这批验收里，哪一类缺陷在反复出现、集中在哪个模块、根因结论是什么。
 * 每一簇都列出命中的报告数与样例，点击可直接跳到那份报告——数字必须点得回证据，
 * 否则就是「AI 拍脑袋总结」，用户无法核对（.claude/rules/no-rootless-tree.md）。
 *
 * 这一版是**确定性统计**，不调大模型：CDS 进程内没有通用 LLM 通道，硬造一个会违反
 * llm-gateway 单一网关约束。因此简报只做能被证据支撑的聚合，不生成推测性叙述。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, fetchDefectDigest, type DefectDigest } from '@/lib/api';

/** 严重度展示顺序与配色（与报告卡 VerdictBadge 同款自包含状态色，双主题可读）。 */
const SEVERITY_ORDER = ['P0', 'P1', 'P2', 'P3'] as const;
const SEVERITY_BG: Record<string, string> = {
  P0: '#b42318',
  P1: '#9a6700',
  P2: '#3b5f8a',
  P3: '#5b6470',
};

const WINDOW_OPTIONS = [7, 30, 90] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前项目作用域；不传表示全部项目。 */
  projectId?: string;
  /** 点击某份报告时的跳转回调（把简报的数字接回具体证据）。 */
  onOpenReport?: (reportId: string) => void;
}

function SeverityChip({ severity, count }: { severity: string; count: number }): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
      style={{ background: SEVERITY_BG[severity] ?? SEVERITY_BG.P3 }}
    >
      {severity} {count}
    </span>
  );
}

export function DefectDigestDialog({ open, onClose, projectId, onOpenReport }: Props): JSX.Element {
  const [days, setDays] = useState<number>(30);
  const [digest, setDigest] = useState<DefectDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError('');
    try {
      setDigest(await fetchDefectDigest(projectId, windowDays));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load(days);
  }, [open, days, load]);

  const totalDefects = digest
    ? SEVERITY_ORDER.reduce((sum, s) => sum + (digest.severityTotals[s] ?? 0), 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>缺陷归因简报</DialogTitle>
          <DialogDescription>
            把最近的验收报告横过来看：哪个模块反复出问题、根因结论集中在哪。每个数字都能点回具体报告。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] pb-3">
          <span className="text-xs text-muted-foreground">统计窗口</span>
          {WINDOW_OPTIONS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={days === option ? 'default' : 'outline'}
              onClick={() => setDays(option)}
            >
              近 {option} 天
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={() => void load(days)} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : undefined} />刷新
          </Button>
        </div>

        <div
          className="min-h-[240px] max-h-[60vh] overflow-y-auto"
          style={{ overscrollBehavior: 'contain' }}
        >
          {loading && !digest ? (
            <p className="py-8 text-center text-sm text-muted-foreground">正在汇总验收报告…</p>
          ) : null}

          {error ? (
            <p className="flex items-center gap-2 py-8 text-center text-sm text-red-500">
              <AlertTriangle className="h-4 w-4" />读取简报失败：{error}
            </p>
          ) : null}

          {digest && !error ? (
            <div className="flex flex-col gap-4 pt-3">
              <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="窗口内报告" value={String(digest.reportCount)} />
                <Stat label="缺陷总数" value={String(totalDefects)} />
                <Stat label="不通过" value={String(digest.verdictTotals.fail)} />
                <Stat label="有条件通过" value={String(digest.verdictTotals.conditional)} />
              </section>

              <section className="flex flex-wrap items-center gap-2">
                {SEVERITY_ORDER.map((s) => (
                  <SeverityChip key={s} severity={s} count={digest.severityTotals[s] ?? 0} />
                ))}
                {digest.unclassifiedDefectCount > 0 ? (
                  <span className="text-[11px] text-muted-foreground">
                    另有 {digest.unclassifiedDefectCount} 条缺陷的严重度写法无法归入 P0-P3
                  </span>
                ) : null}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">高频模块</h3>
                {digest.clusters.length === 0 ? (
                  <p className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs text-muted-foreground">
                    窗口内没有带逐行缺陷证据的报告，因此无法按模块聚类。
                    {digest.reportsWithCountsOnly > 0
                      ? `其中 ${digest.reportsWithCountsOnly} 份只上传了聚合计数（严重度分布仍然可用）。`
                      : ''}
                    归档时由验收技能随报告上传「缺陷清单」表即可点亮这一段。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {digest.clusters.map((cluster) => (
                      <li
                        key={cluster.key}
                        className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{cluster.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {cluster.defectCount} 条缺陷 · 命中 {cluster.reportIds.length} 份报告
                          </span>
                          {SEVERITY_ORDER.filter((s) => (cluster.severityTotals[s] ?? 0) > 0).map((s) => (
                            <SeverityChip key={s} severity={s} count={cluster.severityTotals[s] ?? 0} />
                          ))}
                        </div>
                        <ul className="mt-2 flex flex-col gap-1">
                          {cluster.samples.map((sample, index) => (
                            <li key={`${sample.reportId}-${index}`} className="text-xs text-muted-foreground">
                              <button
                                type="button"
                                className="text-left underline-offset-2 hover:underline"
                                onClick={() => onOpenReport?.(sample.reportId)}
                              >
                                [{sample.severity}] {sample.symptom} — {sample.reportTitle}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {digest.rootCauses.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-sm font-medium">根因结论分布</h3>
                  <ul className="flex flex-col gap-1">
                    {digest.rootCauses.map((rc) => (
                      <li key={rc.conclusion} className="flex items-center justify-between gap-2 text-xs">
                        <span>{rc.conclusion}</span>
                        <span className="text-muted-foreground">
                          {rc.count} 次 · {rc.reportIds.length} 份报告
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <p className="text-[11px] text-muted-foreground">
                证据面：{digest.reportCount} 份报告中 {digest.reportsWithDefectRows} 份带逐行缺陷证据、
                {digest.reportsWithCountsOnly} 份只有聚合计数。带逐行证据的报告以逐行为准，不与聚合计数相加。
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
