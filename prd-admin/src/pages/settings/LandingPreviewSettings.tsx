import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, RefreshCw, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import {
  adoptHomepageAssetFromRun,
  createImageGenRun,
  deleteHomepageAsset,
  getVisualAgentText2ImgModels,
  listHomepageAssets,
  streamImageGenRunWithRetry,
} from '@/services';
import type { HomepageAssetDto } from '@/services/contracts/homepageAssets';
import { ModelHealthStatus, type ModelGroupForApp } from '@/types/modelGroup';
import { Button } from '@/components/design/Button';
import { Select } from '@/components/design/Select';
import { ResponsiveDialog } from '@/components/ui/ResponsiveDialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  LANDING_PREVIEW_SLOTS,
  buildLandingPreviewPrompt,
  type LandingPreviewSlot,
} from '@/lib/landingPreviewSlots';

/**
 * 系统设置 →「首页预览图」。
 *
 * 对外首页（`/home`）十幕，每幕一张示意图；这一屏负责把它们生出来、看一眼、
 * 不满意就带着改过的提示词再生一次。
 *
 * 三条设计取舍：
 *
 * 1. **提示词有默认值，且默认值是好用的那版**（`lib/landingPreviewSlots.ts`）。
 *    管理员打开弹窗看到的是一段能直接出图的完整提示词，不是空白框
 *    （`zero-friction-input`）。改过一次之后回填的是他自己那版，不是默认版——
 *    否则每次微调都要从头改一遍。
 * 2. **模型不问人**：只有一个可用出图池时不显示选择器（`chief-designer-usability`
 *    第二原则：只有一个选项的选择器一律不显示）。
 * 3. **等待期给产物的形状**：生成中的卡片是一块带斜纹的画框加秒表，不是转圈
 *    （`artifact-is-experience`）。一次「全部重新生成」十张并发跑，谁先出谁先落位。
 */

type SlotState = {
  status: 'idle' | 'running' | 'error';
  startedAt?: number;
  error?: string;
};

/**
 * 生成中卡片的斜纹底：给等待一个「画布正在被填」的形状，而不是一个转圈。
 * 走 token 而非裸的白色透明叠加 —— 后者在浅色主题下会直接隐形（双皮肤棘轮盯着这条，
 * 连注释里写出那个字面量都会被计数，所以这里用文字描述）。
 */
const HATCH =
  'repeating-linear-gradient(45deg, var(--bg-tertiary) 0 12px, transparent 12px 24px)';

export default function LandingPreviewSettings() {
  const [assets, setAssets] = useState<Record<string, HomepageAssetDto>>({});
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<ModelGroupForApp[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SlotState>>({});
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<{ slot: LandingPreviewSlot; prompt: string } | null>(null);

  const controllersRef = useRef<AbortController[]>([]);
  /** 卸载后丢弃在途 SSE 回调，避免在已卸载组件上 setState */
  const aliveRef = useRef(true);

  const modelOptions = useMemo(() => {
    const opts: { key: string; poolName: string; modelName: string; platformId: string }[] = [];
    pools.forEach((pool, idx) => {
      if (!pool.models || pool.models.length === 0) return;
      const sorted = [...pool.models].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
      // 先挑健康的，再挑非不可用的，全挂才回退第一个 —— 与分镜板同一条挑法
      const m =
        sorted.find((x) => x.healthStatus === ModelHealthStatus.Healthy) ??
        sorted.find((x) => x.healthStatus !== ModelHealthStatus.Unavailable) ??
        sorted[0];
      opts.push({ key: `${idx}:${pool.name}`, poolName: pool.name, modelName: m.modelId, platformId: m.platformId });
    });
    return opts;
  }, [pools]);

  const activeModel = useMemo(() => {
    const opt = modelOptions.find((o) => o.key === selectedModelKey) ?? modelOptions[0];
    return opt ? { name: opt.poolName, modelName: opt.modelName, platformId: opt.platformId } : null;
  }, [modelOptions, selectedModelKey]);

  const reload = useCallback(async () => {
    const res = await listHomepageAssets();
    if (!aliveRef.current) return;
    if (res.success) {
      const map: Record<string, HomepageAssetDto> = {};
      (res.data ?? []).forEach((a) => { map[a.slot] = a; });
      setAssets(map);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const controllers = controllersRef.current;
    setLoading(true);
    Promise.all([
      reload(),
      getVisualAgentText2ImgModels().then((res) => {
        if (aliveRef.current && res.success) setPools(res.data ?? []);
      }),
    ]).finally(() => {
      if (aliveRef.current) setLoading(false);
    });
    return () => {
      aliveRef.current = false;
      controllers.forEach((c) => c.abort());
      controllers.length = 0;
    };
  }, [reload]);

  /** 有任务在跑时每秒重绘一次，让卡片上的秒表真的在走 */
  const anyRunning = useMemo(() => Object.values(states).some((s) => s.status === 'running'), [states]);
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const patchState = (slot: string, next: SlotState) => {
    if (!aliveRef.current) return;
    setStates((prev) => ({ ...prev, [slot]: next }));
  };

  /**
   * 生成一批槽位。一次 run 带 N 条 item，itemIndex 与 targets 下标一一对应 ——
   * 回填时靠这个下标认领，别用 prompt 反查（同一段提示词可能被两个槽位共用）。
   */
  const generate = async (targets: { slot: LandingPreviewSlot; prompt: string }[]) => {
    if (!activeModel) {
      toast.error('没有可用的文生图模型池，请先在模型中心配置');
      return;
    }
    if (targets.length === 0) return;

    const now = Date.now();
    targets.forEach((t) => patchState(t.slot.slot, { status: 'running', startedAt: now }));

    const ac = new AbortController();
    controllersRef.current.push(ac);

    const created = await createImageGenRun({
      input: {
        appKey: 'visual-agent',
        modelId: activeModel.modelName,
        platformId: activeModel.platformId,
        items: targets.map((t) => ({ prompt: t.prompt, count: 1, size: t.slot.size })),
        responseFormat: 'b64_json',
        maxConcurrency: 3,
      },
      idempotencyKey: `landing_${now}_${Math.random().toString(16).slice(2)}`,
    });
    if (!created.success) {
      const msg = created.error?.message || '创建生成任务失败';
      toast.error(msg);
      targets.forEach((t) => patchState(t.slot.slot, { status: 'error', error: msg }));
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      targets.forEach((t) => patchState(t.slot.slot, { status: 'error', error: '任务未返回 runId，请重试' }));
      return;
    }

    await streamImageGenRunWithRetry({
      runId,
      afterSeq: 0,
      maxAttempts: 20,
      signal: ac.signal,
      onEvent: (evt) => {
        if (!aliveRef.current || !evt.data) return;
        let o: Record<string, unknown>;
        try { o = JSON.parse(evt.data) as Record<string, unknown>; } catch { return; }
        const type = String(o.type ?? '');
        const itemIndex = Number(o.itemIndex ?? -1);
        const target = targets[itemIndex];
        if (!target) return;

        if (type === 'imageDone') {
          // 出图即落位：把这张挂到槽位上，管理员不用再点一次「保存」
          void adoptHomepageAssetFromRun({
            slot: target.slot.slot,
            runId,
            itemIndex,
            imageIndex: 0,
            prompt: target.prompt,
          }).then(async (res) => {
            if (!aliveRef.current) return;
            if (!res.success) {
              patchState(target.slot.slot, { status: 'error', error: res.error?.message || '挂到槽位失败' });
              return;
            }
            patchState(target.slot.slot, { status: 'idle' });
            await reload();
          });
        } else if (type === 'imageError') {
          patchState(target.slot.slot, {
            status: 'error',
            error: String((o.errorMessage as string | undefined) ?? '生成失败'),
          });
        }
      },
    });

    // 流结束兜底：还挂在 running 的都算失败，别让卡片永远转下去
    if (!aliveRef.current) return;
    setStates((prev) => {
      const next = { ...prev };
      targets.forEach((t) => {
        if (next[t.slot.slot]?.status === 'running') {
          next[t.slot.slot] = { status: 'error', error: '生成超时或连接中断，请重试' };
        }
      });
      return next;
    });
  };

  const openDialog = (slot: LandingPreviewSlot) => {
    // 改过一次就回填他自己那版；没生成过才用默认词
    const stored = assets[slot.slot]?.prompt;
    setEditing({ slot, prompt: stored && stored.trim() ? stored : buildLandingPreviewPrompt(slot) });
  };

  const handleGenerateAll = () => {
    void generate(
      LANDING_PREVIEW_SLOTS.map((s) => ({
        slot: s,
        prompt: assets[s.slot]?.prompt?.trim() || buildLandingPreviewPrompt(s),
      })),
    );
  };

  const handleDelete = async (slot: LandingPreviewSlot) => {
    const res = await deleteHomepageAsset({ slot: slot.slot });
    if (!res.success) {
      toast.error(res.error?.message || '删除失败');
      return;
    }
    toast.success(`已清除「${slot.label}」`);
    await reload();
  };

  if (loading) return <MapSectionLoader text="正在加载首页预览图…" />;

  const generatedCount = LANDING_PREVIEW_SLOTS.filter((s) => assets[s.slot]?.url).length;

  return (
    <div className="flex flex-col gap-4">
      {/* 控制条：结论在前（多少张已生成），操作在后 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {generatedCount} / {LANDING_PREVIEW_SLOTS.length} 幕已有配图
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            对外首页 /home 每一幕一张示意图。提示词已按幕写好默认值，点「生成」可当场改。
          </div>
        </div>

        {/* 只有一个池就不摆选择器（没得选就别假装能选） */}
        {modelOptions.length > 1 && (
          <div className="ml-auto shrink-0" style={{ minWidth: '200px' }}>
            <Select
              value={selectedModelKey ?? modelOptions[0]?.key ?? ''}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              uiSize="sm"
            >
              {modelOptions.map((o) => (
                <option key={o.key} value={o.key}>{o.poolName}</option>
              ))}
            </Select>
          </div>
        )}

        <Button
          variant="secondary"
          onClick={handleGenerateAll}
          disabled={anyRunning || !activeModel}
          className={modelOptions.length > 1 ? 'shrink-0' : 'ml-auto shrink-0'}
        >
          {anyRunning ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
          全部重新生成
        </Button>
      </div>

      {!activeModel && (
        <div
          className="text-xs"
          style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
        >
          当前没有可用的文生图模型池，生成按钮不可用。请先到「模型中心 → 模型池」配置一个 text2img 池。
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {LANDING_PREVIEW_SLOTS.map((slot) => {
          const asset = assets[slot.slot];
          const st = states[slot.slot] ?? { status: 'idle' as const };
          const running = st.status === 'running';
          const elapsed = running && st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0;
          // tick 只为让上面这个秒数每秒重算一次；读一下它，避免被当成未使用
          void tick;

          return (
            <div
              key={slot.slot}
              className="flex flex-col overflow-hidden"
              style={{
                borderRadius: '12px',
                border: '1px solid var(--border-secondary)',
                background: 'var(--bg-card)',
              }}
            >
              {/* 画框：3:2，不管有没有图都占同样的位置，出图时不会跳版 */}
              <div
                className="relative flex items-center justify-center"
                style={{
                  aspectRatio: '3 / 2',
                  background: running ? HATCH : 'var(--bg-secondary)',
                  backgroundColor: 'var(--bg-secondary)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                {asset?.url && !running && (
                  <img
                    src={asset.updatedAt ? `${asset.url}?v=${Date.parse(asset.updatedAt) || ''}` : asset.url}
                    alt={slot.label}
                    className="w-full h-full"
                    style={{ objectFit: 'cover' }}
                  />
                )}
                {running && (
                  <div className="flex flex-col items-center gap-2">
                    <MapSpinner size={20} />
                    <span className="text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      正在画第 {slot.where.replace(/[^0-9]/g, '') || '?'} 幕 · 已等待 {elapsed}s
                    </span>
                  </div>
                )}
                {!asset?.url && !running && (
                  <div className="flex flex-col items-center gap-1.5 px-4 text-center">
                    <ImageIcon size={20} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>还没有配图，点下面「生成」</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1 p-3">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{slot.label}</span>
                  <span className="text-[11px] shrink-0 ml-auto" style={{ color: 'var(--text-muted)' }}>{slot.size}</span>
                </div>
                <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{slot.where}</span>

                {st.status === 'error' && (
                  <span className="text-[11px]" style={{ color: 'var(--semantic-danger-text)' }}>{st.error}</span>
                )}

                <div className="flex items-center gap-2 mt-1.5">
                  <Button variant="secondary" size="sm" onClick={() => openDialog(slot)} disabled={running || !activeModel}>
                    <Sparkles size={13} />
                    {asset?.url ? '重新生成' : '生成'}
                  </Button>
                  {asset?.url && (
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(slot)} disabled={running}>
                      <Trash2 size={13} />
                      清除
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <ResponsiveDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing ? `生成「${editing.slot.label}」` : ''}
        description={editing ? `${editing.slot.where} · ${editing.slot.size}` : undefined}
        maxWidth={680}
        content={
          editing ? (
            <div className="flex flex-col gap-3">
              <textarea
                value={editing.prompt}
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                spellCheck={false}
                style={{
                  width: '100%',
                  height: '300px',
                  minHeight: 0,
                  resize: 'vertical',
                  padding: '12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-secondary)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '12.5px',
                  lineHeight: 1.7,
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                }}
              />
              <p className="text-[11px]" style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
                前半段是十幕共用的风格约束（底色、两支重音色、只写小写拉丁标注），改它会让这张图和其它幕不成套；
                后半段是这一幕的画面描述，通常只需要改这里。
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ ...editing, prompt: buildLandingPreviewPrompt(editing.slot) })}
                >
                  <RotateCcw size={13} />
                  恢复默认提示词
                </Button>
                <Button
                  variant="primary"
                  className="ml-auto"
                  onClick={() => {
                    const target = { slot: editing.slot, prompt: editing.prompt.trim() };
                    setEditing(null);
                    if (!target.prompt) {
                      toast.error('提示词不能为空');
                      return;
                    }
                    void generate([target]);
                  }}
                >
                  <Sparkles size={14} />
                  开始生成
                </Button>
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}
