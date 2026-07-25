import { memo, useMemo, useCallback, useState } from 'react';
import { Copy as CopyIcon, Check } from 'lucide-react';
import { MessageContentRenderer } from './MessageContentRenderer';
import { extractInlineImageToken, extractSizeToken } from '@/lib/visualAgentPromptUtils';
import { inlineMarksToTokens } from '@/lib/chipTokenText';
import { parseVisualMessageDisplay } from '@/lib/visualMessageDisplay';
import { copyToClipboard } from '@/lib/clipboard';
import { resolveVisualResultModelLabel } from '../visualAgentModelOptions';

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
  /** 视觉创作选择的稳定逻辑模型公开 ID。 */
  logicalModelPublicId?: string;
  /** 后端实际调度使用的上游模型，仅用于诊断元数据。 */
  actualModel?: string;
  /** 后端实际命中的模型池名 */
  actualModelPool?: string;
  /** 后端返回的真实出图尺寸（WxH），优先于请求尺寸展示 */
  effectiveSize?: string;
  /** 后端判断此次调用使用的是自适应模型：前端应显示"自适应"而不是具体 WxH */
  isAdaptive?: boolean;
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
  // 池名可能自带一层括号（"默认图像生成池 (stub-image)"）——[^)]+ 会在第一个 )
  // 截断，徽标丢右括号且正文残留 ")"。容忍一层嵌套。
  const re = /\(@model:((?:[^()]|\([^()]*\))+)\)\s*/i;
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
  realModel,
  sizeToAspectMap,
}: {
  size?: string;
  /** 展示用模型名（优先模型池名，与"用户期望"、底部选择器保持一致） */
  model?: string;
  /** 后端实际调度命中的真实 modelId；与展示名不同则以淡色后缀露出（自暴露"选 A 给 B"） */
  realModel?: string;
  sizeToAspectMap?: Map<string, string>;
}) {
  if (!size && !model) return null;
  // 展示名与真实 modelId 不一致时才单独提示，避免常态下冗余
  const diverged = !!realModel && !!model && realModel.trim().toLowerCase() !== model.trim().toLowerCase();
  // tooltip 摊开"展示池名 + 实际模型"，便于核对真实路由
  const modelTooltip = diverged
    ? `模型池 ${model} · 实际模型 ${realModel}`
    : `模型 ${model ?? ''}`;
  // 自适应模型：不走 tier/aspect 解析，直接显示"自适应"
  const isAdaptiveSize = size === '自适应' || size === 'adaptive' || size === 'auto';
  const tier = isAdaptiveSize ? '' : detectTierFromSize(size || '');
  const aspect = isAdaptiveSize || !size
    ? ''
    : (sizeToAspectMap?.get(size.toLowerCase()) || detectAspectFromSize(size));
  const tierLabel = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
  const sizeLabel = isAdaptiveSize
    ? '自适应'
    : (aspect ? `${tierLabel} · ${aspect}` : size);
  return (
    <div className="flex flex-wrap items-center justify-between w-full gap-1.5 !mt-0">
      {size ? (
        <span
          className="inline-flex items-center gap-1 px-1.5 rounded-full shrink-0"
          style={{
            height: 22,
            border: '1px solid var(--border-subtle)',
            background: 'var(--nested-block-bg)',
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
            maxWidth: '70%',
            border: '1px solid rgba(139,92,246,0.20)',
            background: 'rgba(139,92,246,0.08)',
            color: 'rgba(139,92,246,0.85)',
            fontSize: 10,
            fontWeight: 600,
          }}
          title={modelTooltip}
        >
          <span className="truncate" style={{ lineHeight: 1 }}>{model}</span>
          {diverged ? (
            <span style={{ lineHeight: 1, whiteSpace: 'nowrap', opacity: 0.6 }}>· {realModel}</span>
          ) : null}
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
  const isLegacyModelHint = !isUser && String(m.content ?? '').trim().startsWith('本次使用模型：');

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

  // ── 复制用户消息（Lovart token 文本）──────────────────────────────
  // 复制产物 = 用户可见正文 + chip 序列化为 [@image:#N:canvasKey:src] token
  //（chipTokenText SSOT，与 composer 复制/粘贴同一格式）：粘回输入框即还原
  // chip，发给他人也能读到图片 URL。@imgN 未命中当前画布时保持原样。
  const [copied, setCopied] = useState(false);
  const copyUserMessage = useCallback(
    (body: string) => {
      const chipMeta = new Map<number, { canvasKey: string; src: string }>();
      for (const c of canvas) {
        if (typeof c.refId === 'number' && c.refId > 0 && c.src) {
          chipMeta.set(c.refId, { canvasKey: c.key, src: c.src });
        }
      }
      // 复制的是「气泡里看到的」而非落库原文（Codex P2）：历史污染消息的
      // content 仍含生图英文前缀/【引用图片】块——先过展示层清洗，与
      // MessageContentRenderer 同口径；块内独有的 refId 以 @imgN 形式补在
      // 文首（与渲染层顶部 chip 行一致），再统一 token 化。
      const parsed = parseVisualMessageDisplay(body);
      const blockMarks = parsed.blockRefIds.map((id) => `@img${id}`).join(' ');
      const cleanedBody = [blockMarks, parsed.text].filter(Boolean).join(' ').trim();
      const text = inlineMarksToTokens(cleanedBody, chipMeta);
      // 走仓库 SSOT 复制工具（Codex P2）：非安全上下文/内嵌 WebView 下
      // navigator.clipboard 为 undefined，直接调用会同步抛错走不到 catch；
      // copyToClipboard 内部已做现代 API + execCommand 兜底并返回真实结果。
      void copyToClipboard(text).then((ok) => {
        if (!ok) return; // 复制失败保持按钮态不变，不假成功
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    },
    [canvas],
  );

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

  // Filter legacy model hint messages after hooks have been registered.
  if (isLegacyModelHint) return null;

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
              <div className="text-[11px] min-w-0 flex-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }} title={genError.prompt}>
                <MessageContentRenderer
                  content={genError.prompt}
                  canvasItems={canvas}
                  onPreview={(src, prompt) => onPreview(src, prompt)}
                />
              </div>
              <button
                type="button"
                className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium transition-colors hover-bg-soft"
                style={{
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--nested-block-bg)',
                  color: 'var(--text-secondary)',
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
                style={{ width: 48, height: 48, border: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.2)' }}
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
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, var(--text-muted))' }}>
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

    // ── 服务端权威覆盖 ──
    // 视觉创作只面向稳定逻辑模型，不把 Provider / Offering / 上游 modelId 泄漏为主展示。
    // 旧任务没有逻辑模型元数据时，才回退实际模型池或上游模型。
    const meta = parseGenDone(m.content);
    msgModel = resolveVisualResultModelLabel(meta, msgModel);
    const realModel = meta?.logicalModelPublicId
      ? ''
      : String(meta?.actualModel ?? '').trim();

    // 尺寸：自适应 > 后端真实出图尺寸 > 用户请求尺寸 > 默认
    // 修复"请求 1:1 但模型实际返回 16:9"导致徽标显示错误：以 effectiveSize 为准
    if (meta?.isAdaptive) {
      msgSize = '自适应';
    } else {
      const eff = String(meta?.effectiveSize ?? '').trim();
      if (eff) {
        msgSize = eff;
      } else if (originalUserMsg && !msgSize) {
        msgSize = '1024x1024';
      }
    }

    return (
      <div className="flex flex-col items-start gap-0.5">
        <div
          className="group relative max-w-[85%] rounded-[10px] overflow-hidden"
          style={{ border: '1px solid var(--border-subtle)', background: 'rgba(44, 44, 50, 0.78)' }}
        >
          {(genDone.prompt || genDone.refSrc) ? (
            <div className="px-2.5 pb-2 pt-1 flex items-center gap-2 border-b border-b-token-subtle" >
              <div className="text-[11px] min-w-0 flex-1 line-clamp-1" style={{ color: 'var(--text-secondary)' }} title={genDone.prompt}>
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
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--nested-block-bg)',
                  color: 'var(--text-secondary)',
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
            <div className="px-2.5 pt-2 pb-1.5 flex border-t border-t-token-subtle" >
              <MessageMetadataInline size={msgSize} model={msgModel} realModel={realModel} sizeToAspectMap={sizeToAspectMap} />
            </div>
          ) : null}
        </div>
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, var(--text-muted))' }}>
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
        <span className="text-[9px] tabular-nums select-none pl-1" style={{ color: 'var(--text-muted, var(--text-muted))' }}>
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

  // 用户消息气泡下方的"用户期望：xxx 模型"标签：从 @model:xxx token 解析
  const expectedModelForUser = isUser ? String(modeledMsg.model ?? '').trim() : '';

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className="group relative max-w-[85%] rounded-[10px] px-2.5 py-1.5 text-[12px] leading-[16px]"
        style={{
          background: isUser ? 'rgba(62, 55, 42, 0.92)' : 'rgba(42, 43, 50, 0.92)',
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 10px 24px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.06)',
          backdropFilter: 'blur(14px) saturate(150%)',
          WebkitBackdropFilter: 'blur(14px) saturate(150%)',
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
      {/* 用户期望模型徽标（仅用户消息 + 有 @model token 时显示），让用户发送后明确知道自己期望的模型 */}
      {isUser && expectedModelForUser ? (
        <div className="flex items-center gap-1 pr-1" title={`用户期望使用：${expectedModelForUser}`}>
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5"
            style={{
              height: 16,
              fontSize: 9,
              lineHeight: '14px',
              fontWeight: 600,
              border: '1px solid rgba(129,140,248,0.25)',
              background: 'rgba(99,102,241,0.08)',
              color: 'rgba(165,180,252,0.85)',
            }}
          >
            <span style={{ opacity: 0.7 }}>用户期望</span>
            <span style={{ whiteSpace: 'nowrap' }}>{expectedModelForUser}</span>
          </span>
        </div>
      ) : null}
      <span
        className={`inline-flex items-center gap-1.5 text-[9px] tabular-nums select-none ${isUser ? 'pr-1' : 'pl-1'}`}
        style={{ color: 'var(--text-muted, var(--text-muted))' }}
      >
        {isUser ? (
          // 明显的按钮态（用户反馈 9px 纯文本「复制」认不出是按钮）：图标 +
          // 边框 chip，走双皮肤 token；点击后短暂变绿反馈「已复制」。
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full font-medium"
            style={{
              padding: '2px 8px',
              fontSize: 10,
              lineHeight: '14px',
              border: '1px solid var(--border-secondary)',
              background: 'var(--bg-card)',
              color: copied ? 'rgba(74,222,128,0.9)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
            title="复制消息（图片引用序列化为 [@image:#N:...] 文本，粘回输入框可还原）"
            onClick={() => copyUserMessage(msgBody)}
          >
            {copied ? <Check size={11} /> : <CopyIcon size={11} />}
            {copied ? '已复制' : '复制'}
          </button>
        ) : null}
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
