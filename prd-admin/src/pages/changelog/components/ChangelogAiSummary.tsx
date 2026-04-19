import { useState, useRef } from 'react';
import { Sparkles, Loader2, Download } from 'lucide-react';
import { readSseStream, type SseEvent } from '@/lib/sse';
import type { ChangelogEntry } from '@/services';
import { RichTextMarkdownContent } from '@/pages/report-agent/components/RichTextMarkdownContent';

interface Props {
  entries: { type: string; module: string; description: string }[];
}

export function ChangelogAiSummary({ entries }: Props) {
  const [status, setStatus] = useState<'idle' | 'generating' | 'done'>('idle');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleGenerate = async () => {
    if (entries.length === 0) return;
    setStatus('generating');
    setSummary('');
    setError('');

    // 拼凑 prompt 
    const plainTextLogs = entries
      .map((e) => `- [${e.type}] ${e.module ? `(${e.module})` : ''} ${e.description}`)
      .join('\n');

    const prompt = `你是一个资深研发团队负责人。请根据下方的代码级更新清单，严格按照周报的标准格式，提炼出本周3-5个最精华的功能升级点，突出业务价值和架构改进。直接输出 Markdown 总结，不要啰嗦的废话。\n\n更新清单：\n${plainTextLogs}`;

    try {
      const tokenString = localStorage.getItem('auth-storage');
      let token = '';
      if (tokenString) {
        try {
          const parsed = JSON.parse(tokenString);
          token = parsed?.state?.token || '';
        } catch { }
      }

      abortControllerRef.current = new AbortController();
      const res = await fetch('/api/ai-toolbox/direct-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          message: prompt,
          systemPrompt: '你是一位精通研发管理与极简文笔的周报总结专家。',
        }),
        signal: abortControllerRef.current.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}`);
      }

      await readSseStream(res, (ev: SseEvent) => {
        if (ev.event === 'delta' && ev.data) {
          try {
            const parsed = JSON.parse(ev.data);
            if (parsed.content) {
              setSummary((s) => s + parsed.content);
            }
          } catch {}
        } else if (ev.event === 'done') {
          setStatus('done');
        } else if (ev.event === 'error') {
          setError('生成中途出错');
          setStatus('done');
        }
      }, abortControllerRef.current.signal);
      
      // stream complete usually doesn't explicitly throw
      if (abortControllerRef.current?.signal.aborted) {
         setStatus('idle');
      } else {
         setStatus('done');
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setError(e?.message || '网络错误');
      setStatus('idle');
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([summary], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    // 生成形如 report.2026-Wxx.md 的名字
    const now = new Date();
    const prefix = `report.${now.getFullYear()}-W`;
    link.setAttribute('download', `${prefix}xx-generated.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (status === 'idle' && !summary) {
    return (
      <div className="mb-6 flex justify-center">
        <button
          onClick={handleGenerate}
          className="h-10 px-6 rounded-full flex items-center gap-2 text-[13px] font-medium transition-all hover:scale-105 active:scale-95 shadow-lg"
          style={{
            background: 'linear-gradient(135deg, #818cf8, #c084fc)',
            color: 'white',
          }}
        >
          <Sparkles size={16} />
          一键调用大模型生成本周总结
        </button>
      </div>
    );
  }

  return (
    <div
      className="mb-6 rounded-xl p-5 relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(168, 85, 247, 0.06) 100%)',
        border: '1px solid rgba(168, 85, 247, 0.18)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
      }}
    >
      <div
        className="absolute -top-10 -right-10 w-40 h-40 blur-3xl rounded-full pointer-events-none"
        style={{ background: 'rgba(168, 85, 247, 0.12)' }}
      />
      <div
        className="absolute -bottom-8 -left-8 w-32 h-32 blur-2xl rounded-full pointer-events-none"
        style={{ background: 'rgba(99, 102, 241, 0.1)' }}
      />

      <div className="relative z-10 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[14px] font-semibold" style={{ color: '#c084fc' }}>
            {status === 'generating' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            <span>AI 总结 {status === 'generating' && '生成中...'}</span>
          </div>
          {status === 'done' && (
            <button
              onClick={downloadMarkdown}
              className="text-[12px] flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors hover:bg-white/10"
              style={{ color: '#d8b4fe', border: '1px solid rgba(216, 180, 254, 0.3)' }}
            >
              <Download size={14} />
              下载存档
            </button>
          )}
        </div>
        
        {error && (
          <div className="text-red-400 text-[12px]">{error}</div>
        )}

        <div className="text-[13px] leading-[1.65]" style={{ color: 'var(--text-secondary)' }}>
          {summary ? (
            <RichTextMarkdownContent content={summary} />
          ) : (
            <span className="opacity-50">正在连接大模型...</span>
          )}
        </div>
      </div>
    </div>
  );
}
