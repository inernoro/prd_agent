import { memo, useMemo, useCallback, useState } from 'react';
import { MessageContentRenderer } from './MessageContentRenderer';
import { extractInlineImageToken, extractSizeToken } from '@/lib/visualAgentPromptUtils';

// ── Types (mirrored from parent to avoid circular deps) ──────────────

type UiMsg = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  ts: number;
};

const GEN_ERROR_PREFIX = '[GEN_ERROR]';
const GEN_DONE_PREFIX = '[GEN_DONE]';

type GenErrorMeta = {
  msg: string;
  refSrc?: string;
  prompt?: string;
  runId?: string;
  modelPool?: string;
  genType?: 'text2img' | 'img2img' | 'vision';
  imageRefShas?: string[];
};
type GenDoneMeta = {
  src: string;
  refSrc?: string;
  prompt?: string;
  runId?: string;
  modelPool?: string;
  genType?: 'text2img' | 'img2img' | 'vision';
  imageRefShas?: string[];
};

function parseGenError(content: string): GenErrorMeta | null {
  if (!content.startsWith(GEN_ERROR_PREFIX)) return null;
  try { return JSON.parse(content.slice(GEN_ERROR_PREFIX.length)) as GenErrorMeta; } catch { return null; }
}
function parseGenDone(content: string): GenDoneMeta | null {
  if (!content.startsWith(GEN_DONE_PREFIX)) return null;
  try { return JSON.parse(content.slice(GEN_DONE_PREFIX.length)) as GenDoneMeta; } catch { return null; }
}

function extractModelToken(text: string): { model: string | null; cleanText: string } {
  const re = /\(@model:([^)]+)\)\s*/i;
  const match = re.exec(text);
  if (!match) return { model: null, cleanText: text };
  return { model: match[1].trim(), cleanText: text.replace(re, '').trim() };
}

function formatMsgTimestamp(ts: number): string {
  const d = new Date(ts);
  if (!d || Number.isNaN(d.getTime())) return '';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}.${mo}.${day} ${h}:${mi}:${s}`;
}

// ── Tier / aspect helpers (inlined to keep self-contained) ───────────

function detectTierFromSize(raw: string): '1k' | '2k' | '4k' {
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(raw);
  if (!m) return '1k';
  const px = Math.max(Number(m[1]), Number(m[2]));
  if (px >= 3072) return '4k';
  if (px >= 1536) return '2k';
  return '1k';
}

function detectAspectFromSize(raw: string): string {
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(raw);
  if (!m) return '';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return '';
  if (w === h) return '1:1';
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.05) return '9:16';
  if (Math.abs(r - 4 / 3) < 0.05) return '4:3';
  if (Math.abs(r - 3 / 4) < 0.05) return '3:4';
  return '';
}

// ── Inline MessageMetadata (kept small, no external import needed) ───

function MessageMetadataInline({
  size,
  model,
  sizeToAspectMap,
}: {
  size?: string;
  model?: string;
  sizeToAspectMap?: Map<string, string>;
}) {
  if (!size && !model) return null;
  const tier = detectTierFromSize(size || '');
  const aspect = size ? (sizeToAspectMap?.get(size.toLowerCase()) || detectAspectFromSize(size)) : '';
  const tierLabel = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
  const sizeLabel = aspect ? `${tierLabel} · ${aspect}` : size;
  return (
    <div className="flex flex-wrap items-center justify-between w-full gap-1.5 !mt-0">
      {size ? (
        <span
          className="inline-flex items-center gap-1 px-1.5 rounded-full shrink-0"
          style={{
            height: 22,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-secondary)',
            fontSize: 10,
            fontWeight: 600,
          }}
          title={`尺寸：${size}`}
        >
          <span className="tabular-nums" style={{ lineHeight: 1, whiteSpace: 'nowrap' }}>{sizeLabel}</span>
        </span>
      ) : <div />}
      {model ? (
        <span
          className="inline-flex items-center gap-1 px-1.5 rounded-full shrink-0 ml-auto"
          style={{
            height: 22,
            border: '1px solid rgba(139,92,246,0.20)',
            background: 'rgba(139,92,246,0.08)',
            color: 'rgba(139,92,246,0.85)',
            fontSize: 10,
            fontWeight: 600,
          }}
          title={`模型池：${model}`}
        >
          <span style={{ lineHeight: 1, whiteSpace: 'nowrap' }}>{model}</span>
        </span>
      ) : null}
    </div>
  );
}

// ── Canvas item subset (only what we need for rendering) ─────────────

interface CanvasItemSubset {
  refId?: number;
  src: string;
  prompt?: string;
  key: string;
  sha256?: string;
  originalSha256?: string;
}

// ── Props ────────────────────────────────────────────────────────────

export interface ChatMessageItemProps {
  msg: UiMsg;
  /** All messages (needed for genDone metadata lookup) */
  allMessages: UiMsg[];
  canvas: CanvasItemSubset[];
  sizeToAspectMap: Map<string, string>;
  onPreview: (src: string, prompt: string, runId?: string) => void;
  onRetry: (prompt: string, imageRefShas: string[], canvas: CanvasItemSubset[]) => void;
}

// ── Component ────────────────────────────────────────────────────────

export const ChatMessageItem = memo(function ChatMessageItem({
  msg: m,
  allMessages,
  canvas,
  sizeToAspectMap,
  onPreview,
  onRetry,
}: ChatMessageItemProps) {
  const isUser = m.role === 'User';

  // Filter legacy model hint messages
  if (!isUser && String(m.content ?? '').trim().startsWith('本次使用模型：')) return null;

  // ── Memoize expensive parsing ──────────────────────────────────────

  const genError = useMemo(() => (!isUser ? parseGenError(m.content) : null), [isUser, m.content]);
  const genDone = useMemo(() => (!isUser ? parseGenDone(m.content) : null), [isUser, m.content]);
  const legacyErrorMatch = useMemo(() => {
    if (isUser || genError || genDone) return null;
    return /^(?:生成失败|解析失败)[：:](.+)$/s.exec(String(m.content ?? '').trim());
  }, [isUser, genError, genDone, m.content]);

  const timestamp = useMemo(() => formatMsgTimestamp(m.ts), [m.ts]);

  // ── Local expand state (doesn't affect siblings) ───────────────────

  const [expanded, setExpanded] = useState(false);

  // ── Retry handler ──────────────────────────────────────────────────

  const handleRetry = useCallback(
    (prompt: string | undefined, imageRefShas: string[] | undefined) => {
      if (!prompt) return;
      const p = prompt.trim();
      if (!p) return;
      onRetry(p, imageRefShas || [], canvas);
    },
    [onRetry, canvas],
  );

  // ── GenError ───────────────────────────────────────────────────────

  if (genError) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <div
          className="group relative max-w-[85%] rounded-[10px] overflow-hidden"
          style={{ border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(55, 35, 35, 0.80)' }}
        >
          {genError.prompt ? (
            <div className="px-2.5 pt-2 pb-1.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(239,68,68,0.15)' }}>
              <div className="text-[11px] min-w-0 flex-1 line-clamp-2" style={{ color: 'rgba(255,255,255,0.5)' }} title={genError.prompt}>
                <MessageContentRenderer
                  content={genError.prompt}
                  canvasItems={canvas}
                  onPreview={(src, prompt) => onPreview(src, prompt)}
                />
              </div>
              <button
                type="button"
                className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium transition-colors hover:bg-white/10"
                style={{
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.05)',
                  color: 'rgba(255,255,255,0.7)',
                }}
                title="重试生成"
                onClick={() => handleRetry(genError.prompt, genError.imageRefShas)}
              >
                重试
              </button>
            </div>
          ) : null}
          <div className="px-2.5 pt-2 pb-2 flex items-start gap-2.5">
            {genError.refSrc ? (
              <button
                type="button"
                className="shrink-0 rounded-[6px] overflow-hidden"
                style={{ width: 48, height: 48, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.2)' }}
                onClick={() => onPreview(genError.refSrc!, '参照图')}
                title="点击预览参照图"
              >
                <img src={genError.refSrc} alt="参照图" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium" style={{ color: 'rgba(239,68,68,0.92)' }}>生成失败</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'rgba(239,68,68,0.72)', wordBreak: 'break-word' }}>
                {genError.msg}
              </div>
            </div>
          </div>
        </div>
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, rgba(255,255,255,0.38))' }}>
          {timestamp}
        </span>
      </div>
    );
  }

  // ── GenDone ────────────────────────────────────────────────────────

  if (genDone) {
    // Compute metadata from adjacent user message
    const myIdx = allMessages.indexOf(m);
    const originalUserMsg = allMessages.find((om) => om.id === m.id.replace('msg_a', 'msg_u')) || allMessages[myIdx - 1];

    let msgSize = '';
    let msgModel = '';

    if (originalUserMsg && originalUserMsg.role === 'User') {
      const parsed = extractInlineImageToken(originalUserMsg.content);
      const contentText = parsed ? parsed.clean : originalUserMsg.content;
      const sizedMsg = extractSizeToken(contentText);
      msgSize = String(sizedMsg.size ?? '').trim();
      const modeledMsg = extractModelToken(sizedMsg.cleanText);
      msgModel = String(modeledMsg.model ?? '').trim();
    }

    if (originalUserMsg && !msgSize) {
      msgSize = '1024x1024';
    }

    if (!msgModel) {
      const meta = parseGenDone(m.content);
      if (meta && meta.modelPool) {
        msgModel = meta.modelPool;
      }
    }

    return (
      <div className="flex flex-col items-start gap-0.5">
        <div
          className="group relative max-w-[85%] rounded-[10px] overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(44, 44, 50, 0.78)' }}
        >
          {(genDone.prompt || genDone.refSrc) ? (
            <div className="px-2.5 pb-2 pt-1 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="text-[11px] min-w-0 flex-1 line-clamp-1" style={{ color: 'rgba(255,255,255,0.5)' }} title={genDone.prompt}>
                <MessageContentRenderer
                  content={genDone.prompt || ''}
                  canvasItems={canvas}
                  onPreview={(src, prompt) => onPreview(src, prompt)}
                />
              </div>
              <button
                type="button"
                className="shrink-0 px-2 py-0.5 text-[10px] rounded-md transition-all hover:brightness-110"
                style={{
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.05)',
                  color: 'rgba(255,255,255,0.7)',
                }}
                title="使用相同提示词重新生成"
                onClick={() => handleRetry(genDone.prompt, genDone.imageRefShas)}
              >
                重试
              </button>
            </div>
          ) : null}

          {/* Generated image */}
          <button
            type="button"
            className="block w-full"
            onClick={() => onPreview(genDone.src, genDone.prompt || '', genDone.runId)}
            title="点击放大"
          >
            <img
              src={genDone.src}
              alt={genDone.prompt || '生成结果'}
              style={{ width: '100%', maxHeight: 160, objectFit: 'contain', display: 'block' }}
            />
          </button>

          {/* Metadata */}
          {(msgSize || msgModel) ? (
            <div className="px-2.5 pt-2 pb-1.5 flex" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <MessageMetadataInline size={msgSize} model={msgModel} sizeToAspectMap={sizeToAspectMap} />
            </div>
          ) : null}
        </div>
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, rgba(255,255,255,0.38))' }}>
          {timestamp}
        </span>
      </div>
    );
  }

  // ── Legacy error ───────────────────────────────────────────────────

  if (legacyErrorMatch) {
    const legacyMsg = legacyErrorMatch[1].trim();
    return (
      <div className="flex flex-col items-start gap-0.5">
        <div
          className="group relative max-w-[85%] rounded-[10px] overflow-hidden px-2.5 pt-2 pb-2"
          style={{ border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(55, 35, 35, 0.80)' }}
        >
          <div className="text-[12px] font-medium" style={{ color: 'rgba(239,68,68,0.92)' }}>生成失败</div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'rgba(239,68,68,0.72)', wordBreak: 'break-word' }}>
            {legacyMsg}
          </div>
        </div>
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, rgba(255,255,255,0.38))' }}>
          {timestamp}
        </span>
      </div>
    );
  }

  // ── Plain text message ─────────────────────────────────────────────

  const parsed = isUser ? extractInlineImageToken(m.content) : null;
  const contentText = parsed ? parsed.clean : m.content;
  const sizedMsg = isUser ? extractSizeToken(contentText) : { size: null as string | null, cleanText: String(contentText ?? '') };
  const modeledMsg = isUser ? extractModelToken(sizedMsg.cleanText) : { model: null as string | null, cleanText: String(sizedMsg.cleanText ?? '') };
  const msgBody = String(modeledMsg.cleanText ?? '');
  const MSG_COLLAPSE_THRESHOLD = 100;
  const isLongMsg = msgBody.length > MSG_COLLAPSE_THRESHOLD;

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className="group relative max-w-[85%] rounded-[10px] px-2.5 py-1.5 text-[12px] leading-[16px]"
        style={{
          background: isUser ? 'rgba(60, 54, 42, 0.82)' : 'rgba(44, 44, 50, 0.78)',
          border: '1px solid rgba(255,255,255,0.10)',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        <div style={{ maxHeight: isLongMsg && !expanded ? 64 : undefined, overflow: isLongMsg && !expanded ? 'hidden' : undefined }}>
          <MessageContentRenderer
            content={msgBody}
            canvasItems={canvas}
            onPreview={(src, prompt) => onPreview(src, prompt)}
          />
        </div>
        {isLongMsg ? (
          <button
            type="button"
            className="mt-0.5 text-[10px] font-medium"
            style={{ color: 'rgba(99, 102, 241, 0.85)' }}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
      <span
        className={`text-[9px] tabular-nums select-none ${isUser ? 'pr-1' : 'pl-1'}`}
        style={{ color: 'var(--text-muted, rgba(255,255,255,0.38))' }}
      >
        {timestamp}
      </span>
    </div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render when message content hasn't changed
  // and canvas reference is the same (image chips won't change appearance)
  return (
    prev.msg === next.msg &&
    prev.canvas === next.canvas &&
    prev.sizeToAspectMap === next.sizeToAspectMap &&
    prev.allMessages === next.allMessages &&
    prev.onPreview === next.onPreview &&
    prev.onRetry === next.onRetry
  );
});
