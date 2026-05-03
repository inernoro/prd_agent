import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, GitBranch, Loader2, RefreshCw, RotateCw, ShieldCheck, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, Section } from '../components';

interface BranchMeta {
  name: string;
  committerDate: string;
  commitHash: string;
  subject: string;
  cdsTouched: boolean;
}

interface SelfBranchesResponse {
  current: string;
  commitHash: string;
  currentCommitterDate?: string;
  branches: string[];
  branchDetails?: BranchMeta[];
}

interface DryRunResponse {
  ok: boolean;
  summary?: string;
  durationMs?: number;
  stage?: string;
  error?: string;
  hint?: string;
}

type BranchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SelfBranchesResponse };

type UpdateRunState = 'idle' | 'running' | 'success' | 'error';

function parseSseBlock(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!raw.trim()) return null;
  if (!data) return { event, data: null };
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

/** 格式化相对时间(N 分钟前 / N 小时前 / N 天前)— branch picker 时间列用。 */
function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '刚才';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

function eventTitle(event: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.title === 'string') return obj.title;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.step === 'string') return String(obj.step);
  }
  if (typeof data === 'string') return data;
  return event;
}

async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${path} -> ${response.status}`);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed.event, parsed.data);
        index = buffer.indexOf('\n\n');
      }
    }
    if (done) break;
  }
}

export function MaintenanceTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [branchState, setBranchState] = useState<BranchState>({ status: 'loading' });
  // 2026-05-04 重构(用户反馈):删掉 branchQuery + selectedBranch 双 state,
  // 改为单一 selectedBranch state。combobox input value === selectedBranch,
  // 用户输入即"选择",杜绝"搜了但实际发的还是旧 branch"的核心 bug。
  // 显示 dropdown 只是过滤候选项,不再独立 state。
  const [selectedBranch, setSelectedBranch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [runState, setRunState] = useState<UpdateRunState>('idle');
  const [runTitle, setRunTitle] = useState('');
  const [runLog, setRunLog] = useState<string[]>([]);

  const loadBranches = useCallback(async () => {
    setBranchState({ status: 'loading' });
    try {
      const data = await apiRequest<SelfBranchesResponse>('/api/self-branches');
      setBranchState({ status: 'ok', data });
      setSelectedBranch((current) => current || data.current || data.branches?.[0] || '');
    } catch (err) {
      setBranchState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  // 关闭 dropdown 当用户点外面
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (event: PointerEvent): void => {
      if (!pickerWrapRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [pickerOpen]);

  /** 候选分支列表 — 按 committerDate 倒排,优先用 branchDetails(后端已排好序),
   * fallback 到旧 branches: string[]。当前分支总在最前(便于看到自己在哪)。*/
  const visibleBranches = useMemo<BranchMeta[]>(() => {
    if (branchState.status !== 'ok') return [];
    const query = selectedBranch.trim().toLowerCase();
    const details = branchState.data.branchDetails;
    const list: BranchMeta[] = details && details.length > 0
      ? details
      : (branchState.data.branches || []).map((name) => ({
          name,
          committerDate: '',
          commitHash: '',
          subject: '',
          cdsTouched: false,
        }));
    // query 为空 → 全部;有 query → 过滤
    const filtered = query
      ? list.filter((b) => b.name.toLowerCase().includes(query))
      : list;
    // 当前分支放最前(如果在过滤结果里)
    const current = branchState.data.current;
    const sorted = filtered.slice().sort((a, b) => {
      if (a.name === current) return -1;
      if (b.name === current) return 1;
      return 0;
    });
    return sorted.slice(0, 80);
  }, [selectedBranch, branchState]);

  function appendRunLine(line: string): void {
    if (!line.trim()) return;
    setRunLog((current) => [...current.slice(-160), line]);
  }

  async function runPreflight(): Promise<void> {
    setDryRunning(true);
    setDryRun(null);
    try {
      const result = await apiRequest<DryRunResponse>('/api/self-update-dry-run', { method: 'POST', body: {} });
      setDryRun(result);
      onToast('自更新预检通过');
    } catch (err) {
      if (err instanceof ApiError && typeof err.body === 'object' && err.body !== null) {
        const body = err.body as DryRunResponse;
        setDryRun({ ...body, ok: false });
      } else {
        setDryRun({ ok: false, error: String(err) });
      }
      onToast('自更新预检失败');
    } finally {
      setDryRunning(false);
    }
  }

  async function runSelfUpdate(endpoint: '/api/self-update' | '/api/self-force-sync', label: string): Promise<void> {
    if (runState === 'running') return;

    setRunState('running');
    setRunTitle(`${label} 已启动`);
    setRunLog([]);
    setDryRun(null);
    try {
      await postSse(endpoint, { branch: selectedBranch || undefined }, (event, data) => {
        const title = eventTitle(event, data);
        if (event === 'error') {
          setRunState('error');
          setRunTitle(title);
        } else if (event === 'done') {
          setRunState('success');
          setRunTitle(title);
        } else {
          setRunTitle(title);
        }
        appendRunLine(title);
      });
      setRunState((current) => (current === 'error' ? 'error' : 'success'));
      onToast(`${label} 已提交`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRunState('error');
      setRunTitle(message);
      appendRunLine(message);
      onToast(`${label} 失败：${message}`);
    }
  }

  async function copyRunLog(): Promise<void> {
    const text = runLog.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onToast('更新日志已复制');
    } catch {
      onToast(text || '暂无日志');
    }
  }

  async function factoryReset(): Promise<void> {
    setSubmitting(true);
    try {
      await apiRequest('/api/factory-reset', { method: 'POST' });
      onToast('已恢复出厂设置，正在跳转');
      setOpen(false);
      window.setTimeout(() => {
        window.location.href = '/project-list';
      }, 1500);
    } catch (err) {
      onToast(`失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <Section title="CDS 更新" description="先预检当前代码能否启动，再选择更新或强制同步。真实重启前会再次确认。">
        <div className="space-y-5">
          {branchState.status === 'loading' ? <LoadingBlock label="读取 CDS 源码分支" /> : null}
          {branchState.status === 'error' ? <ErrorBlock message={branchState.message} /> : null}
          {branchState.status === 'ok' ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-md border border-border bg-card px-4 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">当前分支</span>
                      <CodePill>{branchState.data.current || '-'}</CodePill>
                      {branchState.data.commitHash ? <CodePill>{branchState.data.commitHash}</CodePill> : null}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      更新会先 fetch，再切到目标分支并对齐 origin，预检通过后重启 CDS。
                    </div>
                  </div>
                  <Button type="button" variant="outline" onClick={() => void loadBranches()}>
                    <RefreshCw />
                    刷新分支
                  </Button>
                </div>

                {/* 2026-05-04 重构:单 input combobox 取代「搜索框 + 经典 select」双控件。
                    用户输入 = selectedBranch(无歧义),回车/点击候选 = 确认选中。
                    候选下拉显示更新时间 + cds-touched 标识(是否动了 cds/ 目录)。 */}
                <div className="mt-4">
                  <label className="block space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">目标分支</span>
                      <span className="text-[11px] text-muted-foreground">
                        {visibleBranches.length} 个候选 · 按更新时间倒序 · ✨ 表示该分支动过 cds/
                      </span>
                    </div>
                    <div ref={pickerWrapRef} className="relative">
                      <input
                        ref={inputRef}
                        type="text"
                        value={selectedBranch}
                        onChange={(event) => {
                          setSelectedBranch(event.target.value);
                          setPickerOpen(true);
                          setHighlightedIndex(0);
                        }}
                        onFocus={() => setPickerOpen(true)}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setPickerOpen(true);
                            setHighlightedIndex((i) => Math.min(i + 1, visibleBranches.length - 1));
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setHighlightedIndex((i) => Math.max(i - 1, 0));
                          } else if (event.key === 'Enter') {
                            event.preventDefault();
                            const pick = visibleBranches[highlightedIndex];
                            if (pick) {
                              setSelectedBranch(pick.name);
                              setPickerOpen(false);
                            }
                          } else if (event.key === 'Escape') {
                            setPickerOpen(false);
                          }
                        }}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="输入或选择分支(main / release / codex/...)"
                        autoComplete="off"
                        spellCheck={false}
                        role="combobox"
                        aria-expanded={pickerOpen}
                        aria-autocomplete="list"
                      />
                      {pickerOpen && visibleBranches.length > 0 ? (
                        <div
                          role="listbox"
                          className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-[360px] overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
                          style={{ overscrollBehavior: 'contain' }}
                        >
                          {visibleBranches.map((branch, idx) => {
                            const isCurrent = branch.name === branchState.data.current;
                            const isHighlighted = idx === highlightedIndex;
                            return (
                              <button
                                key={branch.name}
                                type="button"
                                role="option"
                                aria-selected={isHighlighted}
                                onMouseEnter={() => setHighlightedIndex(idx)}
                                onClick={() => {
                                  setSelectedBranch(branch.name);
                                  setPickerOpen(false);
                                  inputRef.current?.focus();
                                }}
                                className={`block w-full border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-xs last:border-b-0 ${
                                  isHighlighted ? 'bg-[hsl(var(--surface-sunken))]' : ''
                                }`}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                                    {branch.name}
                                  </span>
                                  {isCurrent ? (
                                    <span className="shrink-0 rounded border border-emerald-500/50 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                      当前
                                    </span>
                                  ) : null}
                                  {branch.cdsTouched ? (
                                    <span
                                      className="shrink-0 rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                                      title="该分支相对当前 HEAD 改动过 cds/ 目录"
                                    >
                                      <Sparkles className="mr-0.5 inline h-2.5 w-2.5" />
                                      改了 CDS
                                    </span>
                                  ) : null}
                                </div>
                                {branch.committerDate || branch.subject || branch.commitHash ? (
                                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5 text-[10px] text-muted-foreground">
                                    {branch.committerDate ? (
                                      <span title={branch.committerDate}>
                                        {formatRelativeTime(branch.committerDate)}
                                      </span>
                                    ) : null}
                                    {branch.commitHash ? (
                                      <span className="font-mono">{branch.commitHash}</span>
                                    ) : null}
                                    {branch.subject ? (
                                      <span className="min-w-0 truncate">{branch.subject}</span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {pickerOpen && visibleBranches.length === 0 ? (
                        <div className="absolute left-0 right-0 top-full z-[100] mt-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-3 text-xs text-muted-foreground shadow-2xl">
                          没有匹配「{selectedBranch}」的分支。回车将以原值提交(后端会预检 origin/{selectedBranch} 是否存在)。
                        </div>
                      ) : null}
                    </div>
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => void runPreflight()} disabled={dryRunning}>
                    {dryRunning ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                    预检
                  </Button>
                  <ConfirmAction
                    title="更新并重启"
                    description="执行 self-update，完成后会重启 CDS。"
                    confirmLabel="执行"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-update', '更新并重启')}
                    trigger={
                      <Button type="button" disabled={runState === 'running'}>
                        {runState === 'running' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        更新并重启
                      </Button>
                    }
                  />
                  <ConfirmAction
                    title="强制同步"
                    description={`会 git fetch 后 hard reset 到 origin/${selectedBranch || '当前分支'}，丢弃 CDS host 上未推送的本地提交，并重启 CDS。`}
                    confirmLabel="强制同步"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-force-sync', '强制同步')}
                    trigger={
                      <Button type="button" variant="outline" disabled={runState === 'running'}>
                        <AlertTriangle />
                        强制同步
                      </Button>
                    }
                  />
                </div>
              </div>

              <div className="rounded-md border border-border bg-card px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">预检结果</div>
                  {dryRun?.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
                </div>
                {!dryRun ? (
                  <div className="text-sm leading-6 text-muted-foreground">预检会运行 pnpm install --frozen-lockfile 和 tsc --noEmit，不会重启。</div>
                ) : dryRun.ok ? (
                  <div className="space-y-2 text-sm leading-6">
                    <div className="text-emerald-600">通过</div>
                    <div className="text-muted-foreground">{dryRun.summary || '依赖与编译通过'}</div>
                    {dryRun.durationMs ? <CodePill>{Math.round(dryRun.durationMs / 1000)}s</CodePill> : null}
                  </div>
                ) : (
                  <div className="space-y-2 text-sm leading-6">
                    <div className="text-destructive">失败{dryRun.stage ? `：${dryRun.stage}` : ''}</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{dryRun.error || '未知错误'}</div>
                    {dryRun.hint ? <div className="text-muted-foreground">{dryRun.hint}</div> : null}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <DisclosurePanel
            title={runTitle || '更新日志'}
            subtitle={runState === 'idle' ? '尚未执行更新。' : runState === 'running' ? '执行中' : runState === 'success' ? '已提交重启' : '执行失败'}
            contentClassName="p-0"
          >
              <div className="flex justify-end px-4 py-3">
                <Button type="button" variant="outline" size="sm" onClick={() => void copyRunLog()} disabled={runLog.length === 0}>
                  <Copy />
                  复制
                </Button>
              </div>
              <pre className="max-h-64 min-h-32 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
                {runLog.length ? runLog.join('\n') : '这里会显示 self-update / force-sync 的 SSE 步骤。'}
              </pre>
          </DisclosurePanel>
        </div>
      </Section>

      <DisclosurePanel title="危险操作" subtitle="影响所有项目的不可逆操作" tone="danger">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="destructive">
              <AlertTriangle className="mr-2 h-4 w-4" />
              恢复出厂设置
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认恢复出厂设置</DialogTitle>
              <DialogDescription>
                这会清空所有项目的分支、构建配置、环境变量、基础设施和路由规则。Docker 数据卷会保留。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="button" variant="destructive" onClick={() => void factoryReset()} disabled={submitting}>
                确认清空
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DisclosurePanel>
    </div>
  );
}
