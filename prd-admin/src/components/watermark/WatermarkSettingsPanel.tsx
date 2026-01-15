import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

const buildDefaultSpec = (fontKey: string): WatermarkSpec => ({
  enabled: false,
  text: '米多AI生成',
  fontKey,
  fontSizePx: 28,
  opacity: 0.6,
  posXRatio: 0.8,
  posYRatio: 0.8,
  iconEnabled: false,
  iconImageRef: null,
  baseCanvasWidth: DEFAULT_CANVAS_SIZE,
  modelKey: 'default',
  color: '#FFFFFF',
});

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
        setSettings(wmRes.data || null);
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
            <span style={{ color: 'var(--text-primary)' }}>{spec.posXRatio.toFixed(2)}, {spec.posYRatio.toFixed(2)}</span>
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
          <WatermarkPreview
            spec={spec}
            font={currentFont}
            size={spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE}
            previewImage={previewImage}
            draggable
            onPositionChange={(x, y) => updateSpec({ posXRatio: x, posYRatio: y })}
          />
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
  onPositionChange?: (x: number, y: number) => void;
}) {
  const { spec, font, size, height, previewImage, draggable, onPositionChange } = props;
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

  // 水印位置：基于画布宽高计算，保持比例一致
  // posXRatio/posYRatio 范围 0~1，0.5 表示中心
  const offsetX = spec.posXRatio - 0.5; // 相对于中心的 X 偏移
  const offsetY = spec.posYRatio - 0.5; // 相对于中心的 Y 偏移
  const centerX = width / 2 + offsetX * width;
  const centerY = canvasHeight / 2 + offsetY * canvasHeight;

  // 使用 ref 存储回调和位置，避免依赖变化导致拖拽中断
  const posRef = useRef({ x: spec.posXRatio, y: spec.posYRatio });
  const callbackRef = useRef(onPositionChange);
  const sizeRef = useRef({ width, height: canvasHeight });
  posRef.current = { x: spec.posXRatio, y: spec.posYRatio };
  callbackRef.current = onPositionChange;
  sizeRef.current = { width, height: canvasHeight };

  useEffect(() => {
    if (!draggable || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const watermark = canvas.querySelector('[data-watermark]') as HTMLElement | null;
    if (!watermark) return;

    let offsetX = 0;
    let offsetY = 0;

    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { width: w, height: h } = sizeRef.current;
      const nextX = clamp((event.clientX - rect.left - offsetX) / w);
      const nextY = clamp((event.clientY - rect.top - offsetY) / h);
      callbackRef.current?.(nextX, nextY);
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
      const { width: w, height: h } = sizeRef.current;
      offsetX = event.clientX - rect.left - posRef.current.x * w;
      offsetY = event.clientY - rect.top - posRef.current.y * h;
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

  return (
    <div
      ref={canvasRef}
      className="relative overflow-hidden rounded-[12px]"
      style={{
        width,
        height: canvasHeight,
        background: previewImage ? `url(${previewImage}) center/cover no-repeat` : 'rgba(255,255,255,0.04)',
        border: '1px dashed rgba(255,255,255,0.12)',
      }}
    >
      <div
        data-watermark
        className="absolute"
        style={{
          left: centerX,
          top: centerY,
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          gap: gap,
          padding: draggable ? 12 : 0,
          margin: draggable ? -12 : 0,
          opacity: spec.opacity,
          color: spec.color || '#fff',
          fontFamily,
          fontSize,
          pointerEvents: draggable ? 'auto' : 'none',
          cursor: draggable ? 'grab' : 'default',
          userSelect: draggable ? 'none' : undefined,
          WebkitUserSelect: draggable ? 'none' : undefined,
          touchAction: 'none',
        }}
      >
        {spec.iconEnabled && spec.iconImageRef ? (
          <img
            src={spec.iconImageRef}
            alt="watermark icon"
            draggable={false}
            style={{
              width: iconSize,
              height: iconSize,
              objectFit: 'contain',
              flexShrink: 0,
            }}
          />
        ) : null}
        <span style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>
          {spec.text}
        </span>
      </div>
    </div>
  );
}
