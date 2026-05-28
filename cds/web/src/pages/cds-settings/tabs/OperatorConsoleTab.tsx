// CDS 运维控制台 — 用户侧入口
//
// 2026-05-28 用户反馈:"不希望在前端 agent 和 SSH agent 之间反复 bounce"。
// 这里展示注册到 operatorOpRegistry 的所有 ops,用户点击 → 后端 SSE 流式
// 返回日志 + 最终结果。
//
// 设计要点:
// - safe op:点击即执行
// - sensitive op:点击弹出二次确认 dialog
// - destructive op:点击弹出确认 dialog,要求输入 confirmText
// - 执行中实时滚动 log,完成后展示 summary + details (JSON 可折叠)

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Play, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiRequest, apiUrl, ApiError } from '@/lib/api';
import { ErrorBlock, LoadingBlock, Section } from '../components';

type Danger = 'safe' | 'sensitive' | 'destructive';

interface OpDef {
  id: string;
  name: string;
  description: string;
  danger: Danger;
  confirmText?: string;
  estimatedSeconds?: number;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; ops: OpDef[] };

interface LogLine {
  ts: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

interface RunState {
  opId: string;
  startedAt: string;
  logs: LogLine[];
  finished: boolean;
  result?: { summary: string; details?: Record<string, unknown> };
  error?: string;
}

const DANGER_LABEL: Record<Danger, { label: string; cls: string }> = {
  safe: { label: '只读 / 安全', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  sensitive: { label: '会改运行时配置', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  destructive: { label: '高危,需二次确认', cls: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

export function OperatorConsoleTab({ onToast }: { onToast: (msg: string) => void }): JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [running, setRunning] = useState<RunState | null>(null);
  const [pendingOp, setPendingOp] = useState<OpDef | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [shellCmd, setShellCmd] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<{ ok: boolean; ops: OpDef[] }>('/api/cds-system/operator/ops');
      setState({ status: 'ok', ops: data.ops || [] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 自动滚到底部
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [running?.logs.length]);

  const executeOp = useCallback(async (op: OpDef, args?: Record<string, unknown>) => {
    setRunning({ opId: op.id, startedAt: new Date().toISOString(), logs: [], finished: false });
    onToast(`正在执行: ${op.name}`);

    try {
      const resp = await fetch(apiUrl('/api/cds-system/operator/run'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ opId: op.id, confirmText: op.confirmText, args }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      if (!resp.body) throw new Error('响应没有 body');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const evt of events) {
          const lines = evt.split('\n');
          let eventType = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!data) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (eventType === 'log') {
            const l = parsed as LogLine;
            setRunning((cur) => cur ? { ...cur, logs: [...cur.logs, l] } : null);
          } else if (eventType === 'done') {
            const d = parsed as { summary: string; details?: Record<string, unknown> };
            setRunning((cur) => cur ? { ...cur, finished: true, result: d } : null);
            onToast(`完成: ${d.summary}`);
          } else if (eventType === 'failed') {
            const d = parsed as { error: string };
            setRunning((cur) => cur ? { ...cur, finished: true, error: d.error } : null);
            onToast(`失败: ${d.error}`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRunning((cur) => cur ? { ...cur, finished: true, error: message } : null);
      onToast(`执行失败: ${message}`);
    }
  }, [onToast]);

  const handleOpClick = (op: OpDef) => {
    if (op.danger === 'safe') {
      void executeOp(op);
      return;
    }
    setPendingOp(op);
    setConfirmInput('');
    setShellCmd('');
  };

  const confirmAndRun = () => {
    if (!pendingOp) return;
    if (pendingOp.confirmText && confirmInput.trim() !== pendingOp.confirmText) {
      onToast('确认文本不匹配,无法执行');
      return;
    }
    const args = pendingOp.id === 'shell.run' ? { command: shellCmd } : undefined;
    const op = pendingOp;
    setPendingOp(null);
    void executeOp(op, args);
  };

  if (state.status === 'loading') return <LoadingBlock label="加载运维操作列表" />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  return (
    <div className="space-y-8">
      <Section
        title="运维控制台"
        description={
          <>
            把"必须 SSH 上服务器才能改"的运维操作收口到这里。所有操作走鉴权 + 注册表 + 审计日志,
            高危操作需要二次确认。新需求由 <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">cds/src/services/operator-console.ts</code> 注册新 op。
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          {state.ops.map((op) => {
            const meta = DANGER_LABEL[op.danger];
            return (
              <div
                key={op.id}
                className="cds-surface-sunken cds-hairline rounded-md p-4"
              >
                <div className="mb-2 flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold">{op.name}</span>
                  <span className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] ${meta.cls}`}>
                    {meta.label}
                  </span>
                </div>
                <p className="mb-3 text-xs leading-5 text-muted-foreground">{op.description}</p>
                {op.estimatedSeconds ? (
                  <p className="mb-3 text-[11px] text-muted-foreground/70">
                    预计耗时: ~{op.estimatedSeconds}s
                  </p>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={op.danger === 'destructive' ? 'destructive' : 'default'}
                  onClick={() => handleOpClick(op)}
                  disabled={!!running && !running.finished}
                  className="w-full"
                >
                  <Play className="h-3.5 w-3.5" />
                  执行
                </Button>
              </div>
            );
          })}
        </div>
      </Section>

      {running ? (
        <Section title={`执行日志: ${state.status === 'ok' ? (state.ops.find((o) => o.id === running.opId)?.name ?? running.opId) : running.opId}`}>
          <div className="cds-surface-sunken cds-hairline max-h-96 overflow-auto rounded-md p-3 font-mono text-xs">
            {running.logs.length === 0 && !running.finished ? (
              <div className="text-muted-foreground">连接中,等待第一条日志...</div>
            ) : null}
            {running.logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.level === 'error' ? 'text-destructive' :
                  l.level === 'warning' ? 'text-amber-600 dark:text-amber-400' :
                  'text-foreground/85'
                }
              >
                <span className="opacity-50">[{l.ts.slice(11, 19)}]</span> {l.message}
              </div>
            ))}
            {running.finished && running.result ? (
              <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-300">
                <strong>完成:</strong> {running.result.summary}
                {running.result.details ? (
                  <DetailsBlock details={running.result.details} />
                ) : null}
              </div>
            ) : null}
            {running.finished && running.error ? (
              <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                <strong>失败:</strong> {running.error}
              </div>
            ) : null}
            <div ref={logEndRef} />
          </div>
        </Section>
      ) : null}

      <Dialog open={!!pendingOp} onOpenChange={(open) => { if (!open) setPendingOp(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认执行: {pendingOp?.name}
            </DialogTitle>
            <DialogDescription>
              {pendingOp?.description}
            </DialogDescription>
          </DialogHeader>
          {pendingOp?.id === 'shell.run' ? (
            <div className="space-y-2">
              <label className="text-sm font-semibold">Shell 命令</label>
              <textarea
                className="cds-surface-sunken cds-hairline w-full rounded-md px-3 py-2 font-mono text-sm"
                rows={3}
                value={shellCmd}
                onChange={(e) => setShellCmd(e.target.value)}
                placeholder="例: docker exec cds_nginx nginx -T 2>&1 | head -50"
              />
            </div>
          ) : null}
          {pendingOp?.confirmText ? (
            <div className="space-y-2">
              <label className="text-sm font-semibold">输入确认文本(完整复制下方文字)</label>
              <div className="cds-surface-sunken rounded px-2 py-1 text-xs font-mono">
                {pendingOp.confirmText}
              </div>
              <input
                type="text"
                className="cds-surface-sunken cds-hairline w-full rounded-md px-3 py-2 text-sm"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder="逐字复制粘贴上面的确认文本"
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingOp(null)}>取消</Button>
            <Button
              type="button"
              variant={pendingOp?.danger === 'destructive' ? 'destructive' : 'default'}
              onClick={confirmAndRun}
              disabled={
                (!!pendingOp?.confirmText && confirmInput.trim() !== pendingOp.confirmText) ||
                (pendingOp?.id === 'shell.run' && !shellCmd.trim())
              }
            >
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailsBlock({ details }: { details: Record<string, unknown> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-foreground/70 hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        详细数据
      </button>
      {expanded ? (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background/60 p-2 text-[10px]">
          {JSON.stringify(details, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
