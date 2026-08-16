/**
 * 分区三「自动发布规则」——设计稿 design_handoff_release_center §4。
 *
 * 每行照稿子：分支胶囊（mono 12.5 / surface2 / 圆角 7）→ 箭头 → 环境名 12.5/600 +
 * 类型文字分级；触发条件 170px；最近触发 150px mono；状态 96px（圆点 + 启用/暂停）；
 * 编辑 30px。行内第一组宽屏 min-width 280px，窄屏 0 且允许换行。
 *
 * 后端是新增的 `schedule.type = 'push'`（见 src/services/release-push-rules.ts）：
 * CDS 原有的自动发布只有 daily / interval / manual 三种**定时**调度，稿子要的是
 * **事件驱动**（分支被推 / 开 PR 时发到某环境），两者是不同的触发面。底座仍复用
 * ScheduledJob，所以并发、审批、失败回滚、运行记录都是现成的。
 *
 * 定时规则（daily / interval）不在这一屏消失：它们仍由既有的 AutoReleaseTab 完整
 * 管理，由页面渲染在本组件下方——那一块能建能改能试跑，这里只做事件规则，
 * 两者明确分开，不混成一张表（混在一起「触发条件」那一列就没法读了）。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { formatDateTime } from './shared';
import type { CenterRow, ScheduledJobSummary } from './types';

export interface AutoRulesSectionProps {
  projectId: string;
  /** 同项目的全部环境，用来把 targetId 显示成环境名 + 类型。 */
  rows: CenterRow[];
  onToast: (message: string) => void;
}

interface RuleDraft {
  id?: string;
  branchPattern: string;
  event: 'push' | 'pr-open';
  pathPattern: string;
  targetId: string;
  requireApproval: boolean;
  enabled: boolean;
}

const TYPE_TEXT: Record<string, string> = { production: '生产', staging: '预发', other: '其它' };

/** 类型的文字分级配色，与矩阵那一列同源（稿子：类型用文字分级，不用色块）。 */
function typeTone(environment: string | undefined): string {
  if (environment === 'production') return 'text-bad';
  if (environment === 'staging') return 'text-warn';
  return 'text-muted-foreground';
}

/**
 * 触发条件那一句。与后端 `describePushRule` 同一套措辞——两边各写一版的话，
 * 页面上说「每次 push」而日志里说别的，排查时会怀疑自己看错了规则。
 */
function describeRule(job: ScheduledJobSummary): string {
  const bits: string[] = [job.schedule.event === 'pr-open' ? '开 PR 时' : '每次 push'];
  if (job.schedule.pathPattern) bits.push(`仅 ${job.schedule.pathPattern} 变更`);
  const action = (job.actions || [])[0] || job.target;
  bits.push(action?.requireApproval ? '需手动批准' : '自动发布');
  return bits.join(' · ');
}

const FIELD = 'h-9 w-full rounded-[9px] border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-3 text-[12.5px] outline-none focus:border-primary/60';

export function AutoRulesSection({ projectId, rows, onToast }: AutoRulesSectionProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * 请求代次。切项目时自增，晚到的旧项目响应一律丢弃。
   *
   * 没有这道闸的话：从 A 切到 B，A 的请求晚一步回来照样 setJobs，列表被换成 A 的
   * 规则，而整个页面显示的是 B。此时点删除只带一个 jobId 过去，管理员就在「看着 B」
   * 的情况下删掉了 A 的规则——这不是显示错位，是真的删错东西。
   */
  const reqSeq = useRef(0);

  const load = async (): Promise<void> => {
    const seq = ++reqSeq.current;
    const forProject = projectId;
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<{ jobs: ScheduledJobSummary[] }>(
        `/api/scheduled-jobs?project=${encodeURIComponent(forProject)}`,
      );
      if (seq !== reqSeq.current) return;
      setJobs(res.jobs || []);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      // loading 也只由最后一次请求收尾，否则旧响应会把新请求的骨架提前撤掉。
      if (seq === reqSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    // 切项目时先把上一项目的列表清空：宁可空一瞬，也不要让 B 的页面挂着 A 的规则。
    setJobs([]);
    void load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [projectId]);

  const pushRules = jobs.filter((job) => job.schedule.type === 'push');
  const rowOf = (targetId: string | undefined): CenterRow | undefined =>
    rows.find((item) => item.target.id === targetId);

  const startNew = (): void => setDraft({
    branchPattern: 'main',
    event: 'push',
    pathPattern: '',
    targetId: rows.find((row) => row.target.isCanonical)?.target.id || rows[0]?.target.id || '',
    requireApproval: true,
    enabled: true,
  });

  const startEdit = (job: ScheduledJobSummary): void => {
    const action = (job.actions || [])[0] || job.target;
    setDraft({
      id: job.id,
      branchPattern: job.schedule.branchPattern || '',
      event: job.schedule.event === 'pr-open' ? 'pr-open' : 'push',
      pathPattern: job.schedule.pathPattern || '',
      targetId: action?.targetId || '',
      requireApproval: action?.requireApproval !== false,
      enabled: job.enabled,
    });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.targetId) { setError('先选一个目标环境'); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        projectId,
        name: `${draft.branchPattern} → ${rowOf(draft.targetId)?.target.name || draft.targetId}`,
        enabled: draft.enabled,
        schedule: {
          type: 'push',
          branchPattern: draft.branchPattern,
          event: draft.event,
          pathPattern: draft.pathPattern,
        },
        actions: [{
          type: 'release',
          targetId: draft.targetId,
          // 来源分支**故意留空**：这条规则匹配的是分支 glob，真正发哪个分支由
          // 触发它的那次 push 决定（后端 runPushRules 现场覆盖）。填一个固定
          // 分支会让 `release/*` 这类规则永远只发其中一个。
          source: { kind: 'branch', branchId: '' },
          requireApproval: draft.requireApproval,
          rollbackOnFailure: true,
          skipWhenUnchanged: true,
        }],
        timeoutSeconds: 1800,
      };
      if (draft.id) {
        await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
      } else {
        await apiRequest('/api/scheduled-jobs', { method: 'POST', body });
      }
      onToast(draft.id ? '规则已更新' : '规则已创建');
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (job: ScheduledJobSummary): Promise<void> => {
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      onToast('规则已删除');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-[15px]">
          <h2 className="text-sm font-bold">自动发布规则</h2>
          <span className="text-[11.5px] text-muted-foreground">分支满足条件时自动发到目标环境</span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" className="h-8" onClick={startNew}>
            <Plus />
            新建规则
          </Button>
        </div>

        {error ? (
          <p className="border-b border-[hsl(var(--hairline)/0.6)] bg-bad-soft px-[18px] py-2.5 text-xs text-bad">{error}</p>
        ) : null}

        {draft ? (
          <div className="grid gap-x-[18px] gap-y-3.5 border-b border-[hsl(var(--hairline)/0.6)] bg-[hsl(var(--surface-sunken))] p-[18px] sm:grid-cols-2 xl:grid-cols-4">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">分支匹配</span>
              <input
                value={draft.branchPattern}
                placeholder="main 或 release/*"
                onChange={(event) => setDraft({ ...draft, branchPattern: event.target.value })}
                className={`${FIELD} cds-ident`}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">目标环境</span>
              <select
                value={draft.targetId}
                onChange={(event) => setDraft({ ...draft, targetId: event.target.value })}
                className={FIELD}
              >
                <option value="">选择环境</option>
                {rows.map((row) => <option key={row.target.id} value={row.target.id}>{row.target.name}</option>)}
              </select>
            </label>
            {/* 触发事件目前只有 push 一种真能触发。
                「开 PR 时」在类型与后端规则模型里都存在，但 pull_request webhook
                侧没有接线（handlePullRequest 从不调规则服务），选了它规则会一直
                「已启用」却永远不触发——UI 提供一个永远不会生效的选项，比没有这个
                选项更糟。等 PR webhook 接上再放出来。 */}
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">触发事件</span>
              <input value="每次 push（含 PR 合并进该分支）" readOnly className={FIELD} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">仅当这些路径变更（留空 = 任何改动）</span>
              <input
                value={draft.pathPattern}
                placeholder="docs/**"
                onChange={(event) => setDraft({ ...draft, pathPattern: event.target.value })}
                className={`${FIELD} cds-ident`}
              />
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2 xl:col-span-4">
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={draft.requireApproval}
                  onChange={(event) => setDraft({ ...draft, requireApproval: event.target.checked })}
                />
                需手动批准（到点只跑预检并发一条待确认通知，永不自动发布）
              </label>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                启用
              </label>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" className="h-8" onClick={() => { setDraft(null); setError(''); }}>取消</Button>
              <Button size="sm" className="h-8" disabled={saving} onClick={() => void save()}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                {draft.id ? '保存规则' : '创建规则'}
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 px-[18px] py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取规则
          </div>
        ) : pushRules.length === 0 ? (
          <p className="px-[18px] py-6 text-xs text-muted-foreground">
            还没有自动发布规则。建一条之后，命中的分支被推送时 CDS 会自己发到目标环境，不需要人在场。
          </p>
        ) : (
          <div>
            {pushRules.map((job) => {
              const action = (job.actions || [])[0] || job.target;
              const owner = rowOf(action?.targetId);
              return (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center gap-[14px] border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-[14px]"
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5 xl:min-w-[280px]">
                    <span className="cds-ident rounded-[7px] border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-2 py-[3px] text-[12.5px]">
                      {job.schedule.branchPattern}
                    </span>
                    <ArrowRight className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
                    <span className="truncate text-[12.5px] font-semibold">
                      {owner?.target.name || action?.targetId || '未指定环境'}
                    </span>
                    <span className={`text-[11px] font-semibold ${typeTone(owner?.target.environment)}`}>
                      {TYPE_TEXT[owner?.target.environment || 'other'] || '其它'}
                    </span>
                  </div>
                  <div className="w-[170px] shrink-0 text-[12px] text-muted-foreground">{describeRule(job)}</div>
                  <div className="w-[150px] shrink-0 cds-ident text-[11.5px] text-muted-foreground">
                    {job.lastRunAt ? formatDateTime(job.lastRunAt) : '尚未触发'}
                  </div>
                  <div className="flex w-[96px] shrink-0 items-center gap-[7px]">
                    <span className={`h-[7px] w-[7px] rounded-full ${job.enabled ? 'bg-ok' : 'bg-[hsl(var(--hairline-strong))]'}`} />
                    <span className={`text-[12px] ${job.enabled ? 'font-semibold' : 'text-muted-foreground'}`}>
                      {job.enabled ? '启用' : '暂停'}
                    </span>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 [&_button]:h-[30px] [&_button]:px-2.5">
                    <Button variant="outline" size="sm" onClick={() => startEdit(job)}>
                      <Pencil />
                      编辑
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void remove(job)}>
                      <Trash2 />
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

    </div>
  );
}
