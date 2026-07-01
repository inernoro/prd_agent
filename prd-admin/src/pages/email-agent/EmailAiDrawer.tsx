import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Wand2, PenLine, Copy, Check, Loader2, StopCircle } from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { EMAIL_DRAFT_STREAM_URL, EMAIL_POLISH_STREAM_URL } from '@/services';
import type { EmailTemplate } from '@/services';
import { Button } from '@/components/design/Button';
import { copyToClipboard } from './emailTemplateUtils';
import { toast } from '@/lib/toast';

type Mode = 'draft' | 'polish';

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 初始模式 */
  initialMode?: Mode;
  /** 润色模式的初始内容（当前模板正文渲染结果） */
  initialContent?: string;
  /** 可选：起草时作为写法参考的模板 */
  baseTemplate?: EmailTemplate | null;
  /** 生成结果 "应用" 回调（可空；用于回填到编辑器） */
  onApply?: (text: string) => void;
}

const TONES = ['正式', '简洁', '委婉', '诚恳'];

export function EmailAiDrawer({ open, onClose, initialMode = 'draft', initialContent, baseTemplate, onApply }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [scenario, setScenario] = useState('');
  const [tone, setTone] = useState<string>('');
  const [content, setContent] = useState('');
  const [instruction, setInstruction] = useState('');
  const [output, setOutput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<{ name?: string; platform?: string } | null>(null);
  const [phaseMsg, setPhaseMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setContent(initialContent ?? '');
      setOutput('');
      setModel(null);
      setPhaseMsg('');
    }
  }, [open, initialMode, initialContent]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const run = useCallback(async () => {
    if (mode === 'draft' && !scenario.trim()) {
      toast.warning('请先描述要写的邮件场景');
      return;
    }
    if (mode === 'polish' && !content.trim()) {
      toast.warning('请先填写要润色的内容');
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStreaming(true);
    setOutput('');
    setModel(null);
    setPhaseMsg('连接中…');

    const url = mode === 'draft' ? EMAIL_DRAFT_STREAM_URL : EMAIL_POLISH_STREAM_URL;
    const body =
      mode === 'draft'
        ? { scenario: scenario.trim(), tone: tone || undefined, baseTemplateId: baseTemplate?.id }
        : { content: content.trim(), instruction: instruction.trim() || undefined };

    const { success, errorMessage } = await connectSse({
      url,
      method: 'POST',
      body,
      signal: ac.signal,
      onEvent: (evt) => {
        const data = evt.data ? safeJson(evt.data) : null;
        if (!data) return;
        switch (evt.event) {
          case 'phase':
            if (typeof data.message === 'string') setPhaseMsg(data.message);
            break;
          case 'model':
            setModel({
              name: typeof data.model === 'string' ? data.model : undefined,
              platform: typeof data.platform === 'string' ? data.platform : undefined,
            });
            break;
          case 'typing':
            if (typeof data.text === 'string') setOutput((prev) => prev + data.text);
            break;
          case 'done':
            setStreaming(false);
            setPhaseMsg('完成');
            break;
          case 'error':
            setStreaming(false);
            setPhaseMsg('');
            toast.error('生成失败', typeof data.message === 'string' ? data.message : undefined);
            break;
        }
      },
    });

    setStreaming(false);
    if (!success && !ac.signal.aborted) {
      toast.error('生成失败', errorMessage);
    }
  }, [mode, scenario, tone, baseTemplate, content, instruction]);

  const doCopy = async () => {
    const ok = await copyToClipboard(output);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('已复制生成结果');
    } else {
      toast.error('复制失败');
    }
  };

  if (!open) return null;

  const drawer = (
    <div className="fixed inset-0 z-[100] flex justify-end" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <aside
        className="h-full border-l border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ width: 'min(94vw, 620px)', maxHeight: '100vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-300" />
            <h2 className="text-base font-semibold text-white">AI 邮件助手</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/55">
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* 模式切换 */}
        <div className="shrink-0 px-5 pt-4">
          <div className="inline-flex rounded-lg border border-white/12 bg-white/5 p-0.5">
            <button
              type="button"
              onClick={() => setMode('draft')}
              className={`h-8 px-3 rounded-[7px] text-xs inline-flex items-center gap-1.5 transition ${
                mode === 'draft' ? 'bg-indigo-500/25 text-white' : 'text-white/60 hover:text-white/85'
              }`}
            >
              <Wand2 className="w-3.5 h-3.5" /> 一句话起草
            </button>
            <button
              type="button"
              onClick={() => setMode('polish')}
              className={`h-8 px-3 rounded-[7px] text-xs inline-flex items-center gap-1.5 transition ${
                mode === 'polish' ? 'bg-indigo-500/25 text-white' : 'text-white/60 hover:text-white/85'
              }`}
            >
              <PenLine className="w-3.5 h-3.5" /> 润色现有内容
            </button>
          </div>
        </div>

        <div
          className="flex-1 px-5 py-4 space-y-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {mode === 'draft' ? (
            <>
              <div>
                <label className="block text-xs text-white/60 mb-1.5">场景描述</label>
                <textarea
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                  placeholder="例：向主管申请下周三请一天年假，抄送人事，语气正式一点"
                  rows={4}
                  className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-indigo-400/40 resize-y"
                />
              </div>
              <div>
                <label className="block text-xs text-white/60 mb-1.5">语气偏好（可选）</label>
                <div className="flex flex-wrap gap-1.5">
                  {TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTone(tone === t ? '' : t)}
                      className={`h-7 px-2.5 rounded-full text-xs border transition ${
                        tone === t
                          ? 'border-indigo-400/50 bg-indigo-500/20 text-white'
                          : 'border-white/12 bg-white/5 text-white/60 hover:text-white/85'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {baseTemplate && (
                <p className="text-[11px] text-white/40">
                  将参考模板「{baseTemplate.title}」的写法生成。
                </p>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs text-white/60 mb-1.5">待润色内容</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="粘贴或填写要润色的邮件正文"
                  rows={6}
                  className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-indigo-400/40 resize-y"
                />
              </div>
              <div>
                <label className="block text-xs text-white/60 mb-1.5">润色指令（可选）</label>
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="例：更简洁 / 更委婉 / 突出紧急"
                  className="w-full h-9 rounded-lg border border-white/12 bg-white/[0.04] px-3 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-indigo-400/40"
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            {streaming ? (
              <Button variant="secondary" size="sm" onClick={stop}>
                <StopCircle className="w-3.5 h-3.5" /> 停止
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={run}>
                <Sparkles className="w-3.5 h-3.5" /> {mode === 'draft' ? '生成邮件' : '开始润色'}
              </Button>
            )}
            {streaming && (
              <span className="text-[11px] text-white/45 inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> {phaseMsg || '生成中…'}
              </span>
            )}
          </div>

          {/* 输出区 */}
          {(output || streaming) && (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
              <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-2">
                {model?.name ? (
                  <span className="text-[11px] text-white/40 font-mono truncate">
                    ● {model.name}
                    {model.platform ? ` · ${model.platform}` : ''}
                  </span>
                ) : (
                  <span className="text-[11px] text-white/30">生成结果</span>
                )}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={doCopy}
                    disabled={!output}
                    className="h-7 px-2 rounded-md text-[11px] text-white/70 hover:bg-white/10 inline-flex items-center gap-1 disabled:opacity-40"
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />} 复制
                  </button>
                  {onApply && (
                    <button
                      type="button"
                      onClick={() => {
                        onApply(output);
                        toast.success('已应用到正文');
                      }}
                      disabled={!output}
                      className="h-7 px-2 rounded-md text-[11px] text-indigo-200 hover:bg-indigo-500/15 inline-flex items-center gap-1 disabled:opacity-40"
                    >
                      应用到正文
                    </button>
                  )}
                </div>
              </div>
              <pre className="px-3 py-3 text-sm text-white/85 whitespace-pre-wrap break-words font-sans leading-relaxed">
                {output}
                {streaming && <span className="inline-block w-1.5 h-4 bg-indigo-300/70 align-text-bottom animate-pulse ml-0.5" />}
              </pre>
            </div>
          )}
        </div>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}
