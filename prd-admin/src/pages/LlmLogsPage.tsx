import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import { SearchableSelect, Select } from '@/components/design';
import { TabBar } from '@/components/design/TabBar';
import { Dialog } from '@/components/ui/Dialog';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';
import { getAdminDocumentContent, getLlmLogDetail, getLlmLogs, getLlmLogsMeta, listUploadArtifacts, getReplayCurl } from '@/services';
import type { LlmLogsMetaUser, LlmLogsMetaRequestPurpose } from '@/services/contracts/llmLogs';
import type { LlmRequestLog, LlmRequestLogListItem, UploadArtifact } from '@/types/admin';
import { CheckCircle, ChevronDown, Clock, Copy, Database, Eraser, Hash, HelpCircle, ImagePlus, Layers, Loader2, RefreshCw, Reply, ScanEye, Server, Sparkles, StopCircle, Users, XCircle, Zap } from 'lucide-react';
import { AppCallerKeyIcon } from '@/lib/appCallerUtils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useSearchParams } from 'react-router-dom';
import SystemLogsTab from '@/pages/system-logs/SystemLogsTab';

function codeBoxStyle(): React.CSSProperties {
  return {
    background: 'rgba(0,0,0,0.28)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 14,
    padding: 12,
    overflow: 'auto',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}

/**
 * LLM 经常用 ```markdown / ```md 包裹"本来就想渲染的 Markdown"，
 * 这会导致 ReactMarkdown 将其当作代码块显示（<pre><code>），而非解析内部的 markdown 语法。
 * 这里仅解包 markdown/md 语言标记，其它代码块保持不动。
 */
function unwrapMarkdownFences(text: string): string {
  if (!text) return text;
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

const PROMPT_TOKEN_RE = /\[[A-Z0-9_]+\]/g;
const PRD_TOKENS = new Set(['[PRD_CONTENT_REDACTED]', '[PRD_FULL_REDACTED]']);

function splitTextByPromptTokens(text: string): Array<{ type: 'text' | 'token'; value: string }> {
  const s = text ?? '';
  const parts: Array<{ type: 'text' | 'token'; value: string }> = [];
  if (!s) return parts;

  let lastIndex = 0;
  PROMPT_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROMPT_TOKEN_RE.exec(s)) !== null) {
    const idx = m.index;
    if (idx > lastIndex) parts.push({ type: 'text', value: s.slice(lastIndex, idx) });
    parts.push({ type: 'token', value: m[0] });
    lastIndex = idx + m[0].length;
  }
  if (lastIndex < s.length) parts.push({ type: 'text', value: s.slice(lastIndex) });
  return parts;
}

function BodyWithPromptTokens({
  text,
  onTokenClick,
}: {
  text: string;
  onTokenClick: (token: string) => void;
}) {
  const parts = useMemo(() => splitTextByPromptTokens(text), [text]);

  return (
    <div style={codeBoxStyle()}>
      {parts.map((p, i) =>
        p.type === 'token' ? (
          <span
            key={`${p.type}-${p.value}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => onTokenClick(p.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onTokenClick(p.value);
            }}
            title={PRD_TOKENS.has(p.value) ? `点击预览 PRD 原文：${p.value}` : `点击预览 system prompt：${p.value}`}
            style={{
              cursor: 'pointer',
              color: 'rgba(77, 163, 255, 0.95)',
              fontWeight: 800,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {p.value}
          </span>
        ) : (
          <span key={`${p.type}-${i}`}>{p.value}</span>
        )
      )}
    </div>
  );
}

function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function diffMs(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return b.getTime() - a.getTime();
}

function fmtMsSmart(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const ms = Math.round(v);
  if (Math.abs(ms) >= 10_000) {
    const s = ms / 1000;
    const s1 = Math.round(s * 10) / 10; // 1 位小数
    return Number.isInteger(s1) ? `${s1.toFixed(0)}s` : `${s1.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

function fmtNum(v: number | null | undefined): string {
  // 重要：null/undefined 表示“未知/未上报”，不应显示为 0
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

type RequestTypeTone = 'gold' | 'green' | 'blue' | 'purple' | 'muted';

function normalizeRequestType(t: string | null | undefined): string {
  return (t ?? '').trim().toLowerCase();
}

function requestTypeToBadge(t: string | null | undefined): { label: string; title: string; tone: RequestTypeTone; icon: JSX.Element | null } {
  const v = normalizeRequestType(t);
  if (v === 'update-model' || v === 'update_model' || v === 'models' || v === 'model') {
    return { label: '更新模型', title: '更新模型', tone: 'blue', icon: <RefreshCw size={12} /> };
  }
  if (v === 'intent') return { label: '意图', title: '意图', tone: 'green', icon: <Sparkles size={12} /> };
  if (v === 'vision' || v === 'image' || v === 'imagevision') return { label: '识图', title: '识图', tone: 'blue', icon: <ScanEye size={12} /> };
  if (v === 'generation' || v === 'imagegen' || v === 'image_gen' || v === 'image-generate') return { label: '生图', title: '生图', tone: 'purple', icon: <ImagePlus size={12} /> };
  if (v === 'reasoning' || v === 'main' || v === 'chat') return { label: '推理', title: '推理', tone: 'gold', icon: <Zap size={12} /> };
  if (!v || v === 'unknown') return { label: '未知', title: '未知', tone: 'muted', icon: null };
  return { label: '未知', title: v, tone: 'muted', icon: null };
}

function requestTypeChipStyle(tone: RequestTypeTone): React.CSSProperties {
  if (tone === 'green') return { background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.28)', color: 'rgba(34, 197, 94, 0.95)' };
  if (tone === 'blue') return { background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.28)', color: 'rgba(59, 130, 246, 0.95)' };
  if (tone === 'purple') return { background: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.28)', color: 'rgba(168, 85, 247, 0.95)' };
  if (tone === 'gold') return { background: 'rgba(214, 178, 106, 0.18)', border: '1px solid rgba(214, 178, 106, 0.35)', color: 'var(--accent-gold-2)' };
  return { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--text-muted)' };
}

function extractImageSizeAdjustmentHint(it: LlmRequestLogListItem): { from?: string; to?: string; ratioAdjusted?: boolean } | null {
  const reqType = normalizeRequestType(it.requestType);
  if (!(reqType === 'generation' || reqType === 'imagegen' || reqType === 'image_gen' || reqType === 'image-generate')) return null;

  const err = String(it.error ?? '');
  const ans = String(it.answerPreview ?? '');
  const text = `${err}\n${ans}`;

  // 1) 优先：error 中的 Auto-adjusted
  const m1 = /Auto-adjusted image size:\s*([^\s]+)\s*->\s*([^\s]+)/i.exec(text);
  if (m1) return { from: m1[1], to: m1[2] };

  // 2) 其次：answerPreview JSON（OpenAIImageClient summary 会写入 requestedSize/effectiveSize/ratioAdjusted）
  if (text.includes('"sizeAdjusted":true')) {
    const mFrom = /"requestedSize"\s*:\s*"([^"]+)"/.exec(text);
    const mTo = /"effectiveSize"\s*:\s*"([^"]+)"/.exec(text);
    const mRatio = /"ratioAdjusted"\s*:\s*(true|false)/.exec(text);
    return { from: mFrom?.[1], to: mTo?.[1], ratioAdjusted: mRatio?.[1] === 'true' };
  }

  return null;
}

function extractAllowedSizesFromAnswerText(answerText: string | null | undefined): string[] {
  const raw = (answerText ?? '').trim();
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw) as any;
    const arr = obj?.allowedSizes;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x: any) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, 128);
  } catch {
    return [];
  }
}

function extractImageGenUpstreamPreviewFromAnswerText(answerText: string | null | undefined): {
  preview: string;
  initImageProvided?: boolean;
  initImageUsed?: boolean;
} | null {
  const raw = (answerText ?? '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as any;
    const preview = String(obj?.upstreamBodyPreview ?? '').trim();
    if (!preview) return null;
    const initImageProvided = typeof obj?.initImageProvided === 'boolean' ? (obj.initImageProvided as boolean) : undefined;
    const initImageUsed = typeof obj?.initImageUsed === 'boolean' ? (obj.initImageUsed as boolean) : undefined;
    return { preview, initImageProvided, initImageUsed };
  } catch {
    return null;
  }
}

// 注意：isLlmRequest 函数已移除，因为后端已经将非 LLM 请求（如更新模型列表）归类到系统日志中
// 前端无需再做过滤

function tryPrettyJsonText(text: string): string {
  const raw = (text ?? '').trim();
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw) as unknown;
    return JSON.stringify(obj, null, 2);
  } catch {
    return text;
  }
}

function normalizeStrictJsonCandidate(raw: string): { ok: true; json: string } | { ok: false; reason: string } {
  const t0 = (raw ?? '').trim();
  if (!t0) return { ok: false, reason: '空内容' };

  // 允许 ```json ... ``` 这种“整体代码块包裹”的返回
  if (t0.startsWith('```')) {
    const m = t0.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    if (!m) return { ok: false, reason: '代码块格式不完整（缺少闭合 ```）' };
    const inner = (m[1] ?? '').trim();
    if (!inner) return { ok: false, reason: '代码块为空' };
    if (!inner.startsWith('{') && !inner.startsWith('[')) return { ok: false, reason: '代码块内容不是 JSON（未以 { 或 [ 开头）' };
    if (!(inner.endsWith('}') || inner.endsWith(']'))) return { ok: false, reason: '代码块内容不是 JSON（未以 } 或 ] 结尾）' };
    return { ok: true, json: inner };
  }

  if (!t0.startsWith('{') && !t0.startsWith('[')) return { ok: false, reason: '不是 JSON（未以 { 或 [ 开头）' };
  if (!(t0.endsWith('}') || t0.endsWith(']'))) return { ok: false, reason: '不是 JSON（未以 } 或 ] 结尾）' };
  return { ok: true, json: t0 };
}

function validateStrictJson(raw: string): { ok: true } | { ok: false; reason: string } {
  const c = normalizeStrictJsonCandidate(raw);
  if (!c.ok) return c;
  try {
    JSON.parse(c.json);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `JSON.parse 失败：${msg}` };
  }
}

function decodeEscapedTextForDisplay(input: string): string {
  // 目标：把文本中的 \uXXXX（以及常见转义）解码为真实字符，便于阅读日志 Raw。
  // 约束：只用于“显示/复制”的可见性增强，不改变源数据，也不用于严格 JSON 校验。
  const s = String(input ?? '');
  if (!s) return '';

  const isHex4At = (str: string, at: number) => {
    if (at + 4 > str.length) return false;
    for (let i = 0; i < 4; i++) {
      const c = str.charCodeAt(at + i);
      const isNum = c >= 48 && c <= 57; // 0-9
      const isAF = c >= 65 && c <= 70; // A-F
      const isaf = c >= 97 && c <= 102; // a-f
      if (!(isNum || isAF || isaf)) return false;
    }
    return true;
  };

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\' || i + 1 >= s.length) {
      out += ch;
      continue;
    }

    const n = s[i + 1];
    // 常见转义
    if (n === 'n') {
      out += '\n';
      i += 1;
      continue;
    }
    if (n === 'r') {
      out += '\r';
      i += 1;
      continue;
    }
    if (n === 't') {
      out += '\t';
      i += 1;
      continue;
    }
    if (n === 'b') {
      out += '\b';
      i += 1;
      continue;
    }
    if (n === 'f') {
      out += '\f';
      i += 1;
      continue;
    }
    if (n === '"' || n === '\\' || n === '/') {
      out += n;
      i += 1;
      continue;
    }

    // Unicode 转义：\uXXXX（包含 surrogate pair 组合）
    if (n === 'u' && isHex4At(s, i + 2)) {
      const hi = parseInt(s.slice(i + 2, i + 6), 16);

      // surrogate pair: \uD800-\uDBFF + \uDC00-\uDFFF
      if (
        hi >= 0xd800 &&
        hi <= 0xdbff &&
        s[i + 6] === '\\' &&
        s[i + 7] === 'u' &&
        isHex4At(s, i + 8)
      ) {
        const lo = parseInt(s.slice(i + 8, i + 12), 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          const cp = (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
          out += String.fromCodePoint(cp);
          i += 11;
          continue;
        }
      }

      out += String.fromCharCode(hi);
      i += 5;
      continue;
    }

    // 未识别：保留原样
    out += ch;
  }
  return out;
}

function shellSingleQuote(text: string): string {
  // Bash/zsh 安全单引号转义：' -> '"'"'
  return `'${String(text).replace(/'/g, `'"'"'`)}'`;
}

function joinBaseAndPath(apiBase: string, path: string) {
  const b = (apiBase ?? '').trim();
  const p = (path ?? '').trim();
  if (!b) return p;
  if (!p) return b;
  return `${b.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
}

function isExternalCurlOp(it: Pick<LlmRequestLogListItem, 'requestType'>) {
  // 目前产品定义里：更新模型 / models.list 属于“外部 HTTP 请求（非大模型推理）”
  const v = normalizeRequestType(it.requestType);
  return v === 'update-model' || v === 'update_model' || v === 'models' || v === 'model';
}

function resolvePlatformAndModel(
  platformName: string | null | undefined,
  model: string,
  providerFallback: string
): { platform: string; modelName: string } {
  // 优先使用后端下发的真实平台名称
  const pn = (platformName ?? '').trim();
  const raw = (model ?? '').trim();
  if (pn) {
    return { platform: pn, modelName: raw || '—' };
  }
  // 兼容旧数据：没有 platformName 时，回退用 provider
  if (!raw) return { platform: (providerFallback ?? '').trim() || '—', modelName: '—' };
  return { platform: (providerFallback ?? '').trim() || '—', modelName: raw };
}

function inferListItemUrl(it: Pick<LlmRequestLogListItem, 'apiBase' | 'path'>): string {
  const apiBase = (it.apiBase ?? '').trim();
  const path = (it.path ?? '').trim();
  if (!apiBase && !path) return '';
  return joinBaseAndPath(apiBase, path);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  // 仅尝试 JSON object/array；其它情况不推断
  if (!(raw.startsWith('{') || raw.startsWith('['))) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') return v as any;
    return null;
  } catch {
    return null;
  }
}

function isPromptTokenText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^\[[A-Z0-9_]+\]$/.test(s);
}

/** 检测是否为后端截断的文本（包含 ...[N chars trimmed] 后缀） */
function isTruncatedText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return /\.\.\.\[\d+ chars trimmed\]$/.test(v.trim());
}

/** 检测文本是否需要被还原（token 占位符或截断文本） */
function needsRestore(v: unknown): v is string {
  return isPromptTokenText(v) || isTruncatedText(v);
}

/**
 * 检测请求体是否包含需要后端 replay-curl 恢复的 COS 引用。
 * 匹配格式：
 *   1. [BASE64_IMAGE:<sha256>:<mime>] — 图片 SHA256 引用
 *   2. [TEXT_COS:<sha256>:<charcount>] — 长文本 COS 引用
 *   3. data:image/...;base64,...[N chars trimmed] — 旧截断格式
 *   4. "sha256": "<hex>" — 旧 sha256 属性格式
 */
function needsBackendReplayCurl(requestBody?: string): boolean {
  if (!requestBody) return false;
  // 新格式: [BASE64_IMAGE:sha256:mime]
  if (/\[BASE64_IMAGE:[0-9a-f]{64}:[^\]]+\]/.test(requestBody)) return true;
  // COS 长文本引用: [TEXT_COS:sha256:charcount]
  if (/\[TEXT_COS:[0-9a-f]{64}:\d+\]/.test(requestBody)) return true;
  // 旧截断格式: 被截断的 base64 data URL
  if (/data:image\/[^;]+;base64,[A-Za-z0-9+/].*\.\.\[\d+ chars trimmed\]/.test(requestBody)) return true;
  // 旧 sha256 属性格式
  if (/"sha256"\s*:\s*"[0-9a-f]{64}"/.test(requestBody)) return true;
  return false;
}

/**
 * 还原请求体中被截断/脱敏的内容（用于 curl 复制和 body 展示）。
 *
 * 后端日志存储会对请求体做两层处理：
 * 1. OpenAIClient 路径：系统提示词替换为 token（如 [SYSTEM_PROMPT_REDACTED]）
 * 2. LlmRequestLogWriter：>1024 字符存入 COS [TEXT_COS:sha256:charcount]，COS 不可用时截断
 *
 * 本函数从单独存储的 systemPromptText / questionText 还原这些被截断的内容（兼容旧日志）。
 */
function restoreTruncatedRequestBody(
  requestBodyRedacted: string,
  systemPromptText: string | null | undefined,
  questionText: string | null | undefined
): string {
  const raw = requestBodyRedacted || '';
  if (!raw.trim()) return raw;

  const sp = (systemPromptText ?? '').trim();
  const qt = (questionText ?? '').trim();
  if (!sp && !qt) return raw;

  const parsed = tryParseJsonObject(raw);
  if (!parsed) return raw;

  const obj = JSON.parse(JSON.stringify(parsed)) as any;
  let changed = false;

  // Anthropic 顶层 system 字段
  if (sp) {
    const systemKeys = ['system', 'system_prompt', 'systemPrompt', 'system_prompt_text', 'systemPromptText'];
    for (const k of systemKeys) {
      if (needsRestore(obj?.[k])) {
        obj[k] = sp;
        changed = true;
      }
    }
  }

  const messages = obj?.messages;
  if (Array.isArray(messages)) {
    // 找到最后一条 user 消息的索引（用于 questionText 还原）
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && String(messages[i].role ?? '').toLowerCase() === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      const role = String((m as any).role ?? '').toLowerCase();

      // 还原 system 消息
      if (role === 'system' && sp) {
        const c = (m as any).content;
        if (needsRestore(c)) {
          (m as any).content = sp;
          changed = true;
          continue;
        }
        // 兼容：多模态 content 为数组/对象
        if (Array.isArray(c)) {
          for (const it of c) {
            if (!it || typeof it !== 'object') continue;
            if (needsRestore((it as any).text)) {
              (it as any).text = sp;
              changed = true;
            }
          }
        } else if (c && typeof c === 'object') {
          if (needsRestore((c as any).text)) {
            (c as any).text = sp;
            changed = true;
          }
        }
      }

      // 还原最后一条 user 消息（从 questionText）
      if (role === 'user' && qt && i === lastUserIdx) {
        const c = (m as any).content;
        if (isTruncatedText(c)) {
          (m as any).content = qt;
          changed = true;
        }
      }
    }
  }

  return changed ? JSON.stringify(obj) : raw;
}

function inferDocumentCharsFromRequestBody(requestBodyRedacted: string): number | null {
  const obj = tryParseJsonObject(requestBodyRedacted);
  if (!obj) return null;

  // 常见形态：{ documents: [...] } / { document: ... }
  const pickLen = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    try {
      return JSON.stringify(v).length;
    } catch {
      return String(v).length;
    }
  };

  const docs = (obj as any).documents;
  if (Array.isArray(docs)) return docs.reduce((sum: number, x: unknown) => sum + pickLen(x), 0);

  const doc = (obj as any).document;
  if (doc !== undefined) return pickLen(doc);

  return null;
}

function inferUserPromptCharsFromRequestBody(requestBodyRedacted: string): number | null {
  const obj = tryParseJsonObject(requestBodyRedacted);
  if (!obj) return null;

  const messages = (obj as any).messages;
  if (!Array.isArray(messages)) return null;

  const pickTextLen = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (Array.isArray(v)) {
      // Claude/OpenAI 多模态：[{type:"text", text:"..."}, ...]
      return v.reduce((sum, it) => {
        if (it && typeof it === 'object' && typeof (it as any).text === 'string') return sum + ((it as any).text as string).length;
        return sum;
      }, 0);
    }
    if (typeof v === 'object') {
      // 兼容：{type:"text", text:"..."}
      if (typeof (v as any).text === 'string') return ((v as any).text as string).length;
      return 0;
    }
    return 0;
  };

  let sum = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role ?? '').toLowerCase();
    if (role !== 'user') continue;
    sum += pickTextLen((m as any).content);
  }
  return sum;
}

/**
 * 将参考图 URL 注入到请求体 JSON 中（用于 curl 复制和 body 展示）。
 * 当 body 中 initImageProvided=true 且 image 字段缺失时，从 artifacts 补充。
 * 后端新版本已直接写入 image 字段，此函数兼容旧日志。
 */
function injectRefImageIntoRequestBody(bodyText: string, inputArtifacts: UploadArtifact[]): string {
  const raw = (bodyText ?? '').trim();
  if (!raw) return bodyText;
  try {
    const obj = JSON.parse(raw) as any;
    if (obj?.initImageProvided !== true) return bodyText;
    // 如果后端已写入有效 image URL 则不覆盖
    if (typeof obj.image === 'string' && obj.image.startsWith('http')) return bodyText;
    // 兼容旧日志：从 artifacts 注入
    if (inputArtifacts.length === 1) {
      obj.image = inputArtifacts[0].cosUrl;
    } else if (inputArtifacts.length > 1) {
      obj.image = inputArtifacts.map((a) => a.cosUrl);
    }
    // 无 artifact 且后端未写入时不注入占位符（后端新版本会直接写入）
    if (!obj.image) return bodyText;
    return JSON.stringify(obj);
  } catch {
    return bodyText;
  }
}

type InlineImagePreview = {
  label: string;
  url: string;
  sha256?: string;
};

function extractInlineImagesFromBody(bodyJson: string | null | undefined): InlineImagePreview[] {
  if (!bodyJson) return [];
  try {
    const obj = JSON.parse(bodyJson) as any;
    const out: InlineImagePreview[] = [];
    const seen = new Set<string>();
    const push = (label: string, urlLike: unknown, sha256?: string | null) => {
      if (typeof urlLike !== 'string') return;
      const url = urlLike.trim();
      if (!url) return;
      if (!(url.startsWith('http') || url.startsWith('data:image/'))) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ label, url, sha256: (sha256 ?? '').trim() || undefined });
    };

    if (typeof obj?.image === 'string') {
      push('参考图', obj.image, typeof obj?.imageSha256 === 'string' ? obj.imageSha256 : undefined);
    } else if (Array.isArray(obj?.image)) {
      for (const item of obj.image) push('参考图', item);
    }
    if (typeof obj?.mask === 'string') push('蒙版', obj.mask);

    const msgs = Array.isArray(obj?.messages) ? obj.messages : Array.isArray(obj?.contents) ? obj.contents : [];
    for (const msg of msgs) {
      const parts = Array.isArray(msg?.content) ? msg.content : Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) {
        if (part?.type === 'image_url') {
          push('参考图', part?.image_url?.url ?? part?.url);
        }
        if (part?.inline_data && typeof part.inline_data.data === 'string' && part.inline_data.data.length > 100) {
          const mime = String(part.inline_data.mime_type ?? 'image/png').trim() || 'image/png';
          push('参考图', `data:${mime};base64,${part.inline_data.data}`);
        }
      }
    }

    return out;
  } catch {
    return [];
  }
}

function resolveBodyInlineImages(
  imageReferences: LlmRequestLog['imageReferences'],
  requestBodyRedacted: string | null | undefined
): InlineImagePreview[] {
  // 优先新字段 imageReferences（COS URL）；若为空则回退到 requestBody 解析，兼容旧日志。
  const refs = Array.isArray(imageReferences) ? imageReferences : [];
  const fromRefs = refs
    .map((r) => ({
      label: (r?.label ?? '').trim() || '参考图',
      url: (r?.cosUrl ?? '').trim(),
      sha256: (r?.sha256 ?? '').trim() || undefined,
    }))
    .filter((x) => x.url);
  if (fromRefs.length > 0) return fromRefs;
  return extractInlineImagesFromBody(requestBodyRedacted);
}

/**
 * 从 URL 中提取域名，用作 Postman 环境变量名。
 * 例: "https://api.apiyi.com/v1/chat/completions" → "api.apiyi.com"
 */
function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const m = url.match(/https?:\/\/([^/:?\s]+)/);
    return m ? m[1] : '';
  }
}

function buildCurlFromLog(detail: LlmRequestLog, inputArtifacts?: UploadArtifact[]): string {
  const apiBase = (detail.apiBase ?? '').trim();
  const path = (detail.path ?? '').trim();
  const url = joinBaseAndPath(apiBase, path) || 'https://api.example.com/v1/chat/completions';

  // 提取域名作为 Postman 环境变量占位符，例如 {{api.apiyi.com}}
  const domain = extractDomainFromUrl(url);
  const apiKeyPlaceholder = domain ? `{{${domain}}}` : 'YOUR_API_KEY';

  const headers: Record<string, string> = { ...(detail.requestHeadersRedacted ?? {}) };
  // 清理不适合重放的 header
  Object.keys(headers).forEach((k) => {
    const key = k.toLowerCase();
    if (key === 'content-length' || key === 'host') delete headers[k];
  });

  // 使用 Postman 环境变量占位符替换 API Key（避免真实值泄露，且 Postman 可自动匹配）
  const hasXApiKey = Object.keys(headers).some((k) => k.toLowerCase() === 'x-api-key');
  const providerLower = (detail.provider ?? '').toLowerCase();

  const isAnthropicLike = hasXApiKey || providerLower.includes('claude') || providerLower.includes('anthropic');

  if (isAnthropicLike) {
    // Anthropic 风格：x-api-key
    headers['x-api-key'] = apiKeyPlaceholder;
  }

  // 所有非 Anthropic 平台统一补 Authorization Bearer（日志存储时 auth 头已脱敏移除）
  if (!isAnthropicLike) {
    headers.Authorization = `Bearer ${apiKeyPlaceholder}`;
  }

  // 默认 JSON
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  let restoredBody = restoreTruncatedRequestBody(detail.requestBodyRedacted || '', detail.systemPromptText, detail.questionText);
  restoredBody = injectRefImageIntoRequestBody(restoredBody, inputArtifacts ?? []);
  const bodyPretty = tryPrettyJsonText(restoredBody);
  const headerArgs = Object.entries(headers)
    .filter(([k, v]) => String(k).trim() && v !== undefined && v !== null)
    .map(([k, v]) => `-H ${shellSingleQuote(`${k}: ${v}`)}`)
    .join(' \\\n  ');

  const methodFromLog = String(detail.httpMethod ?? '').trim().toUpperCase();
  const pathLower = (path ?? '').trim().toLowerCase();
  const looksLikeModelsList = pathLower === 'v1/models' || pathLower.endsWith('/models') || pathLower.endsWith('models');
  const inferredMethod = methodFromLog || (!bodyPretty && looksLikeModelsList ? 'GET' : 'POST');

  const dataArg = inferredMethod === 'GET' ? '' : bodyPretty ? ` \\\n  --data-raw ${shellSingleQuote(bodyPretty)}` : '';

  return `curl -X ${inferredMethod} ${shellSingleQuote(url)} \\\n  ${headerArgs}${dataArg}`;
}

// rawSse 已移除：管理后台仅展示最终 AnswerText 与统计信息

/**
 * NewsMarquee - 简化版预览文本组件
 *
 * 之前使用 CSS 跑马灯动画，但超长文本会导致与 backdrop-filter（液态玻璃）
 * 产生 GPU 合成层冲突，造成页面闪烁。现改为纯静态 ellipsis 截断。
 */
function NewsMarquee({
  text,
  title,
  align = 'left',
  style,
  className,
}: {
  text: string;
  title?: string;
  align?: 'left' | 'right';
  style?: React.CSSProperties;
  className?: string;
}) {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();

  return (
    <div
      className={className}
      title={title || normalized}
      style={{
        minWidth: 0,
        width: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: align,
        ...style,
      }}
    >
      {normalized || '—'}
    </div>
  );
}

function PreviewTickerRow({ it }: { it: LlmRequestLogListItem }) {
  const external = isExternalCurlOp(it);
  const url = inferListItemUrl(it);

  const q = external ? url : (it.questionPreview ?? '').trim();
  const a = (it.answerPreview ?? '').trim();
  const ttfb = diffMs(it.startedAt, it.firstByteAt ?? null);
  const rightText =
    it.durationMs
      ? `${fmtMsSmart(it.durationMs)}${ttfb !== null ? ` · TTFB ${fmtMsSmart(ttfb)}` : ''}`
      : ttfb !== null
        ? `TTFB ${fmtMsSmart(ttfb)}`
        : formatLocalTime(it.startedAt);

  return (
    <div
      className="mt-2 rounded-[12px] px-3 py-2"
      style={{
        border: '1px solid rgba(231,206,151,0.18)',
        background: 'rgba(231,206,151,0.045)',
      }}
    >
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: '2fr 3fr 1fr' }}>
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[11px] font-semibold shrink-0 flex items-center gap-1" style={{ color: '#E7CE97' }}>
            <HelpCircle size={12} />
            {external ? '请求' : '问题'}
          </span>
          <div className="min-w-0 flex-1 text-[11px]">
            <NewsMarquee text={q ? `：${q}` : external ? '：未记录（URL 缺失）' : '：未记录（已脱敏）'} />
          </div>
        </div>

        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[11px] font-semibold shrink-0 flex items-center gap-1" style={{ color: '#E7CE97', opacity: 0.9 }}>
            <Reply size={12} />
            {external ? '响应' : '回答'}
          </span>
          <div className="min-w-0 flex-1 text-[11px]">
            <NewsMarquee text={a ? `：${a}` : it.status === 'running' ? '：生成中…' : '：未记录'} />
          </div>
        </div>

        <div className="min-w-0 text-right text-[11px] truncate" style={{ color: 'rgba(231,206,151,0.75)' }}>
          {rightText}
        </div>
      </div>
    </div>
  );
}

export function LlmLogsPanel({ embedded, defaultAppKey, customApis }: {
  embedded?: boolean;
  defaultAppKey?: string;
  /** 可选自定义 API 函数，用于应用身份隔离（如 visual-agent 使用域内日志端点） */
  customApis?: {
    getLogs?: typeof getLlmLogs;
    getMeta?: typeof getLlmLogsMeta;
    getDetail?: typeof getLlmLogDetail;
  };
} = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'llm') as 'llm' | 'system';

  const setTab = (next: 'llm' | 'system') => {
    if (embedded) return; // 嵌入模式下不支持切换 tab
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LlmRequestLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [answerView, setAnswerView] = useState<'preview' | 'raw'>('preview');
  const [answerVisibleChars, setAnswerVisibleChars] = useState(false);
  const [answerHint, setAnswerHint] = useState<string>('');
  const [jsonCheckPhase, setJsonCheckPhase] = useState<'idle' | 'scanning' | 'passed' | 'failed'>('idle');
  const jsonCheckLastRef = useRef<{ ok: boolean; reason?: string } | null>(null);

  const [qModel, setQModel] = useState(() => searchParams.get('model') ?? '');
  const [qStatus, setQStatus] = useState(() => searchParams.get('status') ?? '');
  const [qRequestId, setQRequestId] = useState(() => searchParams.get('requestId') ?? '');
  const [qGroupId, setQGroupId] = useState(() => searchParams.get('groupId') ?? '');
  const [qSessionId, setQSessionId] = useState(() => searchParams.get('sessionId') ?? '');
  const [qUserId, setQUserId] = useState(() => searchParams.get('userId') ?? '');
  const [qRequestPurpose, setQRequestPurpose] = useState(() => defaultAppKey ?? searchParams.get('requestPurpose') ?? '');

  const [metaModels, setMetaModels] = useState<string[]>([]);
  const [metaRequestPurposes, setMetaRequestPurposes] = useState<LlmLogsMetaRequestPurpose[]>([]);
  const [metaStatuses, setMetaStatuses] = useState<string[]>(['running', 'succeeded', 'failed', 'cancelled']);
  const [metaUsers, setMetaUsers] = useState<LlmLogsMetaUser[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<LlmRequestLog | null>(null);
  const [allowedSizesByLogId, setAllowedSizesByLogId] = useState<Record<string, string[]>>({});
  const [allowedSizesLoadingId, setAllowedSizesLoadingId] = useState<string | null>(null);
  const [copiedHint, setCopiedHint] = useState<string>('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptToken, setPromptToken] = useState<string>('');
  const [tokenPreviewKind, setTokenPreviewKind] = useState<'system' | 'prd'>('system');
  const [tokenPreviewLoading, setTokenPreviewLoading] = useState(false);
  const [tokenPreviewError, setTokenPreviewError] = useState('');
  const [tokenPreviewText, setTokenPreviewText] = useState('');
  const [tokenPreviewTitle, setTokenPreviewTitle] = useState('');
  const [prdCache, setPrdCache] = useState<Record<string, { title: string; content: string }>>({});

  const [, setArtifactsLoading] = useState(false);
  const [, setArtifactsError] = useState<string>('');
  const [artifacts, setArtifacts] = useState<UploadArtifact[]>([]);
  const artifactsRidRef = useRef<string>('');

  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const autoRefreshTimerRef = useRef<number | null>(null);

  const resetJsonCheck = () => {
    jsonCheckLastRef.current = null;
    setJsonCheckPhase('idle');
  };

  const openTokenPreview = async (token: string) => {
    const t = String(token ?? '').trim();
    if (!t) return;

    setPromptToken(t);
    setPromptOpen(true);
    setTokenPreviewError('');
    setTokenPreviewLoading(false);

    // PRD token：按需拉取原文（后台管理员可读）
    if (PRD_TOKENS.has(t)) {
      setTokenPreviewKind('prd');
      setTokenPreviewTitle('PRD 原文');
      const groupId = String(detail?.groupId ?? '').trim();
      const documentId = String(detail?.documentHash ?? '').trim();
      if (!groupId || !documentId) {
        setTokenPreviewText('');
        setTokenPreviewError('缺少 groupId/documentHash，无法拉取 PRD 原文（该日志可能不是 chat 请求）');
        return;
      }

      const cacheKey = `${groupId}:${documentId}`;
      const cached = prdCache[cacheKey];
      if (cached?.content) {
        setTokenPreviewTitle(`PRD 原文：${cached.title || documentId}`);
        setTokenPreviewText(cached.content);
        return;
      }

      setTokenPreviewLoading(true);
      setTokenPreviewText('');
      try {
        const res = await getAdminDocumentContent(documentId, { groupId });
        if (res.success) {
          const title = String(res.data.title ?? '').trim() || documentId;
          const content = String(res.data.content ?? '');
          setPrdCache((prev) => ({ ...prev, [cacheKey]: { title, content } }));
          setTokenPreviewTitle(`PRD 原文：${title}`);
          setTokenPreviewText(content);
        } else {
          setTokenPreviewError(res.error?.message || '拉取 PRD 原文失败');
        }
      } catch (e) {
        setTokenPreviewError(String((e as any)?.message || e || '拉取 PRD 原文失败'));
      } finally {
        setTokenPreviewLoading(false);
      }
      return;
    }

    // 默认：system prompt 预览
    setTokenPreviewKind('system');
    setTokenPreviewTitle('System Prompt');
    setTokenPreviewText((detail?.systemPromptText ?? '').trim());
  };

  useEffect(() => {
    const rid = (detail?.requestId ?? '').trim();
    if (!rid) {
      artifactsRidRef.current = '';
      setArtifacts([]);
      setArtifactsError('');
      setArtifactsLoading(false);
      return;
    }

    artifactsRidRef.current = rid;
    setArtifactsLoading(true);
    setArtifactsError('');
    void (async () => {
      try {
        const res = await listUploadArtifacts({ requestId: rid, limit: 200 });
        if (artifactsRidRef.current !== rid) return;
        if (res.success) {
          setArtifacts(Array.isArray(res.data.items) ? res.data.items : []);
        } else {
          setArtifacts([]);
          setArtifactsError(res.error?.message || '加载失败');
        }
      } catch (e) {
        if (artifactsRidRef.current !== rid) return;
        setArtifacts([]);
        setArtifactsError(String((e as any)?.message || e || '加载失败'));
      } finally {
        if (artifactsRidRef.current === rid) setArtifactsLoading(false);
      }
    })();
  }, [detail?.requestId]);

  const load = async (opts?: { resetPage?: boolean }) => {
    if (opts?.resetPage) setPage(1);
    setLoading(true);
    try {
      if (!embedded) {
        const sp = new URLSearchParams(searchParams);
        sp.delete('provider');
        sp.set('model', qModel || '');
        sp.set('status', qStatus || '');
        sp.set('requestId', qRequestId || '');
        sp.set('groupId', qGroupId || '');
        sp.set('sessionId', qSessionId || '');
        sp.set('userId', qUserId || '');
        sp.set('requestPurpose', qRequestPurpose || '');
        // 清理空参数（保持 URL 干净）
        ['model', 'status', 'requestId', 'groupId', 'sessionId', 'userId', 'requestPurpose'].forEach((k) => {
          if (!String(sp.get(k) ?? '').trim()) sp.delete(k);
        });
        setSearchParams(sp, { replace: true });
      }

      const fetchLogs = customApis?.getLogs ?? getLlmLogs;
      const res = await fetchLogs({
        page: opts?.resetPage ? 1 : page,
        pageSize,
        model: qModel || undefined,
        status: qStatus || undefined,
        requestId: qRequestId || undefined,
        groupId: qGroupId || undefined,
        sessionId: qSessionId || undefined,
        userId: qUserId || undefined,
        requestPurpose: qRequestPurpose || undefined,
      });
      if (res.success) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) {
      setSelectedId(id);
      setDetailLoading(true);
      setDetail(null);
      setCopiedHint('');
      setAnswerVisibleChars(false);
      resetJsonCheck();
    }
    try {
      const fetchDetail = customApis?.getDetail ?? getLlmLogDetail;
      const res = await fetchDetail(id);
      if (res.success) setDetail(res.data);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!selectedId) return;
    await loadDetail(selectedId, true);
  }, [selectedId, loadDetail]);

  const ensureAllowedSizes = async (logId: string) => {
    const existing = allowedSizesByLogId[logId];
    if (existing && existing.length) return existing;
    if (allowedSizesLoadingId === logId) return [];
    setAllowedSizesLoadingId(logId);
    try {
      const fetchDetail2 = customApis?.getDetail ?? getLlmLogDetail;
      const res = await fetchDetail2(logId);
      if (!res.success) return [];
      const sizes = extractAllowedSizesFromAnswerText((res.data?.answerText ?? '') as any);
      setAllowedSizesByLogId((p) => ({ ...p, [logId]: sizes }));
      return sizes;
    } finally {
      setAllowedSizesLoadingId((cur) => (cur === logId ? null : cur));
    }
  };

  useEffect(() => {
    return () => {
      if (autoRefreshTimerRef.current) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // 下拉筛选框变更时自动触发筛选（重置到第 1 页）
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    load({ resetPage: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qModel, qStatus, qRequestPurpose, qUserId]);

  useEffect(() => {
    if (autoRefreshTimerRef.current) {
      window.clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }

    if (!detailOpen || !detail || !selectedId) {
      setAutoRefreshing(false);
      return;
    }

    const status = (detail.status ?? '').toLowerCase().trim();
    if (status !== 'running') {
      setAutoRefreshing(false);
      return;
    }

    setAutoRefreshing(true);
    const scheduleNext = () => {
      autoRefreshTimerRef.current = window.setTimeout(async () => {
        await refreshDetail();
        if (detailOpen && selectedId) {
          scheduleNext();
        }
      }, 2000);
    };
    scheduleNext();

    return () => {
      if (autoRefreshTimerRef.current) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [detailOpen, detail?.status, selectedId, refreshDetail]);

  useEffect(() => {
    (async () => {
      const fetchMeta = customApis?.getMeta ?? getLlmLogsMeta;
      const res = await fetchMeta();
      if (res.success) {
        setMetaModels(res.data.models ?? []);
        setMetaRequestPurposes(res.data.requestPurposes ?? []);
        setMetaStatuses(res.data.statuses ?? ['running', 'succeeded', 'failed', 'cancelled']);
        setMetaUsers(res.data.users ?? []);
      }
    })();
  }, []);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);
  const answerText = useMemo(() => (detail?.answerText ?? '').trim(), [detail]);
  const answerHasUnicodeEscapes = useMemo(() => /\\u[0-9a-fA-F]{4}/.test(answerText), [answerText]);
  const answerDisplayText = useMemo(
    () => (answerVisibleChars ? decodeEscapedTextForDisplay(answerText) : answerText),
    [answerVisibleChars, answerText]
  );
  const imageGenUpstream = useMemo(() => extractImageGenUpstreamPreviewFromAnswerText(detail?.answerText ?? ''), [detail?.answerText]);
  const artifactsSorted = useMemo(() => {
    const arr = Array.isArray(artifacts) ? artifacts.slice() : [];
    arr.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    return arr;
  }, [artifacts]);
  const artifactInputs = useMemo(() => artifactsSorted.filter((x) => String(x.kind).toLowerCase() === 'input_image'), [artifactsSorted]);
  const artifactOutputs = useMemo(() => artifactsSorted.filter((x) => String(x.kind).toLowerCase() === 'output_image'), [artifactsSorted]);
  const isImageGenRequest = useMemo(() => {
    const v = normalizeRequestType(detail?.requestType);
    return v === 'generation' || v === 'imagegen' || v === 'image_gen' || v === 'image-generate';
  }, [detail?.requestType]);
  const hasLogImages = (detail?.inputImages?.length ?? 0) > 0 || (detail?.outputImages?.length ?? 0) > 0;
  const isImageLikeLog = isImageGenRequest || hasLogImages || typeof detail?.imageSuccessCount === 'number';
  const prettyRequestBody = useMemo(() => {
    if (!detail) return '';
    let restored = restoreTruncatedRequestBody(detail.requestBodyRedacted || '', detail.systemPromptText, detail.questionText);
    restored = injectRefImageIntoRequestBody(restored, artifactInputs);
    return tryPrettyJsonText(restored);
  }, [detail, artifactInputs]);
  const curlText = useMemo(() => (detail ? buildCurlFromLog(detail, artifactInputs) : ''), [detail, artifactInputs]);
  useEffect(() => {
    // 内容不再包含 \uXXXX 时，自动关闭“可见字符”避免误解
    if (!answerHasUnicodeEscapes && answerVisibleChars) setAnswerVisibleChars(false);
  }, [answerHasUnicodeEscapes, answerVisibleChars]);

  const statusBadge = (s: string) => {
    const v = (s || '').toLowerCase();
    if (v === 'succeeded') return <Badge variant="success" size="sm" icon={<CheckCircle size={10} />}>成功</Badge>;
    if (v === 'failed') return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>失败</Badge>;
    if (v === 'running') return <Badge variant="subtle" size="sm" icon={<Loader2 size={10} className="animate-spin" />}>进行中</Badge>;
    if (v === 'cancelled') return <Badge variant="subtle" size="sm" icon={<StopCircle size={10} />}>已取消</Badge>;
    return <Badge variant="subtle" size="sm">{s || '-'}</Badge>;
  };

  const statusRowStyle = (s: string): { container: React.CSSProperties; value: React.CSSProperties } => {
    const v = (s || '').toLowerCase().trim();
    if (v === 'failed') {
      return {
        container: { border: '1px solid rgba(239, 68, 68, 0.38)', background: 'rgba(239, 68, 68, 0.08)' },
        value: { color: 'rgba(239, 68, 68, 0.95)' },
      };
    }
    if (v === 'succeeded') {
      return {
        container: { border: '1px solid rgba(34, 197, 94, 0.38)', background: 'rgba(34, 197, 94, 0.08)' },
        value: { color: 'rgba(34, 197, 94, 0.95)' },
      };
    }
    if (v === 'running') {
      return {
        container: { border: '1px solid rgba(59, 130, 246, 0.38)', background: 'rgba(59, 130, 246, 0.08)' },
        value: { color: 'rgba(147, 197, 253, 0.98)' },
      };
    }
    if (v === 'cancelled') {
      return {
        container: { border: '1px solid rgba(148, 163, 184, 0.30)', background: 'rgba(148, 163, 184, 0.06)' },
        value: { color: 'rgba(148, 163, 184, 0.95)' },
      };
    }
    return { container: {}, value: {} };
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  const tabs = [
    { key: 'llm' as const, label: '大模型日志', icon: <Sparkles size={14} /> },
    { key: 'system' as const, label: '系统日志', icon: <Server size={14} /> },
  ];

  if (tab === 'system' && !embedded) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-4">
        <TabBar
          items={tabs}
          activeKey={tab}
          onChange={(key) => setTab(key as 'llm' | 'system')}
        />
        <div className="flex-1 min-h-0">
          <SystemLogsTab />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {!embedded && (
        <TabBar
          items={tabs}
          activeKey={tab}
          onChange={(key) => setTab(key as 'llm' | 'system')}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQModel('');
                  setQStatus('');
                  setQRequestId('');
                  setQUserId('');
                  setQGroupId('');
                  setQSessionId('');
                  setQRequestPurpose('');
                  setPage(1);
                  setTimeout(() => load({ resetPage: true }), 0);
                }}
                disabled={loading}
              >
                <Eraser size={16} />
                清空
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => load()}
                disabled={loading}
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                刷新
              </Button>
            </div>
          }
        />
      )}

      <GlassCard glow className="p-4">
        <div className="grid gap-3 grid-cols-4 md:grid-cols-8">
          <SearchableSelect
            value={qModel}
            onValueChange={setQModel}
            options={[
              { value: '', label: '模型' },
              ...metaModels.map((m) => ({ value: m, label: m })),
            ]}
            placeholder="模型"
            leftIcon={<Database size={16} />}
            uiSize="sm"
            style={inputStyle}
          />
          <Select
            value={qStatus}
            onChange={(e) => setQStatus(e.target.value)}
            uiSize="sm"
            style={inputStyle}
            leftIcon={<CheckCircle size={16} />}
          >
            <option value="">状态</option>
            {metaStatuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
          <SearchableSelect
            value={qRequestPurpose}
            onValueChange={setQRequestPurpose}
            options={[
              { value: '', label: '应用' },
              ...metaRequestPurposes.map((rp) => ({ value: rp.value, label: rp.displayName })),
            ]}
            placeholder="应用"
            leftIcon={<Zap size={16} />}
            uiSize="sm"
            style={inputStyle}
          />
          <SearchableSelect
            value={qUserId}
            onValueChange={setQUserId}
            options={[
              { value: '', label: '用户' },
              ...metaUsers.map((u) => ({
                value: u.userId,
                label: u.username ? `${u.username} / ${u.userId}` : u.userId,
                displayLabel: u.username || u.userId,
              })),
            ]}
            placeholder="用户"
            leftIcon={<Users size={16} />}
            uiSize="sm"
            style={inputStyle}
          />
          <div className="relative">
            <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qGroupId}
              onChange={(e) => setQGroupId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="groupId"
            />
          </div>
          <div className="relative">
            <Clock size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qSessionId}
              onChange={(e) => setQSessionId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="sessionId"
            />
          </div>
          <div className="relative">
            <Hash size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qRequestId}
              onChange={(e) => setQRequestId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="requestId"
            />
          </div>
        </div>
      </GlassCard>

      <GlassCard glow className="p-0 overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="divide-y divide-white/10">
          {loading ? (
            <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>暂无日志</div>
          ) : (
            items.map((it) => {
              const active = selectedId === it.id;
              const ttfb = diffMs(it.startedAt, it.firstByteAt ?? null);
              const external = isExternalCurlOp(it);
              const url = inferListItemUrl(it);
              const pm = resolvePlatformAndModel(it.platformName, it.model, it.provider);
              // external 和 url 用于 PreviewTickerRow 显示
              void external; void url;
              return (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setDetailOpen(true);
                    loadDetail(it.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setDetailOpen(true);
                      loadDetail(it.id);
                    }
                  }}
                  className="px-4 py-3 cursor-pointer hover:bg-white/2"
                  style={{
                    background: active ? 'rgba(255,255,255,0.03)' : 'transparent',
                  }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      {/* 第一部分：状态 + 应用信息 + appCallerCode */}
                      <div className="flex items-center gap-2 min-w-0">
                        {statusBadge(it.status)}
                        {/* 功能描述（中文标题）- 直接使用后端返回的 displayName */}
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {it.requestPurposeDisplayName || it.requestPurpose || '未知'}
                        </div>
                        {/* appCallerCode 标签，悬浮显示全文 */}
                        {it.requestPurpose && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 cursor-help"
                            style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                            title={it.requestPurpose}
                          >
                            <AppCallerKeyIcon size={10} className="opacity-60" />
                            {it.requestPurpose}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs truncate flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <Hash size={12} />
                        <span>
                          requestId: {it.requestId}
                          {it.groupId ? ` · groupId: ${it.groupId}` : ''}
                          {it.sessionId ? ` · sessionId: ${it.sessionId}` : ''}
                        </span>
                      </div>
                      {/* 第三部分：大模型匹配信息 */}
                      <div className="mt-1 flex items-center gap-2 min-w-0">
                        {/* 模型池标签：专属模型池 / 默认模型池 / 直连单模型（三者互斥） */}
                        {(() => {
                          const groupName = (it.modelGroupName || '').trim();
                          // modelResolutionType: 0=直连单模型, 1=默认模型池, 2=专属模型池
                          // 后端使用 JsonStringEnumConverter，枚举会序列化为字符串名称（如 "DedicatedPool"）
                          const raw = it.modelResolutionType as unknown;
                          const resolutionType =
                            raw === 'DirectModel' || raw === 0 ? 0 :
                            raw === 'DefaultPool' || raw === 1 ? 1 :
                            raw === 'DedicatedPool' || raw === 2 ? 2 :
                            (raw == null ? 0 : -1); // null/undefined 默认为直连单模型，其他未知值为 -1
                          const b = requestTypeToBadge(it.requestType);

                          if (resolutionType === 0) {
                            // 直连单模型
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0 hover:opacity-80 transition-opacity"
                                title="直连单模型（点击跳转到模型管理）"
                                style={{
                                  background: 'rgba(156, 163, 175, 0.12)',
                                  border: '1px solid rgba(156, 163, 175, 0.28)',
                                  color: 'rgba(156, 163, 175, 0.95)'
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = '/mds?tab=models';
                                }}
                              >
                                <Zap size={10} />
                                直连单模型
                              </button>
                            );
                          } else if (resolutionType === 1) {
                            // 默认模型池
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0 hover:opacity-80 transition-opacity"
                                title={`默认模型池：${groupName}（点击跳转到模型池管理）`}
                                style={requestTypeChipStyle(b.tone)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = '/mds?tab=pools';
                                }}
                              >
                                {b.icon}
                                默认模型池：{groupName}
                              </button>
                            );
                          } else if (resolutionType === 2) {
                            // 专属模型池
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0 hover:opacity-80 transition-opacity"
                                title={`专属模型池：${groupName}（点击跳转到模型池管理）`}
                                style={{
                                  background: 'rgba(59, 130, 246, 0.12)',
                                  border: '1px solid rgba(59, 130, 246, 0.28)',
                                  color: 'rgba(59, 130, 246, 0.95)'
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = '/mds?tab=pools';
                                }}
                              >
                                <Layers size={10} />
                                专属模型池：{groupName}
                              </button>
                            );
                          } else {
                            // 兜底：显示默认标签
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0 hover:opacity-80 transition-opacity"
                                title={`默认${b.label}（点击跳转到应用配置）`}
                                style={requestTypeChipStyle(b.tone)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = '/mds?tab=apps';
                                }}
                              >
                                {b.icon}
                                默认{b.label}
                              </button>
                            );
                          }
                        })()}
                        {/* 模型降级标签 */}
                        {it.isFallback ? (
                          <label
                            className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0"
                            title={it.expectedModel ? `期望模型 ${it.expectedModel}，实际使用 ${it.model}` : '模型池回退'}
                            style={{ background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.30)', color: 'rgba(245, 158, 11, 0.95)' }}
                          >
                            <RefreshCw size={10} />
                            已降级
                          </label>
                        ) : null}
                        {(() => {
                          const hint = extractImageSizeAdjustmentHint(it);
                          if (!hint) return null;
                          const title = hint.from && hint.to ? `智能尺寸替换：${hint.from} → ${hint.to}` : '智能尺寸替换';
                          const text = hint.ratioAdjusted ? '比例已微调' : '尺寸替换';
                          return (
                            <label
                              className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0"
                              title={title}
                              style={{ background: 'rgba(168, 85, 247, 0.10)', border: '1px solid rgba(168, 85, 247, 0.22)', color: 'rgba(168, 85, 247, 0.95)' }}
                            >
                              <ImagePlus size={12} />
                              {text}
                            </label>
                          );
                        })()}
                        {(() => {
                          // 注意：requestPurpose 是“用途/功能点”（如 chat.sendMessage），不是模型标识。
                          // 这里应展示 modelId（按全局契约：仅展示 modelId；不要默认展示 name/displayName）。
                          // 兼容：部分历史/接口可能仍使用 model 字段承载 modelId。
                          const modelId = String((it as any).modelId ?? it.model ?? '').trim();
                          const platformName = it.platformName || pm.platform;
                          if (!modelId && !platformName) return null;
                          return (
                            <div className="inline-flex items-center gap-1.5 min-w-0">
                              {platformName && <PlatformLabel name={platformName} />}
                              {modelId && (
                                <span
                                  className="text-[11px] font-semibold truncate"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title={modelId}
                                >
                                  {modelId}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        {(() => {
                          // 你提到的 DOM Path 对应的就是这个容器：这里用“明文”把本次替换写出来，并提供下拉展开查看全部尺寸
                          const hint = extractImageSizeAdjustmentHint(it);
                          if (!hint?.from || !hint?.to) return null;
                          const txt = `${hint.ratioAdjusted ? '比例已微调' : '本次尺寸替换'}：${hint.from} → ${hint.to}`;
                          const sizes = allowedSizesByLogId[it.id] ?? [];
                          return (
                            <DropdownMenu.Root
                              onOpenChange={(open) => {
                                if (!open) return;
                                void ensureAllowedSizes(it.id);
                              }}
                            >
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  className="min-w-0 text-[11px] font-semibold truncate inline-flex items-center gap-1"
                                  style={{ color: 'rgba(168, 85, 247, 0.95)' }}
                                  title={txt}
                                  onClick={(e) => e.stopPropagation()}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <span className="truncate">{txt}</span>
                                  <ChevronDown size={12} className="shrink-0 opacity-90" />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  side="bottom"
                                  align="start"
                                  sideOffset={8}
                                  className="rounded-[12px] p-2 min-w-[260px] max-w-[520px]"
                                  style={{
                                    zIndex: 120,
                                    background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
                                    border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
                                    boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
                                    backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                                    WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                                    允许尺寸（白名单）
                                  </div>
                                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    {allowedSizesLoadingId === it.id ? '加载中…' : sizes.length ? `${sizes.length} 个` : '暂无（可能是旧日志或尚未学习）'}
                                  </div>
                                  {sizes.length ? (
                                    <div
                                      className="mt-2 rounded-[10px] p-2"
                                      style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.02)', maxHeight: 220, overflow: 'auto' }}
                                    >
                                      <div className="flex flex-wrap gap-1.5">
                                        {sizes.map((s, idx) => (
                                          <span
                                            key={`${s}-${idx}`}
                                            className="inline-flex items-center rounded-[10px] px-2 py-1 text-[11px] font-semibold"
                                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.18)' }}
                                            title={s}
                                          >
                                            {s}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ) : null}
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {it.durationMs ? `${it.durationMs}ms` : '-'}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {formatLocalTime(it.startedAt)}
                        {ttfb !== null ? ` · TTFB ${ttfb}ms` : ''}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        in {it.inputTokens ?? '-'} / out {it.outputTokens ?? '-'}
                      </div>
                      {(it.cacheReadInputTokens || it.cacheCreationInputTokens) ? (
                        <div className="mt-1 text-[11px]" style={{ color: 'rgba(34,197,94,0.95)' }}>
                          cache read {it.cacheReadInputTokens ?? 0} · create {it.cacheCreationInputTokens ?? 0}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {/* 底部：问题/回答滚动条（新闻样式） */}
                  <PreviewTickerRow it={it} />
                  {it.error ? (
                    <div
                      className="mt-2 rounded-[12px] px-3 py-2 text-xs flex items-start gap-2 min-w-0"
                      style={{
                        background: 'rgba(239,68,68,0.06)',
                        border: '1px solid rgba(239,68,68,0.18)',
                        color: 'rgba(239,68,68,0.95)',
                      }}
                    >
                      <XCircle size={14} className="shrink-0 mt-[1px]" />
                      <div className="min-w-0 break-words" style={{ wordBreak: 'break-word' }}>
                        {it.error}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="p-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
            上一页
          </Button>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{page}/{totalPages}</div>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
            下一页
          </Button>
          </div>
        </div>
      </GlassCard>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetail(null);
            setSelectedId(null);
            setCopiedHint('');
            setAnswerView('preview');
            setAnswerHint('');
            resetJsonCheck();
            setPromptOpen(false);
            setPromptToken('');
          }
        }}
        title="LLM 请求详情"
        description={detail ? (joinBaseAndPath(detail.apiBase ?? '', detail.path ?? '') || '—') : '点击列表项查看详情'}
        maxWidth={1500}
        contentStyle={{ height: '82vh' }}
        content={
          detailLoading ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>加载详情...</div>
          ) : !detail ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无详情</div>
          ) : (
            <div className="h-full min-h-0 grid gap-3 md:grid-cols-2">
              <GlassCard glow className="p-3 overflow-hidden flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Request（密钥已隐藏）</div>
                  <div className="flex items-center gap-2">
                    {copiedHint ? (
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{copiedHint}</div>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        try {
                          // 检测是否需要后端恢复 base64 图片
                          if (detail && needsBackendReplayCurl(detail.requestBodyRedacted)) {
                            setCopiedHint('正在从 COS 恢复完整内容...');
                            try {
                              const resp = await getReplayCurl(detail.id);
                              if (resp.success && resp.data?.curl) {
                                await navigator.clipboard.writeText(resp.data.curl);
                                const parts: string[] = [];
                                if (resp.data.imageCount) parts.push(`${resp.data.imageCount} 张图片`);
                                if (resp.data.textCount) parts.push(`${resp.data.textCount} 段文本`);
                                const detail_str = parts.length > 0 ? `（已恢复 ${parts.join('、')}）` : '';
                                const warn = resp.data.warning ? ` (${resp.data.warning})` : '';
                                setCopiedHint(`curl 已复制${detail_str}${warn}`);
                                setTimeout(() => setCopiedHint(''), 2500);
                                return;
                              }
                            } catch {
                              // 后端恢复失败，降级到本地 curl
                            }
                          }
                          await navigator.clipboard.writeText(curlText || '');
                          setCopiedHint('curl 已复制');
                          setTimeout(() => setCopiedHint(''), 1200);
                        } catch {
                          setCopiedHint('复制失败（浏览器权限）');
                          setTimeout(() => setCopiedHint(''), 2000);
                        }
                      }}
                      disabled={!detail || !curlText}
                    >
                      <Copy size={16} />
                      复制 curl
                    </Button>
                  </div>
                </div>
                <div className="mt-1 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                  {[
                    { k: 'provider', v: detail.provider || '—' },
                    { k: 'model', v: detail.model || '—' },
                    { k: 'status', v: detail.status || '—' },
                    { k: 'requestId', v: detail.requestId || '—' },
                    { k: 'requestType', v: detail.requestType || '—' },
                    { k: 'acc', v: detail.requestPurpose || '—' },
                    { k: 'groupId', v: detail.groupId || '—' },
                    { k: 'sessionId', v: detail.sessionId || '—' },
                    { k: 'startedAt', v: formatLocalTime(detail.startedAt) },
                    { k: 'firstByteAt', v: formatLocalTime(detail.firstByteAt ?? null) },
                    { k: 'endedAt', v: formatLocalTime(detail.endedAt ?? null) },
                    {
                      k: 'time',
                      v: (() => {
                        const ttfb = diffMs(detail.startedAt, detail.firstByteAt ?? null);
                        const total =
                          typeof detail.durationMs === 'number'
                            ? detail.durationMs
                            : diffMs(detail.startedAt, detail.endedAt ?? null);
                        return `首字延时 ${fmtMsSmart(ttfb)} · 总时长 ${fmtMsSmart(total)}`;
                      })(),
                    },
                  ].map((row) => {
                    const isStatus = row.k === 'status';
                    const ss = isStatus ? statusRowStyle(String(row.v ?? '')) : null;
                    return (
                      <div
                        key={row.k}
                        className="rounded-[12px] px-2.5 py-1.5 min-w-0"
                        style={{
                          border: '1px solid var(--border-subtle)',
                          background: 'rgba(255,255,255,0.02)',
                          minWidth: 0,
                          ...(ss?.container ?? {}),
                        }}
                      >
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {row.k}
                        </div>
                        <NewsMarquee
                          align="right"
                          text={String(row.v ?? '—')}
                          title={String(row.v ?? '')}
                          className="flex-1 min-w-0"
                          style={{
                            color: 'var(--text-secondary)',
                            fontSize: 12,
                            lineHeight: '1.2',
                            fontWeight: 700,
                            fontFamily:
                              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
                            ...(ss?.value ?? {}),
                          }}
                        />
                      </div>
                      </div>
                    );
                  })}
                </div>
                {detail.isFallback ? (
                  <div className="mt-2 rounded-[10px] px-3 py-2" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)' }}>
                    <div className="text-[12px] font-semibold" style={{ color: 'rgba(245, 158, 11, 0.95)' }}>模型已降级</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'rgba(245, 158, 11, 0.75)' }}>
                      {detail.expectedModel ? `期望: ${detail.expectedModel} → 实际: ${detail.model}` : ''}
                      {detail.fallbackReason ? ` · ${detail.fallbackReason}` : ''}
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3">
                  <div>
                    {(() => {
                      const raw = detail.requestBodyRedacted || '';
                      const isTruncated = Boolean(detail.requestBodyTruncated) || raw.includes('[TRUNCATED]');
                      const orig = detail.requestBodyChars ?? null;
                      const stored = raw.length;
                      const hint = isTruncated ? `（已截断：stored ${stored}${orig != null ? ` / original ${orig}` : ''} chars）` : `（${stored} chars）`;
                      return (
                        <div className="text-xs mb-2 flex items-center justify-between gap-2" style={{ color: 'var(--text-muted)' }}>
                          <span>body</span>
                          <span className={isTruncated ? 'text-[11px] font-semibold' : 'text-[11px]'} style={{ color: isTruncated ? 'rgba(255, 160, 160, 0.95)' : 'var(--text-muted)' }}>
                            {hint}
                          </span>
                        </div>
                      );
                    })()}
                    <BodyWithPromptTokens
                      text={prettyRequestBody || ''}
                      onTokenClick={(token) => {
                        void openTokenPreview(token);
                      }}
                    />
                  </div>
                  <div>
                    {(() => {
                      const headersObj = { ...(detail.requestHeadersRedacted ?? {}) };
                      // 补回被脱敏移除的 auth 头，使用 Postman 环境变量占位符
                      const detailUrl = joinBaseAndPath(detail.apiBase ?? '', detail.path ?? '');
                      const detailDomain = extractDomainFromUrl(detailUrl);
                      const keyPlaceholder = detailDomain ? `{{${detailDomain}}}` : 'YOUR_API_KEY';
                      const pLower = (detail.provider ?? '').toLowerCase();
                      const isAnthropic = Object.keys(headersObj).some((k) => k.toLowerCase() === 'x-api-key')
                        || pLower.includes('claude') || pLower.includes('anthropic');
                      if (isAnthropic) {
                        headersObj['x-api-key'] = keyPlaceholder;
                      } else {
                        headersObj['Authorization'] = `Bearer ${keyPlaceholder}`;
                      }
                      const headerKeys = Object.keys(headersObj).length;
                      const headerChars = JSON.stringify(headersObj).length;
                      return (
                        <>
                          <div className="text-xs mb-2 flex items-center justify-between gap-2" style={{ color: 'var(--text-muted)' }}>
                            <span>headers</span>
                            <span className="text-[11px]">
                              {headerKeys} 项 · {headerChars} chars
                            </span>
                          </div>
                          <pre style={codeBoxStyle()}>{JSON.stringify(headersObj, null, 2)}</pre>
                        </>
                      );
                    })()}
                  </div>

                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      endpointChars: {(joinBaseAndPath(detail.apiBase ?? '', detail.path ?? '') || '').length || '—'}
                    </div>
                </div>
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {(() => {
                    const sysChars =
                      typeof detail.systemPromptChars === 'number'
                        ? detail.systemPromptChars
                        : (detail.systemPromptText ? detail.systemPromptText.length : null);
                    const docChars =
                      typeof detail.documentChars === 'number'
                        ? detail.documentChars
                        : inferDocumentCharsFromRequestBody(detail.requestBodyRedacted || '');
                    const userChars =
                      typeof detail.userPromptChars === 'number'
                        ? detail.userPromptChars
                        : inferUserPromptCharsFromRequestBody(detail.requestBodyRedacted || '');
                    const sysLabel = sysChars == null ? '—' : sysChars;
                    const docLabel =
                      docChars == null
                        ? (detail.documentHash ? '—（仅上报 hash）' : '—（未上报/无文档）')
                        : (typeof detail.documentChars === 'number' ? docChars : `${docChars}（推断）`);
                    const userLabel =
                      userChars == null
                        ? '—（未上报）'
                        : (typeof detail.userPromptChars === 'number' ? userChars : `${userChars}（推断）`);
                    return (
                      <>
                        系统提示词长度：{sysLabel} · PRD文档长度：{docLabel} · 用户提示词长度：{userLabel}
                      </>
                    );
                  })()}
                </div>
              </GlassCard>

              <GlassCard glow className="p-3 overflow-hidden flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold shrink-0" style={{ color: 'var(--text-primary)' }}>Response</div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <div className="flex items-center rounded-[8px] p-0.5" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                      <button
                        type="button"
                        onClick={() => setAnswerView('preview')}
                        className="h-7 px-2.5 rounded-[6px] text-[11px] font-semibold"
                        style={{
                          color: answerView === 'preview' ? 'var(--text-primary)' : 'var(--text-muted)',
                          background: answerView === 'preview' ? 'rgba(231,206,151,0.10)' : 'transparent',
                          border: answerView === 'preview' ? '1px solid rgba(231,206,151,0.22)' : '1px solid transparent',
                        }}
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        onClick={() => setAnswerView('raw')}
                        className="h-7 px-2.5 rounded-[6px] text-[11px] font-semibold"
                        style={{
                          color: answerView === 'raw' ? 'var(--text-primary)' : 'var(--text-muted)',
                          background: answerView === 'raw' ? 'rgba(231,206,151,0.10)' : 'transparent',
                          border: answerView === 'raw' ? '1px solid rgba(231,206,151,0.22)' : '1px solid transparent',
                        }}
                      >
                        Raw
                      </button>
                      {answerHasUnicodeEscapes ? (
                        <button
                          type="button"
                          onClick={() => setAnswerVisibleChars((v) => !v)}
                          className="h-7 px-2.5 rounded-[6px] text-[11px] font-semibold"
                          title="当内容包含 \\uXXXX 时，可一键转换为真实字符，避免 Raw 难以阅读"
                          style={{
                            color: answerVisibleChars ? 'var(--text-primary)' : 'var(--text-muted)',
                            background: answerVisibleChars ? 'rgba(231,206,151,0.10)' : 'transparent',
                            border: answerVisibleChars ? '1px solid rgba(231,206,151,0.22)' : '1px solid transparent',
                          }}
                        >
                          可见字符
                        </button>
                      ) : null}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-[11px] px-2.5"
                      onClick={async () => {
                        const text = answerDisplayText || '';
                        try {
                          await navigator.clipboard.writeText(text || '');
                          setCopiedHint('已复制');
                          setTimeout(() => setCopiedHint(''), 1200);
                        } catch {
                          setCopiedHint('复制失败（浏览器权限）');
                          setTimeout(() => setCopiedHint(''), 2000);
                        }
                      }}
                    >
                      <Copy size={12} />
                      复制
                    </Button>
                    <SuccessConfettiButton
                      title="对模型原始返回（Answer）做严格 JSON 校验"
                      size="sm"
                      style={
                        {
                          '--sa-h': '28px',
                          '--sa-radius': '8px',
                          '--sa-font': '11px',
                          '--sa-px': '10px',
                          '--sa-minw': '72px',
                        } as unknown as React.CSSProperties
                      }
                      readyText={jsonCheckPhase === 'failed' ? '不通过' : 'JSON检查'}
                      loadingText="检查中"
                      successText="通过"
                      showLoadingText
                      loadingMinMs={680}
                      completeMode="hold"
                      disabled={!((detail?.answerText ?? '').trim()) || jsonCheckPhase === 'passed'}
                      className={jsonCheckPhase === 'failed' ? 'llm-json-sa-failed' : jsonCheckPhase === 'passed' ? 'llm-json-sa-passed' : ''}
                      onAction={() => {
                        const raw = (detail?.answerText ?? '').trim();
                        const res = validateStrictJson(raw);
                        jsonCheckLastRef.current = res.ok ? { ok: true } : { ok: false, reason: res.reason };
                        return res.ok;
                      }}
                      onPhaseChange={(p) => {
                        if (p === 'loading') {
                          setJsonCheckPhase('scanning');
                          return;
                        }
                        if (p === 'complete') {
                          setJsonCheckPhase('passed');
                          setAnswerHint('扫描通过');
                          window.setTimeout(() => setAnswerHint(''), 1200);
                          return;
                        }
                        // 回到 ready（失败路径）：保持红色状态到弹窗关闭
                        if (p === 'ready') {
                          const last = jsonCheckLastRef.current;
                          if (last && last.ok === false) {
                            setJsonCheckPhase('failed');
                            setAnswerHint(`JSON 不合法：${last.reason || '未知原因'}`);
                            window.setTimeout(() => setAnswerHint(''), 2800);
                          } else {
                            setJsonCheckPhase('idle');
                          }
                        }
                      }}
                    />
                    {autoRefreshing ? (
                      <div className="flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" style={{ color: 'rgba(34,197,94,0.95)' }} />
                        <span className="text-[11px] font-semibold" style={{ color: 'rgba(34,197,94,0.95)' }}>
                          自动刷新中
                        </span>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 text-[11px] px-2.5"
                        onClick={refreshDetail}
                        disabled={!selectedId}
                        title="手动刷新详情"
                      >
                        <RefreshCw size={12} />
                        刷新
                      </Button>
                    )}
                  </div>
                </div>
                {!isImageLikeLog && (
                  <>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {(() => {
                        const s = (detail.tokenUsageSource ?? '').trim().toLowerCase();
                        const label = s === 'reported' ? '上游上报' : (s === 'estimated' ? '估算' : '未上报');
                        return <>Token统计来源：{label}</>;
                      })()}
                    </div>
                    <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                      {[
                        { k: 'Input tokens（输入）', v: fmtNum(detail.inputTokens) },
                        { k: 'Output tokens（输出）', v: fmtNum(detail.outputTokens) },
                        { k: 'Cache read（缓存命中读入）', v: fmtNum(detail.cacheReadInputTokens) },
                        { k: 'Cache create（缓存写入/创建）', v: fmtNum(detail.cacheCreationInputTokens) },
                        { k: 'Assembled chars（拼接字符数）', v: fmtNum(detail.assembledTextChars) },
                        { k: 'Assembled hash（拼接哈希）', v: (detail.assembledTextHash ?? '').trim() || '—' },
                      ].map((it) => (
                        <div
                          key={it.k}
                          className="rounded-[12px] px-3 py-2 min-w-0 overflow-hidden"
                          style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', minWidth: 0 }}
                        >
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {it.k}
                          </div>
                          <div className="mt-1 min-w-0">
                            <NewsMarquee
                              text={String(it.v ?? '—')}
                              title={String(it.v ?? '')}
                              style={{
                                color: 'var(--text-primary)',
                                fontSize: 14,
                                lineHeight: '1.2',
                                fontWeight: 700,
                                fontFamily:
                                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      说明：`—` 表示未上报/未知；`0` 表示真实为 0。
                    </div>
                  </>
                )}
                <div className={`${isImageLikeLog ? 'mt-2' : 'mt-3'} flex-1 min-h-0 overflow-auto`}>
                  {!isImageLikeLog && (
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>回答</div>
                      {answerHint ? (
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {answerHint}
                        </div>
                      ) : null}
                    </div>
                  )}

                  <div className="mt-3">
                    {(() => {
                      // 新日志优先使用 inputImages/outputImages；旧日志回退到 imageReferences/requestBody/artifacts。
                      const effInputs: { url: string; label: string; sha256?: string }[] = [];
                      const effOutputs: { url: string; label: string; sha256?: string; originalUrl?: string }[] = [];
                      const inputSeen = new Set<string>();
                      const outputSeen = new Set<string>();

                      const pushInput = (urlLike: string | null | undefined, label: string, sha256?: string) => {
                        const url = String(urlLike ?? '').trim();
                        if (!url || inputSeen.has(url)) return;
                        inputSeen.add(url);
                        effInputs.push({ url, label: label || '参考图', sha256: (sha256 ?? '').trim() || undefined });
                      };

                      const pushOutput = (urlLike: string | null | undefined, label: string, sha256?: string, originalUrl?: string) => {
                        const url = String(urlLike ?? '').trim();
                        if (!url || outputSeen.has(url)) return;
                        outputSeen.add(url);
                        effOutputs.push({
                          url,
                          label: label || '生成结果',
                          sha256: (sha256 ?? '').trim() || undefined,
                          originalUrl: (originalUrl ?? '').trim() || undefined,
                        });
                      };

                      // 1) 新字段（Worker 直写 COS URL）
                      if (Array.isArray(detail?.inputImages)) {
                        for (const img of detail!.inputImages!) {
                          pushInput(img.url, img.label || '参考图', img.sha256 ?? undefined);
                        }
                      }
                      if (Array.isArray(detail?.outputImages)) {
                        for (const img of detail!.outputImages!) {
                          pushOutput(img.url, img.label || '生成结果', img.sha256 ?? undefined, img.originalUrl ?? undefined);
                        }
                      }

                      // 2) 旧日志回退：requestBody/imageReferences
                      if (effInputs.length === 0) {
                        const restoredBody = restoreTruncatedRequestBody(
                          detail?.requestBodyRedacted || '',
                          detail?.systemPromptText,
                          detail?.questionText
                        );
                        const legacyInputs = resolveBodyInlineImages(detail?.imageReferences, restoredBody);
                        for (const img of legacyInputs) {
                          pushInput(img.url, img.label, img.sha256);
                        }
                      }

                      // 3) 旧日志回退：artifacts
                      if (effInputs.length === 0 && artifactInputs.length > 0) {
                        for (const img of artifactInputs) {
                          pushInput(img.cosUrl, '参考图', img.sha256);
                        }
                      }
                      if (effOutputs.length === 0 && artifactOutputs.length > 0) {
                        for (const img of artifactOutputs) {
                          pushOutput(img.cosUrl, '生成结果', img.sha256, undefined);
                        }
                      }

                      if (effInputs.length === 0 && effOutputs.length === 0) return null;

                      return (
                    <div className="mb-3">
                      <div className="rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                        {/* Prompt */}
                        <div className="text-[12px] mb-3" style={{ color: 'var(--text-secondary)' }}>
                          {(detail?.questionText ?? '').trim() || '（无提示词）'}
                        </div>
                        {/* Input ← → Output 始终双栏 */}
                        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'stretch' }}>
                          {/* ===== Input 参考图（左） ===== */}
                          <div style={{ minWidth: 0 }}>
                            <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Input</div>
                            {effInputs.length > 0 ? (
                              <div className="space-y-2">
                              {effInputs.map((img, idx) => (
                                <div key={`in-${idx}`} className="rounded-[12px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.18)' }}>
                                  <div className="px-3 py-1.5 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                    <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                      {img.label}{effInputs.length > 1 ? ` #${idx + 1}` : ''}
                                    </div>
                                    <Button variant="secondary" size="sm" onClick={async () => {
                                      try { await navigator.clipboard.writeText(img.url); setCopiedHint('已复制'); setTimeout(() => setCopiedHint(''), 1200); }
                                      catch { setCopiedHint('复制失败'); setTimeout(() => setCopiedHint(''), 2000); }
                                    }}>
                                      <Copy size={12} /> URL
                                    </Button>
                                  </div>
                                  <img src={img.url} alt={img.label} style={{ width: '100%', height: 200, objectFit: 'contain', display: 'block', background: 'rgba(0,0,0,0.08)' }} />
                                  {img.sha256 && <div className="px-3 py-1 text-[10px] truncate" style={{ color: 'var(--text-muted)' }} title={img.sha256}>sha256: {img.sha256}</div>}
                                </div>
                              ))}
                              </div>
                            ) : (
                              <div className="rounded-[12px] flex items-center justify-center" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.18)', height: 120 }}>
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>（无输入）</div>
                              </div>
                            )}
                          </div>
                          {/* ===== Output 生成图（右） ===== */}
                          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                            <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Output</div>
                            {effOutputs.length > 0 ? (
                              <div className="space-y-2">
                              {effOutputs.map((img, idx) => (
                                <div key={`out-${idx}`} className="rounded-[12px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.18)' }}>
                                  <div className="px-3 py-1.5 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                    <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                      {img.label}{effOutputs.length > 1 ? ` #${idx + 1}` : ''}
                                    </div>
                                    <Button variant="secondary" size="sm" onClick={async () => {
                                      try { await navigator.clipboard.writeText(img.url); setCopiedHint('已复制'); setTimeout(() => setCopiedHint(''), 1200); }
                                      catch { setCopiedHint('复制失败'); setTimeout(() => setCopiedHint(''), 2000); }
                                    }}>
                                      <Copy size={12} /> URL
                                    </Button>
                                  </div>
                                  <img src={img.url} alt={img.label} style={{ width: '100%', height: 280, objectFit: 'contain', display: 'block', background: 'rgba(0,0,0,0.08)' }} />
                                  {img.sha256 && <div className="px-3 py-1 text-[10px] truncate" style={{ color: 'var(--text-muted)' }} title={img.sha256}>sha256: {img.sha256}</div>}
                                </div>
                              ))}
                              </div>
                            ) : (
                              <div className="rounded-[12px] flex items-center justify-center" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.18)', flex: 1, minHeight: 120 }}>
                                {detail?.status === 'running' ? (
                                  <div className="flex flex-col items-center gap-2">
                                    <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>生成中…</div>
                                  </div>
                                ) : detail?.status === 'failed' || detail?.status === 'cancelled' ? (
                                  <div className="text-[11px]" style={{ color: 'rgba(239,68,68,0.85)' }}>
                                    {detail?.status === 'cancelled' ? '已取消' : '生成失败'}
                                  </div>
                                ) : (
                                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>（无输出）</div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                      );
                    })()}
                    {imageGenUpstream ? (
                      <div className="mb-3">
                        <div className="text-xs mb-2 flex items-center justify-between gap-2" style={{ color: 'var(--text-muted)' }}>
                          <span>上游原始响应（脱敏/截断）</span>
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            参考图：{imageGenUpstream.initImageProvided === true ? '已提供' : imageGenUpstream.initImageProvided === false ? '未提供' : '—'} ·
                            {' '}使用：{imageGenUpstream.initImageUsed === true ? '是' : imageGenUpstream.initImageUsed === false ? '否' : '—'}
                          </span>
                        </div>
                        <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                          说明：此处来自 Answer 中的 <code>upstreamBodyPreview</code> 字段（上游 HTTP 响应的脱敏预览），用于排查问题；并不代表模型返回了两次数据。
                        </div>
                        <pre style={codeBoxStyle()}>{imageGenUpstream.preview}</pre>
                      </div>
                    ) : null}
                    {answerView === 'raw' ? (
                      <>
                        {imageGenUpstream ? (
                          <div className="text-xs mb-2 flex items-center justify-between gap-2" style={{ color: 'var(--text-muted)' }}>
                            <span>系统记录的 Answer（生图归一化摘要）</span>
                            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              包含：images/size/requestedSize/effectiveSize 等
                            </span>
                          </div>
                        ) : null}
                        <pre style={codeBoxStyle()}>
                          {answerDisplayText || (detail?.status === 'running' ? '（生成中…）' : '（无输出）')}
                        </pre>
                      </>
                    ) : (
                      <div
                        className={[
                          'rounded-[14px] p-3 llm-json-scanBox',
                          jsonCheckPhase === 'scanning' ? 'llm-json-scanBox--scanning' : '',
                          jsonCheckPhase === 'failed' ? 'llm-json-scanBox--failed' : '',
                          jsonCheckPhase === 'passed' ? 'llm-json-scanBox--passed' : '',
                        ].join(' ')}
                        style={{
                          background: 'rgba(0,0,0,0.22)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                          overflow: 'auto',
                        }}
                      >
                        <style>{`
                          .prd-md { font-size: 13px; line-height: 1.65; color: var(--text-secondary); }
                          .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 14px 0 8px; }
                          .prd-md h1 { font-size: 18px; }
                          .prd-md h2 { font-size: 16px; }
                          .prd-md h3 { font-size: 14px; }
                          .prd-md p { margin: 8px 0; }
                          .prd-md ul,.prd-md ol { margin: 8px 0; padding-left: 18px; }
                          .prd-md li { margin: 4px 0; }
                          .prd-md hr { border: 0; border-top: 1px solid rgba(255,255,255,0.10); margin: 12px 0; }
                          .prd-md blockquote { margin: 10px 0; padding: 6px 10px; border-left: 3px solid rgba(231,206,151,0.35); background: rgba(231,206,151,0.06); color: rgba(231,206,151,0.92); border-radius: 10px; }
                          .prd-md a { color: #E7CE97; text-decoration: underline; }
                          .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 6px; border-radius: 8px; }
                          .prd-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px; overflow: auto; }
                          .prd-md pre code { background: transparent; border: 0; padding: 0; }
                          .prd-md table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                          .prd-md th,.prd-md td { border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; }
                          .prd-md th { color: var(--text-primary); background: rgba(255,255,255,0.03); }
                        `}</style>
                        <div className="prd-md">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw]}
                            components={{
                              a: ({ href, children, ...props }) => (
                                <a href={href} target="_blank" rel="noreferrer" {...props}>
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {unwrapMarkdownFences(answerDisplayText) || (detail?.status === 'running' ? '（生成中…）' : '（无输出）')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </GlassCard>
            </div>
          )
        }
      />

      <Dialog
        open={promptOpen}
        onOpenChange={(open) => {
          setPromptOpen(open);
          if (!open) {
            setPromptToken('');
            setTokenPreviewError('');
            setTokenPreviewLoading(false);
            setTokenPreviewText('');
            setTokenPreviewTitle('');
            setTokenPreviewKind('system');
          }
        }}
        title={tokenPreviewTitle || (tokenPreviewKind === 'prd' ? 'PRD 原文预览' : 'System Prompt 预览')}
        description={detail ? `${promptToken || '[SYSTEM_PROMPT]'} · requestId: ${detail.requestId}` : promptToken || ''}
        maxWidth={980}
        contentStyle={{ height: '76vh' }}
        content={
          !detail ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无详情</div>
          ) : (
            <div className="h-full min-h-0 flex flex-col">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  点击 body 中的占位符可预览原文（旧数据可能未记录/不可拉取）
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText((tokenPreviewText ?? '').trim());
                      setCopiedHint('内容已复制');
                      setTimeout(() => setCopiedHint(''), 1200);
                    } catch {
                      setCopiedHint('复制失败（浏览器权限）');
                      setTimeout(() => setCopiedHint(''), 2000);
                    }
                  }}
                  disabled={!((tokenPreviewText ?? '').trim())}
                >
                  <Copy size={16} />
                  复制
                </Button>
              </div>
              {copiedHint ? (
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {copiedHint}
                </div>
              ) : null}
              {tokenPreviewError ? (
                <div className="mt-2 text-[11px]" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  {tokenPreviewError}
                </div>
              ) : null}
              <div className="mt-3 flex-1 min-h-0 overflow-auto">
                <pre style={codeBoxStyle()}>
                  {tokenPreviewLoading
                    ? '加载中...'
                    : ((tokenPreviewText ?? '').trim() || (tokenPreviewKind === 'prd'
                      ? '未获取到 PRD 原文（可能为旧日志、缺少 documentHash/groupId，或该群组未绑定 PRD）'
                      : '未记录 system prompt（可能为旧日志或后端未写入该字段）'))}
                </pre>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}

export default function LlmLogsPage() {
  return <LlmLogsPanel />;
}
