import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import {
  PenTool,
  Eraser,
  RotateCcw,
  Send,
  ImagePlus,
  Check,
  Minus,
  Plus,
  Loader2,
  Square,
  RectangleHorizontal,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { toast } from '@/lib/toast';
import { ASPECT_OPTIONS, type AspectOptionId } from '@/lib/imageAspectOptions';

// ─── Types ────────────────────────────────────────────

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
};

type DrawTool = 'pen' | 'eraser';

// ─── Constants ────────────────────────────────────────

const PRESET_COLORS = [
  '#1a1a1a', '#ffffff', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899',
];

const BRUSH_SIZES = [2, 4, 8, 14, 24];
const DEFAULT_BRUSH_IDX = 1;

/** 画布背景色（柔和浅灰，替代纯白） */
const CANVAS_BG = '#f0f0f0';

/** 画布最大像素维度（内部分辨率） */
const MAX_CANVAS_DIM = 640;

/** 可选的画布比例子集 */
const DRAWING_ASPECTS: { id: AspectOptionId; label: string; w: number; h: number }[] = [
  { id: '1:1',  label: '1:1',  w: 1, h: 1 },
  { id: '4:3',  label: '4:3',  w: 4, h: 3 },
  { id: '3:4',  label: '3:4',  w: 3, h: 4 },
  { id: '16:9', label: '16:9', w: 16, h: 9 },
  { id: '9:16', label: '9:16', w: 9, h: 16 },
  { id: '3:2',  label: '3:2',  w: 3, h: 2 },
];

/** 根据比例计算画布内部像素尺寸 */
function computeCanvasDims(aspectId: AspectOptionId): { w: number; h: number } {
  const a = DRAWING_ASPECTS.find(x => x.id === aspectId) ?? DRAWING_ASPECTS[0];
  const ratio = a.w / a.h;
  if (ratio >= 1) {
    return { w: MAX_CANVAS_DIM, h: Math.round(MAX_CANVAS_DIM / ratio) };
  }
  return { w: Math.round(MAX_CANVAS_DIM * ratio), h: MAX_CANVAS_DIM };
}

/** 获取比例对应的1k生成尺寸字符串 */
function getGenSize(aspectId: AspectOptionId): string {
  const opt = ASPECT_OPTIONS.find(x => x.id === aspectId);
  return opt?.size1k ?? '1024x1024';
}

// ─── Props ────────────────────────────────────────────

export type DrawingBoardChatMsg = { role: 'user' | 'assistant'; content: string };

export interface DrawingBoardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 确认后回调：传出画布 data URI + 对话记录 + 建议尺寸 供图片生成使用 */
  onConfirm: (dataUri: string, chatHistory: DrawingBoardChatMsg[], sizeHint: string) => void;
}

// ─── Helper: Parse ASCII art from markdown ───────────

function extractAsciiBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:ascii|text|art|plain)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trimEnd();
    if (body.length > 4) blocks.push(body);
  }
  return blocks;
}

// ─── Component ────────────────────────────────────────

export function DrawingBoardDialog({
  open,
  onOpenChange,
  onConfirm,
}: DrawingBoardDialogProps) {
  // ── Canvas state ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<DrawTool>('pen');
  const [color, setColor] = useState('#1a1a1a');
  const [brushIdx, setBrushIdx] = useState(DEFAULT_BRUSH_IDX);
  const [isDrawing, setIsDrawing] = useState(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── Aspect ratio ──
  const [aspectId, setAspectId] = useState<AspectOptionId>('4:3');
  const canvasDims = computeCanvasDims(aspectId);

  // ── Chat state ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [inputText, setInputText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const brushSize = BRUSH_SIZES[brushIdx];

  // ── Init canvas ──
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      cvs.width = canvasDims.w;
      cvs.height = canvasDims.h;
      const ctx = cvs.getContext('2d');
      if (ctx) {
        ctx.fillStyle = CANVAS_BG;
        ctx.fillRect(0, 0, canvasDims.w, canvasDims.h);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [open, canvasDims.w, canvasDims.h]);

  // ── Auto-scroll chat ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Drawing helpers ──
  const getPos = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const cvs = canvasRef.current;
    if (!cvs) return null;
    const rect = cvs.getBoundingClientRect();
    const scaleX = canvasDims.w / rect.width;
    const scaleY = canvasDims.h / rect.height;
    const clientX = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
    const clientY = 'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, [canvasDims.w, canvasDims.h]);

  const drawAt = useCallback((x: number, y: number) => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    if (tool === 'pen') {
      ctx.fillStyle = color;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fillStyle = CANVAS_BG;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fill();
  }, [tool, brushSize, color]);

  const drawLine = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / (brushSize / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drawAt(from.x + dx * t, from.y + dy * t);
    }
  }, [drawAt, brushSize]);

  const handlePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const pos = getPos(e);
    if (!pos) return;
    setIsDrawing(true);
    lastPosRef.current = pos;
    drawAt(pos.x, pos.y);
  }, [getPos, drawAt]);

  const handlePointerMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    if (!pos) return;
    if (lastPosRef.current) drawLine(lastPosRef.current, pos);
    lastPosRef.current = pos;
  }, [isDrawing, getPos, drawLine]);

  const handlePointerUp = useCallback(() => {
    setIsDrawing(false);
    lastPosRef.current = null;
  }, []);

  const handleClear = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (ctx) {
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(0, 0, canvasDims.w, canvasDims.h);
    }
  }, [canvasDims.w, canvasDims.h]);

  // ── Upload reference image ──
  const handleUploadRef = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const cvs = canvasRef.current;
          if (!cvs) return;
          const ctx = cvs.getContext('2d');
          if (!ctx) return;
          // Scale to fit canvas, centered
          const cw = canvasDims.w;
          const ch = canvasDims.h;
          const scale = Math.min(cw / img.width, ch / img.height, 1);
          const w = img.width * scale;
          const h = img.height * scale;
          const x = (cw - w) / 2;
          const y = (ch - h) / 2;
          ctx.fillStyle = CANVAS_BG;
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, x, y, w, h);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, []);

  // ── Render ASCII art on canvas ──
  const renderAsciiOnCanvas = useCallback((ascii: string) => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const cw = canvasDims.w;
    const ch = canvasDims.h;

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, cw, ch);

    const lines = ascii.split('\n');
    const maxLineLen = Math.max(...lines.map(l => l.length), 1);
    const fontSizeByW = Math.floor((cw - 20) / (maxLineLen * 0.6));
    const fontSizeByH = Math.floor((ch - 20) / lines.length);
    const fontSize = Math.max(6, Math.min(fontSizeByW, fontSizeByH, 16));

    ctx.font = `${fontSize}px "Courier New", "SF Mono", monospace`;
    ctx.fillStyle = '#1a1a1a';
    ctx.textBaseline = 'top';

    const lineHeight = fontSize * 1.2;
    const startY = Math.max(4, (ch - lines.length * lineHeight) / 2);
    const startX = Math.max(4, (cw - maxLineLen * fontSize * 0.6) / 2);

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], startX, startY + i * lineHeight);
    }

    toast.success('字符画已渲染到画布');
  }, [canvasDims.w, canvasDims.h]);

  // ── Chat: send message via SSE ──
  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || streaming) return;
    setInputText('');

    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    const assistantMsg: ChatMsg = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      ts: Date.now(),
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const token = useAuthStore.getState().token;
      const chatMessages = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.content,
      }));

      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';
      const url = baseUrl
        ? `${baseUrl}/${api.visualAgent.imageMaster.drawingBoard.chat().replace(/^\//, '')}`
        : api.visualAgent.imageMaster.drawingBoard.chat();

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Client': 'admin',
          'X-App-Name': 'visual-agent',
        },
        body: JSON.stringify({ messages: chatMessages }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload) as { type: string; content: string };
            if (parsed.type === 'text') {
              accumulated += parsed.content;
              setMessages(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.role === 'assistant') {
                  copy[copy.length - 1] = { ...last, content: accumulated };
                }
                return copy;
              });
            } else if (parsed.type === 'error') {
              toast.error(parsed.content);
            }
          } catch {
            // Ignore parse errors for partial chunks
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      toast.error(`对话失败: ${(err as Error).message}`);
      // Remove empty assistant message on error
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [inputText, streaming, messages]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }, [sendMessage]);

  // ── Confirm: export canvas ──
  const handleConfirm = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const dataUri = cvs.toDataURL('image/png');
    const chatHistory: DrawingBoardChatMsg[] = messages
      .filter(m => m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));
    onConfirm(dataUri, chatHistory, getGenSize(aspectId));
  }, [onConfirm, messages, aspectId]);

  // ── Cleanup on close ──
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setMessages([]);
      setInputText('');
      setStreaming(false);
    }
  }, [open]);

  // ── Render ──
  const content = (
    <div className="flex gap-4 h-full min-h-0">
      {/* ══ Left: Drawing Canvas ══ */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)' }}
        >
          {/* Pen */}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all"
            style={{
              background: tool === 'pen' ? 'rgba(59,130,246,0.25)' : 'transparent',
              color: tool === 'pen' ? '#93c5fd' : 'rgba(255,255,255,0.55)',
              border: tool === 'pen' ? '1px solid rgba(59,130,246,0.35)' : '1px solid transparent',
            }}
            onClick={() => setTool('pen')}
          >
            <PenTool size={13} />
            画笔
          </button>

          {/* Eraser */}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all"
            style={{
              background: tool === 'eraser' ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: tool === 'eraser' ? '#e5e7eb' : 'rgba(255,255,255,0.55)',
              border: tool === 'eraser' ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
            }}
            onClick={() => setTool('eraser')}
          >
            <Eraser size={13} />
            橡皮
          </button>

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.12)' }} />

          {/* Brush size */}
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.5)' }}
            onClick={() => setBrushIdx(i => Math.max(0, i - 1))}
          >
            <Minus size={11} />
          </button>
          <div
            className="rounded-full border"
            style={{
              width: Math.max(8, brushSize * 0.7),
              height: Math.max(8, brushSize * 0.7),
              borderColor: 'rgba(255,255,255,0.3)',
              background: tool === 'pen' ? color : 'rgba(255,255,255,0.2)',
            }}
          />
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.5)' }}
            onClick={() => setBrushIdx(i => Math.min(BRUSH_SIZES.length - 1, i + 1))}
          >
            <Plus size={11} />
          </button>
          <span className="text-[10px] tabular-nums" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {brushSize}px
          </span>

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.12)' }} />

          {/* Colors */}
          <div className="flex items-center gap-0.5">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                type="button"
                className="w-4 h-4 rounded-full transition-transform"
                style={{
                  background: c,
                  border: c === color && tool === 'pen'
                    ? '2px solid rgba(59,130,246,0.9)'
                    : c === '#ffffff'
                      ? '1px solid rgba(255,255,255,0.3)'
                      : '1px solid rgba(0,0,0,0.2)',
                  transform: c === color && tool === 'pen' ? 'scale(1.25)' : undefined,
                }}
                onClick={() => { setColor(c); setTool('pen'); }}
              />
            ))}
          </div>

          <div className="flex-1" />

          {/* Upload reference */}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.55)' }}
            title="上传参考图"
            onClick={handleUploadRef}
          >
            <ImagePlus size={13} />
          </button>

          {/* Clear */}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.55)' }}
            onClick={handleClear}
          >
            <RotateCcw size={12} />
            清空
          </button>
        </div>

        {/* Aspect ratio selector */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <RectangleHorizontal size={12} style={{ color: 'rgba(255,255,255,0.4)' }} />
          <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>画布比例</span>
          <div className="w-px h-3 mx-0.5" style={{ background: 'rgba(255,255,255,0.1)' }} />
          {DRAWING_ASPECTS.map(a => (
            <button
              key={a.id}
              type="button"
              className="px-2 py-0.5 rounded-md text-[10px] font-medium transition-all"
              style={{
                background: aspectId === a.id ? 'rgba(59,130,246,0.2)' : 'transparent',
                color: aspectId === a.id ? '#93c5fd' : 'rgba(255,255,255,0.45)',
                border: aspectId === a.id ? '1px solid rgba(59,130,246,0.3)' : '1px solid transparent',
              }}
              onClick={() => setAspectId(a.id)}
            >
              {a.label}
            </button>
          ))}
          <div className="flex-1" />
          <span className="text-[10px] tabular-nums" style={{ color: 'rgba(255,255,255,0.3)' }}>
            {canvasDims.w}×{canvasDims.h} → 生成 {getGenSize(aspectId)}
          </span>
        </div>

        {/* Canvas */}
        <div
          className="flex-1 min-h-0 rounded-xl overflow-hidden flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <canvas
            ref={canvasRef}
            className="rounded-lg"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              cursor: tool === 'pen' ? 'crosshair' : 'cell',
              touchAction: 'none',
            }}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onMouseLeave={handlePointerUp}
            onTouchStart={handlePointerDown}
            onTouchMove={handlePointerMove}
            onTouchEnd={handlePointerUp}
          />
        </div>

        {/* Confirm button */}
        <button
          type="button"
          className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-sm font-semibold transition-all"
          style={{
            background: 'rgba(34,197,94,0.2)',
            color: '#86efac',
            border: '1px solid rgba(34,197,94,0.3)',
          }}
          onClick={handleConfirm}
        >
          <Check size={15} />
          确认，使用草图生成
        </button>
      </div>

      {/* ══ Right: AI Chat ══ */}
      <div
        className="flex flex-col"
        style={{ width: 340, minWidth: 300 }}
      >
        {/* Chat header */}
        <div
          className="px-3 py-2 rounded-t-xl text-xs font-medium"
          style={{
            background: 'rgba(255,255,255,0.05)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.7)',
          }}
        >
          AI 手绘助手 — 描述你想画的内容，AI 生成字符画参考
        </div>

        {/* Messages */}
        <div
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3"
          style={{ background: 'rgba(0,0,0,0.15)' }}
        >
          {messages.length === 0 && (
            <div className="text-center py-8 space-y-2">
              <div className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
                描述你想创建的草图，AI 会生成字符画参考
              </div>
              <div className="text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                例如："画一只猫坐在窗台上" / "一棵大树，树下有人"
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className="max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed"
                style={{
                  background: msg.role === 'user'
                    ? 'rgba(59,130,246,0.2)'
                    : 'rgba(255,255,255,0.06)',
                  border: msg.role === 'user'
                    ? '1px solid rgba(59,130,246,0.25)'
                    : '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.85)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.content || (
                  <span className="inline-flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.4)' }}>
                    <Loader2 size={12} className="animate-spin" />
                    思考中...
                  </span>
                )}
                {/* Render-to-canvas button for ASCII blocks */}
                {msg.role === 'assistant' && msg.content && extractAsciiBlocks(msg.content).length > 0 && (
                  <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    {extractAsciiBlocks(msg.content).map((block, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all hover:bg-white/10"
                        style={{
                          color: 'rgba(34,197,94,0.9)',
                          border: '1px solid rgba(34,197,94,0.25)',
                          background: 'rgba(34,197,94,0.08)',
                        }}
                        onClick={() => renderAsciiOnCanvas(block)}
                      >
                        <Square size={10} />
                        渲染到画布{extractAsciiBlocks(msg.content).length > 1 ? ` #${idx + 1}` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div
          className="px-3 py-2 rounded-b-xl"
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              className="flex-1 resize-none bg-transparent text-xs leading-relaxed outline-none placeholder:text-white/25"
              style={{ color: 'rgba(255,255,255,0.85)', minHeight: 36, maxHeight: 100 }}
              placeholder="描述你想画的内容... (Enter 发送)"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
            />
            <button
              type="button"
              className="flex items-center justify-center w-7 h-7 rounded-lg transition-all shrink-0"
              style={{
                background: inputText.trim() && !streaming
                  ? 'rgba(59,130,246,0.3)'
                  : 'rgba(255,255,255,0.06)',
                color: inputText.trim() && !streaming
                  ? '#93c5fd'
                  : 'rgba(255,255,255,0.25)',
              }}
              disabled={!inputText.trim() || streaming}
              onClick={() => void sendMessage()}
            >
              {streaming ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="手绘板"
      description="手绘草图或借助 AI 生成字符画参考，确认后作为底图生成图片"
      maxWidth={1160}
      contentStyle={{ height: 'min(86vh, 720px)' }}
      content={content}
    />
  );
}
