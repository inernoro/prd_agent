import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Dialog } from '@/components/ui/Dialog';
import { cancelImageGenRun, createImageGenRun, generateImageGen, getVisualAgentImageGenModels, planImageGen, streamImageGenRunWithRetry } from '@/services';
import type { ImageGenPlanResponse } from '@/services/contracts/imageGen';
import type { ModelGroupForApp } from '@/types/modelGroup';
import { Copy, Download, Loader2, Maximize2, Square, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/lib/toast';

type ImageItem = {
  key: string;
  status: 'idle' | 'running' | 'done' | 'error';
  runId?: string | null;
  itemIndex?: number | null;
  imageIndex?: number | null;
  prompt: string;
  requestedSize?: string;
  effectiveSize?: string;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
  base64?: string | null;
  url?: string | null;
  revisedPrompt?: string | null;
  errorMessage?: string | null;
};

function safeJsonParse(raw: string): unknown | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
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

async function copyImageToClipboard(src: string) {
  const s = String(src ?? '').trim();
  if (!s) return;
  const clipboardAny = navigator.clipboard as unknown as { write?: (items: unknown[]) => Promise<void>; writeText?: (t: string) => Promise<void> };
  const ClipboardItemAny = (window as unknown as { ClipboardItem?: new (items: Record<string, Blob>) => unknown }).ClipboardItem;

  // 1) 尝试：ClipboardItem 写入图片（需要安全上下文 + 用户手势；部分浏览器/环境不支持）
  if (ClipboardItemAny && typeof clipboardAny?.write === 'function') {
    try {
      const res = await fetch(s);
      const blob = await res.blob();
      const type = blob.type || 'image/png';
      await clipboardAny.write([new ClipboardItemAny({ [type]: blob })]);
      return;
    } catch {
      // fallback
    }
  }

  // 2) 降级：复制链接/dataURL（用户可手动粘贴到支持的地方）
  try {
    await copyToClipboard(s);
    toast.info('当前环境不支持直接复制图片，已改为复制图片链接/数据。');
  } catch {
    // ignore
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

export default function ImageGenPanel() {
  // 固定默认参数：用户不需要选择
  const DEFAULT_N = 1;
  const DEFAULT_SIZE = '1024x1024';
  const DEFAULT_RESPONSE_FORMAT = 'b64_json' as const;

  const [imageGenPools, setImageGenPools] = useState<ModelGroupForApp[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // 从模型池中提取第一个可用模型（后端已按 priority 排序，含 3 级回退）
  const activeModel = useMemo(() => {
    for (const pool of imageGenPools) {
      if (pool.models && pool.models.length > 0) {
        const sorted = [...pool.models].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
        const m = sorted[0];
        return {
          name: pool.name,
          modelName: m.modelId,
          platformId: m.platformId,
          poolId: pool.id,
        };
      }
    }
    return null;
  }, [imageGenPools]);

  const [prompt, setPrompt] = useState('生成一张 Hello Kitty 的图片，卡通风格，纯色背景，高清。');
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState('');

  const [images, setImages] = useState<ImageItem[]>([]);
  const [imagePreview, setImagePreview] = useState<{
    open: boolean;
    title: string;
    src: string;
    prompt: string;
    revisedPrompt?: string;
  }>({
    open: false,
    title: '图片预览',
    src: '',
    prompt: '',
    revisedPrompt: '',
  });

  const [planLoading, setPlanLoading] = useState(false);
  const [planResult, setPlanResult] = useState<ImageGenPlanResponse | null>(null);

  const [batchRunning, setBatchRunning] = useState(false);
  const [batchMeta, setBatchMeta] = useState<{ runId?: string; total?: number; done?: number; failed?: number }>({});
  const [batchLog, setBatchLog] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const batchRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    setModelsLoading(true);
    getVisualAgentImageGenModels()
      .then((res) => {
        if (!res.success) return;
        setImageGenPools(res.data ?? []);
      })
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    // no-op：模型由系统自动选择（按优先级）
  }, []);

  const stopBatch = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBatchRunning(false);
    const rid = batchRunIdRef.current;
    batchRunIdRef.current = null;
    if (rid) {
      try {
        await cancelImageGenRun({ runId: rid });
      } catch {
        // ignore
      }
    }
  };

  const runSingle = async () => {
    setSingleError('');
    if (!activeModel) {
      toast.warning('请先选择生图模型');
      return;
    }
    const p = prompt.trim();
    if (!p) return;

    setSingleLoading(true);
    try {
      const res = await generateImageGen({
        modelId: activeModel.modelName,
        platformId: activeModel.platformId,
        prompt: p,
        n: DEFAULT_N,
        size: DEFAULT_SIZE,
        responseFormat: DEFAULT_RESPONSE_FORMAT,
      });
      if (!res.success) {
        setSingleError(res.error?.message || '生成失败');
        return;
      }
      const imgs = (res.data?.images ?? []).map((img, idx) => ({
        key: `${Date.now()}-${idx}`,
        status: 'done' as const,
        prompt: p,
        requestedSize: String(res.data?.meta?.requestedSize ?? DEFAULT_SIZE),
        effectiveSize: String(res.data?.meta?.effectiveSize ?? ''),
        sizeAdjusted: Boolean(res.data?.meta?.sizeAdjusted),
        ratioAdjusted: Boolean(res.data?.meta?.ratioAdjusted),
        base64: img.base64 ?? null,
        url: img.url ?? null,
        revisedPrompt: img.revisedPrompt ?? null,
      }));
      setImages((prev) => [...imgs, ...prev]);
    } finally {
      setSingleLoading(false);
    }
  };

  const buildPlan = async () => {
    if (!prompt.trim()) return;
    setPlanLoading(true);
    try {
      const res = await planImageGen({ text: prompt.trim(), maxItems: 10 });
      if (!res.success) {
        toast.error(res.error?.message || '解析失败');
        return;
      }
      setPlanResult(res.data ?? null);
    } finally {
      setPlanLoading(false);
    }
  };

  const startBatch = async () => {
    if (!activeModel) {
      toast.warning('请先选择生图模型');
      return;
    }
    if (!planResult || !Array.isArray(planResult.items) || planResult.items.length === 0) {
      toast.warning('请先生成批量计划');
      return;
    }
    if (batchRunning) return;

    await stopBatch();
    setBatchRunning(true);
    setBatchMeta({});
    setBatchLog('');

    const ac = new AbortController();
    abortRef.current = ac;

    const items = planResult.items.map((x) => ({ prompt: x.prompt, count: x.count }));

    // 1) 创建 run（后端后台执行；前端只订阅/查询）
    const idem = `img_run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const created = await createImageGenRun({
      input: {
        modelId: activeModel.modelName,
        platformId: activeModel.platformId,
        items,
        size: DEFAULT_SIZE,
        responseFormat: DEFAULT_RESPONSE_FORMAT,
        maxConcurrency: 3,
      },
      idempotencyKey: idem,
    });
    if (!created.success) {
      setBatchLog((p) => (p ? `${p}\n` : '') + `createRunError: ${created.error?.message || '失败'}`);
      await stopBatch();
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      setBatchLog((p) => (p ? `${p}\n` : '') + `createRunError: runId 为空`);
      await stopBatch();
      return;
    }
    batchRunIdRef.current = runId;

    // 2) 先放占位（以 itemIndex/imageIndex 精准对齐事件）
    const placeholders: ImageItem[] = [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const c = Math.max(1, Number(items[itemIndex].count || 1));
      for (let imageIndex = 0; imageIndex < c; imageIndex++) {
        placeholders.push({
          key: `run-${runId}-${itemIndex}-${imageIndex}`,
          status: 'idle',
          runId,
          itemIndex,
          imageIndex,
          prompt: items[itemIndex].prompt,
        });
      }
    }
    setImages((prev) => [...placeholders, ...prev]);

    // 3) 订阅 SSE（断线自动重连；afterSeq 续传）
    const res = await streamImageGenRunWithRetry({
      runId,
      afterSeq: 0,
      maxAttempts: 20,
      signal: ac.signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        const obj = safeJsonParse(evt.data);
        if (!obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;

        const t = String(o.type || '');
        if (!t) return;

        if (t === 'runStart') {
          setBatchMeta({ runId, total: Number(o.total || 0), done: 0, failed: 0 });
          setBatchLog((p) => (p ? `${p}\n` : '') + `runStart: runId=${runId} total=${String(o.total ?? '')}`);
          return;
        }

        if (t === 'imageStart') {
          setBatchLog((p) => (p ? `${p}\n` : '') + `imageStart: item=${String(o.itemIndex)} idx=${String(o.imageIndex)}`);
          const itemIndex = Number(o.itemIndex ?? -1);
          const imageIndex = Number(o.imageIndex ?? -1);
          const p0 = String(o.prompt ?? '');
          setImages((prev) => {
            const idx = prev.findIndex((x) => x.runId === runId && x.itemIndex === itemIndex && x.imageIndex === imageIndex);
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], status: 'running', prompt: p0 || next[idx].prompt };
            return next;
          });
          return;
        }

        if (t === 'imageDone') {
          setBatchMeta((prev) => ({ ...prev, done: Number(prev.done || 0) + 1 }));
          const b64 = (o.base64 as string | null | undefined) ?? null;
          const url = (o.url as string | null | undefined) ?? null;
          const rp = (o.revisedPrompt as string | null | undefined) ?? null;
          const reqSize = String((o.requestedSize as string | undefined) ?? (o.size as string | undefined) ?? DEFAULT_SIZE);
          const effSize = String((o.effectiveSize as string | undefined) ?? '');
          const sizeAdjusted = Boolean((o.sizeAdjusted as boolean | undefined) ?? false);
          const ratioAdjusted = Boolean((o.ratioAdjusted as boolean | undefined) ?? false);
          const itemIndex = Number(o.itemIndex ?? -1);
          const imageIndex = Number(o.imageIndex ?? -1);
          const p0 = String((o.prompt as string | undefined) ?? '');
          setImages((prev) => {
            const idx = prev.findIndex((x) => x.runId === runId && x.itemIndex === itemIndex && x.imageIndex === imageIndex);
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              status: 'done',
              prompt: p0 || next[idx].prompt,
              base64: b64,
              url,
              revisedPrompt: rp,
              requestedSize: reqSize,
              effectiveSize: effSize,
              sizeAdjusted,
              ratioAdjusted,
            };
            return next;
          });
          return;
        }

        if (t === 'imageError') {
          setBatchMeta((prev) => ({ ...prev, failed: Number(prev.failed || 0) + 1 }));
          const itemIndex = Number(o.itemIndex ?? -1);
          const imageIndex = Number(o.imageIndex ?? -1);
          const p0 = String((o.prompt as string | undefined) ?? '');
          const msg = String((o.errorMessage as string | undefined) ?? '生图失败');
          setImages((prev) => {
            const idx = prev.findIndex((x) => x.runId === runId && x.itemIndex === itemIndex && x.imageIndex === imageIndex);
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], status: 'error', prompt: p0 || next[idx].prompt, errorMessage: msg };
            return next;
          });
          setBatchLog((p) => (p ? `${p}\n` : '') + `imageError: ${msg}`);
          return;
        }

        if (t === 'runDone') {
          setBatchMeta((prev) => ({
            ...prev,
            total: Number((o.total as number | string | undefined) ?? prev.total ?? 0),
            done: Number((o.done as number | string | undefined) ?? prev.done ?? 0),
            failed: Number((o.failed as number | string | undefined) ?? prev.failed ?? 0),
          }));
          setBatchLog((p) => (p ? `${p}\n` : '') + `runDone: done=${String(o.done ?? '')} failed=${String(o.failed ?? '')}`);
          void stopBatch();
        }
      },
    });

    if (!res.success) {
      setBatchLog((p) => (p ? `${p}\n` : '') + `batchError: ${res.error?.message || '失败'}`);
      await stopBatch();
    }

    // SSE 流结束后，检查是否有图片还在 running 状态
    // 如果有，说明服务端没有返回最终状态，需要标记为 error
    setImages((prev) =>
      prev.map((x) =>
        x.runId === runId && x.status === 'running'
          ? { ...x, status: 'error', errorMessage: '生成超时或连接中断，请重试' }
          : x
      )
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <GlassCard animated glow className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            结果预览
          </div>
          <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
            {images.length === 0 ? (
              <div className="py-14 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无图片
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {images.map((it) => {
                  const src =
                    it.url ||
                    (it.base64
                      ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`)
                      : '');
                  const canShow = Boolean(src) && it.status === 'done';
                  return (
                    <div
                      key={it.key}
                      className="rounded-[16px] p-3"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                        {it.status === 'error' ? '失败' : it.status === 'done' ? '完成' : it.status === 'running' ? '生成中' : '等待'}
                      </div>
                      {it.status === 'done' && it.sizeAdjusted ? (
                        <div
                          className="mb-2 text-[11px] font-semibold inline-flex items-center gap-1 rounded-full px-2.5 h-5"
                          style={{
                            background: 'rgba(168, 85, 247, 0.12)',
                            border: '1px solid rgba(168, 85, 247, 0.28)',
                            color: 'rgba(168, 85, 247, 0.95)',
                          }}
                          title={
                            it.ratioAdjusted
                              ? `比例已微调：${String(it.requestedSize || DEFAULT_SIZE)} → ${String(it.effectiveSize || '')}`
                              : `尺寸已替换：${String(it.requestedSize || DEFAULT_SIZE)} → ${String(it.effectiveSize || '')}`
                          }
                        >
                          {it.ratioAdjusted ? '比例已微调' : '尺寸已替换'}
                        </div>
                      ) : null}
                      {src ? (
                        <div
                          role={canShow ? 'button' : undefined}
                          tabIndex={canShow ? 0 : -1}
                          className="w-full rounded-[12px] overflow-hidden"
                          style={{
                            height: 180,
                            background: 'rgba(0,0,0,0.18)',
                            border: '1px solid rgba(255,255,255,0.10)',
                            position: 'relative',
                          }}
                          onClick={() => {
                            if (!canShow) return;
                            setImagePreview({ open: true, title: '图片预览', src, prompt: it.prompt, revisedPrompt: it.revisedPrompt || '' });
                          }}
                          onKeyDown={(e) => {
                            if (!canShow) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setImagePreview({ open: true, title: '图片预览', src, prompt: it.prompt, revisedPrompt: it.revisedPrompt || '' });
                            }
                          }}
                        >
                          <img
                            src={src}
                            alt="generated"
                            className="w-full h-full block"
                            style={{ objectFit: 'contain' }}
                            onError={(e) => {
                              const el = e.currentTarget as HTMLImageElement;
                              // 避免反复触发：只在第一次失败时落标记
                              if (el.dataset.prdBroken === '1') return;
                              el.dataset.prdBroken = '1';
                              // 这里不弹窗，避免打扰；在卡片上展示错误占位即可
                            }}
                          />

                          {/* 放大提示（对齐实验室） */}
                          {canShow ? (
                            <div
                              className="absolute left-2 bottom-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center pointer-events-none"
                              style={{
                                border: '1px solid rgba(255,255,255,0.10)',
                                background: 'rgba(0,0,0,0.20)',
                                color: 'var(--text-secondary)',
                              }}
                              title="点击放大预览"
                              aria-label="点击放大预览"
                            >
                              <Maximize2 size={14} />
                            </div>
                          ) : null}

                          {/* 右下角操作：复制提示词 / 下载 */}
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
                                void copyImageToClipboard(src);
                              }}
                              aria-label="复制图片"
                              title="复制图片"
                              disabled={it.status !== 'done' || !src}
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
                                void copyToClipboard(it.prompt);
                              }}
                              aria-label="复制提示词"
                              title="复制提示词"
                              disabled={!it.prompt}
                            >
                              <Copy size={12} />
                              提示词
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
                                void downloadImage(src, it.prompt || 'image');
                              }}
                              aria-label="下载图片"
                              title="下载图片"
                              disabled={it.status !== 'done' || !src}
                            >
                              <Download size={12} />
                              下载
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="h-[180px] rounded-[12px] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)' }}>
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {it.status === 'error' ? (it.errorMessage || '生图失败') : '暂无内容'}
                          </span>
                        </div>
                      )}

                      <div className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {it.revisedPrompt ? `revised: ${it.revisedPrompt}` : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </GlassCard>

      <GlassCard animated glow>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              图片创作（功能测试）
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              复用 /api/visual-agent/image-gen 接口：单次生成 + plan + 批量 SSE（参数自动选择）
            </div>
          </div>
          {batchRunning ? (
            <Button variant="danger" size="sm" onClick={stopBatch}>
              <Square size={16} />
              停止
            </Button>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {modelsLoading ? '加载模型中...' : activeModel ? `默认模型：${activeModel.name || activeModel.modelName}` : '暂无生图模型（请配置模型池）'}
          </div>
          <div className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
            {`默认参数：${DEFAULT_SIZE} · ${DEFAULT_N} 张 · base64`}
          </div>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="mt-4 w-full min-h-[120px] rounded-[16px] px-4 py-3 text-sm outline-none"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          placeholder="输入生图提示词（也用于批量 plan）"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={runSingle} disabled={!activeModel || singleLoading || batchRunning || !prompt.trim()}>
            {singleLoading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
            单次生成
          </Button>
          <Button variant="secondary" onClick={buildPlan} disabled={planLoading || batchRunning || !prompt.trim()}>
            {planLoading ? <Loader2 size={16} className="animate-spin" /> : null}
            生成批量计划
          </Button>
          <Button variant="secondary" onClick={startBatch} disabled={!activeModel || batchRunning || !planResult}>
            批量执行（SSE）
          </Button>
          <Button variant="ghost" onClick={() => setImages([])} disabled={images.length === 0 || batchRunning || singleLoading}>
            清空结果
          </Button>
        </div>

        {singleError ? (
          <div className="mt-3 text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
            {singleError}
          </div>
        ) : null}

        {planResult ? (
          <div className="mt-4 rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              批量计划：{planResult.total} 张（{planResult.items?.length ?? 0} 项）
            </div>
            <div className="mt-2 space-y-1">
              {(planResult.items ?? []).map((it, idx) => (
                <div key={idx} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {idx + 1}. {it.count} × {it.prompt}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {batchRunning || batchLog ? (
          <div className="mt-4 rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                批量进度
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                total={batchMeta.total ?? '-'} done={batchMeta.done ?? '-'} failed={batchMeta.failed ?? '-'}
              </div>
            </div>
            <pre className="mt-2 text-xs whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
              {batchLog || '（等待事件）'}
            </pre>
          </div>
        ) : null}
      </GlassCard>

      <Dialog
        open={imagePreview.open}
        onOpenChange={(open) => setImagePreview((p) => ({ ...p, open }))}
        title={imagePreview.title || '图片预览'}
        description={imagePreview.prompt ? `用户提示词：${imagePreview.prompt}` : '图片预览'}
        maxWidth={1100}
        contentStyle={{ height: 'min(90vh, 880px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadImage(imagePreview.src, imagePreview.prompt || imagePreview.title || 'image')}
                disabled={!imagePreview.src}
              >
                <Download size={16} />
                下载
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyImageToClipboard(imagePreview.src || '')} disabled={!imagePreview.src}>
                <Copy size={16} />
                复制图片
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(imagePreview.prompt || '')} disabled={!imagePreview.prompt}>
                <Copy size={16} />
                复制提示词
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyToClipboard(imagePreview.src || '')}
                disabled={!imagePreview.src}
                title="复制图片 dataURL（或原始 URL）"
              >
                <Copy size={16} />
                复制链接
              </Button>
            </div>

            {imagePreview.revisedPrompt ? (
              <div className="pb-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                模型修订：{imagePreview.revisedPrompt}
              </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {imagePreview.src ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={imagePreview.src}
                    alt={imagePreview.title}
                    className="block"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      width: 'auto',
                      height: 'auto',
                      objectFit: 'contain',
                    }}
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


