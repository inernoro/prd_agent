import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Tooltip } from '@/components/ui/Tooltip';
import { ModelMapDialog } from './model-manage/ModelMapDialog';
import {
  clearIntentModel,
  clearVisionModel,
  clearImageGenModel,
  createModel,
  createPlatform,
  deleteModel,
  deletePlatform,
  getLlmModelStats,
  getModels,
  getPlatforms,
  updateModelPriorities,
  setMainModel,
  setIntentModel,
  setVisionModel,
  setImageGenModel,
  testModel,
  updateModel,
  updatePlatform,
} from '@/services';
import type { Model, Platform } from '@/types/admin';
import { Activity, ArrowDown, ArrowUp, Check, Clock, DatabaseZap, DollarSign, Eye, EyeOff, GripVertical, ImagePlus, Link2, Minus, Pencil, Plus, RefreshCw, ScanEye, Search, Sparkles, Star, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '@/services/real/apiClient';
import { getAvatarUrlByGroup, getAvatarUrlByModelName, getAvatarUrlByPlatformType } from '@/assets/model-avatars';
import type { LlmModelStatsItem } from '@/services/contracts/llmLogs';
import { resolveCherryGroupKey } from '@/lib/cherryModelGrouping';
import { inferPresetTagKeys, type PresetTagKey } from '@/lib/modelPresetTags';

type PlatformForm = {
  name: string;
  platformType: string;
  providerId: string;
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
  // 仅前端本地配置（localStorage）：用于成本估算，不写入后端
  pricingCurrency: string;
  pricingInPer1k: string;
  pricingOutPer1k: string;
};

type ModelForm = {
  name: string;
  modelName: string;
  platformId: string;
  group: string;
  enabled: boolean;
  enablePromptCache: boolean;
};

type AvailableModel = {
  modelName: string;
  displayName: string;
  group?: string;
};

function splitKeywords(input: string): string[] {
  return (input ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function matchAllKeywords(fullText: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const hay = (fullText ?? '').toLowerCase();
  return keywords.every((k) => hay.includes(k));
}

function presetTagMeta(tag: PresetTagKey): { title: string; icon: React.ReactNode; tone: string } {
  switch (tag) {
    case 'reasoning':
      return { title: '推理', icon: <Zap size={14} />, tone: 'rgba(251,146,60,0.95)' };
    case 'vision':
      return { title: '视觉', icon: <ScanEye size={14} />, tone: 'rgba(96,165,250,0.95)' };
    case 'websearch':
      return { title: '联网', icon: <Link2 size={14} />, tone: 'rgba(34,197,94,0.95)' };
    case 'function_calling':
      return { title: '工具', icon: <Sparkles size={14} />, tone: 'rgba(167,139,250,0.95)' };
    case 'embedding':
      return { title: '嵌入', icon: <DatabaseZap size={14} />, tone: 'rgba(34,211,238,0.95)' };
    case 'rerank':
      return { title: '重排', icon: <ArrowDown size={14} />, tone: 'rgba(245,158,11,0.95)' };
    case 'image_generation':
      return { title: '生图', icon: <ImagePlus size={14} />, tone: 'rgba(236,72,153,0.95)' };
    case 'free':
      return { title: '免费', icon: <Star size={14} />, tone: 'rgba(34,197,94,0.95)' };
  }
}

function PresetTagIcons({ modelName, displayName }: { modelName: string; displayName?: string }) {
  const tags = inferPresetTagKeys(modelName, displayName);
  if (tags.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 shrink-0" aria-label="预设标签">
      {tags.map((t) => {
        const meta = presetTagMeta(t);
        return (
          <span
            key={t}
            title={meta.title}
            className="inline-flex items-center justify-center h-[22px] w-[22px] rounded-[9px]"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              color: meta.tone,
            }}
          >
            {meta.icon}
          </span>
        );
      })}
    </div>
  );
}

const defaultPlatformForm: PlatformForm = {
  name: '',
  platformType: 'openai',
  providerId: '',
  apiUrl: '',
  apiKey: '',
  enabled: true,
  pricingCurrency: '¥',
  pricingInPer1k: '',
  pricingOutPer1k: '',
};

const defaultModelForm: ModelForm = {
  name: '',
  modelName: '',
  platformId: '',
  group: '',
  enabled: true,
  enablePromptCache: true,
};

const isSvgAssetUrl = (url?: string | null) => !!url && /\.svg(\?|#|$)/i.test(url);
const isRasterAssetUrl = (url?: string | null) => !!url && /\.(png|jpe?g|webp|gif|bmp|ico)(\?|#|$)/i.test(url);

function FlagLabel({
  icon,
  text,
  title,
  style,
}: {
  icon: React.ReactNode;
  text: string;
  title?: string;
  style: React.CSSProperties;
}) {
  return (
    <label
      className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0"
      style={style}
      title={title || text}
    >
      <span className="shrink-0">{icon}</span>
      <span>{text}</span>
    </label>
  );
}

function StatLabel({
  icon,
  text,
  title,
  style,
}: {
  icon: React.ReactNode;
  text: string;
  title?: string;
  style: React.CSSProperties;
}) {
  return (
    <label
      className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0"
      style={style}
      title={title || text}
    >
      <span className="shrink-0">{icon}</span>
      <span>{text}</span>
    </label>
  );
}

type AggregatedModelStats = {
  requestCount: number;
  avgDurationMs: number | null;
  avgTtfbMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
};

function formatCompactZh(n: number) {
  if (!Number.isFinite(n)) return '';
  const v = Math.floor(n);
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

type PlatformPricing = {
  currency: string;
  inPer1k: number;
  outPer1k: number;
};

const PRICING_LS_KEY = 'prd_admin_platform_pricing_v1';

function readPricingMap(): Record<string, PlatformPricing> {
  try {
    const raw = localStorage.getItem(PRICING_LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as any;
    if (!obj || typeof obj !== 'object') return {};
    return obj as Record<string, PlatformPricing>;
  } catch {
    return {};
  }
}

function writePricingMap(map: Record<string, PlatformPricing>) {
  try {
    localStorage.setItem(PRICING_LS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function toFiniteNumberOrNull(v: string): number | null {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function estimateCost(stats: { totalInputTokens: number; totalOutputTokens: number }, pricing: PlatformPricing | null): number | null {
  if (!pricing) return null;
  const inCost = (Math.max(0, stats.totalInputTokens) / 1000) * pricing.inPer1k;
  const outCost = (Math.max(0, stats.totalOutputTokens) / 1000) * pricing.outPer1k;
  const total = inCost + outCost;
  return Number.isFinite(total) ? total : null;
}

function formatMoney(v: number, currency: string) {
  if (!Number.isFinite(v)) return '';
  if (v >= 1000) return `${currency}${v.toFixed(0)}`;
  if (v >= 10) return `${currency}${v.toFixed(1)}`;
  return `${currency}${v.toFixed(2)}`;
}

function aggregateModelStats(items: LlmModelStatsItem[]): Record<string, AggregatedModelStats> {
  const tmp = new Map<string, {
    requestCount: number;
    durWeightedSum: number;
    durWeight: number;
    ttfbWeightedSum: number;
    ttfbWeight: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>();

  for (const it of items) {
    const key = String(it.model ?? '').trim().toLowerCase();
    if (!key) continue;
    const rc = Math.max(0, Number(it.requestCount ?? 0));
    if (!tmp.has(key)) {
      tmp.set(key, {
        requestCount: 0,
        durWeightedSum: 0,
        durWeight: 0,
        ttfbWeightedSum: 0,
        ttfbWeight: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      });
    }
    const cur = tmp.get(key)!;

    cur.requestCount += rc;

    const avgDur = it.avgDurationMs == null ? null : Number(it.avgDurationMs);
    if (avgDur != null && Number.isFinite(avgDur) && avgDur > 0 && rc > 0) {
      cur.durWeightedSum += avgDur * rc;
      cur.durWeight += rc;
    }

    const avgTtfb = it.avgTtfbMs == null ? null : Number(it.avgTtfbMs);
    if (avgTtfb != null && Number.isFinite(avgTtfb) && avgTtfb > 0 && rc > 0) {
      cur.ttfbWeightedSum += avgTtfb * rc;
      cur.ttfbWeight += rc;
    }

    cur.totalInputTokens += Math.max(0, Number(it.totalInputTokens ?? 0));
    cur.totalOutputTokens += Math.max(0, Number(it.totalOutputTokens ?? 0));
  }

  const out: Record<string, AggregatedModelStats> = {};
  for (const [k, v] of tmp.entries()) {
    out[k] = {
      requestCount: v.requestCount,
      avgDurationMs: v.durWeight > 0 ? Math.round(v.durWeightedSum / v.durWeight) : null,
      avgTtfbMs: v.ttfbWeight > 0 ? Math.round(v.ttfbWeightedSum / v.ttfbWeight) : null,
      totalInputTokens: v.totalInputTokens,
      totalOutputTokens: v.totalOutputTokens,
    };
  }
  return out;
}

export default function ModelManagePage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  // 刷新后默认“全部”，避免每次都跳到第一个平台
  const [selectedPlatformId, setSelectedPlatformId] = useState<string>('__all__');
  const [platformSearch, setPlatformSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');

  const [modelMapOpen, setModelMapOpen] = useState(false);

  const [platformDialogOpen, setPlatformDialogOpen] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<Platform | null>(null);
  const [platformForm, setPlatformForm] = useState<PlatformForm>(defaultPlatformForm);
  const [pricingByPlatformId, setPricingByPlatformId] = useState<Record<string, PlatformPricing>>(() => readPricingMap());
  const [platformCtxMenu, setPlatformCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    platform: Platform | null;
  }>({ open: false, x: 0, y: 0, platform: null });

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(defaultModelForm);

  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ modelId: string; ok: boolean; msg?: string } | null>(null);
  const [mainJustSetId, setMainJustSetId] = useState<string | null>(null);
  const [intentJustSetId, setIntentJustSetId] = useState<string | null>(null);
  const [visionJustSetId, setVisionJustSetId] = useState<string | null>(null);
  const [imageGenJustSetId, setImageGenJustSetId] = useState<string | null>(null);
  const [platformTogglingId, setPlatformTogglingId] = useState<string | null>(null);
  const [modelCacheTogglingId, setModelCacheTogglingId] = useState<string | null>(null);
  const [apiUrlDraft, setApiUrlDraft] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [platformChecking, setPlatformChecking] = useState(false);
  const [platformCheckMsg, setPlatformCheckMsg] = useState<string | null>(null);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableSearch, setAvailableSearch] = useState('');
  const [availableTab, setAvailableTab] = useState<
    'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools'
  >('all');
  const [openAvailableGroups, setOpenAvailableGroups] = useState<Record<string, boolean>>({});
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null);
  const [modelOrderIds, setModelOrderIds] = useState<string[]>([]);
  const [prioritySaving, setPrioritySaving] = useState(false);

  const [modelStatsDays, setModelStatsDays] = useState(7);
  const [modelStatsByModel, setModelStatsByModel] = useState<Record<string, AggregatedModelStats>>({});
  const [modelStatsLoading, setModelStatsLoading] = useState(false);

  const loadModelStats = async () => {
    setModelStatsLoading(true);
    try {
      const res = await getLlmModelStats({ days: 7 });
      if (res.success) {
        setModelStatsDays(res.data.days);
        setModelStatsByModel(aggregateModelStats(res.data.items ?? []));
      }
    } finally {
      setModelStatsLoading(false);
    }
  };

  const load = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [p, m] = await Promise.all([getPlatforms(), getModels()]);
      if (p.success) {
        setPlatforms(p.data);
        setSelectedPlatformId((cur) => (cur ? cur : '__all__'));
      }
      if (m.success) setModels(m.data);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadModelStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主模型选中后的瞬时动效（行闪一下 + 星星弹一下）
  useEffect(() => {
    if (!mainJustSetId) return;
    const t = window.setTimeout(() => setMainJustSetId(null), 650);
    return () => window.clearTimeout(t);
  }, [mainJustSetId]);

  useEffect(() => {
    if (!intentJustSetId) return;
    const t = window.setTimeout(() => setIntentJustSetId(null), 650);
    return () => window.clearTimeout(t);
  }, [intentJustSetId]);

  useEffect(() => {
    if (!visionJustSetId) return;
    const t = window.setTimeout(() => setVisionJustSetId(null), 650);
    return () => window.clearTimeout(t);
  }, [visionJustSetId]);

  useEffect(() => {
    if (!imageGenJustSetId) return;
    const t = window.setTimeout(() => setImageGenJustSetId(null), 650);
    return () => window.clearTimeout(t);
  }, [imageGenJustSetId]);

  const onSetIntent = async (m: Model) => {
    setIntentJustSetId(m.id);
    const res = await setIntentModel(m.id);
    if (!res.success) {
      await load({ silent: true });
      return;
    }
    await load({ silent: true });
  };

  const onClearIntent = async (m: Model) => {
    // 本地即时更新：避免闪烁
    setModels((prev) => prev.map((x) => ({ ...x, isIntent: false })));
    setIntentJustSetId(m.id);
    const res = await clearIntentModel();
    if (!res.success) {
      await load({ silent: true });
      return;
    }
    await load({ silent: true });
  };

  const onClearVision = async (m: Model) => {
    // 本地即时更新：避免闪烁
    setModels((prev) => prev.map((x) => ({ ...x, isVision: false })));
    setVisionJustSetId(m.id);
    const res = await clearVisionModel();
    if (!res.success) {
      await load({ silent: true });
      alert(res.error?.message || '取消图片识别模型失败');
      return;
    }
    await load({ silent: true });
  };

  const onClearImageGen = async (m: Model) => {
    // 本地即时更新：避免闪烁
    setModels((prev) => prev.map((x) => ({ ...x, isImageGen: false })));
    setImageGenJustSetId(m.id);
    const res = await clearImageGenModel();
    if (!res.success) {
      await load({ silent: true });
      alert(res.error?.message || '取消图片生成模型失败');
      return;
    }
    await load({ silent: true });
  };

  const onSetVision = async (m: Model) => {
    setVisionJustSetId(m.id);
    const res = await setVisionModel(m.id);
    if (!res.success) {
      await load({ silent: true });
      return;
    }
    await load({ silent: true });
  };

  const onSetImageGen = async (m: Model) => {
    setImageGenJustSetId(m.id);
    const res = await setImageGenModel(m.id);
    if (!res.success) {
      await load({ silent: true });
      return;
    }
    await load({ silent: true });
  };

  const closePlatformCtxMenu = () => {
    setPlatformCtxMenu({ open: false, x: 0, y: 0, platform: null });
  };

  useEffect(() => {
    if (!platformCtxMenu.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePlatformCtxMenu();
    };
    const onAnyScrollOrResize = () => closePlatformCtxMenu();
    window.addEventListener('keydown', onKeyDown);
    // 捕获任意滚动（包含列表自身滚动），避免菜单“漂移”
    window.addEventListener('scroll', onAnyScrollOrResize, true);
    window.addEventListener('resize', onAnyScrollOrResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onAnyScrollOrResize, true);
      window.removeEventListener('resize', onAnyScrollOrResize);
    };
  }, [platformCtxMenu.open]);

  const filteredPlatforms = useMemo(() => {
    const s = platformSearch.trim().toLowerCase();
    if (!s) return platforms;
    return platforms.filter((p) => p.name.toLowerCase().includes(s) || p.platformType.toLowerCase().includes(s));
  }, [platformSearch, platforms]);

  const filteredModels = useMemo(() => {
    const list = !selectedPlatformId || selectedPlatformId === '__all__' ? models : models.filter((m) => m.platformId === selectedPlatformId);
    const s = modelSearch.trim().toLowerCase();
    if (!s) return list;
    return list.filter((m) => m.name.toLowerCase().includes(s) || m.modelName.toLowerCase().includes(s));
  }, [modelSearch, models, selectedPlatformId]);

  const selectedPlatform = useMemo(() => {
    if (!selectedPlatformId || selectedPlatformId === '__all__') return null;
    return platforms.find((p) => p.id === selectedPlatformId) || null;
  }, [platforms, selectedPlatformId]);

  useEffect(() => {
    if (!selectedPlatform) {
      setApiUrlDraft('');
      setApiKeyDraft('');
      setShowApiKey(false);
      setPlatformCheckMsg(null);
      return;
    }
    setApiUrlDraft(selectedPlatform.apiUrl || '');
    setApiKeyDraft('');
    setShowApiKey(false);
    setPlatformCheckMsg(null);
  }, [selectedPlatform?.id]);

  const platformById = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);

  const orderedModels = useMemo(() => {
    // 默认顺序：priority 越小越靠前；再按 name/modelName 稳定兜底
    const list = [...filteredModels];
    list.sort((a, b) => {
      const ap = typeof a.priority === 'number' ? a.priority : 1e9;
      const bp = typeof b.priority === 'number' ? b.priority : 1e9;
      if (ap !== bp) return ap - bp;
      const an = (a.name || a.modelName || '').trim();
      const bn = (b.name || b.modelName || '').trim();
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
    });
    return list;
  }, [filteredModels]);

  // 同步本地排序（用于拖拽）
  useEffect(() => {
    setModelOrderIds(orderedModels.map((m) => m.id));
  }, [orderedModels]);

  const existingModelByName = useMemo(() => {
    const map = new Map<string, Model>();
    if (!selectedPlatform) return map;
    for (const m of models) {
      if (m.platformId !== selectedPlatform.id) continue;
      if (!map.has(m.modelName)) map.set(m.modelName, m);
    }
    return map;
  }, [models, selectedPlatform?.id]);

  const displayedModels = useMemo(() => {
    const byId = new Map(orderedModels.map((m) => [m.id, m]));
    // 若 orderIds 与当前列表不一致（比如 filter 切换），回退 orderedModels
    if (modelOrderIds.length !== orderedModels.length) return orderedModels;
    const list: Model[] = [];
    for (const id of modelOrderIds) {
      const m = byId.get(id);
      if (m) list.push(m);
    }
    return list.length === orderedModels.length ? list : orderedModels;
  }, [modelOrderIds, orderedModels]);

  const canDragSort = !selectedPlatformId || selectedPlatformId === '__all__';

  const persistPriorityOrder = async (idsInOrder: string[]) => {
    // 只允许在“全部”视图拖拽（priority 是全局排序，避免在单平台里制造不可预期的全局重排）
    if (!canDragSort) return;
    if (prioritySaving) return;
    setPrioritySaving(true);
    try {
      // priority 越小越靠前：从 1 开始即可
      const updates = idsInOrder.map((id, idx) => ({ id, priority: idx + 1 }));
      const res = await updateModelPriorities(updates);
      if (!res.success) {
        alert(res.error?.message || '保存排序失败');
        return;
      }
      await load({ silent: true });
    } finally {
      setPrioritySaving(false);
    }
  };

  const moveId = (ids: string[], fromId: string, toId: string) => {
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = ids.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    return next;
  };

  const modelCategory = (m: AvailableModel) => {
    const s = (m.modelName || '').toLowerCase();
    if (/(embed|embedding)/.test(s)) return 'embedding' as const;
    if (/(rerank|re-rank)/.test(s)) return 'rerank' as const;
    if (/(vision|vl|image)/.test(s)) return 'vision' as const;
    if (/(search|web|online|联网)/.test(s)) return 'web' as const;
    if (/(free|gratis|免费)/.test(s)) return 'free' as const;
    if (/(tool|tools|function)/.test(s)) return 'tools' as const;
    return 'reasoning' as const;
  };

  const filteredAvailableModels = useMemo(() => {
    let list = availableModels;
    if (availableTab !== 'all') {
      list = list.filter((m) => modelCategory(m) === availableTab);
    }
    const ks = splitKeywords(availableSearch);
    if (ks.length === 0) return list;
    const providerName = selectedPlatform?.name || '';
    return list.filter((m) =>
      matchAllKeywords(`${m.displayName || ''} ${m.modelName || ''} ${providerName}`, ks)
    );
  }, [availableModels, availableSearch, availableTab, selectedPlatform?.name]);

  const groupedAvailable = useMemo(() => {
    // Cherry 管理弹窗：不做显式排序；顺序取决于远端返回顺序 + 首次出现 group 的插入顺序
    const providerId = (selectedPlatform?.providerId || selectedPlatform?.platformType || '').trim();
    const groups = new Map<string, AvailableModel[]>();
    for (const m of filteredAvailableModels) {
      const key = (m.group || resolveCherryGroupKey(m.modelName, providerId) || 'other').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filteredAvailableModels, selectedPlatform?.providerId, selectedPlatform?.platformType]);

  // 默认展开第一个分组（允许用户自行折叠/展开）
  useEffect(() => {
    if (groupedAvailable.length === 0) return;
    const first = groupedAvailable[0]?.[0];
    if (!first) return;
    setOpenAvailableGroups((prev) => {
      if (Object.keys(prev).length === 0) return { [first]: true };
      if (prev[first] === undefined) return { ...prev, [first]: true };
      return prev;
    });
  }, [groupedAvailable]);

  const fetchAvailableModels = async (opts?: { refresh?: boolean }) => {
    if (!selectedPlatform) return;
    setAvailableLoading(true);
    setAvailableError(null);
    try {
      const isRefresh = !!opts?.refresh;
      const r = await apiRequest<AvailableModel[]>(
        isRefresh
          ? `/api/v1/platforms/${selectedPlatform.id}/refresh-models`
          : `/api/v1/platforms/${selectedPlatform.id}/available-models`,
        isRefresh ? { method: 'POST', body: {} } : { method: 'GET' }
      );
      if (!r.success) {
        setAvailableError(r.error?.message || '获取模型列表失败');
        setAvailableModels([]);
        return;
      }
      setAvailableModels(r.data || []);
    } finally {
      setAvailableLoading(false);
    }
  };

  const toggleModel = async (m: AvailableModel) => {
    if (!selectedPlatform) return;
    const exist = existingModelByName.get(m.modelName);
    if (exist) {
      const res = await deleteModel(exist.id);
      if (!res.success) return;
      await load();
      return;
    }

    const res = await createModel({
      name: m.displayName || m.modelName,
      modelName: m.modelName,
      platformId: selectedPlatform.id,
      group: m.group || undefined,
      enabled: true,
      enablePromptCache: true,
    });
    if (!res.success) return;
    await load();
  };

  const bulkAddAvailableGroup = async (groupName: string, ms: AvailableModel[]) => {
    if (!selectedPlatform) return;
    const toAdd = ms.filter((m) => !existingModelByName.get(m.modelName));
    if (toAdd.length === 0) return;
    const ok = window.confirm(`确定批量添加 ${toAdd.length} 个模型到平台“${selectedPlatform.name}”？\n分组：${groupName}`);
    if (!ok) return;

    for (const m of toAdd) {
      const res = await createModel({
        name: m.displayName || m.modelName,
        modelName: m.modelName,
        platformId: selectedPlatform.id,
        group: m.group || undefined,
        enabled: true,
        enablePromptCache: true,
      });
      if (!res.success) {
        alert(res.error?.message || '批量添加失败');
        break;
      }
    }
    await load();
  };

  const openCreatePlatform = () => {
    setEditingPlatform(null);
    setPlatformForm(defaultPlatformForm);
    setPlatformDialogOpen(true);
  };

  const openEditPlatform = (p: Platform) => {
    setEditingPlatform(p);
    const pricing = pricingByPlatformId[p.id];
    setPlatformForm({
      name: p.name || '',
      platformType: p.platformType || 'openai',
      providerId: (p.providerId || '').trim(),
      apiUrl: p.apiUrl || '',
      apiKey: '',
      enabled: !!p.enabled,
      pricingCurrency: pricing?.currency || '¥',
      pricingInPer1k: pricing?.inPer1k ? String(pricing.inPer1k) : '',
      pricingOutPer1k: pricing?.outPer1k ? String(pricing.outPer1k) : '',
    });
    setPlatformDialogOpen(true);
  };

  const submitPlatform = async () => {
    if (editingPlatform) {
      const res = await updatePlatform(editingPlatform.id, {
        name: platformForm.name,
        platformType: platformForm.platformType,
        providerId: platformForm.providerId?.trim() || undefined,
        apiUrl: platformForm.apiUrl,
        apiKey: platformForm.apiKey || undefined,
        enabled: platformForm.enabled,
      });
      if (!res.success) return;
      // 保存本地定价（不写入后端）
      const inPer1k = toFiniteNumberOrNull(platformForm.pricingInPer1k);
      const outPer1k = toFiniteNumberOrNull(platformForm.pricingOutPer1k);
      if (inPer1k && outPer1k) {
        const next = { ...pricingByPlatformId, [editingPlatform.id]: { currency: platformForm.pricingCurrency || '¥', inPer1k, outPer1k } };
        setPricingByPlatformId(next);
        writePricingMap(next);
      }
    } else {
      const res = await createPlatform({
        name: platformForm.name,
        platformType: platformForm.platformType,
        providerId: platformForm.providerId?.trim() || undefined,
        apiUrl: platformForm.apiUrl,
        apiKey: platformForm.apiKey,
        enabled: platformForm.enabled,
      });
      if (!res.success) return;
      // 新建平台后也允许保存本地定价（使用后端返回的平台 id）
      const id = (res.data as any)?.id;
      const inPer1k = toFiniteNumberOrNull(platformForm.pricingInPer1k);
      const outPer1k = toFiniteNumberOrNull(platformForm.pricingOutPer1k);
      if (id && inPer1k && outPer1k) {
        const next = { ...pricingByPlatformId, [String(id)]: { currency: platformForm.pricingCurrency || '¥', inPer1k, outPer1k } };
        setPricingByPlatformId(next);
        writePricingMap(next);
      }
    }

    setPlatformDialogOpen(false);
    setEditingPlatform(null);
    await load();
  };

  const onDeletePlatform = async (p: Platform) => {
    const res = await deletePlatform(p.id);
    if (!res.success) return;
    if (selectedPlatformId === p.id) setSelectedPlatformId('');
    await load();
  };

  const togglePlatformEnabled = async (p: Platform) => {
    if (platformTogglingId) return;
    setPlatformTogglingId(p.id);
    try {
      const res = await updatePlatform(p.id, { enabled: !p.enabled });
      if (!res.success) return;
      await load();
    } finally {
      setPlatformTogglingId(null);
    }
  };

  const savePlatformInline = async (patch: Partial<PlatformForm> & { apiKey?: string }) => {
    if (!selectedPlatform) return;
    const res = await updatePlatform(selectedPlatform.id, patch);
    if (!res.success) return;
    await load();
  };

  const onOpenPlatformCtxMenu = (e: React.MouseEvent, p: Platform) => {
    e.preventDefault();
    e.stopPropagation();
    // 右键时顺便选中，符合用户预期（菜单操作作用于当前行）
    setSelectedPlatformId(p.id);
    const menuW = 220;
    const menuH = 96;
    const x = Math.min(e.clientX, Math.max(8, window.innerWidth - menuW - 8));
    const y = Math.min(e.clientY, Math.max(8, window.innerHeight - menuH - 8));
    setPlatformCtxMenu({ open: true, x, y, platform: p });
  };

  const onCheckPlatform = async () => {
    if (!selectedPlatform || platformChecking) return;
    setPlatformChecking(true);
    setPlatformCheckMsg(null);
    try {
      const updates: Record<string, unknown> = {};
      const nextApiUrl = apiUrlDraft.trim();
      const nextApiKey = apiKeyDraft.trim();

      if (nextApiUrl && nextApiUrl !== selectedPlatform.apiUrl) updates.apiUrl = nextApiUrl;
      if (nextApiKey) updates.apiKey = nextApiKey;

      if (Object.keys(updates).length > 0) {
        const saved = await updatePlatform(selectedPlatform.id, updates as any);
        if (!saved.success) {
          setPlatformCheckMsg(saved.error?.message || '保存失败');
          return;
        }
        setApiKeyDraft('');
        setShowApiKey(false);
      }

      // 优先测试该平台的主模型（更贴近“可用性检测”），否则退化为刷新平台模型列表
      const candidate =
        models.find((m) => m.platformId === selectedPlatform.id && m.isMain) ||
        models.find((m) => m.platformId === selectedPlatform.id && m.enabled) ||
        models.find((m) => m.platformId === selectedPlatform.id);

      if (candidate) {
        const r = await testModel(candidate.id);
        if (!r.success) {
          setPlatformCheckMsg(r.error?.message || '检测失败');
          return;
        }
        setPlatformCheckMsg(
          r.data.success
            ? `检测成功：${candidate.modelName}（${r.data.duration}ms）`
            : `检测失败：${r.data.error || '连接失败'}`
        );
        return;
      }

      const r = await apiRequest<unknown[]>(`/api/v1/platforms/${selectedPlatform.id}/refresh-models`, {
        method: 'POST',
        body: {},
      });
      if (!r.success) {
        setPlatformCheckMsg(r.error?.message || '检测失败');
        return;
      }
      setPlatformCheckMsg(`已获取可用模型：${r.data.length} 个`);
    } finally {
      setPlatformChecking(false);
      await load();
    }
  };

  const platformAvatar = (p: Platform) => {
    const t = (p.platformType || '').toLowerCase();
    const avatarUrl = getAvatarUrlByPlatformType(p.platformType || p.name || '');
    const isSvg = isSvgAssetUrl(avatarUrl);
    const isRaster = isRasterAssetUrl(avatarUrl);
    const bg =
      t.includes('openai')
        ? 'rgba(16,185,129,0.18)'
        : t.includes('anthropic')
          ? 'rgba(245,158,11,0.18)'
          : t.includes('google')
            ? 'rgba(59,130,246,0.18)'
            : t.includes('qwen')
              ? 'rgba(168,85,247,0.18)'
              : t.includes('deepseek')
                ? 'rgba(239,68,68,0.16)'
                : 'rgba(255,255,255,0.08)';
    const fg =
      t.includes('openai')
        ? 'rgba(16,185,129,0.95)'
        : t.includes('anthropic')
          ? 'rgba(245,158,11,0.95)'
          : t.includes('google')
            ? 'rgba(59,130,246,0.95)'
            : t.includes('qwen')
              ? 'rgba(168,85,247,0.95)'
              : t.includes('deepseek')
                ? 'rgba(239,68,68,0.95)'
                : 'rgba(247,247,251,0.78)';
    const letter = (p.name || p.platformType || '?').slice(0, 1).toUpperCase();
    return (
      <div
        className="h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-extrabold"
        // 仅在 svg / 文字占位时使用“色块底”，避免 png/jpg 等方图贴边显得突兀
        style={{ background: !avatarUrl || isSvg ? bg : 'transparent', color: fg, border: '1px solid var(--border-subtle)' }}
      >
        {avatarUrl ? (
          isRaster ? (
            <div className="h-6 w-6 rounded-full overflow-hidden bg-transparent">
              <img src={avatarUrl} alt={p.name || p.platformType} className="h-full w-full object-contain" />
            </div>
          ) : (
            <img src={avatarUrl} alt={p.name || p.platformType} className="h-5 w-5 object-contain" />
          )
        ) : (
          letter
        )}
      </div>
    );
  };

  const openCreateModel = () => {
    setEditingModel(null);
    setModelForm({
      ...defaultModelForm,
      platformId: selectedPlatform?.id || platforms[0]?.id || '',
    });
    setModelDialogOpen(true);
  };

  const openEditModel = (m: Model) => {
    setEditingModel(m);
    setModelForm({
      name: m.name,
      modelName: m.modelName,
      platformId: m.platformId,
      group: m.group || '',
      enabled: m.enabled,
      enablePromptCache: typeof (m as any).enablePromptCache === 'boolean' ? (m as any).enablePromptCache : true,
    });
    setModelDialogOpen(true);
  };

  const submitModel = async () => {
    if (editingModel) {
      const res = await updateModel(editingModel.id, {
        name: modelForm.name,
        modelName: modelForm.modelName,
        platformId: modelForm.platformId,
        group: modelForm.group || undefined,
        enabled: modelForm.enabled,
        enablePromptCache: modelForm.enablePromptCache,
      });
      if (!res.success) return;
    } else {
      const res = await createModel({
        name: modelForm.name,
        modelName: modelForm.modelName,
        platformId: modelForm.platformId,
        group: modelForm.group || undefined,
        enabled: modelForm.enabled,
        enablePromptCache: modelForm.enablePromptCache,
      });
      if (!res.success) return;
    }

    setModelDialogOpen(false);
    setEditingModel(null);
    await load();
  };

  const onDeleteModel = async (m: Model) => {
    const res = await deleteModel(m.id);
    if (!res.success) return;
    await load();
  };

  const onSetMain = async (m: Model) => {
    if (m.isMain) return;
    // 先本地即时更新，避免主区域因全局 loading 闪烁“加载中”
    setModels((prev) =>
      prev.map((x) => (x.platformId === m.platformId ? { ...x, isMain: x.id === m.id } : x))
    );
    setMainJustSetId(m.id);

    const res = await setMainModel(m.id);
    if (!res.success) {
      // 失败则静默回源校准
      await load({ silent: true });
      return;
    }
    // 成功后静默刷新，保持与后端一致
    await load({ silent: true });
  };

  const onTest = async (m: Model) => {
    setTestingModelId(m.id);
    setTestResult(null);
    try {
      const res = await testModel(m.id);
      if (res.success && res.data?.success) {
        setTestResult({ modelId: m.id, ok: true, msg: `${res.data.duration}ms` });
      } else {
        const errMsg = res.data?.error ?? res.error?.message ?? '测试失败';
        setTestResult({ modelId: m.id, ok: false, msg: errMsg });
      }
    } catch {
      setTestResult({ modelId: m.id, ok: false, msg: '网络错误' });
    } finally {
      setTestingModelId(null);
      // 自动清除测试结果（让 OK/失败 提示保持一小会儿）
      window.setTimeout(() => setTestResult((cur) => (cur?.modelId === m.id ? null : cur)), 1800);
      // 测试接口会更新后端的模型统计（callCount/averageDuration 等），这里静默刷新一次让 UI 立刻可见
      await load({ silent: true });
      await loadModelStats();
    }
  };

  const toggleModelPromptCache = async (m: Model) => {
    if (modelCacheTogglingId) return;
    setModelCacheTogglingId(m.id);
    try {
      const next = !m.enablePromptCache;
      // 先本地即时更新，提升交互
      setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, enablePromptCache: next } : x)));
      const res = await updateModel(m.id, { enablePromptCache: next } as any);
      if (!res.success) {
        // 失败回滚并静默回源
        setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, enablePromptCache: m.enablePromptCache } : x)));
        await load({ silent: true });
        return;
      }
      await load({ silent: true });
    } finally {
      setModelCacheTogglingId(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  const openModelPicker = async () => {
    if (!selectedPlatform) return;
    setAvailableSearch('');
    setAvailableTab('all');
    setModelPickerOpen(true);
    await fetchAvailableModels();
  };

  const isAll = selectedPlatformId === '__all__';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>模型管理</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            平台 {selectedPlatformId && selectedPlatformId !== '__all__' ? 1 : platforms.length} 个
            {selectedPlatformId && selectedPlatformId !== '__all__'
              ? ` / 模型 ${models.filter((m) => m.platformId === selectedPlatformId).length} 个`
              : ''}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr] flex-1 min-h-0">
        {/* 左侧：平台列表（导航风格） */}
        <Card className="p-0 overflow-hidden flex flex-col">
          <div className="p-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              />
              <input
                value={platformSearch}
                onChange={(e) => setPlatformSearch(e.target.value)}
                type="search"
                name="platform-search"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                className="h-10 w-full rounded-[14px] pl-9 pr-4 text-sm outline-none"
                style={inputStyle}
                placeholder="搜索模型平台..."
              />
            </div>
          </div>

          <div className="flex-1 overflow-auto p-2">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setSelectedPlatformId('__all__')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedPlatformId('__all__');
                }
              }}
              className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-white/2 cursor-pointer select-none"
              style={{
                background: selectedPlatformId === '__all__' ? 'rgba(255,255,255,0.04)' : 'transparent',
                border: selectedPlatformId === '__all__' ? '1px solid var(--border-default)' : '1px solid transparent',
              }}
            >
              <div
                className="h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(247,247,251,0.78)', border: '1px solid var(--border-subtle)' }}
              >
                全
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>全部</div>
                <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>共 {models.length} 个模型</div>
              </div>
              <Badge variant="subtle">{models.length}</Badge>
            </div>

            <div className="mt-2 grid gap-1">
              {filteredPlatforms.map((p) => {
                const isSelected = selectedPlatformId === p.id;
                const count = models.filter((m) => m.platformId === p.id).length;
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedPlatformId(p.id)}
                    onContextMenu={(e) => onOpenPlatformCtxMenu(e, p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedPlatformId(p.id);
                      }
                    }}
                    className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-white/2 cursor-pointer select-none"
                    style={{
                      background: isSelected ? 'rgba(255,255,255,0.04)' : 'transparent',
                      border: isSelected ? '1px solid var(--border-default)' : '1px solid transparent',
                    }}
                  >
                    {platformAvatar(p)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
                        {p.enabled && (
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'rgba(34,197,94,0.9)' }} />
                        )}
                      </div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{count} 个模型</div>
                    </div>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        await togglePlatformEnabled(p);
                      }}
                      onContextMenu={(e) => {
                        // 避免右键启用按钮时触发行点击/聚焦（交互更稳定）
                        e.preventDefault();
                        e.stopPropagation();
                        onOpenPlatformCtxMenu(e, p);
                      }}
                      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors hover:brightness-[1.06] disabled:opacity-60 disabled:cursor-not-allowed"
                      style={
                        p.enabled
                          ? { background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(34,197,94,0.95)' }
                          : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }
                      }
                      disabled={loading || platformTogglingId === p.id}
                      aria-label={p.enabled ? '点击禁用平台' : '点击启用平台'}
                    >
                      {platformTogglingId === p.id ? '处理中' : p.enabled ? '启用' : '禁用'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <Button variant="secondary" size="md" className="w-full" onClick={openCreatePlatform}>
              <Plus size={16} />
              添加平台
            </Button>
          </div>
        </Card>

        {/* 平台右键菜单 */}
        {platformCtxMenu.open && (
          <div
            className="fixed inset-0 z-60"
            onMouseDown={(e) => {
              // 点击空白处关闭
              e.preventDefault();
              closePlatformCtxMenu();
            }}
          >
            <div
              className="fixed z-61 w-[220px] rounded-[14px] p-1.5"
              style={{
                left: platformCtxMenu.x,
                top: platformCtxMenu.y,
                background: 'color-mix(in srgb, var(--bg-elevated) 92%, black)',
                border: '1px solid var(--border-default)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
              }}
              onMouseDown={(e) => {
                // 不让点菜单本身触发 overlay 的关闭
                e.stopPropagation();
              }}
            >
              <button
                type="button"
                className="w-full flex items-center gap-2 rounded-[12px] px-3 py-2 text-sm hover:bg-white/5"
                style={{ color: 'var(--text-primary)' }}
                onClick={() => {
                  const p = platformCtxMenu.platform;
                  closePlatformCtxMenu();
                  if (!p) return;
                  openEditPlatform(p);
                }}
              >
                <Pencil size={16} />
                重命名
              </button>
              <div className="h-px my-1" style={{ background: 'rgba(255,255,255,0.08)' }} />
              <button
                type="button"
                className="w-full flex items-center gap-2 rounded-[12px] px-3 py-2 text-sm hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => closePlatformCtxMenu()}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 右侧：平台详情 + 模型列表 */}
        <Card variant={selectedPlatform ? 'gold' : 'default'} className="p-0 overflow-hidden flex flex-col">
          <div className="p-4 flex items-start justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {selectedPlatform ? selectedPlatform.name : (selectedPlatformId === '__all__' ? '全部模型' : '请选择平台')}
                </div>
                {selectedPlatform && <Badge variant="subtle">{selectedPlatform.platformType}</Badge>}
              </div>
              {selectedPlatform ? null : isAll ? (
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  展示全部平台的模型列表
                </div>
              ) : (
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  从左侧选择一个平台以查看配置与模型列表
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <Tooltip
                content={
                  <div className="leading-snug">
                    <div className="font-semibold">模型地图</div>
                    <div style={{ color: 'var(--text-muted)' }}>查看主/意图/识图/生图/嵌入/重排的当前选择</div>
                  </div>
                }
                side="bottom"
                align="end"
              >
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setModelMapOpen(true)}
                    aria-label="打开模型地图"
                    disabled={models.length === 0}
                    className="h-[35px] w-[35px] p-0 rounded-[12px]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {/* 几何六芒星图标：避免五角星视觉 */}
                    <svg width="18" height="18" viewBox="0 0 100 100" aria-hidden="true">
                      <path d="M50 10 L88 78 L12 78 Z" fill="none" stroke="currentColor" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
                      <path d="M50 90 L12 22 L88 22 Z" fill="none" stroke="currentColor" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" opacity="0.72" />
                    </svg>
                  </Button>
                </span>
              </Tooltip>

              {selectedPlatform && (
                <>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>启用</div>
                  <button
                    type="button"
                    onClick={async () => {
                      await savePlatformInline({ enabled: !selectedPlatform.enabled });
                    }}
                    className="relative h-7 w-12 rounded-full transition-colors"
                    style={{
                      background: selectedPlatform.enabled ? 'rgba(34,197,94,0.22)' : 'rgba(255,255,255,0.10)',
                      border: selectedPlatform.enabled ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(255,255,255,0.14)',
                    }}
                    aria-label={selectedPlatform.enabled ? '已启用，点击关闭' : '已禁用，点击启用'}
                  >
                    <span
                      className="absolute top-1 left-1 h-5 w-5 rounded-full transition-transform"
                      style={{
                        transform: selectedPlatform.enabled ? 'translateX(20px)' : 'translateX(0px)',
                        background: selectedPlatform.enabled ? 'rgba(34,197,94,0.95)' : 'rgba(247,247,251,0.65)',
                      }}
                    />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="py-16 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : selectedPlatform || isAll ? (
              <div className="p-4 space-y-6">
                {selectedPlatform && (
                  <>
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>API 密钥</div>
                      <div className="mt-2">
                        <div
                          className="flex h-[30px] box-border items-center overflow-hidden rounded-[14px]"
                          style={{
                            background: 'var(--bg-input)',
                            border: '1px solid rgba(255,255,255,0.12)',
                          }}
                        >
                          <input
                            value={apiKeyDraft}
                            onChange={(e) => setApiKeyDraft(e.target.value)}
                            className="h-full w-full flex-1 bg-transparent px-4 text-sm outline-none"
                            style={{ color: 'var(--text-primary)' }}
                            type={showApiKey ? 'text' : 'password'}
                            name="platform-api-key"
                            autoComplete="new-password"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            placeholder={selectedPlatform.apiKeyMasked || 'sk-...'}
                          />

                          <button
                            type="button"
                            className="h-full w-[30px] inline-flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed"
                            onClick={() => setShowApiKey((v) => !v)}
                            aria-label={showApiKey ? '隐藏' : '显示'}
                            disabled={platformChecking}
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>

                          <div className="h-6 w-px" style={{ background: 'rgba(255,255,255,0.12)' }} />

                          <button
                            type="button"
                            onClick={onCheckPlatform}
                            disabled={platformChecking}
                            className="h-full px-4 text-[13px] font-semibold transition-colors hover:bg-white/8 disabled:opacity-60 disabled:cursor-not-allowed"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {platformChecking ? '检测中' : '检测'}
                          </button>
                        </div>
                      </div>
                      {platformCheckMsg && (
                        <div className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {platformCheckMsg}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>API 地址</div>
                      <div className="mt-2">
                        <input
                          value={apiUrlDraft}
                          onChange={(e) => setApiUrlDraft(e.target.value)}
                          onBlur={async () => {
                            const next = apiUrlDraft.trim();
                            if (!next || next === selectedPlatform.apiUrl) return;
                            await savePlatformInline({ apiUrl: next });
                          }}
                          className="h-[30px] w-full rounded-[14px] px-4 text-sm outline-none"
                          style={inputStyle}
                          type="url"
                          name="platform-api-url"
                          autoComplete="off"
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-bwignore="true"
                          placeholder="https://..."
                        />
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>模型</div>
                      <Badge variant="subtle">{filteredModels.length}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Search
                          size={16}
                          className="absolute left-3 top-1/2 -translate-y-1/2"
                          style={{ color: 'var(--text-muted)' }}
                        />
                        <input
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          type="search"
                          name="model-search"
                          autoComplete="off"
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-bwignore="true"
                          className="h-10 rounded-[14px] pl-9 pr-4 text-sm outline-none"
                          style={{ ...inputStyle, width: 260 }}
                          placeholder="搜索模型..."
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    {displayedModels.length === 0 ? (
                      <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无模型</div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {canDragSort ? '提示：拖拽左侧把手可调整“全部模型”的全局优先级' : '提示：切换到“全部”后可拖拽调整全局优先级'}
                          </div>
                          {prioritySaving ? (
                            <div className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                              <RefreshCw size={14} className="animate-spin" />
                              保存排序中...
                            </div>
                          ) : null}
                        </div>

                        <div className="rounded-[16px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                          <div className="divide-y divide-white/30">
                            {displayedModels.map((m) => (
                              <div
                                key={m.id}
                                className={[
                                  'px-4 py-3 flex items-center justify-between hover:bg-white/2',
                                  mainJustSetId === m.id ? 'main-row-flash' : '',
                                ].join(' ')}
                                draggable={canDragSort}
                                onDragStart={(e) => {
                                  if (!canDragSort) return;
                                  setDraggingModelId(m.id);
                                  e.dataTransfer.effectAllowed = 'move';
                                  try {
                                    e.dataTransfer.setData('text/plain', m.id);
                                  } catch {
                                    // ignore
                                  }
                                }}
                                onDragEnd={() => setDraggingModelId(null)}
                                onDragOver={(e) => {
                                  if (!canDragSort) return;
                                  e.preventDefault();
                                  if (!draggingModelId) return;
                                  if (draggingModelId === m.id) return;
                                  setModelOrderIds((prev) => moveId(prev, draggingModelId, m.id));
                                }}
                                onDrop={(e) => {
                                  if (!canDragSort) return;
                                  e.preventDefault();
                                  void persistPriorityOrder(modelOrderIds);
                                }}
                              >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                                      <div
                                        className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-[10px] cursor-grab active:cursor-grabbing"
                                        title={canDragSort ? '拖拽排序（优先级）' : '切换到全部后可拖拽排序'}
                                        style={{
                                          border: '1px solid rgba(255,255,255,0.10)',
                                          color: canDragSort ? 'var(--text-secondary)' : 'rgba(255,255,255,0.25)',
                                          background: 'rgba(255,255,255,0.03)',
                                        }}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <GripVertical size={16} />
                                      </div>

                                      <div
                                        className="text-sm font-semibold truncate"
                                        style={{ color: 'var(--text-primary)' }}
                                        title={m.modelName}
                                      >
                                        {m.name}
                                      </div>

                                      {isAll ? (() => {
                                        const p = platformById.get(m.platformId);
                                        if (!p) return null;
                                        const pid = (p.providerId || p.platformType || '').trim();
                                        const title = `${p.name}${pid ? ` · ${pid}` : ''}`;
                                        return (
                                          <span title={title}>
                                            <Badge variant="subtle">{p.name}</Badge>
                                          </span>
                                        );
                                      })() : null}

                                      {/* 模型统计：放到模型名后面（无数据/为 0 则隐藏；样式参考 FlagLabel） */}
                                      {(() => {
                                        if (modelStatsLoading) return null;
                                        const key = String(m.modelName ?? '').trim().toLowerCase();
                                        const sFromLogs = key ? modelStatsByModel[key] : undefined;
                                        const reqFromModel = Math.max(0, Number(m.callCount ?? 0));
                                        const avgFromModel = Number(m.averageDuration ?? 0);

                                        const s: AggregatedModelStats | null =
                                          sFromLogs
                                            ? sFromLogs
                                            : (reqFromModel > 0
                                              ? {
                                                requestCount: reqFromModel,
                                                avgDurationMs: Number.isFinite(avgFromModel) && avgFromModel > 0 ? Math.round(avgFromModel) : null,
                                                avgTtfbMs: null,
                                                totalInputTokens: 0,
                                                totalOutputTokens: 0,
                                              }
                                              : null);

                                        if (!s) return null;

                                        const chips: React.ReactNode[] = [];
                                        const titlePrefix = `近${modelStatsDays}天`;
                                        const white = 'rgba(255,255,255,0.92)';

                                        if (s.requestCount > 0) {
                                          chips.push(
                                            <StatLabel
                                              key="req"
                                              icon={<Activity size={12} />}
                                              text={`请求 ${formatCompactZh(s.requestCount)}`}
                                              title={`${titlePrefix} · 请求次数${sFromLogs ? '' : '（模型计数）'}`}
                                              style={{
                                                background: 'rgba(255,255,255,0.05)',
                                                border: '1px solid rgba(255,255,255,0.12)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        if ((s.avgDurationMs ?? 0) > 0) {
                                          chips.push(
                                            <StatLabel
                                              key="dur"
                                              icon={<Clock size={12} />}
                                              text={`平均 ${s.avgDurationMs}ms`}
                                              title={`${titlePrefix} · 平均响应时间`}
                                              style={{
                                                background: 'rgba(245,158,11,0.12)',
                                                border: '1px solid rgba(245,158,11,0.28)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        if ((s.avgTtfbMs ?? 0) > 0) {
                                          chips.push(
                                            <StatLabel
                                              key="ttfb"
                                              icon={<Zap size={12} />}
                                              text={`首字 ${s.avgTtfbMs}ms`}
                                              title={`${titlePrefix} · 首字延迟（TTFB）`}
                                              style={{
                                                background: 'rgba(59,130,246,0.12)',
                                                border: '1px solid rgba(59,130,246,0.28)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        if (s.totalInputTokens > 0) {
                                          chips.push(
                                            <StatLabel
                                              key="in"
                                              icon={<ArrowDown size={12} />}
                                              text={`输入 ${formatCompactZh(s.totalInputTokens)}`}
                                              title={`${titlePrefix} · 输入 token（总量）`}
                                              style={{
                                                background: 'rgba(168,85,247,0.12)',
                                                border: '1px solid rgba(168,85,247,0.28)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        if (s.totalOutputTokens > 0) {
                                          chips.push(
                                            <StatLabel
                                              key="out"
                                              icon={<ArrowUp size={12} />}
                                              text={`输出 ${formatCompactZh(s.totalOutputTokens)}`}
                                              title={`${titlePrefix} · 输出 token（总量）`}
                                              style={{
                                                background: 'rgba(34,197,94,0.12)',
                                                border: '1px solid rgba(34,197,94,0.28)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        // 成本估算（需要平台本地定价）
                                        const pricing = pricingByPlatformId[m.platformId] ?? null;
                                        const cost = estimateCost(s, pricing);
                                        if (cost != null && pricing) {
                                          chips.push(
                                            <StatLabel
                                              key="cost"
                                              icon={<DollarSign size={12} />}
                                              text={`成本 ${formatMoney(cost, pricing.currency || '¥')}`}
                                              title={`${titlePrefix} · 成本估算（基于本地单价配置）`}
                                              style={{
                                                background: 'rgba(16,185,129,0.10)',
                                                border: '1px solid rgba(16,185,129,0.24)',
                                                color: white,
                                              }}
                                            />
                                          );
                                        }

                                        if (chips.length === 0) return null;
                                        return <div className="flex flex-wrap items-center gap-2 min-w-0">{chips}</div>;
                                      })()}
                                    </div>
                                    {/* 第二行：用于展示标签（主/意图/识图/生图/禁用） */}
                                    {(m.isMain || m.isIntent || m.isVision || m.isImageGen || !m.enabled) ? (
                                      <div className="mt-1 flex items-center gap-2 min-w-0">
                                        {m.isMain ? (
                                          <FlagLabel
                                            icon={<Star size={12} fill="currentColor" />}
                                            text="主"
                                            style={{
                                              background: 'color-mix(in srgb, var(--accent-gold) 18%, transparent)',
                                              border: '1px solid color-mix(in srgb, var(--accent-gold) 35%, transparent)',
                                              color: 'var(--accent-gold-2)',
                                            }}
                                          />
                                        ) : null}
                                        {m.isIntent ? (
                                          <FlagLabel
                                            icon={<Sparkles size={12} />}
                                            text="意图"
                                            style={{
                                              background: 'rgba(34,197,94,0.12)',
                                              border: '1px solid rgba(34,197,94,0.28)',
                                              color: 'rgba(34,197,94,0.95)',
                                            }}
                                          />
                                        ) : null}
                                        {m.isVision ? (
                                          <FlagLabel
                                            icon={<ScanEye size={12} />}
                                            text="识图"
                                            style={{
                                              background: 'rgba(59,130,246,0.12)',
                                              border: '1px solid rgba(59,130,246,0.28)',
                                              color: 'rgba(59,130,246,0.95)',
                                            }}
                                          />
                                        ) : null}
                                        {m.isImageGen ? (
                                          <FlagLabel
                                            icon={<ImagePlus size={12} />}
                                            text="生图"
                                            style={{
                                              background: 'rgba(168,85,247,0.12)',
                                              border: '1px solid rgba(168,85,247,0.28)',
                                              color: 'rgba(168,85,247,0.95)',
                                            }}
                                          />
                                        ) : null}
                                        {!m.enabled ? (
                                          <FlagLabel
                                            icon={<EyeOff size={12} />}
                                            text="禁用"
                                            style={{
                                              background: 'rgba(255,255,255,0.04)',
                                              border: '1px solid rgba(255,255,255,0.12)',
                                              color: 'var(--text-secondary)',
                                            }}
                                          />
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="inline-flex items-center justify-center h-[32px] w-[32px] rounded-[10px] transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:bg-white/6"
                                      style={{
                                        border: '1px solid rgba(255,255,255,0.10)',
                                        color: m.enablePromptCache ? 'rgba(34,197,94,0.95)' : 'var(--text-secondary)',
                                      }}
                                      title={m.enablePromptCache ? 'Prompt Cache：开（点击关闭）' : 'Prompt Cache：关（点击开启）'}
                                      aria-label="切换 Prompt Cache"
                                      disabled={modelCacheTogglingId != null}
                                      onClick={() => void toggleModelPromptCache(m)}
                                    >
                                      <DatabaseZap size={16} />
                                    </button>

                                    <Button
                                      variant="secondary"
                                      size="xs"
                                      disabled={testingModelId != null}
                                      onClick={() => void onTest(m)}
                                      className={[
                                        testingModelId === m.id ? 'test-btn-loading' : '',
                                        testResult?.modelId === m.id && testResult.ok ? 'test-btn-ok' : '',
                                      ].filter(Boolean).join(' ')}
                                      style={
                                        testResult?.modelId === m.id
                                          ? testResult.ok
                                            ? { background: 'rgba(34,197,94,0.18)', borderColor: 'rgba(34,197,94,0.35)', color: 'rgba(34,197,94,0.95)' }
                                            : { background: 'rgba(239,68,68,0.14)', borderColor: 'rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }
                                          : undefined
                                      }
                                      title={testResult?.modelId === m.id && !testResult.ok ? testResult.msg : `测试：${m.name}`}
                                    >
                                      {testingModelId === m.id ? (
                                        <RefreshCw size={16} className="animate-spin" />
                                      ) : testResult?.modelId === m.id ? (
                                        testResult.ok ? <Check size={16} /> : <Minus size={16} />
                                      ) : (
                                        <Link2 size={16} />
                                      )}
                                      {testingModelId === m.id
                                        ? '测试中'
                                        : testResult?.modelId === m.id
                                          ? testResult.ok
                                            ? 'OK'
                                            : '失败'
                                          : '测试'}
                                    </Button>

                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => onSetMain(m)}
                                      disabled={m.isMain}
                                      aria-label={m.isMain ? '主模型' : '设为主模型'}
                                      title={m.isMain ? '主模型' : '设为主模型'}
                                      className={m.isMain ? 'disabled:opacity-100' : ''}
                                      style={m.isMain ? { color: 'rgba(250,204,21,0.95)' } : { color: 'var(--text-secondary)' }}
                                    >
                                      <Star
                                        size={16}
                                        fill={m.isMain ? 'currentColor' : 'none'}
                                        className={mainJustSetId === m.id ? 'main-star-pop' : ''}
                                      />
                                    </Button>

                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => (m.isIntent ? onClearIntent(m) : onSetIntent(m))}
                                      aria-label={m.isIntent ? '取消意图模型' : '设为意图模型'}
                                      title={m.isIntent ? '取消意图模型（将回退到主模型执行）' : '设为意图模型'}
                                      className={m.isIntent ? 'disabled:opacity-100' : ''}
                                      style={m.isIntent ? { color: 'rgba(34,197,94,0.95)' } : { color: 'var(--text-secondary)' }}
                                    >
                                      <Sparkles size={16} className={intentJustSetId === m.id ? 'main-star-pop' : ''} />
                                    </Button>

                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => (m.isVision ? onClearVision(m) : onSetVision(m))}
                                      aria-label={m.isVision ? '图片识别模型' : '设为图片识别模型'}
                                      title={m.isVision ? '取消图片识别模型（将回退到主模型执行）' : '设为图片识别模型'}
                                      className={m.isVision ? 'disabled:opacity-100' : ''}
                                      style={m.isVision ? { color: 'rgba(59,130,246,0.95)' } : { color: 'var(--text-secondary)' }}
                                    >
                                      <ScanEye size={16} className={visionJustSetId === m.id ? 'main-star-pop' : ''} />
                                    </Button>

                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => (m.isImageGen ? onClearImageGen(m) : onSetImageGen(m))}
                                      aria-label={m.isImageGen ? '图片生成模型' : '设为图片生成模型'}
                                      title={m.isImageGen ? '取消图片生成模型（将回退到主模型执行）' : '设为图片生成模型'}
                                      className={m.isImageGen ? 'disabled:opacity-100' : ''}
                                      style={m.isImageGen ? { color: 'rgba(168,85,247,0.95)' } : { color: 'var(--text-secondary)' }}
                                    >
                                      <ImagePlus size={16} className={imageGenJustSetId === m.id ? 'main-star-pop' : ''} />
                                    </Button>

                                    <Button variant="ghost" size="sm" onClick={() => openEditModel(m)}>
                                      <Pencil size={16} />
                                    </Button>
                                    <ConfirmTip
                                      title={`确认删除模型“${m.name}”？`}
                                      description="该操作不可撤销"
                                      confirmText="确认删除"
                                      cancelText="取消"
                                      onConfirm={() => onDeleteModel(m)}
                                      side="top"
                                      align="end"
                                    >
                                      <Button variant="danger" size="sm" aria-label="删除模型">
                                        <Trash2 size={16} />
                                      </Button>
                                    </ConfirmTip>
                                  </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                请选择左侧平台
              </div>
            )}
          </div>

          <div className="p-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <Button
              variant="secondary"
              size="sm"
              className="w-[100px]"
              onClick={() => {
                if (selectedPlatform) openModelPicker();
              }}
              disabled={!selectedPlatform}
            >
              管理
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={openCreateModel}
              disabled={!selectedPlatform && platforms.length === 0}
            >
              <Plus size={16} />
              添加模型
            </Button>

            <div className="flex-1" />

            {selectedPlatform && (
              <ConfirmTip
                title={`确认删除“${selectedPlatform.name}”平台？`}
                description="该操作不可撤销"
                confirmText="确认删除"
                cancelText="取消"
                onConfirm={() => onDeletePlatform(selectedPlatform)}
                side="top"
                align="end"
              >
                <Button variant="danger" size="sm">
                  删除平台
                </Button>
              </ConfirmTip>
            )}
          </div>
        </Card>
      </div>

      <Dialog
        open={platformDialogOpen}
        onOpenChange={(open) => {
          setPlatformDialogOpen(open);
          if (!open) setEditingPlatform(null);
        }}
        title={editingPlatform ? '编辑平台' : '添加平台'}
        description={editingPlatform ? '更新平台基础信息' : '创建一个新的 LLM 平台'}
        content={
          <div className="space-y-4">
            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>名称</div>
              <input
                value={platformForm.name}
                onChange={(e) => setPlatformForm((s) => ({ ...s, name: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="如 OpenAI"
              />
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>类型</div>
              <Select
                value={platformForm.platformType}
                onChange={(e) => setPlatformForm((s) => ({ ...s, platformType: e.target.value }))}
                className="w-full"
              >
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="google">google</option>
                <option value="qwen">qwen</option>
                <option value="deepseek">deepseek</option>
                <option value="other">other</option>
              </Select>
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                ProviderId（可选）
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  用于 Cherry 分组/特例（如 silicon/dashscope）
                </span>
              </div>
              <input
                value={platformForm.providerId}
                onChange={(e) => setPlatformForm((s) => ({ ...s, providerId: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="例如：silicon / dashscope（留空=platformType）"
              />
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                成本估算（本地）
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  仅用于管理后台展示，不写入后端
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  value={platformForm.pricingCurrency}
                  onChange={(e) => setPlatformForm((s) => ({ ...s, pricingCurrency: e.target.value }))}
                  className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={inputStyle}
                  placeholder="币种符号（¥/$）"
                />
                <input
                  value={platformForm.pricingInPer1k}
                  onChange={(e) => setPlatformForm((s) => ({ ...s, pricingInPer1k: e.target.value }))}
                  className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={inputStyle}
                  placeholder="输入单价/1K"
                />
                <input
                  value={platformForm.pricingOutPer1k}
                  onChange={(e) => setPlatformForm((s) => ({ ...s, pricingOutPer1k: e.target.value }))}
                  className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={inputStyle}
                  placeholder="输出单价/1K"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>API URL</div>
              <input
                value={platformForm.apiUrl}
                onChange={(e) => setPlatformForm((s) => ({ ...s, apiUrl: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="https://..."
              />
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>API Key {editingPlatform ? '（留空不变）' : ''}</div>
              <input
                value={platformForm.apiKey}
                onChange={(e) => setPlatformForm((s) => ({ ...s, apiKey: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="sk-..."
              />
            </div>

            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={platformForm.enabled}
                onChange={(e) => setPlatformForm((s) => ({ ...s, enabled: e.target.checked }))}
              />
              启用
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setPlatformDialogOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={submitPlatform}>
                <Check size={16} />
                保存
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={modelPickerOpen}
        onOpenChange={(open) => {
          setModelPickerOpen(open);
          if (!open) {
            setAvailableModels([]);
            setAvailableError(null);
          }
        }}
        title={`${selectedPlatform?.name ?? ''}模型`}
        description="从平台可用模型列表中一键添加/移除"
        maxWidth={600}
        contentStyle={{ height: 'min(80vh, 720px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col space-y-4">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                />
                <input
                  value={availableSearch}
                  onChange={(e) => setAvailableSearch(e.target.value)}
                  type="search"
                  name="available-model-search"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  className="h-10 w-full rounded-[14px] pl-9 pr-4 text-sm outline-none"
                  style={inputStyle}
                  placeholder="搜索模型 ID 或名称"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await fetchAvailableModels({ refresh: true });
                }}
                disabled={!selectedPlatform || availableLoading}
                aria-label="刷新"
              >
                <RefreshCw size={16} />
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {(
                [
                  ['all', '全部'],
                  ['reasoning', '推理'],
                  ['vision', '视觉'],
                  ['web', '联网'],
                  ['free', '免费'],
                  ['embedding', '嵌入'],
                  ['rerank', '重排'],
                  ['tools', '工具'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setAvailableTab(k)}
                  className="px-1 pb-2 text-sm transition-colors"
                  style={{
                    color: availableTab === k ? 'rgba(34,197,94,0.95)' : 'var(--text-secondary)',
                    borderBottom: availableTab === k ? '2px solid rgba(34,197,94,0.95)' : '2px solid transparent',
                  }}
                >
                  {label}
                </button>
              ))}
              <div className="flex-1" />
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                可用 {filteredAvailableModels.length} 个 · 已添加 {existingModelByName.size} 个
              </div>
            </div>

            <div
              className="rounded-[16px] overflow-hidden flex flex-col flex-1 min-h-0"
              style={{ border: '1px solid var(--border-subtle)' }}
            >
              {availableLoading ? (
                <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
              ) : availableError ? (
                <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>{availableError}</div>
              ) : groupedAvailable.length === 0 ? (
                <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>暂无可用模型</div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="space-y-2 p-2">
                    {groupedAvailable.map(([g, ms]) => (
                      <details
                        key={g}
                        className="rounded-[14px] overflow-hidden"
                        style={{ border: '1px solid var(--border-subtle)' }}
                        open={!!openAvailableGroups[g]}
                        onToggle={(e) => {
                          const nextOpen = (e.currentTarget as HTMLDetailsElement).open;
                          setOpenAvailableGroups((prev) => ({ ...prev, [g]: nextOpen }));
                        }}
                      >
                        <summary
                          className="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
                          style={{ background: 'rgba(255,255,255,0.03)' }}
                        >
                          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{g}</div>
                          <div className="flex items-center gap-2">
                            <Badge variant="subtle">{ms.length}</Badge>
                            <button
                              type="button"
                              className="inline-flex items-center justify-center h-[26px] w-[26px] rounded-[10px] hover:bg-white/6"
                              style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                              title="批量添加该组"
                              onClick={(e) => {
                                e.preventDefault(); // 避免触发 summary toggle
                                e.stopPropagation();
                                void bulkAddAvailableGroup(g, ms);
                              }}
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                        </summary>
                        <div className="divide-y divide-white/30">
                          {ms.map((m) => {
                            const exist = existingModelByName.get(m.modelName);
                            const label = (m.displayName || m.modelName).trim();
                            const avatarUrl =
                              (g || '').toLowerCase() === 'other' ? getAvatarUrlByModelName(m.modelName || label) : getAvatarUrlByGroup(g);
                            return (
                              <div
                                key={`${g}:${m.modelName}`}
                                className="px-4 py-3 flex items-center justify-between transition-colors"
                                style={{
                                  background: exist ? 'rgba(34,197,94,0.08)' : 'transparent',
                                }}
                              >
                                <div className="min-w-0 flex items-center gap-3">
                                  <div
                                    className="h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                                    style={{
                                      // 仅在 svg / 文字占位时使用“色块底”，避免 png/jpg 等方图贴边显得突兀
                                      background: !avatarUrl || isSvgAssetUrl(avatarUrl) ? 'rgba(59,130,246,0.14)' : 'rgba(255, 255, 255, 0)',
                                      color: 'rgba(59,130,246,0.95)',
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                  >
                                    {avatarUrl ? (
                                      isRasterAssetUrl(avatarUrl) ? (
                                        <div className="h-6 w-6 rounded-full overflow-hidden bg-transparent">
                                          <img src={avatarUrl} alt={g} className="h-full w-full object-contain" style={{ opacity: 1 }} />
                                        </div>
                                      ) : (
                                        <img
                                          src={avatarUrl}
                                          alt={g}
                                          className="h-5 w-5 object-contain"
                                          style={{
                                            opacity: 1,
                                            // svg 图标可保留轻微阴影提升可读性（raster 容易把“方边”阴影放大）
                                            filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))',
                                          }}
                                        />
                                      )
                                    ) : (
                                      g.slice(0, 1).toUpperCase()
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                        {label}
                                      </div>
                                      {exist && <Badge variant="success">已添加</Badge>}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <PresetTagIcons modelName={m.modelName} displayName={m.displayName} />
                                <Button
                                  variant={exist ? 'secondary' : 'ghost'}
                                  size="sm"
                                  onClick={() => toggleModel(m)}
                                  disabled={availableLoading}
                                  aria-label={exist ? '移除' : '添加'}
                                >
                                  {exist ? <Minus size={16} /> : <Plus size={16} />}
                                </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        }
      />

      <Dialog
        open={modelDialogOpen}
        onOpenChange={(open) => {
          setModelDialogOpen(open);
          if (!open) setEditingModel(null);
        }}
        title={editingModel ? '编辑模型' : '添加模型'}
        description={editingModel ? '更新模型配置' : '创建一个新的模型'}
        content={
          <div className="space-y-4">
            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>名称</div>
              <input
                value={modelForm.name}
                onChange={(e) => setModelForm((s) => ({ ...s, name: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="如 GPT-4o"
              />
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Model Name</div>
              <input
                value={modelForm.modelName}
                onChange={(e) => setModelForm((s) => ({ ...s, modelName: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="如 gpt-4o"
              />
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>平台</div>
              <Select
                value={modelForm.platformId}
                onChange={(e) => setModelForm((s) => ({ ...s, platformId: e.target.value }))}
                className="w-full"
              >
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>

            <div className="grid gap-2">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>分组（可选）</div>
              <input
                value={modelForm.group}
                onChange={(e) => setModelForm((s) => ({ ...s, group: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
                placeholder="如 openai-gpt"
              />
            </div>

            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={modelForm.enabled}
                onChange={(e) => setModelForm((s) => ({ ...s, enabled: e.target.checked }))}
              />
              启用
            </label>

            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={modelForm.enablePromptCache}
                onChange={(e) => setModelForm((s) => ({ ...s, enablePromptCache: e.target.checked }))}
              />
              Prompt Cache（模型级）
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setModelDialogOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={submitModel}>
                <Check size={16} />
                保存
              </Button>
            </div>
          </div>
        }
      />

      <ModelMapDialog
        open={modelMapOpen}
        onOpenChange={setModelMapOpen}
        models={models}
        platforms={platforms}
        selectedPlatformId={selectedPlatformId}
      />
    </div>
  );
}
