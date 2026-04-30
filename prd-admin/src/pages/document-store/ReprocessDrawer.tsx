import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, X, CheckCircle2, AlertCircle, Sparkle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { listReprocessTemplates, startReprocess, getAgentRun } from '@/services';
import type { ReprocessTemplate, DocumentStoreAgentRun } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

export type ReprocessDrawerProps = {
  entryId: string;
  entryTitle: string;
  onClose: () => void;
  onDone?: (outputEntryId: string) => void;
};

type Stage = 'picking' | 'streaming' | 'done' | 'failed';

export function ReprocessDrawer({ entryId, entryTitle, onClose, onDone }: ReprocessDrawerProps) {
  const [stage, setStage] = useState<Stage>('picking');
  const [templates, setTemplates] = useState<ReprocessTemplate[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<DocumentStoreAgentRun | null>(null);
  const [streamedText, setStreamedText] = useState('');
  const [phase, setPhase] = useState('排队中');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const streamedTextRef = useRef('');

  // 加载模板列表
  useEffect(() => {
    (async () => {
      setLoadingTemplates(true);
      const res = await listReprocessTemplates();
      if (res.success) {
        setTemplates(res.data.items);
        if (res.data.items.length > 0) setSelectedKey(res.data.items[0].key);
      } else {
        toast.error('加载模板失败', res.error?.message);
        setTemplates([]);
      }
      setLoadingTemplates(false);
    })();
  }, []);

  // SSE stream
  const streamUrl = useMemo(
    () => (runId ? `${api.documentStore.stores.agentRunStream(runId)}?afterSeq=0` : ''),
    [runId],
  );

  const { start, abort } = useSseStream({
    url: streamUrl,
    onEvent: {
      chunk: (data) => {
        const d = data as { text?: string };
        if (d.text) {
          streamedTextRef.current += d.text;
          setStreamedText(streamedTextRef.current);
        }
      },
      progress: (data) => {
        const d = data as { progress?: number; phase?: string };
        if (typeof d.progress === 'number') setProgress(d.progress);
        if (d.phase) setPhase(d.phase);
      },
      done: (data) => {
        setStage('done');
        setProgress(100);
        setPhase('完成');
        const d = data as { outputEntryId?: string; generatedText?: string };
        if (d.generatedText) {
          streamedTextRef.current = d.generatedText;
          setStreamedText(d.generatedText);
        }
        if (d.outputEntryId) {
          onDone?.(d.outputEntryId);
          toast.success('文档加工完成', '已保存为新文档');
        }
      },
      error: (data) => {
        const d = data as { message?: string };
        setStage('failed');
        setErrorMessage(d.message ?? '未知错误');
      },
    },
    onError: (msg) => {
      setStage('failed');
      setErrorMessage(msg);
    },
  });

  // runId 就绪后启动 SSE + 拉一次 run 当前状态（兜底）
  const refreshRun = useCallback(async (rid: string) => {
    const res = await getAgentRun(rid);
    if (res.success) {
      setRun(res.data);
      if (res.data.generatedText && res.data.generatedText.length > streamedTextRef.current.length) {
        streamedTextRef.current = res.data.generatedText;
        setStreamedText(res.data.generatedText);
      }
      if (res.data.status === 'done') {
        setStage('done');
        if (res.data.outputEntryId) onDone?.(res.data.outputEntryId);
      } else if (res.data.status === 'failed') {
        setStage('failed');
        setErrorMessage(res.data.errorMessage ?? '任务失败');
      }
    }
  }, [onDone]);

  useEffect(() => {
    if (!runId) return;
    void start();
    void refreshRun(runId);
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const handleStart = useCallback(async () => {
    if (!selectedKey) return;
    if (selectedKey === 'custom' && !customPrompt.trim()) {
      toast.warning('请输入自定义提示词');
      return;
    }
    setStage('streaming');
    streamedTextRef.current = '';
    setStreamedText('');
    const res = await startReprocess(entryId, {
      templateKey: selectedKey,
      customPrompt: selectedKey === 'custom' ? customPrompt.trim() : undefined,
    });
    if (!res.success) {
      setStage('failed');
      setErrorMessage(res.error?.message ?? '启动任务失败');
      return;
    }
    setRunId(res.data.runId);
  }, [entryId, selectedKey, customPrompt]);

  const selectedTemplate = templates?.find((t) => t.key === selectedKey);

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex h-full w-[560px] max-w-[92vw] flex-col border-l border-token-subtle">

        {/* Header */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Wand2 size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                文档再加工
              </p>
              <p className="truncate text-[10px] text-token-muted">
                {entryTitle}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage === 'picking' ? (
            loadingTemplates ? (
              <MapSectionLoader text="加载模板中…" />
            ) : (
              <div className="space-y-4">
                <p className="text-[12px] text-token-muted">
                  选择一个模板，或用自定义提示词指导 AI 如何改写内容。
                </p>

                {/* 模板卡片 */}
                <div className="grid grid-cols-2 gap-2">
                  {templates?.map((t) => {
                    const active = selectedKey === t.key;
                    return (
                      <button
                        key={t.key}
                        onClick={() => setSelectedKey(t.key)}
                        className={`cursor-pointer rounded-[10px] p-3 text-left transition-all ${active ? 'surface-action-accent' : 'surface-row'}`}
                      >
                        <p className="mb-1 text-[12px] font-semibold text-token-primary">
                          {t.label}
                        </p>
                        <p className="text-[10px] leading-snug text-token-muted">
                          {t.description}
                        </p>
                      </button>
                    );
                  })}

                  {/* 自定义 */}
                  <button
                    onClick={() => setSelectedKey('custom')}
                    className={`cursor-pointer rounded-[10px] p-3 text-left transition-all ${selectedKey === 'custom' ? 'surface-action-accent' : 'surface-row'}`}
                  >
                    <p className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-token-primary">
                      <Sparkle size={11} /> 自定义
                    </p>
                    <p className="text-[10px] leading-snug text-token-muted">
                      自己输入提示词指导 AI 改写
                    </p>
                  </button>
                </div>

                {/* 自定义 prompt 输入框 */}
                {selectedKey === 'custom' && (
                  <div>
                    <label className="mb-1.5 block text-[11px] font-semibold text-token-muted">
                      自定义提示词
                    </label>
                    <textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="例如：把这篇内容改写成面向产品经理的一页纸摘要，用 bullet list 列出 5 个核心结论..."
                      rows={6}
                      className="prd-field w-full resize-y rounded-[10px] px-3 py-2 text-[12px] outline-none"
                    />
                  </div>
                )}

                {/* 当前选择的描述 */}
                {selectedTemplate && (
                  <div className="surface-action-accent rounded-[8px] p-3 text-[11px]">
                    即将使用「{selectedTemplate.label}」模板处理这篇文档，结果会保存为新的 .md 文档。
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="space-y-3">
              {/* 阶段状态 */}
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-token-primary">
                  {phase}
                </span>
                {stage === 'done' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.95)', border: '1px solid rgba(34,197,94,0.25)' }}>
                    <CheckCircle2 size={10} /> 完成
                  </span>
                ) : stage === 'failed' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(239,68,68,0.25)' }}>
                    <AlertCircle size={10} /> 失败
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(96,165,250,0.95)', border: '1px solid rgba(59,130,246,0.25)' }}>
                    <MapSpinner size={10} /> 生成中
                  </span>
                )}
              </div>

              {/* 进度条 */}
              <div className="bg-token-nested h-1.5 overflow-hidden rounded-full">
                <div className="h-full transition-all duration-500"
                  style={{
                    width: `${progress}%`,
                    background: stage === 'failed'
                      ? 'linear-gradient(90deg, rgba(239,68,68,0.6), rgba(248,113,113,0.9))'
                      : 'linear-gradient(90deg, rgba(59,130,246,0.6), rgba(96,165,250,0.9))',
                  }}/>
              </div>

              {/* 实时打字区 */}
              <div className="surface-code mt-2 max-h-[50vh] min-h-[280px] overflow-y-auto rounded-[10px] p-4 font-mono text-[12px] leading-relaxed text-token-primary whitespace-pre-wrap">
                {streamedText || <span className="text-token-muted">等待 LLM 输出…</span>}
                {stage === 'streaming' && (
                  <span className="inline-block w-1 h-3 ml-0.5 align-middle"
                    style={{ background: 'rgba(96,165,250,0.8)', animation: 'pulse 1s ease-in-out infinite' }} />
                )}
              </div>

              {stage === 'failed' && errorMessage && (
                <div className="p-3 rounded-[10px] text-[11px] break-all"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: 'rgba(248,113,113,0.95)',
                  }}>
                  {errorMessage}
                </div>
              )}

              {stage === 'done' && run?.outputEntryId && (
                <div className="p-3 rounded-[10px] text-[11px]"
                  style={{
                    background: 'rgba(34,197,94,0.06)',
                    border: '1px solid rgba(34,197,94,0.15)',
                    color: 'rgba(74,222,128,0.95)',
                  }}>
                  已保存为新文档，你可以在文件树中找到它。
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="surface-panel-footer flex justify-end gap-2 px-5 py-4">
          {stage === 'picking' ? (
            <>
              <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
              <Button variant="primary" size="xs"
                disabled={!selectedKey || (selectedKey === 'custom' && !customPrompt.trim())}
                onClick={handleStart}>
                <Wand2 size={12} /> 开始加工
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="xs" onClick={onClose}>
              {stage === 'done' || stage === 'failed' ? '关闭' : '后台运行'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
