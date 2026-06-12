/**
 * VisualCreationMiniPanel — 视觉创作迷你面板
 *
 * 嵌入再加工面板的自包含可交互视觉创作缩小版。
 * 按 appKey 复用真实生图入口：visual-agent 或 literary-agent，无业务简化。
 *
 * 规则：
 * - 深色主题，行内 style 用 rgba
 * - loading 用 MapSpinner，禁止 lucide Loader2
 * - 模态框走 createPortal + inline 高度 + min-h-0（frontend-modal.md）
 * - 无 emoji（项目硬规则）
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Image as ImageIcon, RefreshCw, ImagePlus, FileDown, Maximize2, ExternalLink } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { invokeAgent } from '@/services/real/agentUniverse';
import {
  generateVisualImage,
  listVisualModels,
  listVisualSizes,
  fileToDataUri,
} from '@/services/real/visualCreation';
import { toast } from '@/lib/toast';

// ============ Props ============

export interface VisualCreationMiniPanelProps {
  /** 业务归属：文学配图必须走 literary-agent 自己的生图入口。 */
  appKey?: 'visual-agent' | 'literary-agent';
  /** 当前文档标题 */
  docTitle: string;
  /** 当前文档正文（「用原文」按钮使用） */
  docContent: string;
  /** 预填提示词（文学配图场景） */
  initialPrompt?: string;
  /** 重开抽屉时回填「已生成未插入」的图（后端持久化恢复） */
  initialResult?: string | null;
  /** 生成结果变化时上报父级（用于后端持久化暂存图，关窗也不丢）。null = 已清空 */
  onResultChange?: (url: string | null) => void;
  /** 插入图片到文档 */
  onInsertImage: (url: string, name?: string) => void;
  /** 插入「原文片段+配图」。不传则隐藏该按钮（如划词配图场景：原文已在文档里，再插一遍是重复） */
  onInsertImageWithText?: (url: string, text: string) => void;
}

// ============ 内部类型 ============

type GenerateState = 'idle' | 'generating' | 'done' | 'error';

// 生成等待期的分级状态文案（呼应 CLAUDE.md §6 禁止空白等待 + ai-model-visibility.md 展示模型名）
// 导出供单测断言「随时间分级 + 携带模型名」的可见行为
export function genPhaseText(sec: number, model: string): string {
  const m = model ? ` · ${model}` : '';
  if (sec < 15) return `正在绘制${m} · 已 ${sec}s`;
  if (sec < 40) return `模型绘制中${m} · 已 ${sec}s（复杂画面通常 20-40s）`;
  return `仍在绘制${m} · 已 ${sec}s，较慢可取消重试`;
}

// ============ 结果放大浮层（点击结果图全屏看清 + 原图/下载） ============
// createPortal 到 body，避免被 640px 抽屉的 overflow 裁剪（frontend-modal.md）

function ResultLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 1300, background: 'rgba(0,0,0,0.82)', padding: 24 }}
      onClick={onClose}
    >
      <img
        src={url}
        alt="生成结果（放大）"
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 12px 64px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        style={{
          position: 'fixed',
          top: 20,
          right: 20,
          width: 36,
          height: 36,
          borderRadius: 10,
          background: 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: 'rgba(255,255,255,0.85)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <X size={18} />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 14px',
          borderRadius: 10,
          fontSize: 12,
          background: 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: 'rgba(255,255,255,0.85)',
          textDecoration: 'none',
        }}
      >
        <ExternalLink size={13} />
        原图 / 下载
      </a>
    </div>,
    document.body,
  );
}

// ============ 主组件 ============

export function VisualCreationMiniPanel({
  appKey = 'visual-agent',
  docContent,
  initialPrompt = '',
  initialResult = null,
  onResultChange,
  onInsertImage,
  onInsertImageWithText,
}: VisualCreationMiniPanelProps) {
  // 提示词
  const [prompt, setPrompt] = useState(initialPrompt);

  // 参考图
  const [refImageUri, setRefImageUri] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 模型 / 尺寸
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedSize, setSelectedSize] = useState<string>('');

  // 生成状态（initialResult 非空 = 重开抽屉时回填上次「已生成未插入」的图）
  const [genState, setGenState] = useState<GenerateState>(initialResult ? 'done' : 'idle');
  const [resultUrl, setResultUrl] = useState<string | null>(initialResult ?? null);
  const [genError, setGenError] = useState<string | null>(null);

  // 生成等待计时（驱动进度条 + 分级文案，避免空白等待）
  const [elapsedSec, setElapsedSec] = useState(0);
  // 单调递增的生成令牌：用户「取消」后作废当前生成的迟到结果（不杀后端任务，遵循 server-authority.md）
  const genRunIdRef = useRef(0);

  // 「用原文」状态
  const [gettingPrompt, setGettingPrompt] = useState(false);
  const abortPromptRef = useRef<(() => void) | null>(null);

  // 结果放大浮层
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // 尺寸重新加载标记（model 变化时触发）
  const sizeLoadKeyRef = useRef(0);

  // ============ 初始化：拉模型列表 ============

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listVisualModels(appKey);
      if (cancelled) return;
      if (res.success && res.data.length > 0) {
        setModels(res.data);
        setSelectedModel(res.data[0].value);
      }
    })();
    return () => { cancelled = true; };
  }, [appKey]);

  // ============ model 变化时拉尺寸 ============

  useEffect(() => {
    if (!selectedModel) return;
    let cancelled = false;
    const key = ++sizeLoadKeyRef.current;
    (async () => {
      const result = await listVisualSizes(selectedModel);
      if (cancelled || sizeLoadKeyRef.current !== key) return;
      setSizes(result);
      setSelectedSize(result[0] ?? '');
    })();
    return () => { cancelled = true; };
  }, [selectedModel]);

  // ============ 「用原文」构思画面 ============

  const handleUseOriginal = useCallback(() => {
    if (gettingPrompt) {
      abortPromptRef.current?.();
      abortPromptRef.current = null;
      setGettingPrompt(false);
      return;
    }

    const text = docContent.trim();
    if (!text) {
      toast.error('文档无正文', '无法从空文档中构思画面描述');
      return;
    }

    setGettingPrompt(true);
    let accumulated = '';
    const abort = invokeAgent({
      agentKey: 'literary-agent',
      text,
      action: 'generate_illustration',
      onText: (chunk) => { accumulated += chunk; },
      onDone: () => {
        setPrompt(accumulated.trim() || text.slice(0, 200));
        setGettingPrompt(false);
        abortPromptRef.current = null;
      },
      onError: (err) => {
        toast.error('构思失败', err);
        setGettingPrompt(false);
        abortPromptRef.current = null;
      },
    });
    abortPromptRef.current = abort;
  }, [docContent, gettingPrompt]);

  // 组件卸载时终止未完成的流
  useEffect(() => {
    return () => {
      abortPromptRef.current?.();
    };
  }, []);

  // 同步父级 prop 的后续变化：首次挂载只读一次会漏掉「异步回填 / 重新预填」（Bugbot Medium）。
  // - initialResult：后端恢复晚于面板挂载时，把"已生成未插入"的图补回来（否则被隐藏）
  // - initialPrompt：「为这段配图」在面板已打开时重新预填，更新提示词
  // 仅在 prop 真正变化、且非生成中时同步，避免覆盖用户正在进行的生成/输入。
  useEffect(() => {
    if (initialResult && initialResult !== resultUrl && genState !== 'generating') {
      setResultUrl(initialResult);
      setGenState('done');
      setGenError(null);
    } else if (!initialResult && resultUrl && genState === 'done') {
      // 父级清空暂存图（如插入文档成功后）→ 同步清掉面板里已展示的结果，避免在同一面板里被重复插入（Codex P2）
      setResultUrl(null);
      setGenState('idle');
    }
    // 只对 initialResult 的变化作出反应；resultUrl 自身变化不应触发本同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialResult]);

  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
  }, [initialPrompt]);

  // 生成期：每秒推进计时——这是等待时屏幕"持续变化"的来源（CLAUDE.md §6）
  useEffect(() => {
    if (genState !== 'generating') return;
    setElapsedSec(0);
    const t0 = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [genState]);

  // ============ 参考图选择 ============

  const handleRefImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const uri = await fileToDataUri(file);
      setRefImageUri(uri);
    } catch {
      toast.error('读取图片失败', '请重试');
    }
    // 清 input value，允许重复选同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ============ 生成 ============

  const handleGenerate = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      toast.error('请输入提示词', '提示词不能为空');
      return;
    }

    const myRun = ++genRunIdRef.current;
    setGenState('generating');
    setResultUrl(null);
    setGenError(null);

    const res = await generateVisualImage({
      prompt: trimmedPrompt,
      size: selectedSize || undefined,
      modelName: selectedModel || undefined,
      images: appKey === 'visual-agent' && refImageUri ? [refImageUri] : undefined,
      appKey,
    });

    // 用户中途「取消」会 bump genRunIdRef —— 丢弃这次迟到的结果，不覆盖已重置的 UI
    if (genRunIdRef.current !== myRun) return;

    if (!res.success) {
      setGenState('error');
      setGenError(res.error?.message ?? '生成失败，请重试');
      toast.error('生成失败', res.error?.message);
      return;
    }

    const url = res.data.url;
    if (!url) {
      setGenState('error');
      setGenError('返回图片 URL 为空，请重试');
      return;
    }

    setResultUrl(url);
    setGenState('done');
    onResultChange?.(url);  // 上报父级持久化（关窗也不丢）
  }, [prompt, selectedModel, selectedSize, refImageUri, appKey, onResultChange]);

  // ============ 取消等待 ============

  // 作废当前生成令牌 + 回到 idle。后端任务自然跑完（遵循 server-authority.md：客户端取消不杀服务端）
  const handleCancelGenerate = useCallback(() => {
    genRunIdRef.current += 1;
    setGenState('idle');
    setGenError(null);
    toast.info('已停止等待', '图片仍在后台生成，可在需要时重新发起');
  }, []);

  // ============ 重新生成 ============

  const handleRegenerate = useCallback(() => {
    setResultUrl(null);
    setGenState('idle');
    setGenError(null);
    onResultChange?.(null);  // 清空暂存图
  }, [onResultChange]);

  // ============ 插入 ============

  const handleInsertImage = useCallback(() => {
    if (!resultUrl) return;
    onInsertImage(resultUrl, `视觉创作-${Date.now()}`);
  }, [resultUrl, onInsertImage]);

  const handleInsertWithText = useCallback(() => {
    if (!resultUrl || !onInsertImageWithText) return;
    // 取文档前 300 字作为配套文本（避免正文过长）
    const snippet = docContent.trim().slice(0, 300);
    onInsertImageWithText(resultUrl, snippet);
  }, [resultUrl, docContent, onInsertImageWithText]);

  // ============ 渲染 ============

  const isGenerating = genState === 'generating';
  const isDone = genState === 'done';

  // 等待期展示的模型名（单选项时选择器虽隐藏，selectedModel 仍有值）
  const activeModelLabel = models.find((m) => m.value === selectedModel)?.label ?? selectedModel ?? '';
  // 进度条随等待"爬升"到 92% 封顶 —— 不谎报 100%，done 时由结果区接管
  const progressPct = Math.min(92, 8 + elapsedSec * 4);

  const panelBase: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '14px 16px',
    background: 'rgba(18,18,24,0.92)',
    borderRadius: 10,
    border: '1px solid rgba(168,85,247,0.2)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: '0.04em',
    marginBottom: 4,
  };

  const inputBase: React.CSSProperties = {
    width: '100%',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    padding: '8px 10px',
    outline: 'none',
    resize: 'vertical' as const,
    lineHeight: 1.5,
    minHeight: 132,
    maxHeight: 280,
    overflowY: 'auto' as const,
  };

  const btnBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    fontWeight: 500,
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
    padding: '6px 12px',
    transition: 'opacity 0.15s',
  };

  const btnPrimary: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(168,85,247,0.85)',
    color: '#fff',
  };

  const btnGhost: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(255,255,255,0.07)',
    color: 'rgba(255,255,255,0.7)',
  };

  const selectStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    padding: '5px 8px',
    outline: 'none',
    cursor: 'pointer',
    flex: 1,
    minWidth: 0,
  };

  // 「用原文」按钮文案
  const originalBtnLabel = gettingPrompt ? '正在据原文构思画面…' : '用原文';

  return (
    <div style={panelBase}>
      {/* 提示词区 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={labelStyle}>提示词</span>
          <button
            type="button"
            style={{
              ...btnGhost,
              padding: '4px 10px',
              opacity: gettingPrompt ? 0.7 : 1,
            }}
            onClick={handleUseOriginal}
            disabled={isGenerating}
          >
            {gettingPrompt && <MapSpinner size={12} />}
            {originalBtnLabel}
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="请输入图片描述，或点击「用原文」从文档内容自动构思画面…"
          rows={6}
          style={inputBase}
          disabled={isGenerating}
        />
      </div>

      {/* 参考图：只给 visual-agent 临时图生图使用；literary-agent 使用自身配置里的激活风格图。 */}
      {appKey === 'visual-agent' && (
        <div>
          <span style={labelStyle}>参考图（可选）</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleRefImageSelect}
            />
            {refImageUri ? (
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <img
                  src={refImageUri}
                  alt="参考图预览"
                  style={{
                    width: 52,
                    height: 52,
                    objectFit: 'cover',
                    borderRadius: 8,
                    border: '1px solid rgba(168,85,247,0.4)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setRefImageUri(null)}
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: 'rgba(30,20,40,0.95)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    color: 'rgba(255,255,255,0.7)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <X size={10} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                style={btnGhost}
                onClick={() => fileInputRef.current?.click()}
                disabled={isGenerating}
              >
                <ImagePlus size={13} />
                选择参考图
              </button>
            )}
            {refImageUri && (
              <button
                type="button"
                style={btnGhost}
                onClick={() => fileInputRef.current?.click()}
                disabled={isGenerating}
              >
                更换
              </button>
            )}
          </div>
        </div>
      )}

      {/* 模型 / 尺寸 — 仅当有可选项时整行才出现（奥卡姆：单选项/无选项不占位）。
          水印由视觉创作统一管理、服务端自动叠加，不在此 mini 面板内嵌千行编辑器。 */}
      {(models.length >= 2 || sizes.length >= 2) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* 模型下拉 — 仅当 >= 2 个选项时显示 */}
          {models.length >= 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 120 }}>
              <span style={{ ...labelStyle, marginBottom: 0, whiteSpace: 'nowrap' }}>模型</span>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={selectStyle}
                disabled={isGenerating}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* 尺寸下拉 — 仅当 >= 2 个选项时显示，isAdaptive 模型返回空列表则不显示 */}
          {sizes.length >= 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 120 }}>
              <span style={{ ...labelStyle, marginBottom: 0, whiteSpace: 'nowrap' }}>尺寸</span>
              <select
                value={selectedSize}
                onChange={(e) => setSelectedSize(e.target.value)}
                style={selectStyle}
                disabled={isGenerating}
              >
                {sizes.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* 生成按钮（idle / error 时可点，error 时等同重试） */}
      {!isDone && !isGenerating && (
        <button
          type="button"
          style={{ ...btnPrimary, justifyContent: 'center', padding: '9px 16px' }}
          onClick={handleGenerate}
        >
          <ImageIcon size={14} />
          生成图片
        </button>
      )}

      {/* 生成中：爬升进度条 + 分级状态(含模型名) + 取消 —— 杜绝空白等待（CLAUDE.md §6） */}
      {isGenerating && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(168,85,247,0.08)',
            border: '1px solid rgba(168,85,247,0.25)',
          }}
        >
          <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progressPct}%`,
                borderRadius: 2,
                background: 'rgba(168,85,247,0.85)',
                transition: 'width 0.9s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'rgba(255,255,255,0.72)',
                minWidth: 0,
              }}
            >
              <MapSpinner size={13} color="rgba(255,255,255,0.8)" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {genPhaseText(elapsedSec, activeModelLabel)}
              </span>
            </span>
            <button
              type="button"
              style={{ ...btnGhost, padding: '5px 12px', flexShrink: 0 }}
              onClick={handleCancelGenerate}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {genState === 'error' && genError && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: 'rgba(255,180,180,0.9)',
            fontSize: 12,
          }}
        >
          {genError}
        </div>
      )}

      {/* 生成结果 */}
      {isDone && resultUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 结果图片 — 点击放大看清（640px 抽屉里缩略，全屏才看得清） */}
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            title="点击放大查看"
            style={{
              position: 'relative',
              display: 'block',
              width: '100%',
              padding: 0,
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid rgba(168,85,247,0.3)',
              background: 'rgba(0,0,0,0.3)',
              cursor: 'zoom-in',
            }}
          >
            <img
              src={resultUrl}
              alt="生成结果"
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: 420,
                objectFit: 'contain',
                margin: '0 auto',
              }}
            />
            <span
              style={{
                position: 'absolute',
                right: 8,
                bottom: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 11,
                background: 'rgba(0,0,0,0.55)',
                color: 'rgba(255,255,255,0.85)',
                pointerEvents: 'none',
              }}
            >
              <Maximize2 size={11} />
              点击放大
            </span>
          </button>

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={{ ...btnPrimary, flex: 1, justifyContent: 'center' }}
              onClick={handleInsertImage}
            >
              <FileDown size={13} />
              插入文档
            </button>
            {onInsertImageWithText && (
              <button
                type="button"
                style={{ ...btnGhost, flex: 1, justifyContent: 'center' }}
                onClick={handleInsertWithText}
              >
                <ImagePlus size={13} />
                插入原文+配图
              </button>
            )}
            <button
              type="button"
              style={{ ...btnGhost, padding: '6px 10px' }}
              onClick={handleRegenerate}
              title="重新生成"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
      )}

      {/* 结果放大浮层（createPortal，z-index 1300） */}
      {lightboxOpen && resultUrl && (
        <ResultLightbox url={resultUrl} onClose={() => setLightboxOpen(false)} />
      )}
    </div>
  );
}
