import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
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
import { Check, Eye, EyeOff, Link2, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '@/services/real/apiClient';

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
  const [apiUrlDraft, setApiUrlDraft] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [platformChecking, setPlatformChecking] = useState(false);
  const [platformCheckMsg, setPlatformCheckMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [p, m] = await Promise.all([getPlatforms(), getModels()]);
      if (p.success) {
        setPlatforms(p.data);
        setSelectedPlatformId((cur) => (cur ? cur : (p.data[0]?.id || '')));
      }
      if (m.success) setModels(m.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  }, [filteredModels]);

  const openCreatePlatform = () => {
    setEditingPlatform(null);
    setPlatformForm(defaultPlatformForm);
    setPlatformDialogOpen(true);
  };

  const openEditPlatform = (p: Platform) => {
    setEditingPlatform(p);
    setPlatformForm({
      name: p.name,
      platformType: p.platformType,
      apiUrl: p.apiUrl,
      apiKey: '',
      enabled: p.enabled,
    });
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
        style={{ background: bg, color: fg, border: '1px solid var(--border-subtle)' }}
      >
        {letter}
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
    const res = await setMainModel(m.id);
    if (!res.success) return;
    await load();
  };

  const onTest = async (m: Model) => {
    setTestingModelId(m.id);
    try {
      await testModel(m.id);
    } finally {
      setTestingModelId(null);
      await load();
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>模型管理</div>
        <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          平台 {platforms.length} 个 / 模型 {models.length} 个
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
                    <Badge variant={p.enabled ? 'success' : 'subtle'}>{p.enabled ? '启用' : '禁用'}</Badge>
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
              {selectedPlatform ? (
                <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {selectedPlatform.apiUrl} · {selectedPlatform.apiKeyMasked}
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
            ) : selectedPlatform ? (
              <div className="p-4 space-y-6">
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>API 密钥</div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={apiKeyDraft}
                      onChange={(e) => setApiKeyDraft(e.target.value)}
                      className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                      style={inputStyle}
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={showApiKey ? '隐藏' : '显示'}
                    >
                      {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={onCheckPlatform} disabled={platformChecking}>
                      {platformChecking ? '检测中' : '检测'}
                    </Button>
                  </div>
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    留空表示不修改；保存后仅展示掩码。点击“检测”会优先测试该平台的主模型。
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
                      className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
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
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    建议填写基础地址（如 `https://api.xxx.com`）；后端会自动拼接 OpenAI 兼容路径。
                  </div>
                </div>

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

                            <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                              {ms.map((m) => (
                                <div key={m.id} className="px-4 py-3 flex items-center justify-between hover:bg-white/2">
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
                                    >
                                      <Link2 size={16} />
                                      {testingModelId === m.id ? '测试中' : '测试'}
                                    </Button>
                                    <Button variant={m.isMain ? 'secondary' : 'ghost'} size="sm" onClick={() => onSetMain(m)} disabled={m.isMain}>
                                      <Star size={16} />
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => openEditModel(m)}>
                                      <Pencil size={16} />
                                    </Button>
                                    <Button variant="danger" size="sm" onClick={() => onDeleteModel(m)}>
                                      <Trash2 size={16} />
                                    </Button>
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
              onClick={() => {
                if (selectedPlatform) openEditPlatform(selectedPlatform);
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
              <Button variant="danger" size="sm" onClick={() => onDeletePlatform(selectedPlatform)}>
                删除平台
              </Button>
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
