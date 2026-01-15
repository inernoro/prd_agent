import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { getModelSizes, getWatermark, getWatermarkFonts, putWatermark } from '@/services';
import type { ModelSizeInfo, WatermarkFontInfo, WatermarkSpec, WatermarkSettings } from '@/services/contracts/watermark';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X } from 'lucide-react';

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
  baseCanvasWidth: DEFAULT_CANVAS_SIZE,
  modelKey: 'default',
  color: '#FFFFFF',
});

const normalizeSpec = (spec: WatermarkSpec): WatermarkSpec => ({
  ...spec,
  positionMode: spec.positionMode ?? 'pixel',
  anchor: spec.anchor ?? 'bottom-right',
  offsetX: Number.isFinite(spec.offsetX) ? spec.offsetX : 24,
  offsetY: Number.isFinite(spec.offsetY) ? spec.offsetY : 24,
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
            onChange={setDraftSpec}
            onCancel={() => setEditorOpen(false)}
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
  onChange: (spec: WatermarkSpec) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { spec, fonts, onChange, onCancel, onSave } = props;
  const [sizes, setSizes] = useState<ModelSizeInfo[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loadingSizes, setLoadingSizes] = useState(false);
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
            <select
              value={spec.fontKey}
              onChange={(e) => updateSpec({ fontKey: e.target.value })}
              className="mt-2 w-full rounded-[12px] px-3 py-2 text-sm outline-none prd-field"
            >
              {fonts.map((font) => (
                <option key={font.fontKey} value={font.fontKey}>{font.displayName}</option>
              ))}
            </select>
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
            <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>水印图标</div>
            <div className="mt-2 flex items-center gap-2">
              <label className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-[10px] cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
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
                >
                  移除
                </Button>
              ) : null}
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
                <WatermarkPreview
                  spec={spec}
                  font={currentFont}
                  size={previewWidth}
                  height={previewHeight}
                  previewImage={previewImage}
                  showDistances
                  distancePlacement="inside"
                />
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

  const watermarkRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLImageElement | null>(null);
  const [watermarkSize, setWatermarkSize] = useState({ width: 0, height: 0 });
  const [measureTick, setMeasureTick] = useState(0);

  const estimatedTextWidth = Math.max(spec.text.length, 1) * fontSize * 0.6;
  const estimatedWidth = estimatedTextWidth + (spec.iconEnabled && spec.iconImageRef ? iconSize + gap : 0);
  const estimatedHeight = Math.max(fontSize, iconSize);
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
      const combinedWidth = textRect.width + (iconWidth ? iconWidth + gap : 0);
      const combinedHeight = Math.max(textRect.height, iconHeight);
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
      void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => updateSize());
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
  }, [spec.text, spec.iconEnabled, spec.iconImageRef, fontFamily, fontSize, width, canvasHeight, measureTick]);

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
      className="relative rounded-[12px]"
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
            color: spec.color || '#fff',
            fontFamily,
            fontSize,
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
