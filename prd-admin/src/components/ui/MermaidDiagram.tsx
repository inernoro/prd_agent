import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Loader2 } from 'lucide-react';

/**
 * 渲染 Mermaid 图表。mermaid 主包通过动态 import 懒加载，避免进入首包。
 * 渲染失败时降级为可折叠的源码块。
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(mod => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        themeVariables: {
          primaryColor: '#a855f7',
          primaryTextColor: '#f3e8ff',
          primaryBorderColor: '#7e22ce',
          lineColor: '#a78bfa',
          textColor: '#e5e7eb',
          background: 'transparent',
        },
      });
      return m;
    });
  }
  return mermaidPromise;
}

let seq = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadMermaid()
      .then(async mermaid => {
        if (cancelled) return;
        const id = `mermaid-${Date.now().toString(36)}-${++seq}`;
        try {
          const { svg } = await mermaid.render(id, code);
          if (cancelled) return;
          if (containerRef.current) containerRef.current.innerHTML = svg;
          setStatus('ok');
        } catch (err) {
          if (cancelled) return;
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [code]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
  };

  return (
    <div
      className="my-3 rounded-lg overflow-hidden group/mermaid"
      style={{
        background: 'rgba(15, 17, 23, 0.6)',
        border: '1px solid rgba(168, 85, 247, 0.18)',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-[10px] tracking-wider"
        style={{
          background: 'rgba(168, 85, 247, 0.08)',
          borderBottom: '1px solid rgba(168, 85, 247, 0.14)',
          color: '#d8b4fe',
        }}
      >
        <span className="font-mono font-semibold">◆ MERMAID</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSource(v => !v)}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title={showSource ? '隐藏源码' : '查看源码'}
          >
            {showSource ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            源码
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover/mermaid:opacity-100 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/5 transition-all"
            style={{ color: 'var(--text-muted)' }}
            title="复制源码"
          >
            <Copy size={10} /> 复制
          </button>
        </div>
      </div>

      {status === 'loading' && (
        <div
          className="flex items-center justify-center gap-2 py-10 text-[12px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <Loader2 size={14} className="animate-spin" />
          正在渲染图表…
        </div>
      )}

      {status === 'error' && (
        <div
          className="px-4 py-3 text-[12px]"
          style={{ background: 'rgba(248,113,113,0.06)', color: '#fca5a5' }}
        >
          图表渲染失败：{errorMsg}
        </div>
      )}

      <div
        ref={containerRef}
        className="mermaid-render"
        style={{
          display: status === 'ok' ? 'flex' : 'none',
          justifyContent: 'center',
          padding: '16px 12px',
          overflow: 'auto',
        }}
      />

      {(showSource || status === 'error') && (
        <pre
          className="text-[11.5px] overflow-x-auto"
          style={{
            margin: 0,
            padding: '10px 14px',
            background: 'rgba(0,0,0,0.3)',
            color: 'var(--text-secondary)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            whiteSpace: 'pre',
          }}
        >
          {code}
        </pre>
      )}
    </div>
  );
}
