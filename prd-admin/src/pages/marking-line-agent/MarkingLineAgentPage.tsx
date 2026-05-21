import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Factory, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import {
  getMarkingLineDiagramStreamUrl,
  postMarkingLineDiagramImage,
  type MarkingLineDiagramImageDto,
} from '@/services/real/markingLineAgent';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';

function buildDiagramImageSrc(d: MarkingLineDiagramImageDto): string | null {
  const url = d.imageUrl?.trim();
  if (url) return url;
  const b64 = d.imageBase64?.trim();
  if (!b64) return null;
  const mime = (d.mimeType?.trim() || 'image/png').replace(/[^a-z0-9/+.-]/gi, '') || 'image/png';
  return `data:${mime};base64,${b64}`;
}

function extFromMime(mime: string | null | undefined): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

export function MarkingLineAgentPage() {
  const navigate = useNavigate();
  const [brief, setBrief] = useState('');
  const [modelLine, setModelLine] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [thinkingBuf, setThinkingBuf] = useState('');

  const [diagramImage, setDiagramImage] = useState<MarkingLineDiagramImageDto | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageWaitTick, setImageWaitTick] = useState(0);
  const imageAbortRef = useRef<AbortController | null>(null);

  const streamUrl = useMemo(() => getMarkingLineDiagramStreamUrl(), []);

  const {
    phase,
    phaseMessage,
    typing,
    isStreaming,
    start,
    abort,
    reset,
  } = useSseStream({
    url: streamUrl,
    method: 'POST',
    onEvent: {
      model: (raw: unknown) => {
        const d = raw as { model?: string; platform?: string; modelGroupName?: string };
        const parts = [d.model, d.platform].filter(Boolean);
        setModelLine(parts.length > 0 ? parts.join(' · ') : null);
      },
      thinking: (raw: unknown) => {
        const d = raw as { text?: string };
        if (d.text) setThinkingBuf((p) => p + d.text);
      },
    },
    onDone: () => {
      setThinkingOpen(false);
    },
  });

  useEffect(() => {
    if (!imageLoading) return;
    const t = window.setInterval(() => {
      setImageWaitTick((x) => x + 1);
    }, 500);
    return () => window.clearInterval(t);
  }, [imageLoading]);

  const imageWaitSeconds = Math.floor(imageWaitTick / 2);

  const imagePhaseHint = useMemo(() => {
    if (!imageLoading) return '';
    if (imageWaitSeconds < 14) {
      return `第一步：整理英文生图提示词（已等待 ${imageWaitSeconds}s）`;
    }
    if (imageWaitSeconds < 45) {
      return `第二步：文生图绘制位图（已等待 ${imageWaitSeconds}s，大分辨率可能较慢）`;
    }
    return `仍在生成中（已等待 ${imageWaitSeconds}s），若持续过久可中止后重试或检查生图模型池`;
  }, [imageLoading, imageWaitSeconds]);

  const diagramImageSrc = useMemo(
    () => (diagramImage ? buildDiagramImageSrc(diagramImage) : null),
    [diagramImage]
  );

  const handleGenerate = useCallback(async () => {
    setModelLine(null);
    setThinkingBuf('');
    setThinkingOpen(true);
    reset();
    await start({ body: { brief: brief.trim() } });
  }, [brief, reset, start]);

  const cancelImage = useCallback(() => {
    imageAbortRef.current?.abort();
    imageAbortRef.current = null;
    setImageLoading(false);
  }, []);

  const handleGenerateImage = useCallback(async () => {
    imageAbortRef.current?.abort();
    const ac = new AbortController();
    imageAbortRef.current = ac;
    setImageError(null);
    setDiagramImage(null);
    setImageWaitTick(0);
    setImageLoading(true);
    try {
      const res = await postMarkingLineDiagramImage(brief, { responseFormat: 'url', signal: ac.signal });
      if (!res.success) {
        const msg = res.error?.message || '生图失败';
        if (res.error?.code === 'ABORTED') {
          setImageError(null);
          return;
        }
        setImageError(msg);
        return;
      }
      if (!res.data) {
        setImageError('服务端未返回数据');
        return;
      }
      const src = buildDiagramImageSrc(res.data);
      if (!src) {
        setImageError('未返回可用的图片 URL 或 Base64');
        return;
      }
      setDiagramImage(res.data);
    } finally {
      setImageLoading(false);
      imageAbortRef.current = null;
    }
  }, [brief]);

  const downloadName = useMemo(() => {
    const ext = extFromMime(diagramImage?.mimeType);
    return `marking-line-diagram.${ext}`;
  }, [diagramImage?.mimeType]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-token-nested">
      <header className="shrink-0 surface mx-3 mt-3 px-4 py-2.5 flex flex-wrap items-center gap-3 rounded-2xl">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-token-secondary transition-opacity hover:opacity-90"
          aria-label="返回"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #64748b, #475569)' }}
          >
            <Factory size={14} color="white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-token-primary">赋码产线</div>
            <div className="text-[11px] text-token-muted font-mono truncate max-w-[min(100vw-12rem,42rem)]">
              {modelLine ?? '等待模型调度…'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        {(isStreaming || imageLoading) && (
          <div className="flex items-center gap-2">
            {isStreaming && (
              <button
                type="button"
                onClick={() => abort()}
                className="px-3 py-1.5 rounded-lg text-[12px] surface-inset text-token-secondary hover:opacity-90"
              >
                中止文案流
              </button>
            )}
            {imageLoading && (
              <button
                type="button"
                onClick={() => cancelImage()}
                className="px-3 py-1.5 rounded-lg text-[12px] surface-inset text-token-secondary hover:opacity-90"
              >
                中止生图
              </button>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 min-h-0 flex flex-col gap-3 px-3 py-3 mx-0">
        <div className="shrink-0 surface rounded-2xl p-4">
          <label className="block text-[12px] text-token-muted mb-2">产线 / 工位 / 采集点描述</label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={5}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[13px] text-token-primary outline-none focus:border-white/20"
            placeholder="示例：四通道进料，裹包机内瓶码 x4、箱码 x1，龙门剔除校验 x1，爬坡后尾箱计数，末端箱码垛工位…"
            disabled={isStreaming}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isStreaming || imageLoading || !brief.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium surface-action-accent disabled:opacity-40"
            >
              <Sparkles size={14} />
              生成示意图（Markdown）
            </button>
            <button
              type="button"
              onClick={handleGenerateImage}
              disabled={isStreaming || imageLoading || !brief.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium surface-inset text-token-primary border border-white/10 disabled:opacity-40"
            >
              <ImageIcon size={14} />
              生成示意图（位图）
            </button>
            <span className="text-[11px] text-token-muted">
              Markdown 流式输出可含 Mermaid；位图为 PNG 等栅格图（由生图模型决定），需在模型池绑定
              marking-line-agent.diagram.image::generation。
            </span>
          </div>
        </div>

        {imageLoading && (
          <div className="shrink-0 surface rounded-xl px-3 py-2 text-[12px] text-token-secondary">
            <div className="text-token-muted mb-1">生图进度</div>
            <div className="font-medium text-token-primary">{imagePhaseHint}</div>
          </div>
        )}

        {imageError && (
          <div className="shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
            {imageError}
          </div>
        )}

        {diagramImageSrc && diagramImage && (
          <div className="shrink-0 surface rounded-2xl p-4 space-y-2">
            <div className="text-[12px] text-token-muted">位图结果</div>
            {(diagramImage.promptComposerModel || diagramImage.promptComposerPlatform) && (
              <div className="text-[11px] text-token-muted font-mono">
                提示词整理模型：{[diagramImage.promptComposerModel, diagramImage.promptComposerPlatform]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </div>
            )}
            <div className="rounded-xl overflow-hidden border border-white/10 bg-black/20">
              <img
                src={diagramImageSrc}
                alt="赋码产线示意图"
                className="w-full h-auto max-h-[min(70vh,900px)] object-contain"
              />
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <a
                href={diagramImageSrc}
                download={downloadName}
                className="inline-flex px-3 py-1.5 rounded-lg text-[12px] surface-action-accent"
              >
                下载图片
              </a>
            </div>
            {diagramImage.imagePromptUsed && (
              <details className="text-[12px] text-token-muted">
                <summary className="cursor-pointer select-none">实际用于生图的英文提示词</summary>
                <pre className="mt-2 text-[11px] text-token-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {diagramImage.imagePromptUsed}
                </pre>
              </details>
            )}
            {diagramImage.revisedPrompt && (
              <details className="text-[12px] text-token-muted">
                <summary className="cursor-pointer select-none">模型修订说明</summary>
                <pre className="mt-2 text-[11px] text-token-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {diagramImage.revisedPrompt}
                </pre>
              </details>
            )}
          </div>
        )}

        <div className="shrink-0">
          <SsePhaseBar phase={phase} message={phaseMessage} />
        </div>

        {thinkingBuf.length > 0 && (
          <details
            className="shrink-0 surface rounded-xl px-3 py-2"
            open={thinkingOpen}
            onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-[12px] text-token-muted select-none">思考过程</summary>
            <pre className="mt-2 text-[11px] text-token-secondary whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {thinkingBuf}
            </pre>
          </details>
        )}

        <div
          className="flex-1 surface rounded-2xl p-4 min-h-0"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <div className="text-[12px] text-token-muted mb-2">Markdown 生成结果</div>
          <StreamingText
            text={typing}
            streaming={isStreaming}
            markdown
            renderMarkdown={(c) => (
              <MarkdownContent content={c} className="text-[13px] leading-relaxed" />
            )}
            className="text-[13px] leading-relaxed text-token-primary"
          />
        </div>
      </div>
    </div>
  );
}

export default MarkingLineAgentPage;
