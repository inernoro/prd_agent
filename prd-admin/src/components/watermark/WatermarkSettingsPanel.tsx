import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { deleteWatermarkFont, getModelSizes, getWatermark, getWatermarkFonts, putWatermark, uploadWatermarkFont } from '@/services';
import type { ModelSizeInfo, WatermarkFontInfo, WatermarkSpec } from '@/services/contracts/watermark';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { useAuthStore } from '@/stores/authStore';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X, ChevronDown, Trash2, Square, PaintBucket, Type, Droplet, Plus, CheckCircle2 } from 'lucide-react';

const DEFAULT_CANVAS_SIZE = 320;
const createSpecId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `wm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
// 从尺寸列表中筛选出4个有代表性的预览尺寸（排除1:1，因为已有演示画布）
const selectPreviewSizes = (sizes: ModelSizeInfo[]): ModelSizeInfo[] => {
  // 排除 1:1 比例（已在画布中展示）
  const filtered = sizes.filter((s) => Math.abs(s.ratio - 1) > 0.05);
  if (filtered.length <= 4) return filtered;
  // 按比例排序后均匀选取4个
  const sorted = [...filtered].sort((a, b) => a.ratio - b.ratio);
  const step = (sorted.length - 1) / 3;
  return [0, 1, 2, 3].map((i) => sorted[Math.round(i * step)]);
};

const clampPixel = (value: number, min = 0, max = 0) => Math.min(Math.max(value, min), max);

type WatermarkAnchor = WatermarkSpec['anchor'];

const anchorLabelMap: Record<WatermarkAnchor, string> = {
  'top-left': '左上',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-right': '右下',
};

const modeLabelMap: Record<WatermarkSpec['positionMode'], string> = {
  pixel: '按像素',
  ratio: '按比例',
};

const buildDefaultSpec = (fontKey: string): WatermarkSpec => ({
  id: createSpecId(),
  name: '默认水印',
  enabled: false,
  text: '米多AI生成',
  fontKey,
  fontSizePx: 28,
  opacity: 0.6,
  positionMode: 'pixel',
  anchor: 'bottom-right',
  offsetX: 24,
  offsetY: 24,
  iconEnabled: false,
  iconImageRef: null,
  borderEnabled: false,
  backgroundEnabled: false,
  baseCanvasWidth: DEFAULT_CANVAS_SIZE,
  modelKey: 'default',
  color: '#FFFFFF',
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
});

const normalizeSpec = (spec: WatermarkSpec, enabled: boolean, fallbackName: string): WatermarkSpec => {
  const resolvedTextColor = spec.textColor ?? spec.color ?? '#FFFFFF';
  return {
    ...spec,
    id: spec.id || createSpecId(),
    name: spec.name?.trim() || fallbackName,
    enabled,
    positionMode: spec.positionMode ?? 'pixel',
    anchor: spec.anchor ?? 'bottom-right',
    offsetX: Number.isFinite(spec.offsetX) ? spec.offsetX : 24,
    offsetY: Number.isFinite(spec.offsetY) ? spec.offsetY : 24,
    borderEnabled: Boolean(spec.borderEnabled),
    backgroundEnabled: Boolean(spec.backgroundEnabled),
    textColor: resolvedTextColor,
    color: resolvedTextColor,
    backgroundColor: spec.backgroundColor ?? '#000000',
  };
};

const anchorList: WatermarkAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

const getOverlapArea = (
  rect: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number }
) => {
  const left = Math.max(rect.x, target.x);
  const right = Math.min(rect.x + rect.width, target.x + target.width);
  const top = Math.max(rect.y, target.y);
  const bottom = Math.min(rect.y + rect.height, target.y + target.height);
  const overlapWidth = Math.max(0, right - left);
  const overlapHeight = Math.max(0, bottom - top);
  return overlapWidth * overlapHeight;
};

const getDominantAnchor = (
  rect: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  fallback: WatermarkAnchor
) => {
  const halfWidth = canvasWidth / 2;
  const halfHeight = canvasHeight / 2;
  const quadrants: Record<WatermarkAnchor, { x: number; y: number; width: number; height: number }> = {
    'top-left': { x: 0, y: 0, width: halfWidth, height: halfHeight },
    'top-right': { x: halfWidth, y: 0, width: halfWidth, height: halfHeight },
    'bottom-left': { x: 0, y: halfHeight, width: halfWidth, height: halfHeight },
    'bottom-right': { x: halfWidth, y: halfHeight, width: halfWidth, height: halfHeight },
  };
  let best = fallback;
  let bestArea = -1;
  for (const anchor of anchorList) {
    const area = getOverlapArea(rect, quadrants[anchor]);
    if (area > bestArea) {
      bestArea = area;
      best = anchor;
    }
  }
  return best;
};

const computeOffsetsFromAnchor = (
  anchor: WatermarkAnchor,
  rect: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number
) => {
  switch (anchor) {
    case 'top-left':
      return { x: rect.x, y: rect.y };
    case 'top-right':
      return { x: canvasWidth - (rect.x + rect.width), y: rect.y };
    case 'bottom-left':
      return { x: rect.x, y: canvasHeight - (rect.y + rect.height) };
    case 'bottom-right':
    default:
      return { x: canvasWidth - (rect.x + rect.width), y: canvasHeight - (rect.y + rect.height) };
  }
};

function useFontFace(font: WatermarkFontInfo | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !font) return;
    const styleId = 'watermark-font-face';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `@font-face { font-family: "${font.fontFamily}"; src: url("${font.fontFileUrl}"); font-display: swap; }`;
  }, [enabled, font]);
}

type WatermarkStatus = { enabled: boolean; activeId?: string; activeName?: string };

export function WatermarkSettingsPanel(props: { onStatusChange?: (status: WatermarkStatus) => void } = {}) {
  const { onStatusChange } = props;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<WatermarkFontInfo[]>([]);
  const [specs, setSpecs] = useState<WatermarkSpec[]>([]);
  const [activeSpecId, setActiveSpecId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSpec, setDraftSpec] = useState<WatermarkSpec | null>(null);
  const [fontUploading, setFontUploading] = useState(false);
  const [fontDeletingKey, setFontDeletingKey] = useState<string | null>(null);
  const [draftSnapshot, setDraftSnapshot] = useState<{
    specs: WatermarkSpec[];
    activeSpecId: string | null;
  } | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [previewError, setPreviewError] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);

  const fontMap = useMemo(() => new Map(fonts.map((f) => [f.fontKey, f])), [fonts]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wmRes, fontRes] = await Promise.all([getWatermark(), getWatermarkFonts()]);
      const nextFonts = fontRes?.success ? fontRes.data || [] : [];
      if (nextFonts.length > 0) {
        setFonts(nextFonts);
      }
      const fallbackFont = nextFonts[0]?.fontKey || 'default';

      if (wmRes?.success) {
        const source = wmRes.data;
        const sourceSpecs = source?.specs && source.specs.length > 0
          ? source.specs
          : source?.spec
            ? [source.spec]
            : [buildDefaultSpec(fallbackFont)];
        const nextEnabled = Boolean(source?.enabled ?? sourceSpecs[0]?.enabled);
        const normalizedSpecs = sourceSpecs.map((item, index) =>
          normalizeSpec(
            {
              ...item,
              fontKey: item.fontKey || fallbackFont,
            },
            nextEnabled,
            item.name || `水印配置 ${index + 1}`,
          )
        );
        const nextActiveId = source?.activeSpecId || normalizedSpecs[0]?.id || null;
        setSpecs(normalizedSpecs);
        setActiveSpecId(nextActiveId);
        setEnabled(nextEnabled);
      } else if (nextFonts.length > 0) {
        const defaultSpec = buildDefaultSpec(fallbackFont);
        setSpecs([defaultSpec]);
        setActiveSpecId(defaultSpec.id);
        setEnabled(defaultSpec.enabled);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const spec = useMemo(
    () => specs.find((item) => item.id === activeSpecId) ?? specs[0] ?? null,
    [specs, activeSpecId]
  );

  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({ enabled, activeId: spec?.id, activeName: spec?.name });
  }, [onStatusChange, enabled, spec?.id, spec?.name]);

  useEffect(() => {
    if (fonts.length === 0) return;
    const fallback = fonts.find((font) => font.fontKey === 'default')?.fontKey || fonts[0].fontKey;
    setSpecs((prev) =>
      prev.map((item) => (fontMap.has(item.fontKey) ? item : { ...item, fontKey: fallback }))
    );
  }, [fontMap, fonts]);

  const saveSettings = useCallback(
    async (nextSpecs: WatermarkSpec[], nextActiveId: string | null, nextEnabled: boolean) => {
      setSaving(true);
      try {
        const res = await putWatermark({
          enabled: nextEnabled,
          activeSpecId: nextActiveId ?? undefined,
          specs: nextSpecs,
        });
        if (res?.success) {
          const source = res.data;
          const fallbackFont = fonts[0]?.fontKey || 'default';
          const sourceSpecs = source?.specs && source.specs.length > 0
            ? source.specs
            : source?.spec
              ? [source.spec]
              : [buildDefaultSpec(fallbackFont)];
          const nextEnabledValue = Boolean(source?.enabled ?? sourceSpecs[0]?.enabled);
          const normalizedSpecs = sourceSpecs.map((item, index) =>
            normalizeSpec(
              {
                ...item,
                fontKey: item.fontKey || fallbackFont,
              },
              nextEnabledValue,
              item.name || `水印配置 ${index + 1}`,
            )
          );
          const nextActive = source?.activeSpecId || normalizedSpecs[0]?.id || null;
          setSpecs(normalizedSpecs);
          setActiveSpecId(nextActive);
          setEnabled(nextEnabledValue);
          setPreviewEpoch(Date.now());
        }
      } finally {
        setSaving(false);
      }
    },
    [fonts]
  );

  const saveSpec = useCallback(
    async (next: WatermarkSpec) => {
      const nextSpecs = specs.map((item) => (item.id === next.id ? next : item));
      await saveSettings(nextSpecs, activeSpecId, enabled);
    },
    [activeSpecId, enabled, saveSettings, specs]
  );

  const previewRequestUrl = useMemo(() => {
    if (!spec) return null;
    return `/api/watermark/preview/${encodeURIComponent(spec.id)}.png`;
  }, [spec]);

  useEffect(() => {
    if (!previewRequestUrl) {
      setPreviewObjectUrl(null);
      return;
    }
    const controller = new AbortController();
    const token = useAuthStore.getState().token;
    setPreviewError(false);

    void fetch(previewRequestUrl, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error('preview fetch failed');
        return res.blob();
      })
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        setPreviewObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreviewError(true);
          setPreviewObjectUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
        }
      });

    return () => {
      controller.abort();
    };
  }, [previewEpoch, previewRequestUrl]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    };
  }, [previewObjectUrl]);

  const handleActivate = async (id: string) => {
    if (id === activeSpecId) return;
    await saveSettings(specs, id, enabled);
  };

  const handleAddSpec = () => {
    const fallbackFont = fonts[0]?.fontKey || spec?.fontKey || 'default';
    const base = spec ? { ...spec } : buildDefaultSpec(fallbackFont);
    const newSpec = normalizeSpec(
      {
        ...base,
        id: createSpecId(),
        name: `水印配置 ${specs.length + 1}`,
      },
      enabled,
      `水印配置 ${specs.length + 1}`
    );
    setDraftSnapshot({ specs, activeSpecId });
    setSpecs([...specs, newSpec]);
    setActiveSpecId(newSpec.id);
    setDraftSpec({ ...newSpec });
    setEditorOpen(true);
  };

  const handleEditorCancel = () => {
    if (draftSnapshot) {
      setSpecs(draftSnapshot.specs);
      setActiveSpecId(draftSnapshot.activeSpecId);
    }
    setDraftSnapshot(null);
    setDraftSpec(null);
    setEditorOpen(false);
  };

  const refreshFonts = useCallback(async () => {
    const res = await getWatermarkFonts();
    if (res?.success) {
      setFonts(res.data || []);
    }
    return res;
  }, []);

  const handleFontUpload = useCallback(
    async (file: File) => {
      if (fontUploading) return;
      setFontUploading(true);
      try {
        const res = await uploadWatermarkFont({ file });
        if (!res?.success) {
          toast.error('字体上传失败', res?.error?.message || '上传失败');
          return;
        }
        toast.success('字体已上传', res.data?.displayName || '上传成功');
        await refreshFonts();
        setDraftSpec((prev) => (prev ? { ...prev, fontKey: res.data.fontKey } : prev));
      } finally {
        setFontUploading(false);
      }
    },
    [fontUploading, refreshFonts]
  );

  const handleFontDelete = useCallback(
    async (font: WatermarkFontInfo) => {
      if (fontDeletingKey) return;
      const confirmFirst = await systemDialog.confirm({
        title: '确认删除字体',
        message: `确定删除字体「${font.displayName}」吗？`,
        tone: 'danger',
        confirmText: '删除',
        cancelText: '取消',
      });
      if (!confirmFirst) return;
      const confirmSecond = await systemDialog.confirm({
        title: '再次确认',
        message: '该操作不可撤销，确定继续吗？',
        tone: 'danger',
        confirmText: '确认删除',
        cancelText: '取消',
      });
      if (!confirmSecond) return;

      setFontDeletingKey(font.fontKey);
      try {
        const res = await deleteWatermarkFont({ fontKey: font.fontKey });
        if (!res?.success) {
          toast.error('删除字体失败', res?.error?.message || '删除失败');
          return;
        }
        toast.success('字体已删除', font.displayName);
        const updated = await refreshFonts();
        if (updated?.success) {
          const nextFonts = updated.data || [];
          setDraftSpec((prev) => {
            if (!prev) return prev;
            if (prev.fontKey !== font.fontKey) return prev;
            const fallback = nextFonts[0]?.fontKey || prev.fontKey;
            return { ...prev, fontKey: fallback };
          });
        }
      } finally {
        setFontDeletingKey(null);
      }
    },
    [fontDeletingKey, refreshFonts]
  );

  const toggleEnabled = async () => {
    if (!spec) return;
    await saveSettings(specs, activeSpecId, !enabled);
  };

  if (loading) {
    return (
      <Card className="p-4 min-h-[260px] flex items-center justify-center" variant="default">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>水印配置加载中...</div>
      </Card>
    );
  }

  return (
    <Card className="p-4 min-h-0 flex flex-col gap-4" variant="default">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>水印配置</div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>控制生图时的水印展示与样式</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="h-[26px] w-[46px] rounded-full relative transition-colors"
            style={{
              background: enabled ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.12)',
              border: enabled ? '1px solid rgba(214, 178, 106, 0.5)' : '1px solid rgba(255,255,255,0.18)',
            }}
            onClick={toggleEnabled}
            disabled={saving || !spec}
            title={enabled ? '关闭水印' : '开启水印'}
          >
            <span
              className="absolute top-[2px] transition-all"
              style={{
                left: enabled ? 24 : 2,
                width: 20,
                height: 20,
                borderRadius: 10,
                background: enabled ? '#1a1206' : 'rgba(255,255,255,0.9)',
                boxShadow: enabled ? '0 2px 6px rgba(0,0,0,0.25)' : 'none',
              }}
            />
          </button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              if (spec) {
                setDraftSnapshot(null);
                setDraftSpec({ ...spec });
                setEditorOpen(true);
              }
            }}
            disabled={!spec}
          >
            <Pencil size={14} />
            编辑
          </Button>
        </div>
      </div>

      {specs.length > 0 ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0, 1fr) 240px' }}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>水印列表</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>点击启用后即为生图默认水印</div>
              </div>
              <Button variant="secondary" size="xs" onClick={handleAddSpec} disabled={saving}>
                <Plus size={14} />
                新增配置
              </Button>
            </div>
            <div className="grid gap-2">
              {specs.map((item, index) => {
                const isActive = item.id === activeSpecId;
                const fontLabel = fontMap.get(item.fontKey)?.displayName || item.fontKey;
                return (
                  <div
                    key={item.id || `${item.text}-${index}`}
                    className="rounded-[14px] p-3"
                    style={{
                      background: isActive ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255,255,255,0.04)',
                      border: isActive ? '1px solid rgba(245, 158, 11, 0.35)' : '1px solid var(--border-subtle)',
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {item.name || `水印配置 ${index + 1}`}
                        </div>
                        <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{item.text}</div>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full"
                        style={{
                          background: isActive ? 'rgba(245, 158, 11, 0.18)' : 'rgba(255,255,255,0.08)',
                          color: isActive ? 'rgba(245, 158, 11, 0.9)' : 'var(--text-secondary)',
                          border: '1px solid rgba(255,255,255,0.12)',
                        }}
                        onClick={() => handleActivate(item.id)}
                        disabled={saving}
                        title={isActive ? '当前启用' : '设为启用'}
                      >
                        {isActive ? <CheckCircle2 size={12} /> : null}
                        {isActive ? '已启用' : '启用'}
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 text-[11px] grid-cols-2" style={{ color: 'var(--text-muted)' }}>
                      <div className="flex items-center justify-between gap-4">
                        <span>字体</span>
                        <span className="text-right truncate" style={{ color: 'var(--text-primary)', maxWidth: 160 }}>{fontLabel}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>字号</span>
                        <span style={{ color: 'var(--text-primary)' }}>{item.fontSizePx}px</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>位置</span>
                        <span className="text-right truncate" style={{ color: 'var(--text-primary)', maxWidth: 160 }}>
                          {anchorLabelMap[item.anchor]} · {modeLabelMap[item.positionMode]}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>图标</span>
                        <span style={{ color: 'var(--text-primary)' }}>{item.iconEnabled ? '已启用' : '未启用'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>透明度</span>
                        <span style={{ color: 'var(--text-primary)' }}>{Math.round(item.opacity * 100)}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-[16px] p-3 flex flex-col gap-3" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>水印预览</div>
            <div className="flex-1 rounded-[12px] overflow-hidden flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.04)', minHeight: 220 }}>
              {previewObjectUrl && !previewError ? (
                <img
                  src={previewObjectUrl}
                  alt="水印预览"
                  className="max-h-[220px] w-auto object-contain"
                  onError={() => setPreviewError(true)}
                />
              ) : (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无预览</div>
              )}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              预览图由后台渲染并保存为 preview.{spec?.id}.png
            </div>
          </div>
        </div>
      ) : (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无水印配置</div>
      )}

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleEditorCancel();
          } else {
            setEditorOpen(true);
          }
        }}
        title="水印编辑"
        maxWidth={1320}
        contentClassName="overflow-hidden !p-4"
        contentStyle={{ maxHeight: '90vh', height: '90vh' }}
        content={draftSpec ? (
          <WatermarkEditor
            spec={draftSpec}
            fonts={fonts}
            fontUploading={fontUploading}
            fontDeletingKey={fontDeletingKey}
            onChange={setDraftSpec}
            onUploadFont={handleFontUpload}
            onDeleteFont={handleFontDelete}
            onSave={async () => {
              if (!draftSpec) return;
              await saveSpec(draftSpec);
              setDraftSnapshot(null);
              setDraftSpec(null);
              setEditorOpen(false);
            }}
          />
        ) : null}
      />
    </Card>
  );
}

function WatermarkEditor(props: {
  spec: WatermarkSpec;
  fonts: WatermarkFontInfo[];
  fontUploading: boolean;
  fontDeletingKey: string | null;
  onChange: (spec: WatermarkSpec) => void;
  onUploadFont: (file: File) => void;
  onDeleteFont: (font: WatermarkFontInfo) => void;
  onSave: () => void;
}) {
  const { spec, fonts, fontUploading, fontDeletingKey, onChange, onUploadFont, onDeleteFont, onSave } = props;
  const [sizes, setSizes] = useState<ModelSizeInfo[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fontLoading, setFontLoading] = useState(false);
  const previewSizes = useMemo(() => selectPreviewSizes(sizes), [sizes]);

  const fontMap = useMemo(() => new Map(fonts.map((f) => [f.fontKey, f])), [fonts]);
  const baseCanvasSize = spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE;

  useEffect(() => {
    if (!spec.modelKey) return;
    setLoadingSizes(true);
    void getModelSizes({ modelKey: spec.modelKey }).then((res) => {
      if (res?.success) {
        setSizes(res.data?.sizes || []);
      }
    }).finally(() => setLoadingSizes(false));
  }, [spec.modelKey]);

  const updateSpec = (patch: Partial<WatermarkSpec>) => {
    onChange({ ...spec, ...patch });
  };

  const handleIconUpload = async (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      updateSpec({ iconEnabled: true, iconImageRef: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const handlePreviewUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPreviewImage(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
  };

  const currentFont = fontMap.get(spec.fontKey);
  useFontFace(currentFont ?? null, true);

  useEffect(() => {
    if (!currentFont?.fontFamily || !document?.fonts?.load) {
      setFontLoading(false);
      return;
    }
    setFontLoading(true);
    const fontSize = Math.max(12, Math.round(spec.fontSizePx));
    document.fonts
      .load(`${fontSize}px "${currentFont.fontFamily}"`)
      .then(() => setFontLoading(false))
      .catch(() => setFontLoading(false));
  }, [currentFont?.fontFamily, spec.fontSizePx]);

  return (
    <div className="flex flex-col h-full overflow-hidden -mt-3">
      <div className="grid gap-1 flex-1 overflow-hidden" style={{ gridTemplateColumns: '140px minmax(0, 1fr) 300px' }}>
        {/* 左侧: 多尺寸预览 */}
        <div className="flex flex-col gap-1 overflow-hidden">
          <div className="text-[10px] font-semibold px-0.5" style={{ color: 'var(--text-muted)' }}>多尺寸预览</div>
          <div className="flex flex-col gap-1.5 overflow-y-auto overflow-x-hidden pr-0.5" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.2) transparent' }}>
            {(loadingSizes ? Array.from<ModelSizeInfo | undefined>({ length: 4 }) : previewSizes).map((size, idx) => {
              if (!size) {
                return (
                  <div
                    key={`placeholder-${idx}`}
                    className="h-[75px] rounded-[6px]"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  />
                );
              }
              const previewWidth = 118;
              const previewHeight = Math.round((size.height / size.width) * previewWidth);
              return (
                <div
                  key={size.label}
                  className="rounded-[6px] p-0.5"
                  style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}
                >
                  <div className="text-[9px] mb-0.5 px-0.5" style={{ color: 'var(--text-muted)' }}>{size.label}</div>
                  <div className="flex items-center justify-center">
                    <WatermarkPreview
                      spec={spec}
                      font={currentFont}
                      size={previewWidth}
                      height={previewHeight}
                      previewImage={previewImage}
                      showDistances
                      showCrosshair
                      distancePlacement="inside"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 中间: 主预览画布 */}
        <div
          className="rounded-[8px] relative flex items-center justify-center overflow-visible p-2"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          <WatermarkPreview
            spec={spec}
            font={currentFont}
            size={spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE}
            previewImage={previewImage}
            draggable
            showCrosshair
            showDistances
            distancePlacement="outside"
            onPositionChange={(next) => updateSpec(next)}
          />
        </div>

        {/* 右侧: 配置表单 */}
        <div className="flex flex-col gap-2 overflow-y-auto pr-0.5">
          <div className="flex items-center gap-1.5 pb-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <label
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded-[8px] cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            >
              <ImageIcon size={12} />
              上传底图
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handlePreviewUpload(e.target.files?.[0] ?? null)}
              />
            </label>
            <Button variant="primary" size="sm" onClick={onSave} className="flex-1 !text-[11px] !px-2 !py-1.5">
              <Check size={12} />
              保存
            </Button>
          </div>

          <div className="grid gap-1.5" style={{ gridTemplateColumns: '70px minmax(0, 1fr)' }}>
          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>配置名称</div>
          <input
            value={spec.name}
            onChange={(e) => updateSpec({ name: e.target.value })}
            className="w-full rounded-[8px] px-2 py-1 text-sm outline-none prd-field"
            placeholder="例如：默认水印"
          />

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>水印文本</div>
          <input
            value={spec.text}
            onChange={(e) => updateSpec({ text: e.target.value })}
            className="w-full rounded-[8px] px-2 py-1 text-sm outline-none prd-field"
            placeholder="请输入水印文案"
          />

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>字体</div>
          <div className="flex items-center gap-2">
              <FontSelect
                value={spec.fontKey}
                fonts={fonts}
                deletingKey={fontDeletingKey}
                loading={fontLoading}
                onChange={(fontKey) => updateSpec({ fontKey })}
                onDelete={onDeleteFont}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file) onUploadFont(file);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={fontUploading}
              >
                <UploadCloud size={14} />
                {fontUploading ? '上传中...' : '上传字体'}
              </Button>
            </div>

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>字号</div>
          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-right" style={{ color: 'var(--text-muted)' }}>{Math.round(spec.fontSizePx)}px</div>
            <input
              type="range"
              min={12}
              max={64}
              step={2}
              value={spec.fontSizePx}
              onChange={(e) => updateSpec({ fontSizePx: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>透明度</div>
          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-right" style={{ color: 'var(--text-muted)' }}>{Math.round(spec.opacity * 100)}%</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={spec.opacity}
              onChange={(e) => updateSpec({ opacity: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>定位方式</div>
          <div>
            <PositionModeSwitch
              value={spec.positionMode}
              onChange={(nextMode) => {
                if (nextMode === spec.positionMode) return;
                if (nextMode === 'ratio') {
                  updateSpec({
                    positionMode: nextMode,
                    offsetX: spec.offsetX / baseCanvasSize,
                    offsetY: spec.offsetY / baseCanvasSize,
                  });
                } else {
                  updateSpec({
                    positionMode: nextMode,
                    offsetX: spec.offsetX * baseCanvasSize,
                    offsetY: spec.offsetY * baseCanvasSize,
                  });
                }
              }}
            />
          </div>

          <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>装饰</div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
              <div className="relative shrink-0">
                <label
                  className="h-9 w-9 rounded-[9px] inline-flex items-center justify-center cursor-pointer overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  title="上传图标"
                >
                  {spec.iconEnabled && spec.iconImageRef ? (
                    <img src={spec.iconImageRef} alt="水印图标" className="h-full w-full object-cover" />
                  ) : (
                    <UploadCloud size={15} />
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void handleIconUpload(e.target.files?.[0] ?? null)}
                  />
                </label>
                {spec.iconEnabled && spec.iconImageRef ? (
                  <button
                    type="button"
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full inline-flex items-center justify-center"
                    style={{ background: 'rgba(15,15,18,0.9)', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-primary)' }}
                    onClick={() => updateSpec({ iconEnabled: false, iconImageRef: null })}
                    title="移除图标"
                  >
                    <X size={10} />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="h-9 w-9 rounded-[9px] inline-flex items-center justify-center shrink-0"
                style={{
                  background: spec.borderEnabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: spec.borderEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="是否边框"
                onClick={() => updateSpec({ borderEnabled: !spec.borderEnabled })}
              >
                <Square size={15} />
              </button>
              <button
                type="button"
                className="h-9 w-9 rounded-[9px] inline-flex items-center justify-center shrink-0"
                style={{
                  background: spec.backgroundEnabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: spec.backgroundEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="填充背景"
                onClick={() => updateSpec({ backgroundEnabled: !spec.backgroundEnabled })}
              >
                <PaintBucket size={15} />
              </button>
              <label
                className="relative h-9 w-9 rounded-[9px] inline-flex items-center justify-center cursor-pointer shrink-0"
                style={{
                  background: spec.textColor || spec.color || '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  color: 'rgba(0,0,0,0.65)',
                }}
                title="前景色（字体）"
              >
                <Type size={14} />
                <input
                  type="color"
                  value={(spec.textColor || spec.color || '#ffffff') as string}
                  className="absolute inset-0 opacity-0 h-9 w-9 cursor-pointer"
                  onChange={(e) => updateSpec({ textColor: e.target.value, color: e.target.value })}
                />
              </label>
              <label
                className="relative h-9 w-9 rounded-[9px] inline-flex items-center justify-center cursor-pointer shrink-0"
                style={{
                  background: spec.backgroundColor || '#000000',
                  border: '1px solid rgba(255,255,255,0.2)',
                  color: 'rgba(255,255,255,0.85)',
                }}
                title="背景色"
              >
                <Droplet size={14} />
                <input
                  type="color"
                  value={(spec.backgroundColor || '#000000') as string}
                  className="absolute inset-0 opacity-0 h-9 w-9 cursor-pointer"
                  onChange={(e) => updateSpec({ backgroundColor: e.target.value })}
                />
              </label>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionModeSwitch(props: {
  value: 'pixel' | 'ratio';
  onChange: (value: 'pixel' | 'ratio') => void;
}) {
  const { value, onChange } = props;
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const activeButton = buttonsRef.current.get(value);
    if (activeButton) {
      const container = activeButton.parentElement;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const buttonRect = activeButton.getBoundingClientRect();
        setIndicatorStyle({
          left: buttonRect.left - containerRect.left,
          width: buttonRect.width,
        });
      }
    }
  }, [value]);

  return (
    <div
      className="relative inline-flex items-center gap-1 p-1 rounded-[10px]"
      style={{
        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      {/* 滑动指示器 */}
      <div
        className="absolute rounded-[7px] h-[26px] pointer-events-none"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.08) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          boxShadow: '0 2px 8px -1px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {(['pixel', 'ratio'] as const).map((mode) => {
        const isActive = mode === value;
        return (
          <button
            key={mode}
            ref={(el) => {
              if (el) {
                buttonsRef.current.set(mode, el);
              } else {
                buttonsRef.current.delete(mode);
              }
            }}
            type="button"
            onClick={() => onChange(mode)}
            className="relative px-4 h-[26px] text-[12px] font-semibold transition-colors duration-200"
            style={{
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              zIndex: 1,
            }}
          >
            {mode === 'pixel' ? '按像素' : '按比例'}
          </button>
        );
      })}
    </div>
  );
}

function FontSelect(props: {
  value: string;
  fonts: WatermarkFontInfo[];
  deletingKey: string | null;
  loading?: boolean;
  onChange: (fontKey: string) => void;
  onDelete: (font: WatermarkFontInfo) => void;
}) {
  const { value, fonts, deletingKey, loading, onChange, onDelete } = props;
  const [open, setOpen] = useState(false);
  const current = fonts.find((font) => font.fontKey === value);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="relative flex-1 rounded-[12px] px-3 py-2 text-sm outline-none prd-field text-left"
        >
          <span style={{ color: 'var(--text-primary)' }}>
            {current?.displayName || value || '请选择字体'}
          </span>
          {loading ? (
            <span className="ml-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </span>
          ) : null}
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-[120] rounded-[14px] overflow-hidden"
          style={{
            background: 'rgba(15, 15, 18, 1)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
            minWidth: 240,
          }}
          sideOffset={8}
          align="start"
        >
          <div className="max-h-[240px] overflow-auto p-1">
            {fonts.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无字体
              </div>
            ) : (
              fonts.map((font) => {
                const canDelete = font.fontKey.startsWith('custom-');
                return (
                  <div
                    key={font.fontKey}
                    className="flex items-center gap-2 px-3 py-2 rounded-[8px] hover:bg-white/8"
                  >
                    <button
                      type="button"
                      className="flex-1 text-left text-sm"
                      style={{ color: 'var(--text-primary)' }}
                      onClick={() => {
                        onChange(font.fontKey);
                        setOpen(false);
                      }}
                    >
                      {font.displayName}
                    </button>
                    {canDelete ? (
                      <button
                        type="button"
                        className="h-7 w-7 rounded-[8px] inline-flex items-center justify-center"
                        style={{ color: 'rgba(239,68,68,0.9)', background: 'rgba(239,68,68,0.12)' }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onDelete(font);
                        }}
                        disabled={deletingKey === font.fontKey}
                        title="删除字体"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function WatermarkPreview(props: {
  spec: WatermarkSpec;
  font: WatermarkFontInfo | null | undefined;
  size: number;
  height?: number;
  previewImage?: string | null;
  draggable?: boolean;
  showCrosshair?: boolean;
  showDistances?: boolean;
  distancePlacement?: 'inside' | 'outside';
  onPositionChange?: (next: Pick<WatermarkSpec, 'anchor' | 'offsetX' | 'offsetY'>) => void;
}) {
  const {
    spec,
    font,
    size,
    height,
    previewImage,
    draggable,
    showCrosshair,
    showDistances,
    distancePlacement = 'outside',
    onPositionChange,
  } = props;
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const width = size;
  const canvasHeight = height ?? size;

  const fontFamily = font?.fontFamily || 'sans-serif';
  // 基于短边计算缩放比例，确保不同宽高比的画布上字体视觉比例一致
  const baseSize = spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE;
  const shortSide = Math.min(width, canvasHeight);
  const previewScale = shortSide / baseSize;
  const fontSize = spec.fontSizePx * previewScale;
  const iconSize = fontSize;
  const gap = fontSize / 4;
  const decorationPadding = spec.backgroundEnabled || spec.borderEnabled ? Math.round(fontSize * 0.3) : 0;
  const textColor = spec.textColor || spec.color || '#ffffff';
  const backgroundColor = spec.backgroundColor || '#000000';

  const watermarkRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLImageElement | null>(null);
  const lastMeasuredSizeRef = useRef({ width: 0, height: 0 });
  const [watermarkSize, setWatermarkSize] = useState({ width: 0, height: 0 });
  const [measureTick, setMeasureTick] = useState(0);
  const [measuredSignature, setMeasuredSignature] = useState('');
  const [fontReady, setFontReady] = useState(false);
  const measureSignature = useMemo(
    () =>
      [
        spec.text,
        spec.iconEnabled ? '1' : '0',
        spec.iconImageRef ?? '',
        spec.backgroundEnabled ? '1' : '0',
        spec.borderEnabled ? '1' : '0',
        fontFamily,
        fontSize.toFixed(2),
      ].join('|'),
    [spec.text, spec.iconEnabled, spec.iconImageRef, spec.backgroundEnabled, spec.borderEnabled, fontFamily, fontSize]
  );

  useLayoutEffect(() => {
    setWatermarkSize({ width: 0, height: 0 });
    setMeasuredSignature('');
    setFontReady(false);
  }, [measureSignature]);

  useEffect(() => {
    let cancelled = false;
    if (!document.fonts?.load) {
      setFontReady(true);
      return undefined;
    }
    setFontReady(false);
    void document.fonts
      .load(`${fontSize}px "${fontFamily}"`)
      .then(() => {
        if (!cancelled) setFontReady(true);
      })
      .catch(() => {
        if (!cancelled) setFontReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontSize, measureSignature]);

  const estimatedTextWidth = Math.max(spec.text.length, 1) * fontSize * 0.6;
  const estimatedWidth = estimatedTextWidth + (spec.iconEnabled && spec.iconImageRef ? iconSize + gap : 0) + decorationPadding * 2;
  const estimatedHeight = Math.max(fontSize, iconSize) + decorationPadding * 2;
  const measuredWidth = watermarkSize.width || estimatedWidth;
  const measuredHeight = watermarkSize.height || estimatedHeight;
  const hasLastMeasured = lastMeasuredSizeRef.current.width > 0 && lastMeasuredSizeRef.current.height > 0;
  const pendingMeasure = measuredSignature !== measureSignature;
  const effectiveWidth = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.width : measuredWidth;
  const effectiveHeight = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.height : measuredHeight;
  const hideUntilMeasured = !fontReady || measuredSignature !== measureSignature;

  const offsetX = spec.positionMode === 'ratio' ? spec.offsetX * width : spec.offsetX;
  const offsetY = spec.positionMode === 'ratio' ? spec.offsetY * canvasHeight : spec.offsetY;
  const maxX = Math.max(width - effectiveWidth, 0);
  const maxY = Math.max(canvasHeight - effectiveHeight, 0);

  let positionX = 0;
  let positionY = 0;
  switch (spec.anchor) {
    case 'top-left':
      positionX = offsetX;
      positionY = offsetY;
      break;
    case 'top-right':
      positionX = width - effectiveWidth - offsetX;
      positionY = offsetY;
      break;
    case 'bottom-left':
      positionX = offsetX;
      positionY = canvasHeight - effectiveHeight - offsetY;
      break;
    case 'bottom-right':
    default:
      positionX = width - effectiveWidth - offsetX;
      positionY = canvasHeight - effectiveHeight - offsetY;
      break;
  }

  positionX = clampPixel(positionX, 0, maxX);
  positionY = clampPixel(positionY, 0, maxY);
  const watermarkRect = { x: positionX, y: positionY, width: effectiveWidth, height: effectiveHeight };
  const activeAnchor = getDominantAnchor(watermarkRect, width, canvasHeight, spec.anchor);
  const distanceLabels = {
    top: Math.round(watermarkRect.y),
    right: Math.round(Math.max(0, width - (watermarkRect.x + watermarkRect.width))),
    bottom: Math.round(Math.max(0, canvasHeight - (watermarkRect.y + watermarkRect.height))),
    left: Math.round(watermarkRect.x),
  };
  const activeSides = {
    top: spec.anchor === 'top-left' || spec.anchor === 'top-right',
    right: spec.anchor === 'top-right' || spec.anchor === 'bottom-right',
    bottom: spec.anchor === 'bottom-left' || spec.anchor === 'bottom-right',
    left: spec.anchor === 'top-left' || spec.anchor === 'bottom-left',
  };

  // 使用 ref 存储回调和位置，避免依赖变化导致拖拽中断
  const posRef = useRef({ x: positionX, y: positionY });
  const watermarkSizeRef = useRef({ width: measuredWidth, height: measuredHeight });
  const callbackRef = useRef(onPositionChange);
  const sizeRef = useRef({ width, height: canvasHeight });
  const modeRef = useRef(spec.positionMode);
  const anchorRef = useRef(spec.anchor);
  posRef.current = { x: positionX, y: positionY };
  watermarkSizeRef.current = { width: measuredWidth, height: measuredHeight };
  callbackRef.current = onPositionChange;
  sizeRef.current = { width, height: canvasHeight };
  modeRef.current = spec.positionMode;
  anchorRef.current = spec.anchor;

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const target = contentRef.current;

    const updateSize = () => {
      const textRect = textRef.current?.getBoundingClientRect();
      if (!textRect || !textRect.width || !textRect.height) return;
      const iconRect = iconRef.current?.getBoundingClientRect();
      const iconWidth = iconRect?.width ?? 0;
      const iconHeight = iconRect?.height ?? 0;
      const combinedWidth = textRect.width + (iconWidth ? iconWidth + gap : 0) + decorationPadding * 2;
      const combinedHeight = Math.max(textRect.height, iconHeight) + decorationPadding * 2;
      setWatermarkSize((prev) => {
        if (Math.abs(prev.width - combinedWidth) < 0.5 && Math.abs(prev.height - combinedHeight) < 0.5) {
          return prev;
        }
        return { width: combinedWidth, height: combinedHeight };
      });
      lastMeasuredSizeRef.current = { width: combinedWidth, height: combinedHeight };
      if (fontReady) {
        setMeasuredSignature(measureSignature);
      }
    };

    updateSize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateSize());
      observer.observe(target);
    }

    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => updateSize());
    }
    if (document.fonts?.load) {
      void document.fonts.load(`${fontSize}px "${fontFamily}"`).then(() => updateSize()).catch(() => undefined);
    }

    const raf = window.requestAnimationFrame(() => updateSize());
    const timeout = window.setTimeout(() => updateSize(), 0);
    const timeout2 = window.setTimeout(() => updateSize(), 120);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
      window.clearTimeout(timeout2);
      observer?.disconnect();
    };
  }, [
    spec.text,
    spec.iconEnabled,
    spec.iconImageRef,
    spec.backgroundEnabled,
    spec.borderEnabled,
    fontFamily,
    fontSize,
    width,
    canvasHeight,
    measureTick,
    fontReady,
  ]);

  useEffect(() => {
    if (!draggable || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const watermark = canvas.querySelector('[data-watermark]') as HTMLElement | null;
    if (!watermark) return;

    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { width: w, height: h } = sizeRef.current;
      const { width: wmW, height: wmH } = watermarkSizeRef.current;
      const maxX = Math.max(w - wmW, 0);
      const maxY = Math.max(h - wmH, 0);
      const nextX = clampPixel(event.clientX - rect.left - dragOffsetX, 0, maxX);
      const nextY = clampPixel(event.clientY - rect.top - dragOffsetY, 0, maxY);
      const nextRect = { x: nextX, y: nextY, width: wmW, height: wmH };
      const nextAnchor = getDominantAnchor(nextRect, w, h, anchorRef.current);
      const offsets = computeOffsetsFromAnchor(nextAnchor, nextRect, w, h);
      const storeX = modeRef.current === 'ratio' ? offsets.x / w : offsets.x;
      const storeY = modeRef.current === 'ratio' ? offsets.y / h : offsets.y;
      callbackRef.current?.({ anchor: nextAnchor, offsetX: storeX, offsetY: storeY });
    };

    const handlePointerUp = (event: PointerEvent) => {
      watermark.releasePointerCapture(event.pointerId);
      watermark.removeEventListener('pointermove', handlePointerMove);
      watermark.removeEventListener('pointerup', handlePointerUp);
      watermark.style.cursor = 'grab';
    };

    const handlePointerDown = (event: PointerEvent) => {
      event.preventDefault();
      watermark.setPointerCapture(event.pointerId);
      watermark.style.cursor = 'grabbing';
      const rect = canvas.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left - posRef.current.x;
      dragOffsetY = event.clientY - rect.top - posRef.current.y;
      watermark.addEventListener('pointermove', handlePointerMove);
      watermark.addEventListener('pointerup', handlePointerUp);
    };

    watermark.addEventListener('pointerdown', handlePointerDown);
    return () => {
      watermark.removeEventListener('pointerdown', handlePointerDown);
      watermark.removeEventListener('pointermove', handlePointerMove);
      watermark.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggable]);

  const distanceWrapperStyle = distancePlacement === 'outside'
    ? { inset: -18 }
    : { inset: 6 };
  const topLabelClass = distancePlacement === 'outside'
    ? 'absolute left-1/2 top-0 -translate-x-1/2 text-[11px] font-semibold'
    : 'absolute left-1/2 top-2 -translate-x-1/2 text-[11px] font-semibold';
  const bottomLabelClass = distancePlacement === 'outside'
    ? 'absolute left-1/2 bottom-0 -translate-x-1/2 text-[11px] font-semibold'
    : 'absolute left-1/2 bottom-2 -translate-x-1/2 text-[11px] font-semibold';
  const leftLabelClass = distancePlacement === 'outside'
    ? 'absolute left-0 top-1/2 -translate-y-1/2 text-[11px] font-semibold'
    : 'absolute left-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold';
  const rightLabelClass = distancePlacement === 'outside'
    ? 'absolute right-0 top-1/2 -translate-y-1/2 text-[11px] font-semibold'
    : 'absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold';

  return (
    <div
      ref={canvasRef}
      className="relative"
      style={{
        width,
        height: canvasHeight,
        background: previewImage ? `url(${previewImage}) center/cover no-repeat` : 'rgba(255,255,255,0.04)',
        border: '1px dashed rgba(255,255,255,0.12)',
        overflow: showDistances && distancePlacement === 'outside' ? 'visible' : 'hidden',
      }}
    >
      {showCrosshair ? (
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
          <div className="absolute left-1/2 top-0 h-full w-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
          <div className="absolute top-1/2 left-0 w-full h-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
          <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
            {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as WatermarkAnchor[]).map((anchor) => (
              <div
                key={anchor}
                className="flex items-center justify-center"
                style={{
                  background: activeAnchor === anchor ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <span style={{ color: 'var(--text-primary)', opacity: 0.2, fontSize: 12 }}>
                  {anchorLabelMap[anchor]}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {showDistances ? (
        <div className="absolute pointer-events-none" style={{ zIndex: 2, ...distanceWrapperStyle }}>
          <div
            className={topLabelClass}
            style={{ color: activeSides.top ? '#FF5C77' : 'rgba(255,255,255,0.32)' }}
          >
            {distanceLabels.top}px
          </div>
          <div
            className={rightLabelClass}
            style={{ color: activeSides.right ? '#FF5C77' : 'rgba(255,255,255,0.32)' }}
          >
            {distanceLabels.right}px
          </div>
          <div
            className={bottomLabelClass}
            style={{ color: activeSides.bottom ? '#FF5C77' : 'rgba(255,255,255,0.32)' }}
          >
            {distanceLabels.bottom}px
          </div>
          <div
            className={leftLabelClass}
            style={{ color: activeSides.left ? '#FF5C77' : 'rgba(255,255,255,0.32)' }}
          >
            {distanceLabels.left}px
          </div>
        </div>
      ) : null}
      <div
        data-watermark
        ref={watermarkRef}
        className="absolute"
        style={{
          left: positionX,
          top: positionY,
          transform: 'translate(0, 0)',
          opacity: spec.opacity,
          zIndex: 1,
          visibility: hideUntilMeasured ? 'hidden' : 'visible',
          pointerEvents: draggable ? 'auto' : 'none',
          cursor: draggable ? 'grab' : 'default',
          userSelect: draggable ? 'none' : undefined,
          WebkitUserSelect: draggable ? 'none' : undefined,
          touchAction: 'none',
          padding: draggable ? 12 : 0,
          margin: draggable ? -12 : 0,
        }}
      >
        <div
          ref={contentRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: gap,
            color: textColor,
            fontFamily,
            fontSize,
            padding: decorationPadding,
            background: spec.backgroundEnabled ? backgroundColor : 'transparent',
            border: spec.borderEnabled ? `1px solid ${textColor}` : '1px solid transparent',
            borderRadius: spec.backgroundEnabled || spec.borderEnabled ? 8 : 0,
          }}
        >
          {spec.iconEnabled && spec.iconImageRef ? (
            <img
              src={spec.iconImageRef}
              alt="watermark icon"
              draggable={false}
              ref={iconRef}
              onLoad={() => setMeasureTick((value) => value + 1)}
              style={{
                width: iconSize,
                height: iconSize,
                objectFit: 'contain',
                flexShrink: 0,
              }}
            />
          ) : null}
          <span ref={textRef} style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>
            {spec.text}
          </span>
        </div>
      </div>
    </div>
  );
}
