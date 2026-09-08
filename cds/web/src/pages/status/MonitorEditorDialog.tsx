/*
 * 添加 / 编辑自定义监控。
 *
 * 最小输入原则：主路径只有「选方式 + 填地址」两步，名称留空由服务端按主机名派生；
 * 方法 / 状态码规则 / 间隔 / 超时 / 归属项目 / 标签全部收进「高级」折叠区，
 * 各有正确默认值。保存前可以「测试一次」——走与轮次相同的探测实现，结果当场可见。
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, FlaskConical, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { MONITOR_KIND_META, formatLatency, type CustomMonitor, type MonitorKind } from '@/lib/monitorCenter';

interface ProjectRow {
  id: string;
  name?: string;
  slug?: string;
}

interface Draft {
  kind: MonitorKind;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
  keyword: string;
  host: string;
  port: string;
  intervalSeconds: string;
  timeoutMs: string;
  projectId: string;
  tags: string;
}

interface TestResult {
  up: boolean;
  ms: number;
  code?: number;
  err?: string;
  name: string;
  description: string;
}

const KINDS: ReadonlyArray<MonitorKind> = ['http', 'keyword', 'tcp'];

function draftFrom(monitor: CustomMonitor | null): Draft {
  return {
    kind: monitor?.kind || 'http',
    name: monitor?.name || '',
    url: monitor?.url || '',
    method: monitor?.method || 'GET',
    expectedStatus: monitor?.expectedStatus || '',
    keyword: monitor?.keyword || '',
    host: monitor?.host || '',
    port: monitor?.port ? String(monitor.port) : '',
    intervalSeconds: monitor?.intervalSeconds ? String(monitor.intervalSeconds) : '',
    timeoutMs: monitor?.timeoutMs ? String(monitor.timeoutMs) : '',
    projectId: monitor?.projectId || '',
    tags: (monitor?.tags || []).join(', '),
  };
}

/** 把草稿收成请求体：空串一律不传，让服务端用默认值 / 沿用旧值。 */
function payloadOf(draft: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: draft.kind, name: draft.name };
  if (draft.kind === 'tcp') {
    body.host = draft.host;
    body.port = draft.port;
  } else {
    body.url = draft.url;
    body.method = draft.method;
    if (draft.expectedStatus.trim()) body.expectedStatus = draft.expectedStatus;
    if (draft.kind === 'keyword') body.keyword = draft.keyword;
  }
  if (draft.intervalSeconds.trim()) body.intervalSeconds = draft.intervalSeconds;
  if (draft.timeoutMs.trim()) body.timeoutMs = draft.timeoutMs;
  body.projectId = draft.projectId || null;
  body.tags = draft.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  return body;
}

function errorOf(err: unknown): { message: string; field?: string } {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; field?: string } | null;
    return { message: body?.error || err.message, field: body?.field };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

const INPUT_CLASS = 'h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60';

function FieldRow({ label, hint, error, children, htmlFor }: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  htmlFor?: string;
}): JSX.Element {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {error ? <div className="text-xs text-destructive">{error}</div> : hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function MonitorEditorDialog({ open, monitor, defaultProjectId, onOpenChange, onSaved }: {
  open: boolean;
  /** null = 新建 */
  monitor: CustomMonitor | null;
  defaultProjectId?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (saved: CustomMonitor) => Promise<void> | void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(monitor));
  const [advanced, setAdvanced] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const editing = Boolean(monitor);

  useEffect(() => {
    if (!open) return;
    const next = draftFrom(monitor);
    if (!monitor && defaultProjectId) next.projectId = defaultProjectId;
    setDraft(next);
    setAdvanced(Boolean(monitor && (monitor.intervalSeconds || monitor.timeoutMs || monitor.expectedStatus || monitor.method === 'HEAD' || (monitor.tags || []).length > 0)));
    setTestResult(null);
    setError(null);
    apiRequest<{ projects: ProjectRow[] }>('/api/projects')
      .then((res) => setProjects(res.projects || []))
      .catch(() => setProjects([]));
  }, [open, monitor, defaultProjectId]);

  const update = (patch: Partial<Draft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setTestResult(null);
    setError(null);
  };

  const canSubmit = useMemo(() => {
    if (draft.kind === 'tcp') return draft.host.trim().length > 0 && draft.port.trim().length > 0;
    if (draft.kind === 'keyword' && !draft.keyword.trim()) return false;
    return draft.url.trim().length > 0;
  }, [draft]);

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    try {
      const res = await apiRequest<TestResult & { ok: boolean }>('/api/uptime/monitors/test', { method: 'POST', body: payloadOf(draft) });
      setTestResult(res);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setTesting(false);
    }
  };

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = monitor
        ? await apiRequest<{ monitor: CustomMonitor }>(`/api/uptime/monitors/${encodeURIComponent(monitor.id)}`, { method: 'PUT', body: payloadOf(draft) })
        : await apiRequest<{ monitor: CustomMonitor }>('/api/uptime/monitors', { method: 'POST', body: payloadOf(draft) });
      await onSaved(res.monitor);
      onOpenChange(false);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (field: string): string | undefined => (error?.field === field ? error.message : undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame className="max-w-xl">
        <DialogHeader className="shrink-0 border-b border-[hsl(var(--hairline))] px-5 py-4">
          <DialogTitle>{editing ? `编辑监控 · ${monitor?.name}` : '添加监控'}</DialogTitle>
          <DialogDescription>
            {editing ? '改完保存后立刻按新规则探一次。' : '选一种探测方式、填地址就够了；名称留空会按主机名自动命名。'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => { event.preventDefault(); if (canSubmit && !saving) void submit(); }}
          >
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="探测方式">
              {KINDS.map((kind) => {
                const meta = MONITOR_KIND_META[kind];
                const selected = draft.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => update({ kind })}
                    className={cn(
                      'flex flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
                      selected ? 'border-primary/60 bg-primary/10' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 hover:border-[hsl(var(--hairline-strong))]',
                    )}
                  >
                    <span className={cn('text-sm font-medium', selected ? 'text-primary' : 'text-foreground')}>{meta.label}</span>
                    <span className="text-[11px] leading-4 text-muted-foreground">{meta.hint}</span>
                  </button>
                );
              })}
            </div>

            {draft.kind === 'tcp' ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                <FieldRow label="主机" htmlFor="mon-host" error={fieldError('host')} hint="域名或 IP，不带协议">
                  <input id="mon-host" className={INPUT_CLASS} value={draft.host} onChange={(e) => update({ host: e.target.value })} placeholder="redis.internal" autoFocus />
                </FieldRow>
                <FieldRow label="端口" htmlFor="mon-port" error={fieldError('port')}>
                  <input id="mon-port" className={INPUT_CLASS} inputMode="numeric" value={draft.port} onChange={(e) => update({ port: e.target.value })} placeholder="6379" />
                </FieldRow>
              </div>
            ) : (
              <FieldRow label="地址" htmlFor="mon-url" error={fieldError('url')} hint="http:// 或 https:// 开头的完整地址">
                <input id="mon-url" className={INPUT_CLASS} value={draft.url} onChange={(e) => update({ url: e.target.value })} placeholder="https://api.example.com/health" autoFocus />
              </FieldRow>
            )}

            {draft.kind === 'keyword' ? (
              <FieldRow label="响应必须包含" htmlFor="mon-keyword" error={fieldError('keyword')} hint="区分大小写；只读取响应体前 512 KB">
                <input id="mon-keyword" className={INPUT_CLASS} value={draft.keyword} onChange={(e) => update({ keyword: e.target.value })} placeholder={'"status":"ok"'} />
              </FieldRow>
            ) : null}

            <FieldRow label="名称" htmlFor="mon-name" error={fieldError('name')} hint="留空自动取主机名">
              <input id="mon-name" className={INPUT_CLASS} value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="上游网关" />
            </FieldRow>

            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={advanced}
            >
              {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              高级选项（方法、状态码规则、间隔、超时、归属、标签）
            </button>

            {advanced ? (
              <div className="grid gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 p-3 sm:grid-cols-2">
                {draft.kind !== 'tcp' ? (
                  <>
                    <FieldRow label="请求方法" htmlFor="mon-method" error={fieldError('method')} hint={draft.kind === 'keyword' ? '关键字探测只能用 GET' : 'HEAD 更省流量，但有些服务不支持'}>
                      <select id="mon-method" className={INPUT_CLASS} value={draft.method} onChange={(e) => update({ method: e.target.value as 'GET' | 'HEAD' })} disabled={draft.kind === 'keyword'}>
                        <option value="GET">GET</option>
                        <option value="HEAD">HEAD</option>
                      </select>
                    </FieldRow>
                    <FieldRow label="判定正常的状态码" htmlFor="mon-status" error={fieldError('expectedStatus')} hint="默认 200-399；可写 200-299,401">
                      <input id="mon-status" className={INPUT_CLASS} value={draft.expectedStatus} onChange={(e) => update({ expectedStatus: e.target.value })} placeholder="200-399" />
                    </FieldRow>
                  </>
                ) : null}
                <FieldRow label="探测间隔（秒）" htmlFor="mon-interval" error={fieldError('intervalSeconds')} hint="留空跟随实例全局间隔；只能比全局慢">
                  <input id="mon-interval" className={INPUT_CLASS} inputMode="numeric" value={draft.intervalSeconds} onChange={(e) => update({ intervalSeconds: e.target.value })} placeholder="跟随全局" />
                </FieldRow>
                <FieldRow label="超时（毫秒）" htmlFor="mon-timeout" error={fieldError('timeoutMs')} hint="留空跟随实例全局超时">
                  <input id="mon-timeout" className={INPUT_CLASS} inputMode="numeric" value={draft.timeoutMs} onChange={(e) => update({ timeoutMs: e.target.value })} placeholder="跟随全局" />
                </FieldRow>
                <FieldRow label="归属项目" htmlFor="mon-project" error={fieldError('projectId')} hint="系统级 = 只有人类账号与全局 Key 可见">
                  <select id="mon-project" className={INPUT_CLASS} value={draft.projectId} onChange={(e) => update({ projectId: e.target.value })}>
                    <option value="">系统级（不归属项目）</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name || p.slug || p.id}</option>)}
                  </select>
                </FieldRow>
                <FieldRow label="标签" htmlFor="mon-tags" error={fieldError('tags')} hint="逗号分隔，用于搜索">
                  <input id="mon-tags" className={INPUT_CLASS} value={draft.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="核心, 第三方" />
                </FieldRow>
              </div>
            ) : null}

            {testResult ? (
              <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5', testResult.up ? 'border-ok/40 bg-ok-soft text-ok' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
                {testResult.up ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                <div className="min-w-0">
                  <div className="font-medium">
                    {testResult.up ? '探测成功' : '探测失败'} · {formatLatency(testResult.ms)}
                    {testResult.code ? ` · HTTP ${testResult.code}` : ''}
                  </div>
                  {testResult.err ? <div className="break-all opacity-90">{testResult.err}</div> : null}
                  <div className="break-all font-mono opacity-75">{testResult.description}</div>
                  {!draft.name.trim() ? <div className="opacity-75">将命名为「{testResult.name}」</div> : null}
                </div>
              </div>
            ) : null}
            {error && !error.field ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error.message}</div>
            ) : null}
          </form>
        </DialogBody>
        <DialogFooter className="shrink-0 items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-3 sm:justify-between">
          <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={!canSubmit || testing || saving}>
            <FlaskConical className={testing ? 'animate-pulse' : undefined} />
            {testing ? '探测中' : '测试一次'}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button type="button" size="sm" onClick={() => void submit()} disabled={!canSubmit || saving || testing}>
              {saving ? '保存中' : editing ? '保存修改' : '添加并开始探测'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
