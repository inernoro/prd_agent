/**
 * VisualCreationMiniPanel — 视觉创作迷你面板
 *
 * 嵌入再加工面板的自包含可交互视觉创作缩小版。
 * 复用真实视觉创作生图端点（visual-agent），无业务简化。
 *
 * 规则：
 * - 深色主题，行内 style 用 rgba
 * - loading 用 MapSpinner，禁止 lucide Loader2
 * - 模态框走 createPortal + inline 高度 + min-h-0（frontend-modal.md）
 * - 无 emoji（项目硬规则）
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Image as ImageIcon, RefreshCw, ImagePlus, FileDown, Settings2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { WatermarkSettingsPanel } from '@/components/watermark/WatermarkSettingsPanel';
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
  /** 当前文档标题 */
  docTitle: string;
  /** 当前文档正文（「用原文」按钮使用） */
  docContent: string;
  /** 预填提示词（文学配图场景） */
  initialPrompt?: string;
  /** 插入图片到文档 */
  onInsertImage: (url: string, name?: string) => void;
  /** 插入「原文片段+配图」 */
  onInsertImageWithText: (url: string, text: string) => void;
}

// ============ 内部类型 ============

type GenerateState = 'idle' | 'generating' | 'done' | 'error';

// ============ 水印浮层组件 ============

function WatermarkOverlay({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ zIndex: 1300 }}
      onClick={onClose}
    >
      <div
        className="rounded-[10px] overflow-hidden"
        style={{
          width: '100%',
          maxWidth: 640,
          height: '70vh',
          maxHeight: '70vh',
          background: 'rgba(18,18,24,0.98)',
          border: '1px solid rgba(168,85,247,0.25)',
          boxShadow: '0 -8px 48px rgba(0,0,0,0.6)',
          marginBottom: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between shrink-0 px-4"
          style={{
            height: 44,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
            水印设置
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: 'none',
              cursor: 'pointer',
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容区 — 滚动 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '12px 16px',
          }}
        >
          <WatermarkSettingsPanel appKey="visual-agent" columns={1} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============ 主组件 ============

export function VisualCreationMiniPanel({
  docContent,
  initialPrompt = '',
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

  // 生成状态
  const [genState, setGenState] = useState<GenerateState>('idle');
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // 「用原文」状态
  const [gettingPrompt, setGettingPrompt] = useState(false);
  const abortPromptRef = useRef<(() => void) | null>(null);

  // 水印浮层
  const [watermarkOpen, setWatermarkOpen] = useState(false);

  // 尺寸重新加载标记（model 变化时触发）
  const sizeLoadKeyRef = useRef(0);

  // ============ 初始化：拉模型列表 ============

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listVisualModels();
      if (cancelled) return;
      if (res.success && res.data.length > 0) {
        setModels(res.data);
        setSelectedModel(res.data[0].value);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

    setGenState('generating');
    setResultUrl(null);
    setGenError(null);

    const res = await generateVisualImage({
      prompt: trimmedPrompt,
      size: selectedSize || undefined,
      modelName: selectedModel || undefined,
      images: refImageUri ? [refImageUri] : undefined,
    });

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
  }, [prompt, selectedModel, selectedSize, refImageUri]);

  // ============ 重新生成 ============

  const handleRegenerate = useCallback(() => {
    setResultUrl(null);
    setGenState('idle');
    setGenError(null);
  }, []);

  // ============ 插入 ============

  const handleInsertImage = useCallback(() => {
    if (!resultUrl) return;
    onInsertImage(resultUrl, `视觉创作-${Date.now()}`);
  }, [resultUrl, onInsertImage]);

  const handleInsertWithText = useCallback(() => {
    if (!resultUrl) return;
    // 取文档前 300 字作为配套文本（避免正文过长）
    const snippet = docContent.trim().slice(0, 300);
    onInsertImageWithText(resultUrl, snippet);
  }, [resultUrl, docContent, onInsertImageWithText]);

  // ============ 渲染 ============

  const isGenerating = genState === 'generating';
  const isDone = genState === 'done';

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
    resize: 'none' as const,
    lineHeight: 1.5,
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
          rows={3}
          style={inputBase}
          disabled={isGenerating}
        />
      </div>

      {/* 参考图 */}
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

      {/* 模型 / 尺寸 / 水印 — 一行 */}
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

        {/* 水印设置按钮 */}
        <button
          type="button"
          style={btnGhost}
          onClick={() => setWatermarkOpen(true)}
          disabled={isGenerating}
          title="水印设置（由视觉创作统一管理，服务端自动叠加）"
        >
          <Settings2 size={13} />
          水印设置
        </button>
      </div>

      {/* 生成按钮 */}
      {!isDone && (
        <button
          type="button"
          style={{
            ...btnPrimary,
            justifyContent: 'center',
            padding: '9px 16px',
            opacity: isGenerating ? 0.75 : 1,
            cursor: isGenerating ? 'not-allowed' : 'pointer',
          }}
          onClick={handleGenerate}
          disabled={isGenerating}
        >
          {isGenerating ? (
            <>
              <MapSpinner size={14} color="rgba(255,255,255,0.8)" />
              正在生成…（生图模型可能较慢）
            </>
          ) : (
            <>
              <ImageIcon size={14} />
              生成图片
            </>
          )}
        </button>
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
          {/* 结果图片 */}
          <div
            style={{
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid rgba(168,85,247,0.3)',
              background: 'rgba(0,0,0,0.3)',
              textAlign: 'center',
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
          </div>

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
            <button
              type="button"
              style={{ ...btnGhost, flex: 1, justifyContent: 'center' }}
              onClick={handleInsertWithText}
            >
              <ImagePlus size={13} />
              插入原文+配图
            </button>
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

      {/* 水印浮层（createPortal，z-index 1300） */}
      {watermarkOpen && (
        <WatermarkOverlay onClose={() => setWatermarkOpen(false)} />
      )}
    </div>
  );
}
