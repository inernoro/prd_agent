import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import type { Model } from '@/types/admin';
import {
  createModelLabExperiment,
  getModels,
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

  const [experiments, setExperiments] = useState<ModelLabExperiment[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(true);
  const [activeExperimentId, setActiveExperimentId] = useState<string>('');

  const [suite, setSuite] = useState<ModelLabSuite>('speed');
  const [params, setParams] = useState<ModelLabParams>(defaultParams);
  const [promptText, setPromptText] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<ModelLabSelectedModel[]>([]);

  const [modelSets, setModelSets] = useState<ModelLabModelSet[]>([]);
  const [modelSetsLoading, setModelSetsLoading] = useState(false);
  const [modelSetName, setModelSetName] = useState('');

  const [pickerOpen, setPickerOpen] = useState(false);

  const [saving, setSaving] = useState(false);

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runItems, setRunItems] = useState<Record<string, ViewRunItem>>({});
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeExperiment = useMemo(
    () => experiments.find((e) => e.id === activeExperimentId) ?? null,
    [experiments, activeExperimentId]
  );

  const load = async () => {
    setModelsLoading(true);
    setExperimentsLoading(true);
    try {
      const [m, exps] = await Promise.all([getModels(), listModelLabExperiments({ page: 1, pageSize: 50 })]);
      if (m.success) setAllModels(m.data);
      if (exps.success) setExperiments(exps.data.items);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeExperiment) return;
    setSuite(activeExperiment.suite);
    setParams(activeExperiment.params ?? defaultParams);
    setPromptText(activeExperiment.promptText ?? '');
    setSelectedModels(activeExperiment.selectedModels ?? []);
  }, [activeExperiment?.id]);

  const addSelectedModels = (toAdd: ModelLabSelectedModel[]) => {
    setSelectedModels((prev) => {
      const map = new Map(prev.map((x) => [x.modelId, x]));
      for (const m of toAdd) map.set(m.modelId, m);
      return Array.from(map.values());
    });
  };

  const removeSelectedModel = (modelId: string) => {
    setSelectedModels((prev) => prev.filter((x) => x.modelId !== modelId));
  };

  const saveExperiment = async () => {
    if (!activeExperimentId) return;
    setSaving(true);
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
      setSaving(false);
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
    <div className="grid gap-5" style={{ gridTemplateColumns: '360px 1fr' }}>
      {/* 左侧：试验区 */}
      <div className="space-y-4">
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
            <Button variant="ghost" size="sm" onClick={() => load()} disabled={experimentsLoading}>
              刷新
            </Button>
          </div>

          <div className="mt-3">
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              当前实验
            </div>
            <select
              value={activeExperimentId}
              onChange={(e) => setActiveExperimentId(e.target.value)}
              className="h-10 w-full rounded-[14px] px-3 text-sm"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            >
              {experiments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: '1fr 120px' }}>
            <input
              value={activeExperiment?.name ?? ''}
              onChange={(e) => setExperiments((prev) => prev.map((x) => (x.id === activeExperimentId ? { ...x, name: e.target.value } : x)))}
              className="h-10 rounded-[14px] px-3 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="实验名称"
            />
            <Button onClick={async () => {
              const created = await createModelLabExperiment({ name: '新实验', suite: 'speed', params: defaultParams, selectedModels: [] });
              if (!created.success) return alert(created.error?.message || '创建失败');
              setExperiments((p) => [created.data, ...p]);
              setActiveExperimentId(created.data.id);
            }}>
              新建
            </Button>
          </div>

          <div className="mt-4">
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              测试类型
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant={suite === 'speed' ? 'primary' : 'secondary'} onClick={() => setSuite('speed')}>
                速度
              </Button>
              <Button size="sm" variant={suite === 'intent' ? 'primary' : 'secondary'} onClick={() => setSuite('intent')}>
                意图
              </Button>
              <Button size="sm" variant={suite === 'custom' ? 'primary' : 'secondary'} onClick={() => setSuite('custom')}>
                自定义
              </Button>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              参数（最小可用）
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
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
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="ghost" onClick={saveExperiment} disabled={saving || !activeExperimentId}>
              保存
            </Button>
            <Button onClick={startRun} disabled={!canRun || !activeExperimentId}>
              一键开始实验
            </Button>
            <Button variant="ghost" onClick={stopRun} disabled={!running}>
              停止
            </Button>
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

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              自定义模型集合
            </div>
            <Button size="sm" variant="ghost" onClick={loadModelSets} disabled={modelSetsLoading}>
              刷新
            </Button>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={modelSetName}
              onChange={(e) => setModelSetName(e.target.value)}
              className="h-10 flex-1 rounded-[14px] px-3 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="集合名称（用于保存当前选择）"
            />
            <Button onClick={saveModelSet} disabled={selectedModels.length === 0}>
              保存
            </Button>
          </div>

          <div className="mt-3">
            {modelSets.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                暂无集合
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {modelSets.map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant="ghost"
                    onClick={() => addSelectedModels(s.models)}
                    title="将该集合模型加入当前实验"
                  >
                    {s.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 右侧：大模型实验 */}
      <div className="space-y-4 relative">
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                大模型实验
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                选择模型 → 选择内置提示词或自定义 → 运行 → 对比 TTFT/总耗时
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPickerOpen(true)} disabled={modelsLoading}>
                添加模型
              </Button>
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                已选择模型 {selectedModels.length} 个
              </div>
              {modelsLoading ? <Badge variant="subtle">加载中</Badge> : null}
            </div>
            {selectedModels.length === 0 ? (
              <div className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无模型。点击“添加模型”从已配置模型中选择。
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedModels.map((m) => (
                  <button
                    key={m.modelId}
                    className="px-3 py-1 rounded-[999px] text-xs"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}
                    onClick={() => removeSelectedModel(m.modelId)}
                    title="点击移除"
                    type="button"
                  >
                    {m.name || m.modelName}
                    <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                      ×
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              提示词
            </div>
            <div className="flex gap-2">
              {builtInPrompts[suite].map((p) => (
                <Button key={p.label} size="sm" variant="ghost" onClick={() => applyBuiltInPrompt(p.promptText)}>
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            className="mt-3 h-28 w-full rounded-[14px] px-3 py-2 text-sm outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            placeholder="输入本次对比测试的 prompt（可使用内置模板快速填充）"
          />
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              实时结果（按 TTFT 优先排序）
            </div>
            {running ? <Badge variant="subtle">运行中</Badge> : <Badge variant="subtle">就绪</Badge>}
          </div>

          {sortedItems.length === 0 ? (
            <div className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
              暂无结果。点击“一键开始实验”后，会在这里实时展示每个模型的 TTFT、总耗时与输出预览。
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {sortedItems.map((it) => (
                <div
                  key={it.itemId}
                  className="rounded-[14px] p-3"
                  style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {it.displayName}
                      </div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        {it.modelName} · {it.modelId}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        TTFT {typeof it.ttftMs === 'number' ? `${it.ttftMs}ms` : '-'} · 总耗时 {typeof it.totalMs === 'number' ? `${it.totalMs}ms` : '-'}
                      </div>
                      <div className="mt-1 text-xs" style={{ color: it.status === 'error' ? 'rgba(239,68,68,0.95)' : it.status === 'done' ? 'rgba(34,197,94,0.95)' : 'var(--text-muted)' }}>
                        {it.status === 'running' ? '进行中' : it.status === 'done' ? '完成' : '失败'}
                      </div>
                    </div>
                  </div>
                  {it.errorMessage ? (
                    <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                      {it.errorMessage}
                    </div>
                  ) : null}
                  <pre className="mt-2 text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>
                    {it.preview || (it.status === 'running' ? '（等待输出）' : '（无输出）')}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 右下角卡片堆叠（快速扫一眼） */}
        {sortedItems.length > 0 ? (
          <div className="absolute right-3 bottom-3 w-[320px] space-y-2 pointer-events-none">
            {sortedItems.slice(0, 3).map((it) => (
              <div
                key={it.itemId}
                className="rounded-[16px] p-3"
                style={{ border: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-elevated) 88%, black)', boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}
              >
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {it.displayName}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  TTFT {typeof it.ttftMs === 'number' ? `${it.ttftMs}ms` : '-'} · 总耗时 {typeof it.totalMs === 'number' ? `${it.totalMs}ms` : '-'}
                </div>
                <div className="mt-2 text-xs line-clamp-3" style={{ color: 'var(--text-primary)' }}>
                  {it.preview || '（暂无预览）'}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <ModelPickerDialog
          open={pickerOpen}
          onOpenChange={(o) => setPickerOpen(o)}
          allModels={allModels}
          selectedModels={selectedModels}
          onAdd={(ms) => {
            addSelectedModels(ms);
          }}
        />
      </div>
    </div>
  );
}


