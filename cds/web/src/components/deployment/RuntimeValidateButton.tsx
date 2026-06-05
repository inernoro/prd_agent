/*
 * RuntimeValidateButton — 配置闭环的"试运行验证"。
 * 点一下 → 后端起一次性容器，在真实仓库上跑「镜像 + 启动命令」，流式回日志 + 端口探活，
 * 给出 通过 / 需确认 / 不通过 三档结论。不行就改上面的命令/镜像，再点一次。容器跑完即销毁。
 * 后端:POST /api/validate-runtime (SSE)，见 cds/src/routes/projects.ts。
 */
import { useState } from 'react';
import { Play, Loader2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { apiUrl } from '@/lib/api';

interface StepEv { step: string; status: string; title: string }
type Verdict = 'pass' | 'warn' | 'fail';

const VERDICT_META: Record<Verdict, { icon: JSX.Element; cls: string; label: string }> = {
  pass: { icon: <CheckCircle2 className="h-4 w-4" />, cls: 'border-green-500/40 bg-green-500/10 text-green-600', label: '配置可用' },
  warn: { icon: <AlertTriangle className="h-4 w-4" />, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-600', label: '需确认' },
  fail: { icon: <XCircle className="h-4 w-4" />, cls: 'border-destructive/40 bg-destructive/10 text-destructive', label: '不通过' },
};

export function RuntimeValidateButton({
  gitRepoUrl,
  gitRef,
  image,
  command,
  port,
}: {
  gitRepoUrl: string;
  gitRef?: string;
  image: string;
  command: string;
  port: number;
}): JSX.Element {
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<StepEv[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ verdict: Verdict; summary: string } | null>(null);

  async function validate(): Promise<void> {
    if (!gitRepoUrl.trim()) {
      setResult({ verdict: 'fail', summary: '先在上面填 Git 仓库 URL 才能试运行——要在你的真实代码上测这条命令。' });
      setOpen(true);
      return;
    }
    setRunning(true); setOpen(true); setSteps([]); setLogs([]); setResult(null);
    try {
      const res = await fetch(apiUrl('/api/validate-runtime'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitRepoUrl, gitRef, image, command, port }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error('服务器未返回流');
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() || '';
        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          const evLine = lines.find((l) => l.startsWith('event:'));
          const dataLine = lines.find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const ev = evLine ? evLine.slice(6).trim() : 'message';
          let data: { line?: string; step?: string; status?: string; title?: string; verdict?: Verdict; summary?: string; message?: string };
          try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (ev === 'log') setLogs((p) => [...p, String(data.line)].slice(-400));
          else if (ev === 'step') setSteps((p) => {
            const i = p.findIndex((s) => s.step === data.step);
            const next = { step: data.step || '', status: data.status || '', title: data.title || '' };
            if (i >= 0) { const c = [...p]; c[i] = next; return c; }
            return [...p, next];
          });
          else if (ev === 'result') setResult({ verdict: data.verdict || 'fail', summary: data.summary || '' });
          else if (ev === 'error') setResult({ verdict: 'fail', summary: String(data.message) });
        }
      }
    } catch (e) {
      setResult({ verdict: 'fail', summary: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void validate()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:border-primary hover:text-foreground disabled:opacity-60"
        title="用一次性容器在真实仓库上测这套配置能否跑通"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {running ? '试运行中…' : '试运行验证'}
      </button>
      {open ? (
        <div className="mt-2 rounded-md border border-border bg-background p-2.5">
          {steps.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-x-2 gap-y-1">
              {steps.map((s) => (
                <span
                  key={s.step}
                  className={`text-[11px] ${s.status === 'done' ? 'text-green-600' : s.status === 'error' ? 'text-destructive' : s.status === 'warning' ? 'text-amber-600' : 'text-muted-foreground'}`}
                >
                  {s.status === 'running' ? '... ' : ''}{s.title}
                </span>
              ))}
            </div>
          ) : null}
          {logs.length > 0 ? (
            <pre
              className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-4 text-muted-foreground"
              style={{ overscrollBehavior: 'contain' }}
            >
              {logs.join('\n')}
            </pre>
          ) : null}
          {result ? (
            <div className={`mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${VERDICT_META[result.verdict].cls}`}>
              {VERDICT_META[result.verdict].icon}
              <span><span className="font-semibold">{VERDICT_META[result.verdict].label}</span> · {result.summary}</span>
            </div>
          ) : running ? (
            <div className="text-[11px] text-muted-foreground">正在真实容器里跑你的命令…不行的话改上面的命令/镜像，再点一次试运行。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
