import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { deleteWatermarkFont, getModelSizes, getWatermark, getWatermarkFonts, putWatermark, uploadWatermarkFont } from '@/services';
import type { ModelSizeInfo, WatermarkFontInfo, WatermarkSpec, WatermarkSettings } from '@/services/contracts/watermark';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X, ChevronDown, Trash2, Square, PaintBucket, Type, Droplet } from 'lucide-react';

const DEFAULT_CANVAS_SIZE = 320;
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

const normalizeSpec = (spec: WatermarkSpec): WatermarkSpec => ({
  ...spec,
  positionMode: spec.positionMode ?? 'pixel',
  anchor: spec.anchor ?? 'bottom-right',
  offsetX: Number.isFinite(spec.offsetX) ? spec.offsetX : 24,
  offsetY: Number.isFinite(spec.offsetY) ? spec.offsetY : 24,
  borderEnabled: Boolean(spec.borderEnabled),
  backgroundEnabled: Boolean(spec.backgroundEnabled),
  textColor: spec.textColor ?? spec.color ?? '#FFFFFF',
  backgroundColor: spec.backgroundColor ?? '#000000',
});

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

function useFontFace(fonts: WatermarkFontInfo[]) {
  useEffect(() => {
    if (!fonts.length) return;
    const styleId = 'watermark-font-face';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = fonts
      .map((font) => `@font-face { font-family: "${font.fontFamily}"; src: url("${font.fontFileUrl}"); font-display: swap; }`)
      .join('\n');
  }, [fonts]);
}

export function WatermarkSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<WatermarkFontInfo[]>([]);
  const [settings, setSettings] = useState<WatermarkSettings | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSpec, setDraftSpec] = useState<WatermarkSpec | null>(null);
  const [fontUploading, setFontUploading] = useState(false);
  const [fontDeletingKey, setFontDeletingKey] = useState<string | null>(null);

  useFontFace(fonts);

  const fontMap = useMemo(() => new Map(fonts.map((f) => [f.fontKey, f])), [fonts]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wmRes, fontRes] = await Promise.all([getWatermark(), getWatermarkFonts()]);
      if (fontRes?.success) {
        setFonts(fontRes.data || []);
      }
      if (wmRes?.success) {
        setSettings(wmRes.data ? { ...wmRes.data, spec: normalizeSpec(wmRes.data.spec) } : null);
      } else if (fontRes?.success) {
        const defaultFont = fontRes.data?.[0]?.fontKey || 'dejavu-sans';
        setSettings({ enabled: false, spec: buildDefaultSpec(defaultFont) });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const spec = settings?.spec;
  const currentFont = spec ? fontMap.get(spec.fontKey) : null;

  const saveSpec = useCallback(
    async (next: WatermarkSpec) => {
      setSaving(true);
      try {
        const res = await putWatermark({ spec: next });
        if (res?.success) {
          setSettings(res.data || null);
        }
      } finally {
        setSaving(false);
      }
    },
    []
  );

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
    const next = { ...spec, enabled: !spec.enabled };
    await saveSpec(next);
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
              background: spec?.enabled ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.12)',
              border: spec?.enabled ? '1px solid rgba(214, 178, 106, 0.5)' : '1px solid rgba(255,255,255,0.18)',
            }}
            onClick={toggleEnabled}
            disabled={saving || !spec}
            title={spec?.enabled ? '关闭水印' : '开启水印'}
          >
            <span
              className="absolute top-[2px] transition-all"
              style={{
                left: spec?.enabled ? 24 : 2,
                width: 20,
                height: 20,
                borderRadius: 10,
                background: spec?.enabled ? '#1a1206' : 'rgba(255,255,255,0.9)',
                boxShadow: spec?.enabled ? '0 2px 6px rgba(0,0,0,0.25)' : 'none',
              }}
            />
          </button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              if (spec) setDraftSpec({ ...spec });
              setEditorOpen(true);
            }}
            disabled={!spec}
          >
            <Pencil size={14} />
            编辑
          </Button>
        </div>
      </div>

      {spec ? (
        <div className="grid gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <div className="flex items-center justify-between">
            <span>文本</span>
            <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>{spec.text}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>字体</span>
            <span style={{ color: 'var(--text-primary)' }}>{currentFont?.displayName || spec.fontKey}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>字号</span>
            <span style={{ color: 'var(--text-primary)' }}>{spec.fontSizePx}px</span>
          </div>
          <div className="flex items-center justify-between">
            <span>透明度</span>
            <span style={{ color: 'var(--text-primary)' }}>{Math.round(spec.opacity * 100)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span>位置</span>
            <span style={{ color: 'var(--text-primary)' }}>
              {anchorLabelMap[spec.anchor]} · {modeLabelMap[spec.positionMode]}
              ({spec.offsetX.toFixed(spec.positionMode === 'ratio' ? 2 : 0)},
              {spec.offsetY.toFixed(spec.positionMode === 'ratio' ? 2 : 0)})
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>图标</span>
            <span style={{ color: 'var(--text-primary)' }}>{spec.iconEnabled ? '已启用' : '未启用'}</span>
          </div>
        </div>
      ) : (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无水印配置</div>
      )}

      <Dialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title="水印编辑"
        description="配置文本、字体、位置与多尺寸预览"
        maxWidth={980}
        content={draftSpec ? (
          <WatermarkEditor
            spec={draftSpec}
            fonts={fonts}
            fontUploading={fontUploading}
            fontDeletingKey={fontDeletingKey}
            onChange={setDraftSpec}
            onCancel={() => setEditorOpen(false)}
            onUploadFont={handleFontUpload}
            onDeleteFont={handleFontDelete}
            onSave={async () => {
              if (!draftSpec) return;
              await saveSpec(draftSpec);
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
  onCancel: () => void;
  onSave: () => void;
}) {
  const { spec, fonts, fontUploading, fontDeletingKey, onChange, onUploadFont, onDeleteFont, onCancel, onSave } = props;
  const [sizes, setSizes] = useState<ModelSizeInfo[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0, 1fr) 280px' }}>
        <div className="rounded-[16px] p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>1:1 演示画布</div>
          <div className="flex items-center justify-center">
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
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>水印文本</div>
            <input
              value={spec.text}
              onChange={(e) => updateSpec({ text: e.target.value })}
              className="mt-2 w-full rounded-[12px] px-3 py-2 text-sm outline-none prd-field"
              placeholder="请输入水印文案"
            />
          </div>

          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>字体</div>
            <div className="mt-2 flex items-center gap-2">
              <FontSelect
                value={spec.fontKey}
                fonts={fonts}
                deletingKey={fontDeletingKey}
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
          </div>

          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>字号</div>
            <select
              value={spec.fontSizePx}
              onChange={(e) => updateSpec({ fontSizePx: Number(e.target.value) })}
              className="mt-2 w-full rounded-[12px] px-3 py-2 text-sm outline-none prd-field"
            >
              {[18, 22, 26, 28, 32, 36, 42, 48].map((size) => (
                <option key={size} value={size}>{size}px</option>
              ))}
            </select>
          </div>

          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>透明度</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={spec.opacity}
              onChange={(e) => updateSpec({ opacity: Number(e.target.value) })}
              className="mt-2 w-full"
            />
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {Math.round(spec.opacity * 100)}%
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>定位方式</div>
            <select
              value={spec.positionMode}
              onChange={(e) => {
                const nextMode = e.target.value as WatermarkSpec['positionMode'];
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
              className="mt-2 w-full rounded-[12px] px-3 py-2 text-sm outline-none prd-field"
            >
              <option value="pixel">按像素</option>
              <option value="ratio">按比例</option>
            </select>
          </div>

          <div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label
                className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-[10px] cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                title="上传图标"
              >
                <UploadCloud size={14} />
                上传图标
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => void handleIconUpload(e.target.files?.[0] ?? null)}
                />
              </label>
              {spec.iconEnabled && spec.iconImageRef ? (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => updateSpec({ iconEnabled: false, iconImageRef: null })}
                  title="移除图标"
                >
                  移除
                </Button>
              ) : null}
              <button
                type="button"
                className="h-9 w-9 rounded-[10px] inline-flex items-center justify-center"
                style={{
                  background: spec.borderEnabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: spec.borderEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="是否边框"
                onClick={() => updateSpec({ borderEnabled: !spec.borderEnabled })}
              >
                <Square size={16} />
              </button>
              <button
                type="button"
                className="h-9 w-9 rounded-[10px] inline-flex items-center justify-center"
                style={{
                  background: spec.backgroundEnabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: spec.backgroundEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="填充背景"
                onClick={() => updateSpec({ backgroundEnabled: !spec.backgroundEnabled })}
              >
                <PaintBucket size={16} />
              </button>
              <label
                className="relative h-9 w-9 rounded-[10px] inline-flex items-center justify-center cursor-pointer"
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
                  onChange={(e) => updateSpec({ textColor: e.target.value })}
                />
              </label>
              <label
                className="relative h-9 w-9 rounded-[10px] inline-flex items-center justify-center cursor-pointer"
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

      <div className="border-t" style={{ borderColor: 'var(--border-subtle)' }} />

      <div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>多尺寸同步预览</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>按当前模型支持的尺寸展示（每行 4 个）</div>
          </div>
          <label className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-[10px] cursor-pointer"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          >
            <ImageIcon size={14} />
            上传底图
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handlePreviewUpload(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {(loadingSizes ? Array.from<ModelSizeInfo | undefined>({ length: 4 }) : previewSizes).map((size, idx) => {
            if (!size) {
              return (
                <div key={`placeholder-${idx}`} className="h-[120px] rounded-[12px]" style={{ background: 'rgba(255,255,255,0.06)' }} />
              );
            }
            const previewWidth = 180;
            const previewHeight = Math.round((size.height / size.width) * previewWidth);
            return (
              <div key={size.label} className="rounded-[12px] p-2" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>{size.label}</div>
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

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          <X size={14} />
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={onSave}>
          <Check size={14} />
          保存
        </Button>
      </div>
    </div>
  );
}

function FontSelect(props: {
  value: string;
  fonts: WatermarkFontInfo[];
  deletingKey: string | null;
  onChange: (fontKey: string) => void;
  onDelete: (font: WatermarkFontInfo) => void;
}) {
  const { value, fonts, deletingKey, onChange, onDelete } = props;
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
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 rounded-[14px] overflow-hidden"
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
  const [watermarkSize, setWatermarkSize] = useState({ width: 0, height: 0 });
  const [measureTick, setMeasureTick] = useState(0);

  const estimatedTextWidth = Math.max(spec.text.length, 1) * fontSize * 0.6;
  const estimatedWidth = estimatedTextWidth + (spec.iconEnabled && spec.iconImageRef ? iconSize + gap : 0) + decorationPadding * 2;
  const estimatedHeight = Math.max(fontSize, iconSize) + decorationPadding * 2;
  const measuredWidth = watermarkSize.width || estimatedWidth;
  const measuredHeight = watermarkSize.height || estimatedHeight;

  const offsetX = spec.positionMode === 'ratio' ? spec.offsetX * width : spec.offsetX;
  const offsetY = spec.positionMode === 'ratio' ? spec.offsetY * canvasHeight : spec.offsetY;
  const maxX = Math.max(width - measuredWidth, 0);
  const maxY = Math.max(canvasHeight - measuredHeight, 0);

  let positionX = 0;
  let positionY = 0;
  switch (spec.anchor) {
    case 'top-left':
      positionX = offsetX;
      positionY = offsetY;
      break;
    case 'top-right':
      positionX = width - measuredWidth - offsetX;
      positionY = offsetY;
      break;
    case 'bottom-left':
      positionX = offsetX;
      positionY = canvasHeight - measuredHeight - offsetY;
      break;
    case 'bottom-right':
    default:
      positionX = width - measuredWidth - offsetX;
      positionY = canvasHeight - measuredHeight - offsetY;
      break;
  }

  positionX = clampPixel(positionX, 0, maxX);
  positionY = clampPixel(positionY, 0, maxY);
  const watermarkRect = { x: positionX, y: positionY, width: measuredWidth, height: measuredHeight };
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
      void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => updateSize()).catch(() => undefined);
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
