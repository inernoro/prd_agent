import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { generateImageGen, getModels, planImageGen } from '@/services';
import type { ImageGenPlanResponse } from '@/services/contracts/imageGen';
import type { Model } from '@/types/admin';
import { Copy, Download, ImagePlus, Loader2, Maximize2, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

type CanvasImageItem = {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  errorMessage?: string | null;
};

type UiMsg = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  ts: number;
};

function firstEnabledImageModel(models: Model[]): Model | null {
  const list = (models ?? []).filter((m) => m.enabled && m.isImageGen);
  list.sort(
    (a, b) =>
      Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9) ||
      String(a.name || a.modelName || '').localeCompare(String(b.name || b.modelName || ''), undefined, { numeric: true, sensitivity: 'base' })
  );
  return list[0] ?? null;
}

async function copyToClipboard(text: string) {
  const t = String(text ?? '');
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    return;
  } catch {
    // fallback
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    // ignore
  } finally {
    document.body.removeChild(ta);
  }
}

async function downloadImage(src: string, filename: string) {
  const safe = String(filename || 'image')
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .replaceAll(':', '-')
    .replaceAll('*', '-')
    .replaceAll('?', '-')
    .replaceAll('"', '-')
    .replaceAll('<', '-')
    .replaceAll('>', '-')
    .replaceAll('|', '-')
    .slice(0, 80);
  const a = document.createElement('a');
  a.href = src;
  a.download = safe ? `${safe}.png` : 'image.png';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function buildTemplate(name: string) {
  if (name === 'wine') {
    return `为一家精品红酒商店设计一张海报：\n- 风格：高级、克制、现代\n- 主色：深酒红 + 金色点缀\n- 文案：Wine List / 2026 Spring Collection\n- 版式：留白，中心主视觉\n请输出：设计要点 + 生图提示词`;
  }
  if (name === 'coffee') {
    return `为咖啡店做品牌视觉：\n- 风格：手作感、温暖、轻复古\n- 元素：咖啡杯、豆子、纸张纹理\n- Logo：简洁字标\n请输出：设计方向 + 生图提示词`;
  }
  if (name === 'story') {
    return `为短片做分镜首帧图：\n- 画面：室内夜景，窗外雨，暖光\n- 情绪：克制、孤独\n- 镜头：中景，人物背影\n请输出：分镜描述 + 首帧生图提示词`;
  }
  return '';
}

export default function AdvancedImageMasterTab() {
  // 固定默认参数：用户不需要选择
  const DEFAULT_SIZE = '1024x1024';
  const DEFAULT_RESPONSE_FORMAT = 'b64_json' as const;

  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const activeModel = useMemo(() => firstEnabledImageModel(models), [models]);

  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: 'assistant-hello',
      role: 'Assistant',
      content: 'Hi，我是你的 AI 设计师。描述你的需求，我会把它转成可执行的生图提示词，并把结果放到左侧画板。',
      ts: Date.now(),
    },
  ]);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const [canvas, setCanvas] = useState<CanvasImageItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');

  const selected = useMemo(() => canvas.find((x) => x.key === selectedKey) ?? null, [canvas, selectedKey]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  const fileRef = useRef<HTMLInputElement | null>(null);

  const [preview, setPreview] = useState<{ open: boolean; src: string; prompt: string }>({ open: false, src: '', prompt: '' });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setModelsLoading(true);
    getModels()
      .then((res) => {
        if (!res.success) return;
        setModels(res.data ?? []);
      })
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth' });
  }, [messages, busy]);

  const pushMsg = (role: UiMsg['role'], content: string) => {
    setMessages((prev) => prev.concat({ id: `${role}-${Date.now()}`, role, content, ts: Date.now() }));
  };

  const ensureModel = () => {
    if (modelsLoading) return { ok: false as const, reason: '模型加载中' };
    if (!activeModel) return { ok: false as const, reason: '暂无可用生图模型（请先在“模型管理”启用 isImageGen 模型）' };
    return { ok: true as const };
  };

  const runFromText = async (text: string) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    const modelCheck = ensureModel();
    if (!modelCheck.ok) {
      setError(modelCheck.reason);
      pushMsg('Assistant', modelCheck.reason);
      return;
    }

    setError('');
    setBusy(true);
    pushMsg('User', t);

    let plan: ImageGenPlanResponse | null = null;
    try {
      const pres = await planImageGen({ text: t, maxItems: 8 });
      if (!pres.success) {
        const msg = pres.error?.message || '解析失败';
        setError(msg);
        pushMsg('Assistant', `解析失败：${msg}`);
        return;
      }
      plan = pres.data ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '网络错误';
      setError(msg);
      pushMsg('Assistant', `解析失败：${msg}`);
      return;
    }

    const items = Array.isArray(plan?.items) ? plan!.items : [];
    const firstPrompt = String(items[0]?.prompt ?? '').trim() || t;

    pushMsg(
      'Assistant',
      [
        `我已把需求解析成 ${items.length || 1} 条生图提示词。`,
        items.length ? '候选提示词（前 3 条）：\n' + items.slice(0, 3).map((x, i) => `${i + 1}. ${x.prompt}`).join('\n') : '',
        selected ? '你已选中一张图片作为“首帧图”。当前后端生图接口尚未开放图生图参数，本次先按文本生图；后端支持后将自动带上首帧。' : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );

    // 画板占位
    const key = `gen_${Date.now()}`;
    setCanvas((prev) => {
      const placeholder: CanvasImageItem = {
        key,
        createdAt: Date.now(),
        prompt: firstPrompt,
        src: '',
        status: 'running',
      };
      return [placeholder, ...prev].slice(0, 60);
    });

    try {
      const gres = await generateImageGen({
        modelId: activeModel!.id,
        prompt: firstPrompt,
        n: 1,
        size: DEFAULT_SIZE,
        responseFormat: DEFAULT_RESPONSE_FORMAT,
      });
      if (!gres.success) {
        const msg = gres.error?.message || '生成失败';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        setError(msg);
        pushMsg('Assistant', `生成失败：${msg}`);
        return;
      }
      const img0 = (gres.data?.images ?? [])[0];
      const src =
        (img0?.url ?? '') ||
        (img0?.base64 ? (img0.base64.startsWith('data:') ? img0.base64 : `data:image/png;base64,${img0.base64}`) : '');
      if (!src) {
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: '未返回图片' } : x)));
        setError('未返回图片');
        pushMsg('Assistant', '生成失败：未返回图片');
        return;
      }
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'done', src } : x)));
      setSelectedKey((cur) => cur || key);
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    const t = input.trim();
    if (!t) return;
    setInput('');
    await runFromText(t);
  };

  const onUploadImage = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }
    const reader = new FileReader();
    const key = `upload_${Date.now()}`;
    reader.onload = () => {
      const src = String(reader.result || '');
      if (!src) return;
      const item: CanvasImageItem = { key, createdAt: Date.now(), prompt: file.name || 'uploaded', src, status: 'done' };
      setCanvas((prev) => [item, ...prev].slice(0, 60));
      setSelectedKey(key);
      pushMsg('Assistant', '已把你上传的图片加入画板。点击图片可选中，后续可作为首帧图使用。');
    };
    reader.readAsDataURL(file);
  };

  const templates = [
    { id: 'wine', title: 'Wine List', desc: '生成一张高级红酒海报（克制、留白、金色点缀）' },
    { id: 'coffee', title: 'Coffee Shop Branding', desc: '为咖啡店生成品牌视觉方向与主视觉' },
    { id: 'story', title: 'Story Board', desc: '生成短片分镜首帧图（情绪与镜头）' },
  ] as const;

  return (
    <div className="h-full min-h-0 flex gap-4">
      {/* 左侧：画板 */}
      <Card className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex">
          <div className="w-[52px] shrink-0 flex flex-col items-center gap-2 py-3">
            <button
              type="button"
              className="h-10 w-10 rounded-[14px] inline-flex items-center justify-center hover:bg-white/5"
              style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
              onClick={() => fileRef.current?.click()}
              title="上传图片到画板"
            >
              <ImagePlus size={18} />
            </button>
            <button
              type="button"
              className="h-10 w-10 rounded-[14px] inline-flex items-center justify-center hover:bg-white/5"
              style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
              onClick={() => {
                const ok = window.confirm('确认清空画板？');
                if (!ok) return;
                setCanvas([]);
                setSelectedKey('');
              }}
              title="清空画板"
              disabled={canvas.length === 0}
            >
              <Trash2 size={18} />
            </button>
          </div>

          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  画板
                </div>
                <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {selected ? `已选中：${selected.prompt}` : '点击图片可选中；选中后可作为首帧图'}
                </div>
              </div>
              <div className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                {activeModel ? `默认模型：${activeModel.name || activeModel.modelName}` : modelsLoading ? '加载模型中...' : '暂无生图模型'}
              </div>
            </div>

            <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
              {canvas.length === 0 ? (
                <div className="h-full min-h-[240px] flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  画板暂无图片。右侧输入需求点击“生成”，或上传一张图片作为首帧。
                </div>
              ) : (
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {canvas.map((it) => {
                    const selectedNow = it.key === selectedKey;
                    const canOpen = it.status === 'done' && !!it.src;
                    return (
                      <div
                        key={it.key}
                        className="rounded-[16px] p-3"
                        style={{
                          border: selectedNow ? '1px solid rgba(250,204,21,0.65)' : '1px solid var(--border-subtle)',
                          background: selectedNow ? 'rgba(250,204,21,0.06)' : 'rgba(255,255,255,0.02)',
                        }}
                      >
                        <div className="text-xs mb-2 truncate" style={{ color: 'var(--text-muted)' }} title={it.prompt}>
                          {it.status === 'running' ? '生成中' : it.status === 'error' ? '失败' : '完成'} · {it.prompt}
                        </div>
                        <div
                          role="button"
                          tabIndex={0}
                          className="w-full rounded-[12px] overflow-hidden"
                          style={{
                            height: 180,
                            background: 'rgba(0,0,0,0.18)',
                            border: '1px solid rgba(255,255,255,0.10)',
                            position: 'relative',
                          }}
                          onClick={() => {
                            setSelectedKey(it.key);
                            if (canOpen) setPreview({ open: true, src: it.src, prompt: it.prompt });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedKey(it.key);
                              if (canOpen) setPreview({ open: true, src: it.src, prompt: it.prompt });
                            }
                          }}
                          title="点击选中；双用途：选中 + 预览"
                        >
                          {it.status === 'running' ? (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              <Loader2 size={22} className="animate-spin" style={{ color: 'var(--text-secondary)' }} />
                              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                生成中…
                              </div>
                            </div>
                          ) : it.status === 'error' ? (
                            <div className="w-full h-full flex items-center justify-center px-3 text-center text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                              {it.errorMessage || '失败'}
                            </div>
                          ) : (
                            <img src={it.src} alt={it.prompt} className="w-full h-full block" style={{ objectFit: 'contain' }} />
                          )}

                          {canOpen ? (
                            <div
                              className="absolute left-2 bottom-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center pointer-events-none"
                              style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}
                              title="点击放大预览"
                              aria-label="点击放大预览"
                            >
                              <Maximize2 size={14} />
                            </div>
                          ) : null}

                          <div className="absolute right-2 bottom-2 flex items-center gap-1">
                            <button
                              type="button"
                              className={[
                                'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                'transition-all duration-150',
                                'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                              ].join(' ')}
                              onClick={(e) => {
                                e.stopPropagation();
                                void copyToClipboard(it.prompt);
                              }}
                              aria-label="复制提示词"
                              title="复制提示词"
                              disabled={!it.prompt}
                            >
                              <Copy size={12} />
                              复制
                            </button>
                            <button
                              type="button"
                              className={[
                                'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                'transition-all duration-150',
                                'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                              ].join(' ')}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!it.src) return;
                                void downloadImage(it.src, it.prompt || 'image');
                              }}
                              aria-label="下载图片"
                              title="下载图片"
                              disabled={it.status !== 'done' || !it.src}
                            >
                              <Download size={12} />
                              下载
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0] ?? null;
              e.currentTarget.value = '';
              void onUploadImage(f);
            }}
          />
        </div>
      </Card>

      {/* 右侧：单对话/上下文 */}
      <div className="w-[420px] shrink-0 min-h-0 flex flex-col gap-4">
        <Card className="flex-1 min-h-0 overflow-hidden">
          <div className="h-full min-h-0 flex flex-col">
            <div className="min-w-0">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Hi，我是你的 AI 设计师
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                右侧是唯一对话上下文；左侧是画板。点画板图片即可选中，未来可作为图生图首帧。
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="w-full text-left rounded-[16px] p-3 hover:bg-white/5 transition-colors"
                  style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  onClick={() => {
                    const text = buildTemplate(t.id);
                    setInput(text);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t.title}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t.desc}
                  </div>
                </button>
              ))}
            </div>

            <div ref={scrollRef} className="mt-4 flex-1 min-h-0 overflow-auto pr-1 space-y-3">
              {messages.map((m) => {
                const isUser = m.role === 'User';
                return (
                  <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className="max-w-[92%] rounded-[16px] px-4 py-3 text-sm"
                      style={{
                        background: isUser ? 'color-mix(in srgb, var(--accent-gold) 28%, rgba(255,255,255,0.02))' : 'rgba(255,255,255,0.04)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error ? (
              <div className="mt-3 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                {error}
              </div>
            ) : null}

            <div className="mt-3 rounded-[20px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.03)' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                placeholder="请输入你的设计需求（Enter 发送，Shift+Enter 换行）"
                className="w-full min-h-[96px] resize-none rounded-[16px] px-4 py-3 text-sm outline-none"
                style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                disabled={busy}
              />

              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {selected ? `已选中首帧：${selected.prompt}` : '未选择首帧'}
                </div>
                <Button variant="primary" onClick={() => void onSend()} disabled={busy || !input.trim()}>
                  <Wand2 size={16} />
                  {busy ? '生成中...' : '生成'}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Dialog
        open={preview.open}
        onOpenChange={(open) => setPreview((p) => ({ ...p, open }))}
        title="图片预览"
        description="完整显示（不裁切）"
        maxWidth={1100}
        contentStyle={{ height: 'min(90vh, 880px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              <Button variant="secondary" size="sm" onClick={() => void downloadImage(preview.src, preview.prompt || 'image')} disabled={!preview.src}>
                <Download size={16} />
                下载
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(preview.prompt || '')} disabled={!preview.prompt}>
                <Copy size={16} />
                复制提示词
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(preview.src || '')} disabled={!preview.src} title="复制图片 dataURL（或原始 URL）">
                <Copy size={16} />
                复制链接
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {preview.src ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={preview.src}
                    alt={preview.prompt}
                    className="block"
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }}
                  />
                </div>
              ) : (
                <div className="h-full min-h-[220px] flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  （无图片）
                </div>
              )}
            </div>
          </div>
        }
      />
    </div>
  );
}


