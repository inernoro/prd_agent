import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { getModelSizes, getWatermark, getWatermarkFonts, putWatermark } from '@/services';
import type { ModelSizeInfo, WatermarkFontInfo, WatermarkSpec, WatermarkSettings } from '@/services/contracts/watermark';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X } from 'lucide-react';

const DEFAULT_CANVAS_SIZE = 320;
const DEFAULT_SIZES: ModelSizeInfo[] = [
  { width: 1024, height: 1024, label: '1024x1024', ratio: 1 },
  { width: 1536, height: 1024, label: '1536x1024', ratio: 1.5 },
  { width: 1024, height: 1536, label: '1024x1536', ratio: 0.6667 },
  { width: 1344, height: 768, label: '1344x768', ratio: 1.75 },
  { width: 768, height: 1344, label: '768x1344', ratio: 0.5714 },
  { width: 1600, height: 900, label: '1600x900', ratio: 1.7778 },
  { width: 900, height: 1600, label: '900x1600', ratio: 0.5625 },
];

const createTextMeasurer = () => {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  return (text: string, fontFamily: string, fontSize: number) => {
    if (!canvas) return { width: text.length * fontSize * 0.6, height: fontSize };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: text.length * fontSize * 0.6, height: fontSize };
    ctx.font = `${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText(text);
    return { width: metrics.width, height: fontSize };
  };
};

const measureText = createTextMeasurer();

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
  const previewSizes = sizes.length ? sizes : DEFAULT_SIZES;

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
            const width = 180;
            const height = Math.round((size.height / size.width) * width);
            return (
              <div key={size.label} className="rounded-[12px] p-2" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>{size.label}</div>
                <WatermarkPreview
                  spec={spec}
                  font={currentFont}
                  size={width}
                  height={height}
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
  const scale = width / (spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE);
  const fontSize = spec.fontSizePx * scale;
  const textMetrics = measureText(spec.text, fontFamily, fontSize);
  const textWidth = textMetrics.width;
  const textHeight = fontSize;
  const iconSize = fontSize;
  const gap = fontSize / 4;

  const centerX = spec.posXRatio * width;
  const centerY = spec.posYRatio * width;

  useEffect(() => {
    if (!draggable || !canvasRef.current || !onPositionChange) return;
    const canvas = canvasRef.current;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const rect = canvas.getBoundingClientRect();
      const nextX = clamp((event.clientX - rect.left - offsetX) / width);
      const nextY = clamp((event.clientY - rect.top - offsetY) / width);
      onPositionChange(nextX, nextY);
    };

    const handlePointerUp = () => {
      dragging = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest('[data-watermark]')) return;
      dragging = true;
      const rect = canvas.getBoundingClientRect();
      const currentCenterX = spec.posXRatio * width;
      const currentCenterY = spec.posYRatio * width;
      offsetX = event.clientX - rect.left - currentCenterX;
      offsetY = event.clientY - rect.top - currentCenterY;
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggable, onPositionChange, spec.posXRatio, spec.posYRatio, width]);

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
          opacity: spec.opacity,
          color: spec.color || '#fff',
          fontFamily,
          fontSize,
          pointerEvents: draggable ? 'auto' : 'none',
          cursor: draggable ? 'grab' : 'default',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: 'translate(-50%, -50%)',
            whiteSpace: 'nowrap',
            lineHeight: 1,
          }}
        >
          {spec.text}
        </span>
        {spec.iconEnabled && spec.iconImageRef ? (
          <img
            src={spec.iconImageRef}
            alt="watermark icon"
            style={{
              position: 'absolute',
              width: iconSize,
              height: iconSize,
              left: -(textWidth / 2 + gap + iconSize),
              top: -textHeight / 2,
              objectFit: 'contain',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
