import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Layers, MinusCircle, Play, Plus, RefreshCcw, Sparkles, TimerOff, Trash2 } from 'lucide-react';

import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Dialog } from '@/components/ui/Dialog';
import type { Platform } from '@/types/admin';
import type { Model } from '@/types/admin';
import {
  createModelLabExperiment,
  deleteModelLabExperiment,
  getModels,
  getPlatforms,
  listModelLabExperiments,
  listModelLabModelSets,
  runModelLabStream,
  updateModelLabExperiment,
  upsertModelLabModelSet,
} from '@/services';
import type { ModelLabExperiment, ModelLabModelSet, ModelLabParams, ModelLabSelectedModel, ModelLabSuite } from '@/services/contracts/modelLab';
import { ModelPickerDialog } from '@/pages/lab-llm/components/ModelPickerDialog';

type ViewRunItem = {
  itemId: string;
  modelId: string;
  displayName: string;
  modelName: string;
  status: 'running' | 'done' | 'error';
  ttftMs?: number;
  totalMs?: number;
  preview: string;
  errorMessage?: string;
};

const defaultParams: ModelLabParams = {
  temperature: 0.2,
  maxTokens: null,
  timeoutMs: 60000,
  maxConcurrency: 3,
  repeatN: 1,
};

const builtInPrompts: Record<ModelLabSuite, { label: string; promptText: string }[]> = {
  speed: [
    { label: '短回复', promptText: '你好，请用一句话简短回复。' },
    { label: '固定长度', promptText: '请输出恰好 20 个中文字符（不要标点）。' },
  ],
  intent: [
    { label: '登录/鉴权', promptText: '用户话术：我登录失败，一直提示 token 过期。请判断意图。' },
    { label: '支付/退款', promptText: '用户话术：我要申请退款，订单号 12345。请判断意图。' },
  ],
  custom: [{ label: '自定义', promptText: '' }],
};

export default function LlmLabTab() {
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [platforms, setPlatforms] = useState<Platform[]>([]);

  const [experiments, setExperiments] = useState<ModelLabExperiment[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(true);
  const [activeExperimentId, setActiveExperimentId] = useState<string>('');
  const [createExperimentOpen, setCreateExperimentOpen] = useState(false);
  const [createExperimentName, setCreateExperimentName] = useState('');
  const [loadExperimentOpen, setLoadExperimentOpen] = useState(false);
  const [loadExperimentId, setLoadExperimentId] = useState<string>('');

  const [suite, setSuite] = useState<ModelLabSuite>('speed');
  const [params, setParams] = useState<ModelLabParams>(defaultParams);
  const [promptText, setPromptText] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<ModelLabSelectedModel[]>([]);

  const [modelSets, setModelSets] = useState<ModelLabModelSet[]>([]);
  const [modelSetsLoading, setModelSetsLoading] = useState(false);
  const [modelSetName, setModelSetName] = useState('');

  const [pickerOpen, setPickerOpen] = useState(false);

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runItems, setRunItems] = useState<Record<string, ViewRunItem>>({});
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suiteCycleRef = useRef<Record<ModelLabSuite, number>>({} as Record<ModelLabSuite, number>);

  const activeExperiment = useMemo(
    () => experiments.find((e) => e.id === activeExperimentId) ?? null,
    [experiments, activeExperimentId]
  );

  const platformNameById = useMemo(() => {
    return new Map<string, string>((platforms ?? []).map((p) => [p.id, p.name]));
  }, [platforms]);

  const openCreateExperiment = () => {
    setCreateExperimentName('');
    setCreateExperimentOpen(true);
  };

  const confirmCreateExperiment = async () => {
    const name = createExperimentName.trim();
    if (!name) return;
    const created = await createModelLabExperiment({ name, suite: 'speed', params: defaultParams, selectedModels: [] });
    if (!created.success) return alert(created.error?.message || '创建失败');
    setExperiments((p) => [created.data, ...p]);
    setActiveExperimentId(created.data.id);
    setCreateExperimentOpen(false);
    setCreateExperimentName('');
  };

  const openLoadExperiment = () => {
    setLoadExperimentId(activeExperimentId);
    setLoadExperimentOpen(true);
  };

  const shortId = (id: string) => (id || '').slice(0, 8);

  const formatDateTime = (iso: string | undefined) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const deleteExperiment = async (id: string) => {
    const res = await deleteModelLabExperiment(id);
    if (!res.success) return alert(res.error?.message || '删除失败');

    setExperiments((prev) => {
      const remaining = prev.filter((x) => x.id !== id);
      setLoadExperimentId((cur) => (cur === id ? '' : cur));
      setActiveExperimentId((cur) => (cur === id ? (remaining[0]?.id || '') : cur));
      return remaining;
    });
  };

  const confirmLoadExperiment = () => {
    if (!loadExperimentId) return;
    setActiveExperimentId(loadExperimentId);
    setLoadExperimentOpen(false);
  };

  const load = async () => {
    setModelsLoading(true);
    setExperimentsLoading(true);
    try {
      const [m, exps, ps] = await Promise.all([getModels(), listModelLabExperiments({ page: 1, pageSize: 50 }), getPlatforms()]);
      if (m.success) setAllModels(m.data);
      if (exps.success) setExperiments(exps.data.items);
      if (ps.success) setPlatforms(ps.data);

      // 没有实验时，自动创建一个默认实验，方便直接使用
      if (exps.success && exps.data.items.length === 0) {
        const created = await createModelLabExperiment({
          name: '默认实验',
          suite: 'speed',
          selectedModels: [],
          params: defaultParams,
        });
        if (created.success) {
          setExperiments([created.data]);
          setActiveExperimentId(created.data.id);
        }
      } else if (exps.success) {
        setActiveExperimentId((cur) => cur || exps.data.items[0]?.id || '');
      }
    } finally {
      setModelsLoading(false);
      setExperimentsLoading(false);
    }
  };

  const loadModelSets = async () => {
    setModelSetsLoading(true);
    try {
      const res = await listModelLabModelSets({ limit: 100 });
      if (res.success) setModelSets(res.data.items);
    } finally {
      setModelSetsLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadModelSets();
  }, []);

  useEffect(() => {
    if (!activeExperiment) return;
    setSuite(activeExperiment.suite);
    setParams(activeExperiment.params ?? defaultParams);
    setPromptText(activeExperiment.promptText ?? '');
    setSelectedModels(activeExperiment.selectedModels ?? []);
  }, [activeExperiment]);

  const setSelectedModelsDedupe = (list: ModelLabSelectedModel[]) => {
    // 唯一选择：平台 + modelName
    const map = new Map<string, ModelLabSelectedModel>();
    for (const m of list) {
      const key = `${m.platformId}:${m.modelName}`.toLowerCase();
      const prev = map.get(key);
      // 若冲突，优先保留有 name 的那条（更像“配置模型”）
      if (!prev || (m.name && !prev.name)) map.set(key, m);
    }
    setSelectedModels(Array.from(map.values()));
  };

  const removeSelectedModel = (modelId: string) => {
    setSelectedModels((prev) => prev.filter((x) => x.modelId !== modelId));
  };

  const saveExperiment = async () => {
    if (!activeExperimentId) return;
    try {
      const res = await updateModelLabExperiment(activeExperimentId, {
        suite,
        promptText,
        selectedModels,
        params,
      });
      if (!res.success) {
        alert(res.error?.message || '保存失败');
        return;
      }
      // 刷新本地列表
      setExperiments((prev) => prev.map((e) => (e.id === res.data.id ? res.data : e)));
    } finally {
      // no-op
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const startRun = async () => {
    if (!activeExperimentId) return alert('请先选择实验');
    if (selectedModels.length === 0) return alert('请先加入至少 1 个模型');

    setRunError(null);
    setRunItems({});
    setRunId(null);
    stopRun();
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // 运行前先保存一次实验配置
    await saveExperiment();

    const res = await runModelLabStream({
      input: {
        experimentId: activeExperimentId,
        suite,
        promptText,
        params,
      },
      signal: ac.signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        try {
          const obj = JSON.parse(evt.data);
          if (evt.event === 'run') {
            if (obj.type === 'runStart') setRunId(obj.runId || null);
            if (obj.type === 'error') {
              setRunError(obj.errorMessage || '运行失败');
              setRunning(false);
            }
            if (obj.type === 'runDone') {
              setRunning(false);
            }
            return;
          }

          if (evt.event === 'model') {
            if (obj.type === 'modelStart') {
              const item: ViewRunItem = {
                itemId: obj.itemId,
                modelId: obj.modelId,
                displayName: obj.displayName || obj.modelName || obj.modelId,
                modelName: obj.modelName || '',
                status: 'running',
                preview: '',
              };
              setRunItems((p) => ({ ...p, [item.itemId]: item }));
              return;
            }
            if (obj.type === 'delta' && typeof obj.content === 'string') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                const nextPreview = (cur.preview + obj.content).slice(0, 512);
                return { ...p, [obj.itemId]: { ...cur, preview: nextPreview } };
              });
              return;
            }
            if (obj.type === 'firstToken') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                return { ...p, [obj.itemId]: { ...cur, ttftMs: Number(obj.ttftMs) } };
              });
              return;
            }
            if (obj.type === 'modelDone') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                return {
                  ...p,
                  [obj.itemId]: {
                    ...cur,
                    status: 'done',
                    ttftMs: obj.ttftMs ?? cur.ttftMs,
                    totalMs: obj.totalMs ?? cur.totalMs,
                    preview: typeof obj.preview === 'string' ? obj.preview : cur.preview,
                  },
                };
              });
              return;
            }
            if (obj.type === 'modelError') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                return { ...p, [obj.itemId]: { ...cur, status: 'error', errorMessage: obj.errorMessage || '失败' } };
              });
              return;
            }
          }
        } catch {
          // ignore
        }
      },
    });

    if (!res.success) {
      setRunError(res.error?.message || '运行失败');
      setRunning(false);
    }
  };

  const itemsList = useMemo(() => Object.values(runItems), [runItems]);
  const sortedItems = useMemo(() => {
    return [...itemsList].sort((a, b) => {
      const at = a.ttftMs ?? Number.POSITIVE_INFINITY;
      const bt = b.ttftMs ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      const aa = a.totalMs ?? Number.POSITIVE_INFINITY;
      const bb = b.totalMs ?? Number.POSITIVE_INFINITY;
      return aa - bb;
    });
  }, [itemsList]);

  const applyBuiltInPrompt = (p: string) => {
    setPromptText(p);
  };

  const onSuiteClick = (nextSuite: ModelLabSuite) => {
    if (suite !== nextSuite) {
      setSuite(nextSuite);
      suiteCycleRef.current[nextSuite] = 0;
      return;
    }

    // 重复点击当前 suite：循环填充内置提示词
    const list = builtInPrompts[nextSuite] ?? [];
    if (list.length === 0) return;
    const cur = suiteCycleRef.current[nextSuite] ?? 0;
    const idx = ((cur % list.length) + list.length) % list.length;
    applyBuiltInPrompt(list[idx].promptText);
    suiteCycleRef.current[nextSuite] = (idx + 1) % list.length;
  };

  const saveModelSet = async () => {
    if (!modelSetName.trim()) return alert('请输入集合名称');
    if (selectedModels.length === 0) return alert('当前没有已选择的模型');
    const res = await upsertModelLabModelSet({ name: modelSetName.trim(), models: selectedModels });
    if (!res.success) return alert(res.error?.message || '保存失败');
    await loadModelSets();
    setModelSetName('');
  };

  const canRun = !running && selectedModels.length > 0;

  return (
    <div className="h-full min-h-0">
      <div className="h-full min-h-0 grid gap-x-5 gap-y-4 lg:grid-cols-[360px_1fr] lg:grid-rows-[auto_1fr]">
        {/* 左上：试验区 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-1">
          <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                试验区
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                保存实验配置与历史（Mongo）
              </div>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
              style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
              onClick={openCreateExperiment}
              disabled={experimentsLoading}
            >
              <Plus size={14} />
              新建
            </button>
          </div>

          <div className="mt-3">
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              当前实验
            </div>
            <button
              type="button"
              className="h-10 w-full rounded-[14px] px-3 text-sm inline-flex items-center justify-between gap-2"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              onClick={openLoadExperiment}
              disabled={experimentsLoading}
              title="点击加载实验"
            >
              <span className="min-w-0 truncate">{activeExperiment?.name || '未选择实验'}</span>
              <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                加载
              </span>
            </button>
          </div>

          <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              并发
              <input
                type="number"
                value={params.maxConcurrency}
                onChange={(e) => setParams((p) => ({ ...p, maxConcurrency: Math.max(1, Number(e.target.value || 1)) }))}
                className="mt-1 h-9 w-full rounded-[12px] px-2 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
            </label>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              重复 N 次
              <input
                type="number"
                value={params.repeatN}
                onChange={(e) => setParams((p) => ({ ...p, repeatN: Math.max(1, Number(e.target.value || 1)) }))}
                className="mt-1 h-9 w-full rounded-[12px] px-2 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
            </label>
          </div>

          {runId ? (
            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              runId：{runId}
            </div>
          ) : null}
          {runError ? (
            <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
              {runError}
            </div>
          ) : null}
          </Card>
        </div>

        {/* 左下：自定义模型集合 + 大模型实验 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-2">
          <Card className="p-4 overflow-hidden flex flex-col min-h-0 h-full">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                大模型实验
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="xs" className="shrink-0" onClick={() => setPickerOpen(true)} disabled={modelsLoading}>
                <Plus size={16} />
                添加模型
              </Button>
            </div>
          </div>

          {/* 分组/集合 */}
          <div className="mt-4 shrink-0">
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                自定义模型集合
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                value={modelSetName}
                onChange={(e) => setModelSetName(e.target.value)}
                className="h-10 flex-1 rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.12)', color: 'var(--text-primary)' }}
                placeholder="集合名称（用于保存当前选择）"
              />
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={saveModelSet}
                disabled={selectedModels.length === 0}
              >
                <Layers size={16} />
                保存
              </button>
            </div>

            <div className="mt-3">
              {modelSets.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  暂无集合
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {modelSets.map((s) => (
                    <ConfirmTip
                      key={s.id}
                      title="确定将模型增加到试验区?"
                      description={`将集合“${s.name}”中的模型加入当前实验`}
                      confirmText="确定"
                      cancelText="取消"
                      onConfirm={() => setSelectedModelsDedupe([...selectedModels, ...(s.models ?? [])])}
                      side="top"
                      align="start"
                    >
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                        style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                        title="将该集合模型加入当前实验"
                      >
                        <Layers size={14} />
                        {s.name}
                      </button>
                    </ConfirmTip>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 已选择模型 */}
          <div className="mt-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                已选择模型 {selectedModels.length} 个
              </div>
              {modelsLoading ? <Badge variant="subtle">加载中</Badge> : null}
            </div>
            <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
              {selectedModels.length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无模型。点击“添加模型”从已配置模型中选择。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {selectedModels.map((m) => (
                    <button
                      key={m.modelId}
                      className="w-full rounded-[14px] px-3 py-2 text-xs flex items-center justify-between gap-3 min-w-0 whitespace-nowrap"
                      style={{
                        border: '1px solid var(--border-subtle)',
                        background: 'rgba(255, 255, 255, 0.02)',
                        color: 'var(--text-primary)',
                      }}
                      onClick={() => removeSelectedModel(m.modelId)}
                      title={`${platformNameById.get(m.platformId) ? `${platformNameById.get(m.platformId)} ` : ''}${m.name || m.modelName}`}
                      type="button"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <label
                          className="inline-flex items-center gap-1 rounded-[999px] px-2 py-[2px] text-[11px] shrink-0 max-w-[140px] truncate"
                          style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
                          title={platformNameById.get(m.platformId) || m.platformId}
                        >
                          <Cpu size={12} className="shrink-0" />
                          <span className="truncate">{platformNameById.get(m.platformId) || m.platformId}</span>
                        </label>
                        <span className="min-w-0 truncate">{m.name || m.modelName}</span>
                      </span>
                      <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          </Card>
        </div>

        {/* 右上：提示词 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-1">
          <Card className="p-4">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
              提示词
            </div>
            <div className="flex gap-2 shrink-0">
              {!running ? (
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                  style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                  onClick={startRun}
                  disabled={!canRun || !activeExperimentId}
                >
                  <Play size={16} />
                  一键开始实验
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                  style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                  onClick={stopRun}
                >
                  <MinusCircle size={16} />
                  停止
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-auto pr-1">
            <Button size="xs" variant={suite === 'speed' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onSuiteClick('speed')}>
              <Sparkles size={14} />
              速度
            </Button>
            <Button size="xs" variant={suite === 'intent' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onSuiteClick('intent')}>
              <Sparkles size={14} />
              意图
            </Button>
            <Button size="xs" variant={suite === 'custom' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onSuiteClick('custom')}>
              <Sparkles size={14} />
              自定义
            </Button>
          </div>

          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            className="mt-3 h-20 w-full rounded-[14px] px-3 py-2 text-sm outline-none resize-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            placeholder="输入本次对比测试的 prompt（可使用内置模板快速填充）"
          />
          </Card>
        </div>

        {/* 右下：实时结果 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-2">
          <Card className="p-4 overflow-hidden flex flex-col min-h-0 h-full">
          <div className="flex items-center justify-between shrink-0">
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
              实时结果（按 TTFT 优先排序）
            </div>
            {running ? <Badge variant="subtle">运行中</Badge> : <Badge variant="subtle">就绪</Badge>}
          </div>

          <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1 pb-6">
            {sortedItems.length === 0 ? (
              <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                <div
                  className="h-12 w-12 rounded-full flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)' }}
                >
                  <TimerOff size={22} style={{ color: 'var(--text-muted)' }} />
                </div>
                <div className="mt-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  这里将实时展示对比结果
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  点击上方“一键开始实验”，会按模型展示 TTFT、总耗时与输出预览
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedItems.map((it) => (
                  <div
                    key={it.itemId}
                    className="rounded-[14px] p-3"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {it.displayName}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                          {(() => {
                            const name = (it.modelName ?? '').trim();
                            const id = (it.modelId ?? '').trim();
                            if (name && id && name !== id) return `${name} · ${id}`;
                            return name || id || '-';
                          })()}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          TTFT {typeof it.ttftMs === 'number' ? `${it.ttftMs}ms` : '-'} · 总耗时 {typeof it.totalMs === 'number' ? `${it.totalMs}ms` : '-'}
                        </div>
                        <div
                          className="mt-1 text-xs"
                          style={{
                            color:
                              it.status === 'error'
                                ? 'rgba(239,68,68,0.95)'
                                : it.status === 'done'
                                  ? 'rgba(34,197,94,0.95)'
                                  : 'var(--text-muted)',
                          }}
                        >
                          {it.status === 'running' ? '进行中' : it.status === 'done' ? '完成' : '失败'}
                        </div>
                      </div>
                    </div>
                    {it.errorMessage ? (
                      <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                        {it.errorMessage}
                      </div>
                    ) : null}
                    <pre className="mt-2 text-xs whitespace-pre-wrap wrap-break-word" style={{ color: 'var(--text-primary)' }}>
                      {it.preview || (it.status === 'running' ? '（等待输出）' : '（无输出）')}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
          </Card>
        </div>
      </div>

      {/* 弹窗放在 grid 外，避免参与布局 */}
      <ModelPickerDialog
        open={pickerOpen}
        onOpenChange={(o) => setPickerOpen(o)}
        allModels={allModels}
        platforms={platforms}
        selectedModels={selectedModels}
        onConfirm={(finalList) => {
          setSelectedModelsDedupe(finalList);
        }}
      />

      <Dialog
        open={createExperimentOpen}
        onOpenChange={(o) => setCreateExperimentOpen(o)}
        title="新建实验"
        description="输入实验名称后创建"
        content={
          <div className="grid gap-3">
            <input
              value={createExperimentName}
              onChange={(e) => setCreateExperimentName(e.target.value)}
              className="h-10 w-full rounded-[14px] px-3 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="例如：默认实验"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={() => setCreateExperimentOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={confirmCreateExperiment}
                disabled={!createExperimentName.trim()}
              >
                创建
              </button>
            </div>
          </div>
        }
      />

      <Dialog
        open={loadExperimentOpen}
        onOpenChange={(o) => setLoadExperimentOpen(o)}
        title="加载实验"
        description="选择一个实验加载到试验区"
        content={
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                共 {experiments.length} 个实验
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={load}
                disabled={experimentsLoading}
              >
                刷新列表
              </button>
            </div>

            {experiments.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无实验
              </div>
            ) : (
              <div className="max-h-[420px] overflow-auto pr-1 rounded-[14px]" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
                <div className="p-2 grid gap-1">
                  {experiments.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-2 hover:bg-white/4"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <button
                        type="button"
                        className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
                        style={{ color: 'inherit' }}
                        onClick={() => setLoadExperimentId(e.id)}
                      >
                        <input type="radio" name="load-experiment" checked={loadExperimentId === e.id} onChange={() => setLoadExperimentId(e.id)} />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold truncate">{e.name}</span>
                          <span className="block text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                            #{shortId(e.id)} · 模型 {e.selectedModels?.length ?? 0} · {formatDateTime(e.updatedAt)}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                        style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                        onClick={async (evt) => {
                          evt.stopPropagation();
                          if (!window.confirm(`确定删除实验“${e.name}”？（不可恢复）`)) return;
                          await deleteExperiment(e.id);
                        }}
                        title="删除实验"
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={() => setLoadExperimentOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={confirmLoadExperiment}
                disabled={!loadExperimentId}
              >
                加载
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
