import { useState } from 'react';
import { FileText, GitBranch, ShieldCheck, UserRound, Bot, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { releaseActorLabel, releaseMergeState } from '@/lib/releaseProvenance';
import type { ReleaseCommitRail } from '@/lib/releaseRail';
import type { CenterRow, ReleaseCommitMeta, ReleaseRun } from './types';
import { Chip, formatDateTime, healthLabel, healthTone } from './shared';

interface Props {
  rows: CenterRow[];
  rail?: ReleaseCommitRail;
  commitMeta: Record<string, ReleaseCommitMeta>;
  selectedTargetId: string;
  onSelect: (id: string) => void;
  onOpenLogs: (run: ReleaseRun) => void;
  onInspect: (id: string) => void;
}

type FileFilter = 'all' | 'both' | 'production';
const FILTERS: Array<{ value: FileFilter; label: string }> = [
  { value: 'all', label: '全部文件' },
  { value: 'both', label: '双方重叠' },
  { value: 'production', label: '生产侧变更' },
];
const SIDE_ORDER = { both: 0, production: 1, main: 2 };

/** 真实发布台账和固定 Git 快照；未知身份、批准和冲突不做推断。 */
export function ReleaseTraceOverview({ rows, rail, commitMeta, selectedTargetId, onSelect, onOpenLogs, onInspect }: Props): JSX.Element | null {
  const [detail, setDetail] = useState(false);
  const [filter, setFilter] = useState<FileFilter>('all');
  const row = rows.find(r => r.target.id === selectedTargetId) || rows.find(r => r.target.isCanonical) || rows[0];
  if (!row) return null;

  const comparison = row.comparison;
  const current = row.currentRun || row.successfulRuns?.find(r => r.commitSha === row.currentCommit);
  const knownPosition = row.commitPosition?.aheadCount != null && row.commitPosition?.behindCount != null;
  const main = rail?.nodes[0];
  const hasExtra = knownPosition && row.commitPosition!.aheadCount! > 0;
  const thread = current?.agentIdentity?.threadId;
  const files = (comparison?.files || [])
    .filter(file => filter === 'all' || file.side === filter || (filter === 'production' && file.side === 'both'))
    .sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.path.localeCompare(b.path));

  return (
    <section aria-label="线上版本与主干追溯" className="min-w-0 border-b border-[hsl(var(--hairline))] pb-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">线上与主干</h2>
          <p className="mt-1 text-xs text-muted-foreground">追溯最近成功发布的版本、操作人和主干差异。</p>
        </div>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          环境
          <select aria-label="追溯环境" value={row.target.id} onChange={event => onSelect(event.target.value)} className="max-w-[24rem] rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 max-sm:max-w-[14rem]">
            {rows.map(item => <option key={item.target.id} value={item.target.id}>{item.target.name}</option>)}
          </select>
        </label>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div className="space-y-5 py-5" aria-label="版本关系">
            <VersionLine label={rail?.branch || '主干'} sha={main?.sha} subject={main?.subject || rail?.unavailableReason || '主干引用暂不可用'} />
            <div className="ml-4 border-l-2 border-primary/40 pl-5">
              <VersionLine label="当前生产记录" sha={row.currentCommit} subject={commitMeta[row.currentCommit]?.subject || (row.currentCommit ? '暂无提交说明' : '尚无成功发布记录')} production />
            </div>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-[hsl(var(--hairline))] py-3 text-sm">
            <span>生产独有 <strong className="text-primary">{knownPosition ? row.commitPosition!.aheadCount : '未知'}</strong> 个提交</span>
            <span>主干后续 <strong>{knownPosition ? row.commitPosition!.behindCount : '未知'}</strong> 个提交</span>
            <span>重叠文件 <strong>{comparison?.overlapCount ?? '未知'}</strong> 个</span>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">受影响文件</h3>
            <span className="text-xs text-muted-foreground">{comparison ? formatDateTime(comparison.comparedAt) : '尚无比较快照'}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">文件重叠需重点检查，文本冲突尚未经过预合并核验。</p>
          {comparison?.reason ? (
            <p role="status" className="py-5 text-sm text-muted-foreground">{comparison.reason}</p>
          ) : comparison?.baseSha ? (
            <>
              <div aria-label="文件范围" className="mt-3 flex flex-wrap gap-1">
                {FILTERS.map(item => (
                  <Button key={item.value} variant={filter === item.value ? 'secondary' : 'ghost'} size="sm" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</Button>
                ))}
              </div>
              {files.length ? (
                <div className="mt-2 max-h-[22rem] overflow-auto">
                  <table className="w-full min-w-[30rem] text-left text-xs">
                    <thead className="sticky top-0 bg-background"><tr className="border-b border-[hsl(var(--hairline))]"><th className="py-2 font-medium">文件</th><th className="py-2 font-medium">变更归属</th><th className="py-2 font-medium">冲突结论</th></tr></thead>
                    <tbody>{files.map(file => (
                      <tr key={file.path} className="border-b border-[hsl(var(--hairline))]">
                        <td className="break-all py-2.5 pr-4"><FileText className="mr-2 inline h-4 w-4 text-muted-foreground" />{file.path}</td>
                        <td className="whitespace-nowrap pr-4">{file.side === 'both' ? '双方重叠' : file.side === 'production' ? '生产侧' : '主干侧'}</td>
                        <td className="whitespace-nowrap text-muted-foreground">未核验</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <p className="py-5 text-sm text-muted-foreground">{comparison.files.length ? '此范围没有文件。' : '没有文件差异，历史包含关系仍以提交比较为准。'}</p>}
              {comparison.truncated ? <p className="mt-2 text-xs text-muted-foreground">列表取前 200 个文件，筛选在此范围内进行；统计包含完整比较结果。</p> : null}
            </>
          ) : <p className="py-5 text-sm text-muted-foreground">缺少版本或比较快照，暂时无法确认差异。</p>}
          <p className="mt-3 text-xs text-muted-foreground">主干引用截至 {formatDateTime(rail?.refsAsOf)}。发布台账不代表外部操作后的实际运行版本。</p>
        </div>

        <aside className="min-w-0 border-t border-[hsl(var(--hairline))] pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
          <h3 className="text-base font-semibold">发布追溯</h3>
          <p className="mt-2 break-all font-mono text-sm">{row.currentCommit || '未发布'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(row.lastReleasedAt)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">健康快照<Chip tone={healthTone(row.healthStatus)}>{healthLabel(row.healthStatus)}</Chip></div>
          <dl className="mt-5 space-y-4 border-y border-[hsl(var(--hairline))] py-5 text-sm">
            <div>
              <dt className="flex items-center gap-2 text-muted-foreground"><UserRound className="h-4 w-4" />发起人 / 执行凭据</dt>
              <dd className="mt-1 break-all">{releaseActorLabel(current?.operator)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-muted-foreground"><ShieldCheck className="h-4 w-4" />批准记录</dt>
              <dd className="mt-1">未记录独立批准证据</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-muted-foreground"><Bot className="h-4 w-4" />关联对话</dt>
              <dd className="mt-1 break-all">{thread || '未记录'}</dd>
              {thread ? <p className="mt-1 text-xs text-muted-foreground">由调用方声明。</p> : null}
            </div>
          </dl>
          <div className="py-5">
            <h4 className="flex items-center gap-2 font-medium"><GitBranch className="h-4 w-4" />回并状态</h4>
            <p className={`mt-2 text-sm ${hasExtra ? 'text-warn' : 'text-muted-foreground'}`}>{releaseMergeState(row.commitPosition)}</p>
            <p className="mt-2 text-xs text-muted-foreground">按 Git 历史判断，尚未关联回并 PR 与负责人。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!current} onClick={() => current && onOpenLogs(current)}>查看发布证据</Button>
            <Button variant="outline" size="sm" onClick={() => setDetail(true)}>版本依据</Button>
            <Button variant="ghost" size="sm" onClick={() => onInspect(row.target.id)}>环境配置<ArrowUpRight /></Button>
          </div>
        </aside>
      </div>

      <Dialog open={detail} onOpenChange={setDetail}>
        <DialogContent>
          <DialogHeader><DialogTitle>固定版本比较依据</DialogTitle><DialogDescription>保留原始版本与观察时间，便于复核同一组提交。</DialogDescription></DialogHeader>
          <dl className="space-y-3 break-all text-sm">
            <div><dt className="text-muted-foreground">生产提交</dt><dd>{row.currentCommit || '未知'}</dd></div>
            <div><dt className="text-muted-foreground">主干提交</dt><dd>{comparison?.mainSha || main?.sha || '未知'}</dd></div>
            <div><dt className="text-muted-foreground">共同起点</dt><dd>{comparison?.baseSha || '未计算成功'}</dd></div>
            <div><dt className="text-muted-foreground">发布记录</dt><dd>{current?.releaseId || '未知'}</dd></div>
            <div><dt className="text-muted-foreground">观察口径</dt><dd>展示最近成功发布记录；外部版本偏移需结合健康与发布证据核对。</dd></div>
          </dl>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function VersionLine({ label, sha, subject, production = false }: { label: string; sha?: string; subject: string; production?: boolean }): JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-4">
      <span className={`mt-2 h-3 w-3 shrink-0 rounded-full border-2 ${production ? 'border-primary' : 'border-muted-foreground'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><span className={production ? 'font-medium text-primary' : 'font-medium'}>{label}</span><span className="font-mono text-sm">{sha ? sha.slice(0, 12) : '未知'}</span></div>
        <p className="mt-1 truncate text-sm text-muted-foreground" title={subject}>{subject}</p>
      </div>
    </div>
  );
}
