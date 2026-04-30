import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, GitBranch, Loader2, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react';

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

interface SelfBranchesResponse {
  current: string;
  commitHash: string;
  branches: string[];
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
  const [selectedBranch, setSelectedBranch] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
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

  const visibleBranches = useMemo(() => {
    if (branchState.status !== 'ok') return [];
    const query = branchQuery.trim().toLowerCase();
    return branchState.data.branches
      .filter((branch) => !query || branch.toLowerCase().includes(query))
      .slice(0, 80);
  }, [branchQuery, branchState]);

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

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium">搜索分支</span>
                    <input
                      value={branchQuery}
                      onChange={(event) => setBranchQuery(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="main / release / codex/..."
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium">目标分支</span>
                    <select
                      value={selectedBranch}
                      onChange={(event) => setSelectedBranch(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {visibleBranches.length === 0 ? (
                        <option value={selectedBranch}>{selectedBranch || '无匹配分支'}</option>
                      ) : (
                        visibleBranches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))
                      )}
                    </select>
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
