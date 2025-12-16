import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import {
  createModel,
  createPlatform,
  deleteModel,
  deletePlatform,
  getModels,
  getPlatforms,
  setMainModel,
  testModel,
  updateModel,
  updatePlatform,
} from '@/services';
import type { Model, Platform } from '@/types/admin';
import { Check, Eye, EyeOff, Link2, Minus, Pencil, Plus, RefreshCw, Search, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '@/services/real/apiClient';
import { getAvatarUrlByGroup, getAvatarUrlByModelName, getAvatarUrlByPlatformType } from '@/assets/model-avatars';

type PlatformForm = {
  name: string;
  platformType: string;
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
};

type ModelForm = {
  name: string;
  modelName: string;
  platformId: string;
  group: string;
  enabled: boolean;
};

type AvailableModel = {
  modelName: string;
  displayName: string;
  group?: string;
};

const defaultPlatformForm: PlatformForm = {
  name: '',
  platformType: 'openai',
  apiUrl: '',
  apiKey: '',
  enabled: true,
};

const defaultModelForm: ModelForm = {
  name: '',
  modelName: '',
  platformId: '',
  group: '',
  enabled: true,
};

const isSvgAssetUrl = (url?: string | null) => !!url && /\.svg(\?|#|$)/i.test(url);
const isRasterAssetUrl = (url?: string | null) => !!url && /\.(png|jpe?g|webp|gif|bmp|ico)(\?|#|$)/i.test(url);

export default function ModelManagePage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedPlatformId, setSelectedPlatformId] = useState<string>('');
  const [platformSearch, setPlatformSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');

  const [platformDialogOpen, setPlatformDialogOpen] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<Platform | null>(null);
  const [platformForm, setPlatformForm] = useState<PlatformForm>(defaultPlatformForm);

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(defaultModelForm);

  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ modelId: string; ok: boolean; msg?: string } | null>(null);
  const [mainJustSetId, setMainJustSetId] = useState<string | null>(null);
  const [platformTogglingId, setPlatformTogglingId] = useState<string | null>(null);
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

  const load = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [p, m] = await Promise.all([getPlatforms(), getModels()]);
      if (p.success) {
        setPlatforms(p.data);
        setSelectedPlatformId((cur) => (cur ? cur : (p.data[0]?.id || '')));
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

  // 主模型选中后的瞬时动效（行闪一下 + 星星弹一下）
  useEffect(() => {
    if (!mainJustSetId) return;
    const t = window.setTimeout(() => setMainJustSetId(null), 650);
    return () => window.clearTimeout(t);
  }, [mainJustSetId]);

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

  const useMockMode = useMemo(() => {
    return ['1', 'true', 'yes'].includes(((import.meta.env.VITE_USE_MOCK as string | undefined) ?? '').toLowerCase());
  }, []);

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

  const grouped = useMemo(() => {
    const g: Record<string, Model[]> = {};
    for (const m of filteredModels) {
      const key = m.group || m.modelName.split('-').slice(0, 2).join('-') || 'other';
      (g[key] ||= []).push(m);
    }
    // 同组内按“名字”排序（UI 展示用），不改变分组排序策略
    for (const ms of Object.values(g)) {
      ms.sort((a, b) => {
        const an = (a.name || a.modelName || '').trim();
        const bn = (b.name || b.modelName || '').trim();
        return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
      });
    }
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  }, [filteredModels]);

  const existingModelByName = useMemo(() => {
    const map = new Map<string, Model>();
    if (!selectedPlatform) return map;
    for (const m of models) {
      if (m.platformId !== selectedPlatform.id) continue;
      if (!map.has(m.modelName)) map.set(m.modelName, m);
    }
    return map;
  }, [models, selectedPlatform?.id]);

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
    const s = availableSearch.trim().toLowerCase();
    if (!s) return list;
    return list.filter((m) => (m.modelName || '').toLowerCase().includes(s) || (m.displayName || '').toLowerCase().includes(s));
  }, [availableModels, availableSearch, availableTab]);

  const groupedAvailable = useMemo(() => {
    const autoGroupKey = (rawName: string) => {
      const s = (rawName || '').trim().toLowerCase();
      const parts = s.replace(/\//g, '-').split('-').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
      if (parts.length >= 1) return parts[0];
      return 'other';
    };

    const buckets: Record<string, AvailableModel[]> = {};
    for (const m of filteredAvailableModels) {
      const key = (m.group || autoGroupKey(m.modelName) || 'other').toLowerCase();
      (buckets[key] ||= []).push(m);
    }

    // 模型数量不足 3 的分组统一并入 other
    const merged: Record<string, AvailableModel[]> = {};
    const other: AvailableModel[] = [];
    for (const [k, ms] of Object.entries(buckets)) {
      if (k !== 'other' && ms.length < 3) other.push(...ms);
      else merged[k] = ms;
    }
    if (buckets.other) other.push(...buckets.other);
    if (other.length > 0) merged.other = other;

    // 同组内按“名字”排序（优先 displayName，其次 modelName）
    for (const ms of Object.values(merged)) {
      ms.sort((a, b) => {
        const an = ((a.displayName || a.modelName) || '').trim();
        const bn = ((b.displayName || b.modelName) || '').trim();
        return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    return Object.entries(merged).sort((a, b) => {
      const ao = a[0] === 'other';
      const bo = b[0] === 'other';
      if (ao !== bo) return ao ? 1 : -1;
      return b[1].length - a[1].length;
    });
  }, [filteredAvailableModels]);

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
    });
    if (!res.success) return;
    await load();
  };

  const openCreatePlatform = () => {
    setEditingPlatform(null);
    setPlatformForm(defaultPlatformForm);
    setPlatformDialogOpen(true);
  };

  const submitPlatform = async () => {
    if (editingPlatform) {
      const res = await updatePlatform(editingPlatform.id, {
        name: platformForm.name,
        platformType: platformForm.platformType,
        apiUrl: platformForm.apiUrl,
        apiKey: platformForm.apiKey || undefined,
        enabled: platformForm.enabled,
      });
      if (!res.success) return;
    } else {
      const res = await createPlatform({
        name: platformForm.name,
        platformType: platformForm.platformType,
        apiUrl: platformForm.apiUrl,
        apiKey: platformForm.apiKey,
        enabled: platformForm.enabled,
      });
      if (!res.success) return;
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

      if (useMockMode) {
        setPlatformCheckMsg('mock：检测通过');
        return;
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
      });
      if (!res.success) return;
    } else {
      const res = await createModel({
        name: modelForm.name,
        modelName: modelForm.modelName,
        platformId: modelForm.platformId,
        group: modelForm.group || undefined,
        enabled: modelForm.enabled,
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
    <div className="space-y-4">
      <div>
        <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>模型管理</div>
        <div className="mt-1 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
          平台 {selectedPlatformId && selectedPlatformId !== '__all__' ? 1 : platforms.length} 个
          {selectedPlatformId && selectedPlatformId !== '__all__'
            ? ` / 模型 ${models.filter((m) => m.platformId === selectedPlatformId).length} 个`
            : ''}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]" style={{ minHeight: 720 }}>
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
            <button
              type="button"
              onClick={() => setSelectedPlatformId('__all__')}
              className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-white/2"
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
            </button>

            <div className="mt-2 grid gap-1">
              {filteredPlatforms.map((p) => {
                const isSelected = selectedPlatformId === p.id;
                const count = models.filter((m) => m.platformId === p.id).length;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPlatformId(p.id)}
                    className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-white/2"
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
                  </button>
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

            {selectedPlatform && (
              <div className="flex items-center gap-3">
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
              </div>
            )}
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
                    {grouped.length === 0 ? (
                      <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无模型</div>
                    ) : (
                      <div className="space-y-3">
                        {grouped.map(([g, ms], idx) => (
                          <details
                            key={g}
                            className="rounded-[16px] overflow-hidden"
                            style={{ border: '1px solid var(--border-subtle)' }}
                            open={idx < 6}
                          >
                            <summary
                              className="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
                              style={{ background: 'rgba(255,255,255,0.03)' }}
                            >
                              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{g}</div>
                              <Badge variant="subtle">{ms.length} 个</Badge>
                            </summary>

                            <div className="divide-y divide-white/30">
                              {ms.map((m) => (
                                <div
                                  key={m.id}
                                  className={[
                                    'px-4 py-3 flex items-center justify-between hover:bg-white/2',
                                    mainJustSetId === m.id ? 'main-row-flash' : '',
                                  ].join(' ')}
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{m.name}</div>
                                      {m.isMain && <Badge variant="featured">主</Badge>}
                                      {!m.enabled && <Badge variant="subtle">禁用</Badge>}
                                    </div>
                                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{m.modelName}</div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => onTest(m)}
                                      disabled={testingModelId === m.id}
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
                                      title={testResult?.modelId === m.id && !testResult.ok ? testResult.msg : undefined}
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
                          </details>
                        ))}
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
              <select
                value={platformForm.platformType}
                onChange={(e) => setPlatformForm((s) => ({ ...s, platformType: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
              >
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="google">google</option>
                <option value="qwen">qwen</option>
                <option value="deepseek">deepseek</option>
                <option value="other">other</option>
              </select>
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
              className="rounded-[16px] overflow-hidden"
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
                          <Badge variant="subtle">{ms.length}</Badge>
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
              <select
                value={modelForm.platformId}
                onChange={(e) => setModelForm((s) => ({ ...s, platformId: e.target.value }))}
                className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={inputStyle}
              >
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
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
    </div>
  );
}
