import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { WatermarkDescriptionGrid } from '@/components/watermark/WatermarkDescriptionGrid';
import { ColorPicker } from '@/components/watermark/ColorPicker';
import { Dialog } from '@/components/ui/Dialog';
import {
  deleteWatermarkFont,
  getWatermarks,
  getWatermarkFonts,
  createWatermark,
  updateWatermark,
  deleteWatermark,
  bindWatermarkApp,
  unbindWatermarkApp,
  uploadWatermarkFont,
  uploadWatermarkIcon,
  testWatermark,
  publishWatermark,
  unpublishWatermark,
} from '@/services';
import type { WatermarkFontInfo, WatermarkConfig } from '@/services/contracts/watermark';
import { toast } from '@/lib/toast';
import { glassPopoverCompact, glassBadge, glassPanel } from '@/lib/glassStyles';
import { systemDialog } from '@/lib/systemDialog';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X, ChevronDown, Trash2, Droplet, Plus, CheckCircle2, FlaskConical, Share2, GitFork, Eye, PaintBucket } from 'lucide-react';

const DEFAULT_CANVAS_SIZE = 320;
const watermarkSizeCache = new Map<string, { width: number; height: number }>();
const createSpecId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `wm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
const clampPixel = (value: number, min = 0, max = 0) => Math.min(Math.max(value, min), max);

type WatermarkAnchor = WatermarkConfig['anchor'];

const anchorLabelMap: Record<WatermarkAnchor, string> = {
  'top-left': '左上',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-right': '右下',
};

const modeLabelMap: Record<WatermarkConfig['positionMode'], string> = {
  pixel: '按像素',
  ratio: '按比例',
};

// appKey 到显示名称的映射
const appKeyLabelMap: Record<string, string> = {
  'literary-agent': '文学创作',
  'visual-agent': '视觉创作',
  'prd-agent': '米多智能体平台',
};

const SectionLabel = ({ label }: { label: string }) => (
  <div className="text-[12px] font-semibold self-center text-center" style={{ color: 'var(--text-muted)' }}>
    {label}
  </div>
);

const InlineLabel = ({ label }: { label: string }) => (
  <div className="text-[11px] font-semibold shrink-0" style={{ color: 'var(--text-muted)' }}>
    {label}
  </div>
);

const SectionDivider = () => (
  <div className="col-span-2 border-t my-1" style={{ borderColor: 'rgba(255,255,255,0.08)' }} />
);

const buildDefaultConfig = (fontKey: string): WatermarkConfig => ({
  id: createSpecId(),
  name: '默认水印',
  appKeys: [],
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
  iconPosition: 'left',
  iconGapPx: Math.round(28 / 4),
  iconScale: 1,
  borderEnabled: false,
  borderColor: '#FFFFFF',
  borderWidth: 2,
  backgroundEnabled: false,
  roundedBackgroundEnabled: false,
  cornerRadius: 0,
  baseCanvasWidth: DEFAULT_CANVAS_SIZE,
  adaptiveScaleMode: 0,
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  previewBackgroundImageRef: null,
});

const normalizeConfig = (config: WatermarkConfig, fallbackName: string): WatermarkConfig => {
  const resolvedTextColor = config.textColor ?? '#FFFFFF';
  return {
    ...config,
    id: config.id || createSpecId(),
    name: config.name?.trim() || fallbackName,
    appKeys: config.appKeys ?? [],
    positionMode: config.positionMode ?? 'pixel',
    anchor: config.anchor ?? 'bottom-right',
    offsetX: Number.isFinite(config.offsetX) ? config.offsetX : 24,
    offsetY: Number.isFinite(config.offsetY) ? config.offsetY : 24,
    borderEnabled: Boolean(config.borderEnabled),
    borderColor: config.borderColor ?? '#FFFFFF',
    borderWidth: Number.isFinite(config.borderWidth) ? config.borderWidth : 2,
    iconPosition: (config.iconPosition ?? 'left') as 'left' | 'right' | 'top' | 'bottom',
    iconGapPx: Number.isFinite(config.iconGapPx) ? (config.iconGapPx as number) : Math.round((config.fontSizePx ?? 28) / 4),
    iconScale: Number.isFinite(config.iconScale) ? (config.iconScale as number) : 1,
    backgroundEnabled: Boolean(config.backgroundEnabled),
    roundedBackgroundEnabled: Boolean(config.roundedBackgroundEnabled),
    cornerRadius: Number.isFinite(config.cornerRadius) ? config.cornerRadius : 0,
    textColor: resolvedTextColor,
    backgroundColor: config.backgroundColor ?? '#000000',
    previewBackgroundImageRef: config.previewBackgroundImageRef ?? null,
    adaptiveScaleMode: Number.isFinite(config.adaptiveScaleMode) ? (config.adaptiveScaleMode as 0 | 1 | 2 | 3 | 4) : 0,
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

type WatermarkStatus = { hasActiveConfig: boolean; activeId?: string; activeName?: string };
export type WatermarkSettingsPanelHandle = { addSpec: () => void; editCurrentSpec: () => void };
type WatermarkSettingsPanelProps = {
  /** 当前应用的 appKey，用于绑定/解绑水印 */
  appKey: string;
  onStatusChange?: (status: WatermarkStatus) => void;
  hideAddButton?: boolean;
  /** 固定列数布局（与 cardWidth 互斥） */
  columns?: number;
  /** 固定卡片宽度（启用 flex-wrap 自适应布局） */
  cardWidth?: number;
};

export const WatermarkSettingsPanel = forwardRef(function WatermarkSettingsPanel(
  props: WatermarkSettingsPanelProps,
  ref: ForwardedRef<WatermarkSettingsPanelHandle>
) {
  const { appKey, onStatusChange, hideAddButton = false, columns = 1, cardWidth } = props;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<WatermarkFontInfo[]>([]);
  const [configs, setConfigs] = useState<WatermarkConfig[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftConfig, setDraftConfig] = useState<WatermarkConfig | null>(null);
  const [isNewConfig, setIsNewConfig] = useState(false);
  const [fontUploading, setFontUploading] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [fontDeletingKey, setFontDeletingKey] = useState<string | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(() => Date.now());
  const [previewErrorById, setPreviewErrorById] = useState<Record<string, boolean>>({});
  const [enlargedPreviewUrl, setEnlargedPreviewUrl] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const testInputRef = useRef<HTMLInputElement | null>(null);
  const testTargetIdRef = useRef<string | null>(null);

  const fontMap = useMemo(() => new Map(fonts.map((f) => [f.fontKey, f])), [fonts]);

  // 找到当前 appKey 绑定的水印配置
  const activeConfig = useMemo(
    () => configs.find((c) => c.appKeys?.includes(appKey)) ?? null,
    [configs, appKey]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wmRes, fontRes] = await Promise.all([getWatermarks(), getWatermarkFonts()]);
      const nextFonts = fontRes?.success ? fontRes.data || [] : [];
      if (nextFonts.length > 0) {
        setFonts(nextFonts);
      }
      const fallbackFont = nextFonts[0]?.fontKey || 'default';

      if (wmRes?.success) {
        const sourceConfigs = wmRes.data || [];
        const normalizedConfigs = sourceConfigs.map((item, index) =>
          normalizeConfig(
            {
              ...item,
              fontKey: item.fontKey || fallbackFont,
            },
            item.name || `水印配置 ${index + 1}`,
          )
        );
        // 按 ID 稳定排序，避免操作后列表重排序导致页面闪烁
        normalizedConfigs.sort((a, b) => a.id.localeCompare(b.id));
        setConfigs(normalizedConfigs);
        // 刷新缓存时间戳，确保预览图不被浏览器缓存
        setPreviewEpoch(Date.now());
      } else {
        setConfigs([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({
      hasActiveConfig: activeConfig !== null,
      activeId: activeConfig?.id,
      activeName: activeConfig?.name,
    });
  }, [onStatusChange, activeConfig]);

  useEffect(() => {
    if (!draftConfig) return;
    setTitleDraft(draftConfig.name || '');
    setTitleEditing(false);
  }, [draftConfig]);

  useEffect(() => {
    if (fonts.length === 0) return;
    const fallback = fonts.find((font) => font.fontKey === 'default')?.fontKey || fonts[0].fontKey;
    setConfigs((prev) =>
      prev.map((item) => (fontMap.has(item.fontKey) ? item : { ...item, fontKey: fallback }))
    );
  }, [fontMap, fonts]);

  const saveConfig = useCallback(
    async (config: WatermarkConfig, isNew: boolean) => {
      setSaving(true);
      try {
        if (isNew) {
          const res = await createWatermark({
            name: config.name,
            text: config.text,
            fontKey: config.fontKey,
            fontSizePx: config.fontSizePx,
            opacity: config.opacity,
            positionMode: config.positionMode,
            anchor: config.anchor,
            offsetX: config.offsetX,
            offsetY: config.offsetY,
            iconEnabled: config.iconEnabled,
            iconImageRef: config.iconImageRef,
            iconPosition: config.iconPosition ?? 'left',
            iconGapPx: config.iconGapPx ?? Math.round((config.fontSizePx ?? 28) / 4),
            iconScale: config.iconScale ?? 1,
            borderEnabled: config.borderEnabled,
            borderColor: config.borderColor,
            borderWidth: config.borderWidth,
            backgroundEnabled: config.backgroundEnabled,
            roundedBackgroundEnabled: config.roundedBackgroundEnabled,
            cornerRadius: config.cornerRadius,
            baseCanvasWidth: config.baseCanvasWidth,
            adaptiveScaleMode: config.adaptiveScaleMode ?? 0,
            textColor: config.textColor,
            backgroundColor: config.backgroundColor,
            previewBackgroundImageRef: config.previewBackgroundImageRef,
          });
          if (res?.success) {
            await load();
            setPreviewEpoch(Date.now());
          }
        } else {
          const res = await updateWatermark({
            id: config.id,
            name: config.name,
            text: config.text,
            fontKey: config.fontKey,
            fontSizePx: config.fontSizePx,
            opacity: config.opacity,
            positionMode: config.positionMode,
            anchor: config.anchor,
            offsetX: config.offsetX,
            offsetY: config.offsetY,
            iconEnabled: config.iconEnabled,
            iconImageRef: config.iconImageRef,
            iconPosition: config.iconPosition ?? 'left',
            iconGapPx: config.iconGapPx ?? Math.round((config.fontSizePx ?? 28) / 4),
            iconScale: config.iconScale ?? 1,
            borderEnabled: config.borderEnabled,
            borderColor: config.borderColor,
            borderWidth: config.borderWidth,
            backgroundEnabled: config.backgroundEnabled,
            roundedBackgroundEnabled: config.roundedBackgroundEnabled,
            cornerRadius: config.cornerRadius,
            baseCanvasWidth: config.baseCanvasWidth,
            adaptiveScaleMode: config.adaptiveScaleMode ?? 0,
            textColor: config.textColor,
            backgroundColor: config.backgroundColor,
            previewBackgroundImageRef: config.previewBackgroundImageRef,
          });
          if (res?.success) {
            await load();
            setPreviewEpoch(Date.now());
          }
        }
      } finally {
        setSaving(false);
      }
    },
    [load]
  );

  const buildPreviewUrl = useCallback((raw?: string | null) => {
    const base = String(raw || '').trim();
    if (!base) return null;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}t=${previewEpoch}`;
  }, [previewEpoch]);

  useEffect(() => {
    setPreviewErrorById({});
  }, [previewEpoch, configs]);

  const handleActivate = async (id: string) => {
    if (activeConfig?.id === id) return;
    setSaving(true);
    try {
      const res = await bindWatermarkApp({ id, appKey });
      if (res?.success) {
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    setSaving(true);
    try {
      const res = await unbindWatermarkApp({ id, appKey });
      if (res?.success) {
        await load();
        toast.success('已取消水印绑定');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTestClick = (id: string) => {
    testTargetIdRef.current = id;
    testInputRef.current?.click();
  };

  const handleTestFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0 || !testTargetIdRef.current) return;
    
    const files = Array.from(fileList);
    const id = testTargetIdRef.current;
    setTestingId(id);
    
    try {
      const result = await testWatermark({ id, files });
      if (result.success && result.blob) {
        // 触发下载
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.isZip 
          ? `watermark-test-${Date.now()}.zip` 
          : `watermark-test-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        const msg = files.length > 1 
          ? `已处理 ${files.length} 张图片，下载压缩包中` 
          : '水印测试完成，已开始下载';
        toast.success(msg);
      } else {
        toast.error('水印测试失败', result.error || '未知错误');
      }
    } catch (err) {
      toast.error('水印测试失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setTestingId(null);
      testTargetIdRef.current = null;
      if (testInputRef.current) testInputRef.current.value = '';
    }
  };

  const handleAddConfig = useCallback(() => {
    const fallbackFont = fonts[0]?.fontKey || activeConfig?.fontKey || 'default';
    const base = buildDefaultConfig(fallbackFont);
    const newConfig = normalizeConfig(
      {
        ...base,
        id: createSpecId(),
        name: `水印配置 ${configs.length + 1}`,
      },
      `水印配置 ${configs.length + 1}`
    );
    setDraftConfig({ ...newConfig });
    setIsNewConfig(true);
    setEditorOpen(true);
  }, [fonts, activeConfig, configs.length]);

  const handleEditorCancel = () => {
    setDraftConfig(null);
    setIsNewConfig(false);
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
        setDraftConfig((prev) => (prev ? { ...prev, fontKey: res.data.fontKey } : prev));
      } finally {
        setFontUploading(false);
      }
    },
    [fontUploading, refreshFonts]
  );

  const handleIconUpload = useCallback(
    async (file: File) => {
      if (iconUploading) return null;
      setIconUploading(true);
      try {
        const res = await uploadWatermarkIcon({ file });
        if (!res?.success) {
          toast.error('图标上传失败', res?.error?.message || '上传失败');
          return null;
        }
        return res.data.url;
      } finally {
        setIconUploading(false);
      }
    },
    [iconUploading]
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
          setDraftConfig((prev) => {
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

  const handleDeleteConfig = useCallback(
    async (target: WatermarkConfig) => {
      if (saving) return;
      // 第一次确认
      const confirmed = await systemDialog.confirm({
        title: '确认删除水印配置',
        message: `确定删除「${target.name || '水印配置'}」吗？`,
        tone: 'danger',
        confirmText: '删除',
        cancelText: '取消',
      });
      if (!confirmed) return;
      // 已发布到海鲜市场的配置需要二次确认
      if (target.isPublic) {
        const doubleConfirmed = await systemDialog.confirm({
          title: '⚠️ 该配置已发布到海鲜市场',
          message: '删除后其他用户将无法再下载此配置，确定要删除吗？',
          tone: 'danger',
          confirmText: '确认删除',
          cancelText: '取消',
        });
        if (!doubleConfirmed) return;
      }
      setSaving(true);
      try {
        const res = await deleteWatermark({ id: target.id });
        if (res?.success) {
          await load();
        }
      } finally {
        setSaving(false);
      }
    },
    [load, saving]
  );

  // 发布水印到海鲜市场
  const handlePublishWatermark = useCallback(
    async (target: WatermarkConfig) => {
      if (saving) return;
      setSaving(true);
      try {
        const res = await publishWatermark({ id: target.id });
        if (res?.success) {
          await load();
          toast.success('发布成功', '配置已发布到海鲜市场');
        } else {
          toast.error('发布失败', res?.error?.message || '未知错误');
        }
      } finally {
        setSaving(false);
      }
    },
    [load, saving]
  );

  // 取消发布水印
  const handleUnpublishWatermark = useCallback(
    async (target: WatermarkConfig) => {
      if (saving) return;
      const ok = await systemDialog.confirm({
        title: '确认取消发布',
        message: `确定要取消发布「${target.name || '水印配置'}」吗？取消后其他用户将无法看到此配置。`,
        tone: 'neutral',
      });
      if (!ok) return;

      setSaving(true);
      try {
        const res = await unpublishWatermark({ id: target.id });
        if (res?.success) {
          await load();
          toast.success('已取消发布');
        } else {
          toast.error('取消发布失败', res?.error?.message || '未知错误');
        }
      } finally {
        setSaving(false);
      }
    },
    [load, saving]
  );

  useImperativeHandle(ref, () => ({
    addSpec: () => {
      void handleAddConfig();
    },
    editCurrentSpec: () => {
      if (activeConfig) {
        setDraftConfig({ ...activeConfig });
        setIsNewConfig(false);
        setEditorOpen(true);
      } else {
        // 如果没有激活的配置，则新建一个
        void handleAddConfig();
      }
    },
  }), [handleAddConfig, activeConfig]);

  if (loading) {
    return (
      <div className="p-4 min-h-[260px] flex items-center justify-center rounded-[16px]" style={{ background: 'var(--bg-card)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-0 h-full flex flex-col gap-3 overflow-hidden">
      {/* 隐藏的测试文件上传 input（支持多选） */}
      <input
        ref={testInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleTestFileChange}
      />
      {!hideAddButton ? (
        <div className="flex items-center justify-end shrink-0">
          <Button variant="secondary" size="xs" onClick={handleAddConfig} disabled={saving}>
            <Plus size={14} />
            新增配置
          </Button>
        </div>
      ) : null}

      {configs.length > 0 ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-hidden">
          <div
            className={cardWidth ? "flex flex-wrap gap-3 flex-1 min-h-0 overflow-auto pr-1 content-start items-start" : "grid gap-3 flex-1 min-h-0 overflow-auto overflow-x-hidden pr-1 content-start items-start"}
            style={cardWidth ? { minWidth: 0 } : {
              gridTemplateColumns: columns > 1 ? `repeat(${columns}, minmax(0, 1fr))` : '1fr',
              gridAutoRows: 'min-content'
            }}
          >
            {configs.map((item, index) => {
              const isActive = item.appKeys?.includes(appKey);
              const fontLabel = fontMap.get(item.fontKey)?.displayName || item.fontKey;
              const previewUrl = buildPreviewUrl(item.previewUrl);
              const previewError = Boolean(previewErrorById[item.id]);
              const cardStyle = {
                ...(cardWidth ? { width: cardWidth, flexShrink: 0 } : {}),
                ...(isActive ? { border: '2px solid rgba(34, 197, 94, 0.8)', boxShadow: '0 0 16px rgba(34, 197, 94, 0.3)' } : {}),
              };
              return (
                <GlassCard
                  key={item.id || `${item.text}-${index}`}
                  className="p-0 overflow-hidden"
                  style={Object.keys(cardStyle).length > 0 ? cardStyle : undefined}
                >
                  <div className="flex flex-col">
                    <div className="p-2 pb-1 shrink-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 flex items-center gap-1.5">
                          <Droplet size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
                          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {item.name || `Watermark ${index + 1}`}
                          </div>
                          {/* 授权应用查看按钮 */}
                          <button
                            type="button"
                            className="p-0.5 rounded hover:bg-white/10 transition-colors"
                            title="点击查看授权应用"
                            style={{ color: item.appKeys && item.appKeys.length > 0 ? 'var(--text-muted)' : 'rgba(239, 68, 68, 0.6)' }}
                            onClick={() => {
                              const appNames = item.appKeys && item.appKeys.length > 0
                                ? item.appKeys.map(k => appKeyLabelMap[k] || k).join('、')
                                : null;
                              void systemDialog.alert({
                                title: '授权应用',
                                message: appNames ? `已授权给: ${appNames}` : '当前水印未授权给任何应用',
                              });
                            }}
                          >
                            <Eye size={12} />
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {/* 测试按钮（图标形式） */}
                          <button
                            type="button"
                            className="p-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                            onClick={() => handleTestClick(item.id)}
                            disabled={saving || testingId === item.id}
                            title="上传图片测试水印效果"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <FlaskConical size={14} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 配置信息区（统一高度100px，左侧两列配置 + 右侧预览图，与风格图卡片保持一致） */}
                    <div className="px-2 pb-1 flex-shrink-0">
                      <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: '100px' }}>
                        {/* 左侧：配置信息（使用共享组件，两列布局） */}
                        <WatermarkDescriptionGrid
                          data={{
                            text: item.text,
                            fontKey: item.fontKey,
                            fontLabel,
                            fontSizePx: item.fontSizePx,
                            opacity: item.opacity,
                            anchor: item.anchor,
                            offsetX: item.offsetX,
                            offsetY: item.offsetY,
                            positionMode: item.positionMode,
                            iconEnabled: item.iconEnabled,
                            borderEnabled: item.borderEnabled,
                            backgroundEnabled: item.backgroundEnabled,
                            roundedBackgroundEnabled: item.roundedBackgroundEnabled,
                          }}
                        />
                        {/* 右侧：预览图（水印是透明PNG，使用象棋格背景） */}
                        <div
                          className="flex items-center justify-center overflow-hidden rounded-[6px]"
                          style={{
                            background: previewUrl && !previewError
                              ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
                              : 'rgba(255,255,255,0.02)',
                            border: previewUrl && !previewError ? 'none' : '1px solid rgba(255,255,255,0.08)',
                            cursor: previewUrl && !previewError ? 'zoom-in' : 'default',
                          }}
                          onClick={() => {
                            if (previewUrl && !previewError) {
                              setEnlargedPreviewUrl(previewUrl);
                            }
                          }}
                          title={previewUrl && !previewError ? '点击放大' : undefined}
                        >
                          {previewUrl && !previewError ? (
                            <img
                              src={previewUrl}
                              alt="Preview"
                              className="block w-full h-full object-contain"
                              onError={() => setPreviewErrorById((prev) => ({ ...prev, [item.id]: true }))}
                            />
                          ) : (
                            <div className="text-[11px]" style={{ color: 'rgba(233,209,156,0.7)' }}>无预览</div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 操作按钮区（图标化布局） */}
                    <div className="px-2 pb-2 pt-1 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <div className="flex items-center gap-1 justify-between">
                        {/* 左侧：发布图标 + 下载次数 */}
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10 disabled:opacity-50"
                            style={{
                              color: item.isPublic ? 'rgba(251, 146, 60, 0.9)' : 'var(--text-muted)',
                              background: item.isPublic ? 'rgba(251, 146, 60, 0.1)' : 'transparent',
                            }}
                            onClick={() => item.isPublic ? void handleUnpublishWatermark(item) : void handlePublishWatermark(item)}
                            disabled={saving}
                            title={item.isPublic ? '点击取消发布' : '发布到海鲜市场'}
                          >
                            <Share2 size={14} />
                          </button>
                          {/* 下载次数 */}
                          {typeof item.forkCount === 'number' && (
                            <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              <GitFork size={10} />
                              {item.forkCount}
                            </span>
                          )}
                        </div>
                        {/* 右侧：选择 | 编辑/删除（用分隔线区分功能组） */}
                        <div className="flex items-center gap-1">
                          {/* 选择按钮 */}
                          <button
                            type="button"
                            className="px-2.5 py-1.5 rounded-md transition-all duration-200 hover:bg-white/10 disabled:opacity-50"
                            style={{
                              color: isActive ? 'white' : 'rgba(156, 163, 175, 0.6)',
                              background: isActive ? 'rgba(34, 197, 94, 0.95)' : 'transparent',
                              border: isActive ? '1px solid rgba(34, 197, 94, 0.95)' : 'none',
                              minWidth: 40,
                            }}
                            onClick={() => isActive ? handleDeactivate(item.id) : handleActivate(item.id)}
                            disabled={saving}
                            title={isActive ? '取消选择' : '选择'}
                          >
                            <CheckCircle2 size={16} />
                          </button>
                          {/* 分隔线 */}
                          <div className="h-4 w-px mx-0.5" style={{ background: 'var(--border-subtle)' }} />
                          {/* 编辑/删除按钮组 */}
                          <button
                            type="button"
                            className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10"
                            style={{ color: 'var(--text-muted)' }}
                            onClick={() => {
                              setDraftConfig({ ...item });
                              setIsNewConfig(false);
                              setEditorOpen(true);
                            }}
                            title="编辑"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="p-1.5 rounded-md transition-all duration-200 hover:bg-red-500/10 disabled:opacity-50"
                            style={{ color: 'rgba(239, 68, 68, 0.7)' }}
                            onClick={() => void handleDeleteConfig(item)}
                            disabled={saving}
                            title="删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无水印配置</div>
          <Button variant="secondary" size="sm" onClick={handleAddConfig} disabled={saving}>
            <Plus size={14} />
            创建水印
          </Button>
        </div>
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
        title={draftConfig ? (
          <div className="flex items-center gap-2">
            {titleEditing ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const nextName = titleDraft.trim();
                    if (nextName) setDraftConfig((prev) => (prev ? { ...prev, name: nextName } : prev));
                    setTitleEditing(false);
                  }
                }}
                onBlur={() => {
                  const nextName = titleDraft.trim();
                  if (nextName) setDraftConfig((prev) => (prev ? { ...prev, name: nextName } : prev));
                  setTitleEditing(false);
                }}
                className="h-8 w-48 rounded-[8px] px-3 text-sm outline-none prd-field"
                placeholder="请输入配置名称"
                autoFocus
              />
            ) : (
              <>
                <span>{draftConfig?.name?.trim() || '水印配置'}</span>
                <button
                  type="button"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-[8px] hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)' }}
                  onClick={() => setTitleEditing(true)}
                  title="编辑名称"
                >
                  <Pencil size={14} />
                </button>
              </>
            )}
          </div>
        ) : '水印配置'}
        maxWidth={920}
        contentClassName="overflow-hidden !p-4"
        contentStyle={{ maxHeight: '70vh', height: '70vh' }}
        content={draftConfig ? (
          <WatermarkEditor
            config={draftConfig}
            fonts={fonts}
            fontUploading={fontUploading}
            fontDeletingKey={fontDeletingKey}
            iconUploading={iconUploading}
            onChange={setDraftConfig}
            onUploadFont={handleFontUpload}
            onUploadIcon={handleIconUpload}
            onDeleteFont={handleFontDelete}
            onSave={async () => {
              if (!draftConfig) return;
              await saveConfig(draftConfig, isNewConfig);
              setDraftConfig(null);
              setIsNewConfig(false);
              setEditorOpen(false);
            }}
          />
        ) : null}
      />

      {/* 放大预览模态框 */}
      {enlargedPreviewUrl && (
        <div
          className="fixed inset-0 z-9999 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setEnlargedPreviewUrl(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <div
              className="rounded-lg overflow-hidden shadow-2xl"
              style={{
                // 使用棋盘格图案表示透明背景
                background: 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 20px 20px',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={enlargedPreviewUrl}
                alt="预览大图"
                className="max-w-full max-h-[90vh] object-contain"
              />
            </div>
            <button
              type="button"
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.9)' }}
              onClick={() => setEnlargedPreviewUrl(null)}
              title="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

WatermarkSettingsPanel.displayName = 'WatermarkSettingsPanel';

function WatermarkEditor(props: {
  config: WatermarkConfig;
  fonts: WatermarkFontInfo[];
  fontUploading: boolean;
  fontDeletingKey: string | null;
  iconUploading: boolean;
  onChange: (config: WatermarkConfig) => void;
  onUploadFont: (file: File) => void;
  onUploadIcon: (file: File) => Promise<string | null>;
  onDeleteFont: (font: WatermarkFontInfo) => void;
  onSave: () => void;
}) {
  const { config, fonts, fontUploading, fontDeletingKey, iconUploading, onChange, onUploadFont, onUploadIcon, onDeleteFont, onSave } = props;
  // 初始化时使用配置中保存的底图
  const [previewImage, setPreviewImage] = useState<string | null>(config.previewBackgroundImageRef ?? null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mainPreviewRef = useRef<HTMLDivElement | null>(null);
  const [mainPreviewSize, setMainPreviewSize] = useState(config.baseCanvasWidth || DEFAULT_CANVAS_SIZE);
  const [fontLoading, setFontLoading] = useState(false);
  const adaptiveScaleMode = (Number.isFinite(config.adaptiveScaleMode) ? config.adaptiveScaleMode : 0) as 0 | 1 | 2 | 3 | 4;
  const adaptiveEnabled = adaptiveScaleMode !== 0;
  const adaptiveScaleOptions: Array<{ value: 1 | 2 | 3 | 4; label: string }> = [
    { value: 1, label: '长边' },
    { value: 2, label: '短边' },
    { value: 3, label: '宽' },
    { value: 4, label: '高' },
  ];
  const iconPosition = config.iconPosition ?? 'left';
  const iconGapValue = Number.isFinite(config.iconGapPx)
    ? (config.iconGapPx as number)
    : Math.round((config.fontSizePx ?? 28) / 4);
  const iconScaleValue = Number.isFinite(config.iconScale) ? (config.iconScale as number) : 1;

  const fontMap = useMemo(() => new Map(fonts.map((f) => [f.fontKey, f])), [fonts]);
  const baseCanvasSize = config.baseCanvasWidth || DEFAULT_CANVAS_SIZE;

  useEffect(() => {
    const container = mainPreviewRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      const baseSize = config.baseCanvasWidth || DEFAULT_CANVAS_SIZE;
      const paddingAllowance = 24;
      const nextSize = Math.max(
        280,
        Math.min(width - paddingAllowance, height - paddingAllowance, Math.round(baseSize * 0.92))
      );
      setMainPreviewSize(nextSize);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [config.baseCanvasWidth]);

  const updateConfig = (patch: Partial<WatermarkConfig>) => {
    onChange({ ...config, ...patch });
  };

  const handleIconUpload = async (file: File | null) => {
    if (!file) return;
    const url = await onUploadIcon(file);
    if (!url) return;
    updateConfig({ iconEnabled: true, iconImageRef: url });
  };

  const handlePreviewUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setPreviewImage(dataUrl);
      // 保存到配置中，这样保存时会发送给后端上传到 COS
      updateConfig({ previewBackgroundImageRef: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const currentFont = fontMap.get(config.fontKey);
  useFontFace(currentFont ?? null, true);

  useEffect(() => {
    if (!currentFont?.fontFamily || !document?.fonts?.load) {
      setFontLoading(false);
      return;
    }
    setFontLoading(true);
    const fontSize = Math.max(12, Math.round(config.fontSizePx));
    document.fonts
      .load(`${fontSize}px "${currentFont.fontFamily}"`)
      .then(() => setFontLoading(false))
      .catch(() => setFontLoading(false));
  }, [currentFont?.fontFamily, config.fontSizePx]);

  return (
    <div className="flex flex-col h-full overflow-hidden -mt-1">
      <div className="grid gap-2 flex-1 overflow-hidden items-stretch" style={{ gridTemplateColumns: 'minmax(0, 1fr) 336px' }}>
        {/* 左侧: 主预览画布 */}
        <div
          ref={mainPreviewRef}
          className="relative flex items-center justify-center overflow-visible self-center"
        >
          <div
            className="absolute left-0 -top-7 text-[11px] font-semibold px-2 py-0.5 rounded-[6px]"
            style={{
              color: 'var(--text-muted)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {anchorLabelMap[config.anchor]} · {modeLabelMap[config.positionMode]}
          </div>
          <div
            className="rounded-[8px] flex items-center justify-center overflow-visible p-3 w-fit h-fit"
            style={{
              background: 'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)',
              border: '1px solid rgba(125,211,252,0.25)',
              boxShadow: '0 0 0 1px rgba(125,211,252,0.08) inset, 0 8px 24px rgba(0,0,0,0.35)',
            }}
          >
            <WatermarkPreview
              spec={config}
              font={currentFont}
              size={mainPreviewSize}
              previewImage={previewImage}
              draggable
              showCrosshair
              showDistances
              showEdgeInputs
              distancePlacement="outside"
              onPositionChange={(next) => updateConfig(next)}
            />
          </div>
        </div>

        {/* 右侧: 配置表单 */}
        <div
          className="flex flex-col gap-2 overflow-hidden rounded-[10px] p-2 h-full"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'inset 1px 0 0 var(--border-subtle)',
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-1 pt-2">
            <div className="grid gap-4" style={{ gridTemplateColumns: '48px minmax(0, 1fr)' }}>
              <SectionLabel label="文本" />
              <input
                value={config.text}
                onChange={(e) => updateConfig({ text: e.target.value })}
                className="w-full h-8 rounded-[8px] px-3 text-sm outline-none prd-field"
                placeholder="请输入水印文案"
              />

              <SectionLabel label="字体" />
              <div className="flex items-center gap-2" style={{ opacity: config.text ? 1 : 0.4, pointerEvents: config.text ? 'auto' : 'none' }}>
                <FontSelect
                  value={config.fontKey}
                  fonts={fonts}
                  deletingKey={fontDeletingKey}
                  loading={fontLoading}
                  onChange={(fontKey) => updateConfig({ fontKey })}
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
                  className="shrink-0 h-8! w-8! px-0!"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={fontUploading || !config.text}
                >
                  <UploadCloud size={14} />
                </Button>
              </div>

              <SectionLabel label="大小" />
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={5}
                  max={64}
                  step={1}
                  value={config.fontSizePx}
                  onChange={(e) => updateConfig({ fontSizePx: Number(e.target.value) })}
                  className="flex-1 min-w-0"
                />
                <div className="text-[11px] w-6 text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {Math.round(config.fontSizePx)}
                </div>
              </div>

              <SectionLabel label="透明" />
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.opacity}
                  onChange={(e) => updateConfig({ opacity: Number(e.target.value) })}
                  className="flex-1 min-w-0"
                />
                <div className="text-[11px] w-10 text-right" style={{ color: 'var(--text-muted)' }}>
                  {Math.round(config.opacity * 100)}%
                </div>
              </div>

              <SectionLabel label="文字" />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="h-8 w-8 rounded-lg inline-flex items-center justify-center"
                  style={{
                    background: config.text ? 'rgba(255,255,255,0.1)' : 'transparent',
                    border: config.text ? '1.5px solid rgba(255,255,255,0.3)' : '1.5px solid rgba(255,255,255,0.1)',
                    color: config.text ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                  title={config.text ? '点击关闭文字' : '点击开启文字'}
                  onClick={() => {
                    if (config.text) {
                      // 关闭文字时，图标间距设为0
                      updateConfig({ text: '', iconGapPx: 0 });
                    } else {
                      updateConfig({ text: '米多AI生成' });
                    }
                  }}
                >
                  字
                </button>
                {config.text && (
                  <ColorPicker
                    value={config.textColor || '#ffffff'}
                    onChange={(color) => updateConfig({ textColor: color })}
                    title="文字颜色"
                  />
                )}
              </div>

              <SectionDivider />

              <SectionLabel label="图标" />
              <div className="flex flex-col gap-3">
                {/* 图标 + 位置按钮 - 一行排列 */}
                <div className="flex items-center gap-2">
                  {/* 图标上传 */}
                  <div className="relative">
                    <label
                      className="h-8 w-8 rounded-full inline-flex items-center justify-center cursor-pointer overflow-hidden"
                      style={{
                        background: config.iconEnabled && config.iconImageRef ? 'transparent' : 'transparent',
                        border: config.iconEnabled && config.iconImageRef ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(255,255,255,0.1)',
                        color: config.iconEnabled && config.iconImageRef ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                        opacity: iconUploading ? 0.6 : 1,
                        pointerEvents: iconUploading ? 'none' : 'auto',
                      }}
                      title="上传图标"
                    >
                      {config.iconEnabled && config.iconImageRef ? (
                        <img src={config.iconImageRef} alt="水印图标" className="h-full w-full object-cover rounded-full" />
                      ) : (
                        <UploadCloud size={14} />
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => void handleIconUpload(e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {config.iconEnabled && config.iconImageRef ? (
                      <button
                        type="button"
                        className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full inline-flex items-center justify-center"
                        style={{ background: '#1a1a1a', border: '1.5px solid rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.9)' }}
                        onClick={() => updateConfig({ iconEnabled: false, iconImageRef: null })}
                        title="移除图标"
                      >
                        <X size={10} />
                      </button>
                    ) : null}
                  </div>

                  {/* 位置按钮 - 仅在有文字时显示（位置相对于文字） */}
                  {config.iconEnabled && config.text && (
                    <>
                      {([
                        { value: 'left', label: '左' },
                        { value: 'right', label: '右' },
                        { value: 'top', label: '上' },
                        { value: 'bottom', label: '下' },
                      ] as const).map((option) => {
                        const active = iconPosition === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className="h-8 w-8 rounded-full text-[11px] font-semibold transition-all"
                            style={{
                              background: active ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.06)',
                              border: active ? '1.5px solid rgba(59,130,246,0.5)' : '1.5px solid rgba(255,255,255,0.12)',
                              color: active ? 'rgba(59,130,246,0.95)' : 'var(--text-muted)',
                            }}
                            onClick={() => updateConfig({ iconPosition: option.value })}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>

                {/* 间距和缩放 - 仅在有文字+图标时显示 */}
                {config.iconEnabled && config.text && (
                  <div className="flex items-center gap-3">
                    <InlineLabel label="间距" />
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="w-14 h-8 rounded-[8px] px-2 text-sm outline-none prd-field"
                      value={iconGapValue}
                      onChange={(e) => updateConfig({ iconGapPx: Number(e.target.value) })}
                    />
                    <InlineLabel label="缩放" />
                    <input
                      type="number"
                      min={0.2}
                      max={3}
                      step={0.1}
                      className="w-14 h-8 rounded-[8px] px-2 text-sm outline-none prd-field"
                      value={iconScaleValue}
                      onChange={(e) => updateConfig({ iconScale: Number(e.target.value) })}
                    />
                  </div>
                )}
              </div>

              <SectionDivider />

              <SectionLabel label="填充" />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="h-8 w-8 rounded-lg inline-flex items-center justify-center"
                  style={{
                    background: config.backgroundEnabled ? 'rgba(255,255,255,0.1)' : 'transparent',
                    border: config.backgroundEnabled ? '1.5px solid rgba(255,255,255,0.3)' : '1.5px solid rgba(255,255,255,0.1)',
                    color: config.backgroundEnabled ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                  }}
                  title="填充背景"
                  onClick={() => updateConfig({ backgroundEnabled: !config.backgroundEnabled })}
                >
                  <PaintBucket size={16} />
                </button>
                {config.backgroundEnabled && (
                  <ColorPicker
                    value={config.backgroundColor || '#000000'}
                    onChange={(color) => updateConfig({ backgroundColor: color })}
                    title="背景颜色"
                  />
                )}
              </div>

              <SectionLabel label="边框" />
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="h-8 w-8 rounded-lg inline-flex items-center justify-center"
                    style={{
                      background: config.borderEnabled ? 'rgba(255,255,255,0.1)' : 'transparent',
                      border: config.borderEnabled ? '1.5px solid rgba(255,255,255,0.3)' : '1.5px solid rgba(255,255,255,0.1)',
                    }}
                    title="显示边框"
                    onClick={() => updateConfig({ borderEnabled: !config.borderEnabled })}
                  >
                    <div
                      className="h-4 w-5 rounded-[3px]"
                      style={{
                        border: config.borderEnabled ? '2px solid rgba(255,255,255,0.95)' : '2px solid rgba(255,255,255,0.35)',
                      }}
                    />
                  </button>
                  {config.borderEnabled && (
                    <ColorPicker
                      value={config.borderColor || '#ffffff'}
                      onChange={(color) => updateConfig({ borderColor: color })}
                      title="边框颜色"
                    />
                  )}
                </div>

                {/* 边框宽度（启用边框时显示） */}
                {config.borderEnabled && (
                  <div className="flex items-center gap-3">
                    <InlineLabel label="粗细" />
                    <input
                      type="range"
                      min="1"
                      max="10"
                      step="1"
                      value={config.borderWidth ?? 2}
                      onChange={(e) => updateConfig({ borderWidth: Number(e.target.value) })}
                      className="flex-1 h-1.5 appearance-none rounded-full cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(((config.borderWidth ?? 2) - 1) / 9) * 100}%, rgba(255,255,255,0.25) ${(((config.borderWidth ?? 2) - 1) / 9) * 100}%, rgba(255,255,255,0.25) 100%)`,
                      }}
                    />
                    <span className="text-[11px] w-6 text-right tabular-nums font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>
                      {config.borderWidth ?? 2}
                    </span>
                  </div>
                )}
              </div>

              {/* 圆角 - 填充和边框共用，仅在启用时显示 */}
              {(config.backgroundEnabled || config.borderEnabled) && (
                <>
                  <SectionLabel label="圆角" />
                  <div className="flex items-center gap-3 min-w-0 overflow-hidden">
                    <input
                      type="range"
                      min="0"
                      max="50"
                      step="1"
                      value={config.cornerRadius ?? 0}
                      onChange={(e) => updateConfig({ cornerRadius: Number(e.target.value) })}
                      className="flex-1 min-w-0 h-1.5 appearance-none rounded-full cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${((config.cornerRadius ?? 0) / 50) * 100}%, rgba(255,255,255,0.25) ${((config.cornerRadius ?? 0) / 50) * 100}%, rgba(255,255,255,0.25) 100%)`,
                      }}
                    />
                    <span className="text-[11px] w-10 text-right tabular-nums font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>
                      {Math.round(((config.cornerRadius ?? 0) / 50) * 100)}%
                    </span>
                  </div>
                </>
              )}

              <SectionDivider />

              <SectionLabel label="定位" />
              <div>
                <PositionModeSwitch
                  value={config.positionMode}
                  onChange={(nextMode) => {
                    if (nextMode === config.positionMode) return;
                    if (nextMode === 'ratio') {
                      updateConfig({
                        positionMode: nextMode,
                        offsetX: config.offsetX / baseCanvasSize,
                        offsetY: config.offsetY / baseCanvasSize,
                      });
                    } else {
                      updateConfig({
                        positionMode: nextMode,
                        offsetX: config.offsetX * baseCanvasSize,
                        offsetY: config.offsetY * baseCanvasSize,
                      });
                    }
                  }}
                />
              </div>

              <SectionLabel label="适应" />
              <div className="flex flex-col gap-2 pt-1">
                <div>
                  <ScaleModeSwitch
                    enabled={adaptiveEnabled}
                    onToggle={(nextEnabled) => {
                      updateConfig({ adaptiveScaleMode: nextEnabled ? (adaptiveScaleMode === 0 ? 2 : adaptiveScaleMode) : 0 });
                    }}
                  />
                </div>
                {adaptiveEnabled ? (
                  <div className="flex items-center gap-2">
                  <InlineLabel label="方式" />
                    <div className="grid grid-cols-4 gap-2 flex-1">
                      {adaptiveScaleOptions.map((option) => {
                        const active = adaptiveScaleMode === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className="h-7 rounded-[7px] text-[11px] font-semibold transition-all"
                            style={{
                              background: active ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.06)',
                              border: active ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.12)',
                              color: active ? 'rgba(59,130,246,0.95)' : 'var(--text-muted)',
                            }}
                            onClick={() => updateConfig({ adaptiveScaleMode: option.value })}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <label
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] h-9 rounded-[8px] cursor-pointer"
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
            <Button variant="primary" size="sm" onClick={onSave} className="flex-1 text-[11px]! h-9! px-2!">
              <Check size={12} />
              保存
            </Button>
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
      className="relative inline-flex items-center gap-1 p-1 h-9 rounded-[10px]"
      style={{
        ...glassPopoverCompact,
        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
      }}
    >
      {/* 滑动指示器 */}
      <div
        className="absolute rounded-[7px] h-7 pointer-events-none"
        style={{
          ...glassBadge,
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.08) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          boxShadow: '0 2px 8px -1px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
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
            className="relative px-4 h-7 text-[12px] font-semibold transition-colors duration-200"
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

function ScaleModeSwitch(props: { enabled: boolean; onToggle: (next: boolean) => void }) {
  const { enabled, onToggle } = props;
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const activeKey = enabled ? 'on' : 'off';
    const activeButton = buttonsRef.current.get(activeKey);
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
  }, [enabled]);

  return (
    <div
      className="relative inline-flex items-center gap-1 p-1 h-9 rounded-[10px]"
      style={{
        ...glassPopoverCompact,
        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
      }}
    >
      <div
        className="absolute rounded-[7px] h-7 pointer-events-none"
        style={{
          ...glassBadge,
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.08) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          boxShadow: '0 2px 8px -1px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
        }}
      />
      {([
        { key: 'off', label: '关闭', value: false },
        { key: 'on', label: '开启', value: true },
      ] as const).map((item) => {
        const isActive = enabled === item.value;
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) {
                buttonsRef.current.set(item.key, el);
              } else {
                buttonsRef.current.delete(item.key);
              }
            }}
            type="button"
            onClick={() => onToggle(item.value)}
            className="relative px-4 h-7 text-[12px] font-semibold transition-colors duration-200"
            style={{
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              zIndex: 1,
            }}
          >
            {item.label}
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
          className="relative flex-1 h-8 rounded-[12px] px-3 text-sm outline-none prd-field text-left"
        >
          <span
            className="block max-w-[9ch] truncate"
            style={{ color: 'var(--text-primary)' }}
            title={current?.displayName || value || '请选择字体'}
          >
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
          className="z-120 rounded-[14px] overflow-hidden"
          style={{
            ...glassPanel,
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
  spec: WatermarkConfig;
  font: WatermarkFontInfo | null | undefined;
  size: number;
  height?: number;
  previewImage?: string | null;
  draggable?: boolean;
  showCrosshair?: boolean;
  showDistances?: boolean;
  distancePlacement?: 'inside' | 'outside';
  showQuadrantLabels?: boolean;
  showEdgeInputs?: boolean;
  onPositionChange?: (next: Pick<WatermarkConfig, 'anchor' | 'offsetX' | 'offsetY'>) => void;
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
    showQuadrantLabels = true,
    showEdgeInputs = false,
    onPositionChange,
  } = props;
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const width = size;
  const canvasHeight = height ?? size;

  const fontFamily = font?.fontFamily || 'sans-serif';
  // 基于缩放模式计算缩放比例，确保预览与后端一致
  const baseSize = spec.baseCanvasWidth || DEFAULT_CANVAS_SIZE;
  const shortSide = Math.min(width, canvasHeight);
  const longSide = Math.max(width, canvasHeight);
  const previewScale = (() => {
    if (!spec.adaptiveScaleMode) return 1;
    const basis = spec.adaptiveScaleMode === 1
      ? longSide
      : spec.adaptiveScaleMode === 2
        ? shortSide
        : spec.adaptiveScaleMode === 3
          ? width
          : canvasHeight;
    return basis / baseSize;
  })();
  const fontSize = spec.fontSizePx * previewScale;
  const iconScale = Number.isFinite(spec.iconScale) && (spec.iconScale ?? 0) > 0 ? (spec.iconScale as number) : 1;
  const iconSize = fontSize * iconScale;
  const baseGap = Number.isFinite(spec.iconGapPx) && (spec.iconGapPx ?? 0) > 0
    ? (spec.iconGapPx as number)
    : (spec.fontSizePx / 4);
  const gap = baseGap * previewScale;
  const iconPosition = spec.iconPosition ?? 'left';
  const isVerticalIcon = iconPosition === 'top' || iconPosition === 'bottom';
  const hasDecoration = spec.backgroundEnabled || spec.borderEnabled || (spec.cornerRadius ?? 0) > 0;
  const decorationPadding = hasDecoration ? Math.round(fontSize * 0.3) : 0;
  const textColor = spec.textColor || '#ffffff';
  const borderColor = spec.borderColor || textColor;
  const borderWidth = (spec.borderWidth ?? 2) * previewScale;
  const backgroundColor = spec.backgroundColor || '#000000';

  const watermarkRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLImageElement | null>(null);
  const lastMeasuredSizeRef = useRef({ width: 0, height: 0 });
  const sizeStableRef = useRef(false);  // 用于 updateSize 闭包访问
  const [watermarkSize, setWatermarkSize] = useState({ width: 0, height: 0 });
  const [measureTick, setMeasureTick] = useState(0);
  const [measuredSignature, setMeasuredSignature] = useState('');
  const [fontReady, setFontReady] = useState(false);
  const [sizeStable, setSizeStable] = useState(false);  // 尺寸是否稳定
  // 缓存版本号：修改测量逻辑时需要更新，使旧缓存失效
  const measureSignature = useMemo(
    () =>
      [
        'v3',  // 版本号：v3 = 只有延迟两帧后才写入缓存，避免缓存被错误小尺寸污染
        spec.text,
        spec.iconEnabled ? '1' : '0',
        spec.iconImageRef ?? '',
        spec.backgroundEnabled ? '1' : '0',
        spec.borderEnabled ? '1' : '0',
        borderWidth.toFixed(2),
        fontFamily,
        fontSize.toFixed(2),
        iconPosition,
        gap.toFixed(2),
        iconSize.toFixed(2),
      ].join('|'),
    [spec.text, spec.iconEnabled, spec.iconImageRef, spec.backgroundEnabled, spec.borderEnabled, borderWidth, fontFamily, fontSize, iconPosition, gap, iconSize]
  );
  const cachedSize = watermarkSizeCache.get(measureSignature);

  useLayoutEffect(() => {
    if (cachedSize) {
      setWatermarkSize(cachedSize);
      setMeasuredSignature(measureSignature);
      setSizeStable(true);  // 有缓存说明尺寸已经稳定过
      sizeStableRef.current = true;
    } else {
      setWatermarkSize({ width: 0, height: 0 });
      setMeasuredSignature('');
      setSizeStable(false);  // 需要重新测量并等待稳定
      sizeStableRef.current = false;
    }
    // 注意：不要在这里 setFontReady(false)，否则会和字体加载 effect 形成循环
    // 字体状态由专门的 useEffect 管理
  }, [cachedSize, measureSignature]);

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

  // 关键修复：当 fontReady 变为 true 时，等待尺寸稳定后再写入缓存
  // 因为字体加载完成后，浏览器渲染时间不可预测，可能需要多个渲染周期
  useEffect(() => {
    if (!fontReady || !contentRef.current) return;

    let cancelled = false;
    let lastSize = { width: 0, height: 0 };
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    const measureAndCheck = () => {
      if (cancelled || !contentRef.current) return;

      const contentRect = contentRef.current.getBoundingClientRect();
      if (!contentRect.width || !contentRect.height) return;

      const measuredWidth = Math.ceil(contentRect.width);
      const measuredHeight = Math.ceil(contentRect.height);

      // 如果尺寸与上次不同，继续等待稳定（不更新状态，避免抖动）
      if (measuredWidth !== lastSize.width || measuredHeight !== lastSize.height) {
        lastSize = { width: measuredWidth, height: measuredHeight };
        // 100ms 后再检查
        stabilityTimer = setTimeout(measureAndCheck, 100);
      } else {
        // 尺寸稳定，更新状态并写入缓存
        setWatermarkSize({ width: measuredWidth, height: measuredHeight });
        lastMeasuredSizeRef.current = { width: measuredWidth, height: measuredHeight };
        setMeasuredSignature(measureSignature);
        setSizeStable(true);
        sizeStableRef.current = true;
        watermarkSizeCache.set(measureSignature, { width: measuredWidth, height: measuredHeight });
      }
    };

    // 延迟两帧后开始测量
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      const raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        measureAndCheck();
      });

      return () => cancelAnimationFrame(raf2);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (stabilityTimer) clearTimeout(stabilityTimer);
    };
  }, [fontReady, measureSignature]);

  const estimatedTextWidth = Math.max(spec.text.length, 1) * fontSize * 1.0;
  const hasIcon = Boolean(spec.iconEnabled && spec.iconImageRef);
  const estimatedContentWidth = hasIcon
    ? (isVerticalIcon
      ? Math.max(estimatedTextWidth, iconSize)
      : estimatedTextWidth + iconSize + gap)
    : estimatedTextWidth;
  const estimatedContentHeight = hasIcon
    ? (isVerticalIcon
      ? fontSize + iconSize + gap
      : Math.max(fontSize, iconSize))
    : fontSize;
  // 估算尺寸需要包含边框宽度，确保 fallback 值更准确
  const estimatedBorderExtra = spec.borderEnabled ? borderWidth * 2 : 0;
  const estimatedWidth = estimatedContentWidth + decorationPadding * 2 + estimatedBorderExtra;
  const estimatedHeight = estimatedContentHeight + decorationPadding * 2 + estimatedBorderExtra;
  // 关键修复：只有当 measuredSignature 匹配当前配置时，才使用 watermarkSize
  // 否则可能是旧配置的尺寸（组件实例复用时 state 被保留）
  const isWatermarkSizeValid = measuredSignature === measureSignature;
  const validatedWidth = isWatermarkSizeValid ? watermarkSize.width : 0;
  const validatedHeight = isWatermarkSizeValid ? watermarkSize.height : 0;
  const measuredWidth = validatedWidth || cachedSize?.width || estimatedWidth;
  const measuredHeight = validatedHeight || cachedSize?.height || estimatedHeight;
  const hasLastMeasured = lastMeasuredSizeRef.current.width > 0 && lastMeasuredSizeRef.current.height > 0;
  const pendingMeasure = measuredSignature !== measureSignature;
  const effectiveWidth = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.width : measuredWidth;
  const effectiveHeight = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.height : measuredHeight;
  // 必须同时满足：字体加载完成 AND 尺寸稳定，才显示水印
  // 这样可以避免在尺寸稳定前显示，导致位置抖动
  const hideUntilMeasured = !fontReady || !sizeStable;

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
      // 直接测量 contentRef 的实际渲染尺寸，避免手动计算带来的 subpixel 误差
      // 这样可以确保定位计算使用的尺寸与浏览器实际渲染的尺寸完全一致
      const contentRect = contentRef.current?.getBoundingClientRect();
      if (!contentRect || !contentRect.width || !contentRect.height) return;

      // 关键修复：只有当字体加载完成时才更新尺寸状态
      // 否则会用字体未加载时的错误小尺寸覆盖正确尺寸
      if (!fontReady) return;

      // 关键修复：如果尺寸已经稳定（从缓存加载），不再更新状态
      // 否则会导致第二次进入编辑时的抖动
      if (sizeStableRef.current) return;

      // 使用 ceil 确保不会因为 subpixel 渲染导致边缘被截断
      const measuredWidth = Math.ceil(contentRect.width);
      const measuredHeight = Math.ceil(contentRect.height);

      setWatermarkSize((prev) => {
        if (Math.abs(prev.width - measuredWidth) < 0.5 && Math.abs(prev.height - measuredHeight) < 0.5) {
          return prev;
        }
        return { width: measuredWidth, height: measuredHeight };
      });
      // 注意：不在这里写入缓存！缓存只在 fontReady effect 延迟两帧后写入
      // 否则会用 fontReady=true 但字体还没渲染完成时的错误小尺寸污染缓存
      lastMeasuredSizeRef.current = { width: measuredWidth, height: measuredHeight };
      setMeasuredSignature(measureSignature);
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
    iconPosition,
    isVerticalIcon,
    gap,
    iconSize,
    borderWidth,
    decorationPadding,
    width,
    canvasHeight,
    measureTick,
    fontReady,
    measureSignature,
  ]);

  const commitRect = (nextRect: { x: number; y: number; width: number; height: number }) => {
    const { width: w, height: h } = sizeRef.current;
    const nextAnchor = getDominantAnchor(nextRect, w, h, anchorRef.current);
    const offsets = computeOffsetsFromAnchor(nextAnchor, nextRect, w, h);
    const storeX = modeRef.current === 'ratio' ? offsets.x / w : offsets.x;
    const storeY = modeRef.current === 'ratio' ? offsets.y / h : offsets.y;
    callbackRef.current?.({ anchor: nextAnchor, offsetX: storeX, offsetY: storeY });
  };

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
      commitRect(nextRect);
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

  const edgeDistances = ({
    top: Math.round(watermarkRect.y),
    right: Math.round(Math.max(0, width - (watermarkRect.x + watermarkRect.width))),
    bottom: Math.round(Math.max(0, canvasHeight - (watermarkRect.y + watermarkRect.height))),
    left: Math.round(watermarkRect.x),
  });

  const handleEdgeInputChange = (edge: 'top' | 'right' | 'bottom' | 'left', value: number) => {
    if (!Number.isFinite(value)) return;
    const maxX = Math.max(width - effectiveWidth, 0);
    const maxY = Math.max(canvasHeight - effectiveHeight, 0);
    let nextX = watermarkRect.x;
    let nextY = watermarkRect.y;

    switch (edge) {
      case 'top':
        nextY = value;
        break;
      case 'bottom':
        nextY = canvasHeight - effectiveHeight - value;
        break;
      case 'left':
        nextX = value;
        break;
      case 'right':
        nextX = width - effectiveWidth - value;
        break;
      default:
        break;
    }

    nextX = clampPixel(nextX, 0, maxX);
    nextY = clampPixel(nextY, 0, maxY);
    commitRect({ x: nextX, y: nextY, width: effectiveWidth, height: effectiveHeight });
  };

  const edgeInputClassName = 'w-[64px] h-7 px-2 text-[11px] rounded-[7px] text-center outline-none';
  const edgeInputStyle = {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.16)',
    color: 'var(--text-muted)',
    fontWeight: 500,
  } as const;
  const getEdgeInputStyle = (active: boolean) => ({
    ...edgeInputStyle,
    color: active ? '#FF5C77' : edgeInputStyle.color,
    fontWeight: active ? 600 : edgeInputStyle.fontWeight,
  });

  return (
    <div
      ref={canvasRef}
      className="relative"
      style={{
        width,
        height: canvasHeight,
        background: previewImage ? `url(${previewImage}) center/cover no-repeat` : 'rgba(255,255,255,0.04)',
        border: '1px dashed rgba(255,255,255,0.12)',
        overflow: (showDistances || showEdgeInputs) && distancePlacement === 'outside' ? 'visible' : 'hidden',
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
                {showQuadrantLabels ? (
                  <span style={{ color: 'var(--text-primary)', opacity: 0.2, fontSize: 12 }}>
                    {anchorLabelMap[anchor]}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {showDistances && !showEdgeInputs ? (
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
      {showEdgeInputs ? (
        <>
          <div className="absolute left-1/2 -translate-x-1/2" style={{ zIndex: 3, top: -44 }}>
            <input
              type="number"
              min={0}
              step={1}
              className={edgeInputClassName}
              style={getEdgeInputStyle(activeSides.top)}
              value={edgeDistances.top}
              onChange={(e) => handleEdgeInputChange('top', Number(e.target.value))}
            />
          </div>
          <div className="absolute top-1/2 -translate-y-1/2" style={{ zIndex: 3, right: -84 }}>
            <input
              type="number"
              min={0}
              step={1}
              className={edgeInputClassName}
              style={getEdgeInputStyle(activeSides.right)}
              value={edgeDistances.right}
              onChange={(e) => handleEdgeInputChange('right', Number(e.target.value))}
            />
          </div>
          <div className="absolute left-1/2 -translate-x-1/2" style={{ zIndex: 3, bottom: -44 }}>
            <input
              type="number"
              min={0}
              step={1}
              className={edgeInputClassName}
              style={getEdgeInputStyle(activeSides.bottom)}
              value={edgeDistances.bottom}
              onChange={(e) => handleEdgeInputChange('bottom', Number(e.target.value))}
            />
          </div>
          <div className="absolute top-1/2 -translate-y-1/2" style={{ zIndex: 3, left: -84 }}>
            <input
              type="number"
              min={0}
              step={1}
              className={edgeInputClassName}
              style={getEdgeInputStyle(activeSides.left)}
              value={edgeDistances.left}
              onChange={(e) => handleEdgeInputChange('left', Number(e.target.value))}
            />
          </div>
        </>
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
            flexDirection: iconPosition === 'right'
              ? 'row-reverse'
              : iconPosition === 'top'
                ? 'column'
                : iconPosition === 'bottom'
                  ? 'column-reverse'
                  : 'row',
            alignItems: 'center',
            gap: gap,
            color: textColor,
            fontFamily,
            fontSize,
            padding: decorationPadding,
            background: spec.backgroundEnabled ? backgroundColor : 'transparent',
            border: spec.borderEnabled ? `${borderWidth}px solid ${borderColor}` : '1px solid transparent',
            borderRadius: (spec.cornerRadius ?? 0) > 0 && (spec.backgroundEnabled || spec.borderEnabled)
              ? (spec.cornerRadius ?? 0) * previewScale
              : 0,
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
