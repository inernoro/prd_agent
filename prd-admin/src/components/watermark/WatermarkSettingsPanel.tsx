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
import { systemDialog } from '@/lib/systemDialog';
import { UploadCloud, Image as ImageIcon, Pencil, Check, X, ChevronDown, Trash2, Square, Droplet, Plus, CheckCircle2, FlaskConical, Globe, Share2, XCircle, GitFork } from 'lucide-react';

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

// appKey 到显示名称的映射
const appKeyLabelMap: Record<string, string> = {
  'literary-agent': '文学创作',
  'visual-agent': '视觉创作',
  'prd-agent': '米多智能体平台',
};

const modeLabelMap: Record<WatermarkConfig['positionMode'], string> = {
  pixel: '像素',
  ratio: '比例',
};

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
  borderEnabled: false,
  borderColor: '#FFFFFF',
  borderWidth: 2,
  backgroundEnabled: false,
  roundedBackgroundEnabled: false,
  cornerRadius: 0,
  baseCanvasWidth: DEFAULT_CANVAS_SIZE,
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
    backgroundEnabled: Boolean(config.backgroundEnabled),
    roundedBackgroundEnabled: Boolean(config.roundedBackgroundEnabled),
    cornerRadius: Number.isFinite(config.cornerRadius) ? config.cornerRadius : 0,
    textColor: resolvedTextColor,
    backgroundColor: config.backgroundColor ?? '#000000',
    previewBackgroundImageRef: config.previewBackgroundImageRef ?? null,
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
  columns?: number;
};

export const WatermarkSettingsPanel = forwardRef(function WatermarkSettingsPanel(
  props: WatermarkSettingsPanelProps,
  ref: ForwardedRef<WatermarkSettingsPanelHandle>
) {
  const { appKey, onStatusChange, hideAddButton = false, columns = 1 } = props;
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
            borderEnabled: config.borderEnabled,
            borderColor: config.borderColor,
            borderWidth: config.borderWidth,
            backgroundEnabled: config.backgroundEnabled,
            roundedBackgroundEnabled: config.roundedBackgroundEnabled,
            cornerRadius: config.cornerRadius,
            baseCanvasWidth: config.baseCanvasWidth,
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
            borderEnabled: config.borderEnabled,
            borderColor: config.borderColor,
            borderWidth: config.borderWidth,
            backgroundEnabled: config.backgroundEnabled,
            roundedBackgroundEnabled: config.roundedBackgroundEnabled,
            cornerRadius: config.cornerRadius,
            baseCanvasWidth: config.baseCanvasWidth,
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

  const handleAddConfig = () => {
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
  };

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
      const confirmed = await systemDialog.confirm({
        title: '确认删除水印配置',
        message: `确定删除「${target.name || '水印配置'}」吗？`,
        tone: 'danger',
        confirmText: '删除',
        cancelText: '取消',
      });
      if (!confirmed) return;
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
        <div className="flex items-center justify-end flex-shrink-0">
          <Button variant="secondary" size="xs" onClick={handleAddConfig} disabled={saving}>
            <Plus size={14} />
            新增配置
          </Button>
        </div>
      ) : null}

      {configs.length > 0 ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-hidden">
          <div
            className="grid gap-3 flex-1 min-h-0 overflow-auto overflow-x-hidden pr-1 content-start items-start"
            style={{
              gridTemplateColumns: columns > 1 ? `repeat(${columns}, minmax(0, 1fr))` : '1fr',
              gridAutoRows: 'min-content'
            }}
          >
            {configs.map((item, index) => {
              const isActive = item.appKeys?.includes(appKey);
              const fontLabel = fontMap.get(item.fontKey)?.displayName || item.fontKey;
              const previewUrl = buildPreviewUrl(item.previewUrl);
              const previewError = Boolean(previewErrorById[item.id]);
              return (
                <GlassCard key={item.id || `${item.text}-${index}`} className="p-0 overflow-hidden">
                  <div className="flex flex-col">
                    <div className="p-2 pb-1 flex-shrink-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 flex items-center gap-1.5">
                          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {item.name || `Watermark ${index + 1}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {/* 已选择徽章 */}
                          {isActive && (
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                              style={{
                                background: 'var(--accent-primary)',
                                color: 'white',
                              }}
                            >
                              当前
                            </span>
                          )}
                          {/* 已公开徽章 */}
                          {item.isPublic && (
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-0.5"
                              style={{
                                background: 'rgba(59, 130, 246, 0.12)',
                                color: 'rgba(59, 130, 246, 0.95)',
                                border: '1px solid rgba(59, 130, 246, 0.28)',
                              }}
                              title="已发布到海鲜市场"
                            >
                              <Globe size={8} />
                              已公开
                            </span>
                          )}
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => handleTestClick(item.id)}
                            disabled={saving || testingId === item.id}
                            title="上传图片测试水印效果"
                          >
                            <FlaskConical size={12} />
                            {testingId === item.id ? '测试中...' : '测试'}
                          </Button>
                        </div>
                      </div>
                      {/* 授权应用提示 */}
                      {item.appKeys && item.appKeys.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {item.appKeys.map((key) => (
                            <span
                              key={key}
                              className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                background: 'rgba(99, 102, 241, 0.12)',
                                color: 'rgba(99, 102, 241, 0.9)',
                                border: '1px solid rgba(99, 102, 241, 0.2)',
                              }}
                            >
                              {appKeyLabelMap[key] || key}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[10px]" style={{ color: 'rgba(239, 68, 68, 0.7)' }}>
                          未授权任何应用
                        </div>
                      )}
                    </div>

                    <div className="px-2 pb-1 flex-shrink-0">
                      <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 140px' }}>
                        <div
                          className="overflow-auto border rounded-[6px]"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'rgba(255,255,255,0.02)',
                            minHeight: '120px',
                            maxHeight: '160px',
                          }}
                        >
                          <div className="text-[11px] grid gap-2 grid-cols-1 p-2" style={{ color: 'var(--text-muted)' }}>
                            <div className="grid items-center gap-3" style={{ gridTemplateColumns: '48px auto' }}>
                              <span>字体</span>
                              <span className="truncate" style={{ color: 'var(--text-primary)', maxWidth: 160 }}>{fontLabel}</span>
                            </div>
                            <div className="grid items-center gap-3" style={{ gridTemplateColumns: '48px auto' }}>
                              <span>大小</span>
                              <span style={{ color: 'var(--text-primary)' }}>{item.fontSizePx}px</span>
                            </div>
                            <div className="grid items-center gap-3" style={{ gridTemplateColumns: '48px auto' }}>
                              <span>位置</span>
                              <span className="truncate" style={{ color: 'var(--text-primary)', maxWidth: 200 }}>
                                {anchorLabelMap[item.anchor]} · {modeLabelMap[item.positionMode]}
                              </span>
                            </div>
                            <div className="grid items-center gap-3" style={{ gridTemplateColumns: '48px auto' }}>
                              <span>图标</span>
                              <span style={{ color: 'var(--text-primary)' }}>{item.iconEnabled ? '已启用' : '禁用'}</span>
                            </div>
                            <div className="grid items-center gap-3" style={{ gridTemplateColumns: '48px auto' }}>
                              <span>透明度</span>
                              <span style={{ color: 'var(--text-primary)' }}>{Math.round(item.opacity * 100)}%</span>
                            </div>
                          </div>
                        </div>
                        <div
                          className="relative flex items-center justify-center overflow-hidden"
                          style={{
                            // 使用棋盘格图案表示透明背景
                            background: previewUrl && !previewError
                              ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 16px 16px'
                              : 'rgba(255,255,255,0.02)',
                            border: previewUrl && !previewError ? 'none' : '1px solid rgba(255,255,255,0.08)',
                            minHeight: '120px',
                            maxHeight: '160px',
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
                              className="block w-full h-auto object-contain"
                              onError={() => setPreviewErrorById((prev) => ({ ...prev, [item.id]: true }))}
                            />
                          ) : (
                            <div className="text-[11px]" style={{ color: 'rgba(233,209,156,0.7)' }}>无预览</div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 操作按钮区（单行布局） */}
                    <div className="px-2 pb-2 pt-1 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <div className="flex items-center gap-1.5 justify-between">
                        {/* 左侧：发布状态按钮 + 下载次数 */}
                        <div className="flex items-center gap-2">
                          {item.isPublic ? (
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => void handleUnpublishWatermark(item)}
                              disabled={saving}
                              title="取消发布后其他用户将无法看到此配置"
                            >
                              <XCircle size={12} />
                              取消发布
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => void handlePublishWatermark(item)}
                              disabled={saving}
                              title="发布到海鲜市场供其他用户下载"
                            >
                              <Share2 size={12} />
                              发布
                            </Button>
                          )}
                          {/* 下载次数（已发布时显示） */}
                          {item.isPublic && typeof item.forkCount === 'number' && (
                            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              <GitFork size={10} />
                              {item.forkCount}
                            </span>
                          )}
                        </div>
                        {/* 右侧：选择/编辑/删除按钮 */}
                        <div className="flex gap-1.5">
                          {isActive ? (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center gap-1.5 font-semibold h-[28px] px-3 rounded-[9px] text-[12px] transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                              style={{
                                background: 'rgba(34, 197, 94, 0.15)',
                                border: '1px solid rgba(34, 197, 94, 0.3)',
                                color: 'rgba(34, 197, 94, 0.95)',
                              }}
                              onClick={() => handleDeactivate(item.id)}
                              disabled={saving}
                              title="点击取消选择"
                            >
                              <CheckCircle2 size={12} />
                              已选择
                            </button>
                          ) : (
                            <Button size="xs" variant="secondary" onClick={() => handleActivate(item.id)} disabled={saving}>
                              <Check size={12} />
                              选择
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => {
                              setDraftConfig({ ...item });
                              setIsNewConfig(false);
                              setEditorOpen(true);
                            }}
                          >
                            <Pencil size={12} />
                            编辑
                          </Button>
                          <Button
                            size="xs"
                            variant="danger"
                            onClick={() => {
                              void handleDeleteConfig(item);
                            }}
                            disabled={saving}
                          >
                            <Trash2 size={12} />
                            删除
                          </Button>
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
        title="水印编辑器"
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
          className="fixed inset-0 z-[9999] flex items-center justify-center"
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
    <div className="flex flex-col h-full overflow-hidden -mt-3">
      <div className="grid gap-3 flex-1 overflow-hidden items-stretch" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        {/* 左侧: 主预览画布 */}
        <div
          ref={mainPreviewRef}
          className="relative flex items-center justify-center overflow-visible self-center"
        >
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
              distancePlacement="outside"
              onPositionChange={(next) => updateConfig(next)}
            />
          </div>
        </div>

        {/* 右侧: 配置表单 */}
        <div
          className="flex flex-col gap-3 overflow-hidden rounded-[10px] p-2 h-full"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'inset 1px 0 0 var(--border-subtle)',
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            <div className="grid gap-2" style={{ gridTemplateColumns: '74px minmax(0, 1fr)' }}>
              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>配置名称</div>
              <input
                value={config.name}
                onChange={(e) => updateConfig({ name: e.target.value })}
                className="w-full h-9 rounded-[8px] px-3 text-sm outline-none prd-field"
                placeholder="例如：默认水印"
              />

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>水印文本</div>
              <input
                value={config.text}
                onChange={(e) => updateConfig({ text: e.target.value })}
                className="w-full h-9 rounded-[8px] px-3 text-sm outline-none prd-field"
                placeholder="请输入水印文案"
              />

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>字体</div>
              <div className="flex items-center gap-2">
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
                  className="shrink-0 !h-9 !w-9 !px-0"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={fontUploading}
                >
                  <UploadCloud size={14} />
                </Button>
              </div>

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>字号</div>
              <div className="flex flex-col gap-1">
                <div className="text-[11px] text-right" style={{ color: 'var(--text-muted)' }}>{Math.round(config.fontSizePx)}px</div>
                <input
                  type="range"
                  min={5}
                  max={64}
                  step={1}
                  value={config.fontSizePx}
                  onChange={(e) => updateConfig({ fontSizePx: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>透明度</div>
              <div className="flex flex-col gap-1">
                <div className="text-[11px] text-right" style={{ color: 'var(--text-muted)' }}>{Math.round(config.opacity * 100)}%</div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.opacity}
                  onChange={(e) => updateConfig({ opacity: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>定位方式</div>
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

              <div className="text-xs font-semibold pt-1" style={{ color: 'var(--text-muted)' }}>装饰</div>
              <div className="flex flex-col gap-3 pt-2">
                {/* 图标 */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>图标</span>
                  <div className="relative">
                    <label
                      className="h-9 w-9 rounded-lg inline-flex items-center justify-center cursor-pointer overflow-hidden"
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
                        <img src={config.iconImageRef} alt="水印图标" className="h-full w-full object-cover" />
                      ) : (
                        <UploadCloud size={16} />
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
                </div>

                {/* 填充 + 背景色 */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>填充</span>
                  <button
                    type="button"
                    className="h-9 w-9 rounded-lg inline-flex items-center justify-center"
                    style={{
                      background: config.backgroundEnabled ? 'rgba(255,255,255,0.2)' : 'transparent',
                      border: config.backgroundEnabled ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(255,255,255,0.1)',
                      color: config.backgroundEnabled ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                    }}
                    title="填充背景"
                    onClick={() => updateConfig({ backgroundEnabled: !config.backgroundEnabled })}
                  >
                    <div className="w-4.5 h-4.5 rounded-sm" style={{ background: config.backgroundEnabled ? 'currentColor' : 'transparent', border: '2px solid currentColor' }} />
                  </button>
                  {config.backgroundEnabled && (
                    <label
                      className="relative h-9 w-9 rounded-lg inline-flex items-center justify-center cursor-pointer"
                      style={{
                        background: config.backgroundColor || '#000000',
                        border: '2px solid rgba(255,255,255,0.3)',
                        color: 'rgba(255,255,255,0.9)',
                      }}
                      title="背景颜色"
                    >
                      <Droplet size={14} />
                      <input
                        type="color"
                        value={(config.backgroundColor || '#000000') as string}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={(e) => updateConfig({ backgroundColor: e.target.value })}
                      />
                    </label>
                  )}
                </div>

                {/* 边框 + 边框色 */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>边框</span>
                  <button
                    type="button"
                    className="h-9 w-9 rounded-lg inline-flex items-center justify-center"
                    style={{
                      background: config.borderEnabled ? 'rgba(255,255,255,0.2)' : 'transparent',
                      border: config.borderEnabled ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(255,255,255,0.1)',
                      color: config.borderEnabled ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                    }}
                    title="显示边框"
                    onClick={() => updateConfig({ borderEnabled: !config.borderEnabled })}
                  >
                    <Square size={16} />
                  </button>
                  {config.borderEnabled && (
                    <label
                      className="relative h-9 w-9 rounded-lg inline-flex items-center justify-center cursor-pointer"
                      style={{
                        background: config.borderColor || '#ffffff',
                        border: '2px solid rgba(255,255,255,0.3)',
                        color: 'rgba(0,0,0,0.7)',
                      }}
                      title="边框颜色"
                    >
                      <Droplet size={14} />
                      <input
                        type="color"
                        value={(config.borderColor || '#ffffff') as string}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={(e) => updateConfig({ borderColor: e.target.value })}
                      />
                    </label>
                  )}
                </div>

                {/* 边框宽度（启用边框时显示） */}
                {config.borderEnabled && (
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>粗细</span>
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

                {/* 圆角 */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>圆角</span>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    step="1"
                    value={config.cornerRadius ?? 0}
                    onChange={(e) => updateConfig({ cornerRadius: Number(e.target.value) })}
                    className="flex-1 h-1.5 appearance-none rounded-full cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${((config.cornerRadius ?? 0) / 50) * 100}%, rgba(255,255,255,0.25) ${((config.cornerRadius ?? 0) / 50) * 100}%, rgba(255,255,255,0.25) 100%)`,
                    }}
                  />
                  <span className="text-[11px] w-6 text-right tabular-nums font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>
                    {config.cornerRadius ?? 0}
                  </span>
                </div>

                {/* 文字 + 文字色 */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] w-8 shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }}>文字</span>
                  <div
                    className="h-9 w-9 rounded-lg inline-flex items-center justify-center"
                    style={{
                      background: 'rgba(255,255,255,0.1)',
                      border: '1.5px solid rgba(255,255,255,0.2)',
                      color: 'rgba(255,255,255,0.8)',
                      fontSize: '14px',
                      fontWeight: 500,
                    }}
                  >
                    字
                  </div>
                  <label
                    className="relative h-9 w-9 rounded-lg inline-flex items-center justify-center cursor-pointer"
                    style={{
                      background: config.textColor || '#ffffff',
                      border: '2px solid rgba(255,255,255,0.3)',
                      color: 'rgba(0,0,0,0.7)',
                    }}
                    title="文字颜色"
                  >
                    <Droplet size={14} />
                    <input
                      type="color"
                      value={(config.textColor || '#ffffff') as string}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      onChange={(e) => updateConfig({ textColor: e.target.value })}
                    />
                  </label>
                </div>
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
            <Button variant="primary" size="sm" onClick={onSave} className="flex-1 !text-[11px] !h-9 !px-2">
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
        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      {/* 滑动指示器 */}
      <div
        className="absolute rounded-[7px] h-7 pointer-events-none"
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
          className="relative flex-1 h-9 rounded-[12px] px-3 text-sm outline-none prd-field text-left"
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
          className="z-[120] rounded-[14px] overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
            border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
            backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
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
        borderWidth.toFixed(2),
        fontFamily,
        fontSize.toFixed(2),
      ].join('|'),
    [spec.text, spec.iconEnabled, spec.iconImageRef, spec.backgroundEnabled, spec.borderEnabled, borderWidth, fontFamily, fontSize]
  );
  const cachedSize = watermarkSizeCache.get(measureSignature);

  useLayoutEffect(() => {
    if (cachedSize) {
      setWatermarkSize(cachedSize);
      setMeasuredSignature(measureSignature);
    } else {
      setWatermarkSize({ width: 0, height: 0 });
      setMeasuredSignature('');
    }
    setFontReady(false);
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

  const estimatedTextWidth = Math.max(spec.text.length, 1) * fontSize * 1.0;
  const estimatedWidth = estimatedTextWidth + (spec.iconEnabled && spec.iconImageRef ? iconSize + gap : 0) + decorationPadding * 2;
  const estimatedHeight = Math.max(fontSize, iconSize) + decorationPadding * 2;
  const measuredWidth = watermarkSize.width || cachedSize?.width || estimatedWidth;
  const measuredHeight = watermarkSize.height || cachedSize?.height || estimatedHeight;
  const hasLastMeasured = lastMeasuredSizeRef.current.width > 0 && lastMeasuredSizeRef.current.height > 0;
  const pendingMeasure = measuredSignature !== measureSignature;
  const effectiveWidth = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.width : measuredWidth;
  const effectiveHeight = pendingMeasure && hasLastMeasured ? lastMeasuredSizeRef.current.height : measuredHeight;
  const hideUntilMeasured = (!fontReady && !cachedSize) || measuredSignature !== measureSignature;

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
      // 边框宽度会增加元素整体尺寸（CSS border 在 padding 外面）
      const borderExtra = spec.borderEnabled ? borderWidth * 2 : 0;
      const combinedWidth = textRect.width + (iconWidth ? iconWidth + gap : 0) + decorationPadding * 2 + borderExtra;
      const combinedHeight = Math.max(textRect.height, iconHeight) + decorationPadding * 2 + borderExtra;
      setWatermarkSize((prev) => {
        if (Math.abs(prev.width - combinedWidth) < 0.5 && Math.abs(prev.height - combinedHeight) < 0.5) {
          return prev;
        }
        return { width: combinedWidth, height: combinedHeight };
      });
      watermarkSizeCache.set(measureSignature, { width: combinedWidth, height: combinedHeight });
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
            border: spec.borderEnabled ? `${borderWidth}px solid ${borderColor}` : '1px solid transparent',
            borderRadius: (spec.cornerRadius ?? 0) * previewScale,
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
