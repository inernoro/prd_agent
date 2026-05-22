import { useCallback, useRef, useState } from 'react';
import { Sparkles, RefreshCw, StopCircle, FileDown, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { CCAS_PRD_STREAM_URL } from '@/services';
import type { CcasMeta } from '@/services';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';

interface Props {
  meta: CcasMeta;
}

type Phase = 'idle' | 'A-streaming' | 'A-done' | 'B-streaming' | 'B-done' | 'error';

/**
 * CCAS PRD 文档生成 Tab
 * 工作流：
 *   1) 用户填表 → 选模板 → 点击"生成 Part A"，前端发 phase=A 请求 → SSE 流式输出
 *   2) Part A 输出完，用户阅读后点"确认 Part A，继续 Part B"，前端发 phase=B + ConfirmedPartA → SSE 输出 Part B
 *   3) 用户可以下载完整 markdown
 */
export function CcasPrdTab({ meta }: Props) {
  const [templateKey, setTemplateKey] = useState<string>(meta.templates[0]?.key ?? 'engineering-main');
  const [input, setInput] = useState('');
  const [existingMarkdown, setExistingMarkdown] = useState('');
  const [partA, setPartA] = useState('');
  const [partB, setPartB] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [model, setModel] = useState<{ name?: string; platform?: string }>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const streamPart = useCallback(
    async (target: 'A' | 'B') => {
      if (target === 'A' && !input.trim()) {
        toast.error('请填写产品/项目的基本描述');
        return;
      }

      setErrorMsg(null);
      const ac = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ac;

      if (target === 'A') {
        setPartA('');
        setPartB('');
        setModel({});
      } else {
        setPartB('');
      }
      setPhase(target === 'A' ? 'A-streaming' : 'B-streaming');
      setPhaseMsg('连接中…');

      const body = {
        templateKey,
        phase: target,
        input,
        existingMarkdown: existingMarkdown.trim() || undefined,
        confirmedPartA: target === 'B' ? partA : undefined,
      };

      const setText = target === 'A' ? setPartA : setPartB;

      const { success, errorMessage } = await connectSse({
        url: CCAS_PRD_STREAM_URL,
        method: 'POST',
        body,
        signal: ac.signal,
        onEvent: (evt) => {
          const data = evt.data ? safeJson(evt.data) : null;
          if (!data) return;
          switch (evt.event) {
            case 'phase':
              setPhaseMsg(typeof data.message === 'string' ? data.message : '');
              break;
            case 'model':
              setModel({
                name: typeof data.model === 'string' ? data.model : undefined,
                platform: typeof data.platform === 'string' ? data.platform : undefined,
              });
              break;
            case 'thinking':
              // 思考过程目前不展示，避免文档区被覆盖；后续可加单独面板
              break;
            case 'typing':
              if (typeof data.text === 'string') {
                setText((prev) => prev + data.text);
              }
              break;
            case 'done':
              setPhase(target === 'A' ? 'A-done' : 'B-done');
              setPhaseMsg('完成');
              break;
            case 'error':
              setPhase('error');
              setErrorMsg(typeof data.message === 'string' ? data.message : '生成失败');
              break;
          }
        },
      });

      if (!success && phase !== 'error') {
        setPhase('error');
        setErrorMsg(errorMessage || '连接失败');
      }
    },
    [templateKey, input, existingMarkdown, partA, phase]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setPhase('idle');
    setPhaseMsg('已中止');
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPartA('');
    setPartB('');
    setPhase('idle');
    setPhaseMsg('');
    setErrorMsg(null);
    setModel({});
  }, []);

  const downloadMarkdown = useCallback(() => {
    const merged = [partA, partB].filter(Boolean).join('\n\n---\n\n');
    if (!merged.trim()) {
      toast.error('暂无内容可下载');
      return;
    }
    const blob = new Blob([merged], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ccas-prd-${templateKey}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [partA, partB, templateKey]);

  const isStreaming = phase === 'A-streaming' || phase === 'B-streaming';

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4 overflow-hidden">
      {/* 左：表单 + 控制 */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">1. 选择文档模板</h2>
          <div className="grid grid-cols-1 gap-2">
            {meta.templates.map((t) => (
              <label
                key={t.key}
                className={`block cursor-pointer rounded-md border px-3 py-2 transition ${
                  templateKey === t.key
                    ? 'border-amber-400/60 bg-amber-500/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="ccas-template"
                  value={t.key}
                  checked={templateKey === t.key}
                  onChange={() => setTemplateKey(t.key)}
                  className="hidden"
                />
                <div className="text-sm text-white">{t.label}</div>
                <div className="text-xs text-white/55 mt-0.5">{t.description}</div>
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">2. 填写产品/项目描述</h2>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例：产品母体「品牌商后台基础」T6.12.0；本次新增「赋码采集关联系统」模块；产线设备：裹包机、龙门架、工业相机×4、工控机、共享屏幕、箱码垛工位；关联模式：瓶箱垛；目标：实现 NC 剔除 + 实时关联校验…"
            rows={8}
            className="w-full rounded-md bg-black/30 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">
            3. 已有 Markdown（可选，AI 会在此基础上补全/优化）
          </h2>
          <textarea
            value={existingMarkdown}
            onChange={(e) => setExistingMarkdown(e.target.value)}
            placeholder="把已有 PRD/设计文档粘贴在这里，AI 会保留关键信息、补全缺失章节、优化表达"
            rows={6}
            className="w-full rounded-md bg-black/30 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60 font-mono"
          />
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
          <h2 className="text-sm font-medium text-white">4. 生成</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => streamPart('A')}
              disabled={isStreaming || !input.trim()}
              className="!h-9 !px-3 !text-xs"
            >
              {phase === 'A-streaming' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
              生成 Part A（价值层）
            </Button>
            <Button
              variant="primary"
              onClick={() => streamPart('B')}
              disabled={isStreaming || phase !== 'A-done' || !partA.trim()}
              className="!h-9 !px-3 !text-xs"
              title={phase !== 'A-done' ? '先完成并确认 Part A' : '继续生成 Part B'}
            >
              {phase === 'B-streaming' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
              确认并生成 Part B（设计层）
            </Button>
            {isStreaming && (
              <Button variant="ghost" onClick={abort} className="!h-9 !px-3 !text-xs">
                <StopCircle className="w-3.5 h-3.5 mr-1" />
                中止
              </Button>
            )}
            <Button variant="ghost" onClick={reset} className="!h-9 !px-3 !text-xs">
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              重置
            </Button>
            <Button
              variant="ghost"
              onClick={downloadMarkdown}
              disabled={!partA && !partB}
              className="!h-9 !px-3 !text-xs"
            >
              <FileDown className="w-3.5 h-3.5 mr-1" />
              下载 Markdown
            </Button>
          </div>
          {(phaseMsg || model.name) && (
            <div className="mt-1 text-[11px] text-white/45 flex items-center gap-2">
              {phaseMsg && <span>{phaseMsg}</span>}
              {model.name && (
                <span className="font-mono opacity-70">
                  ● {model.name}
                  {model.platform ? ` · ${model.platform}` : ''}
                </span>
              )}
            </div>
          )}
          {errorMsg && (
            <div className="mt-1 text-xs text-red-300/90 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {errorMsg}
            </div>
          )}
        </section>
      </div>

      {/* 右：输出 */}
      <div className="flex flex-col gap-3 min-h-0">
        <section className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/30">
          <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Part A · 价值层</h2>
            <div className="text-[11px] text-white/45">
              {phase === 'A-streaming' && '生成中…'}
              {phase === 'A-done' && '✓ 完成'}
            </div>
          </div>
          <div
            className="flex-1 px-4 py-3 text-sm text-white/85 font-mono leading-relaxed whitespace-pre-wrap"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {partA || <span className="text-white/30">点击左侧"生成 Part A"开始</span>}
          </div>
        </section>
        <section className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/30">
          <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Part B · 设计层 / 全局规范层</h2>
            <div className="text-[11px] text-white/45">
              {phase === 'B-streaming' && '生成中…'}
              {phase === 'B-done' && '✓ 完成'}
            </div>
          </div>
          <div
            className="flex-1 px-4 py-3 text-sm text-white/85 font-mono leading-relaxed whitespace-pre-wrap"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {partB || <span className="text-white/30">Part A 完成并确认后生成</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
