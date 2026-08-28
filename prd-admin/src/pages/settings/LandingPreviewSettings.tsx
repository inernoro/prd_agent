import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Maximize2, RefreshCw, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
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
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { toast } from '@/lib/toast';
import {
  LANDING_PREVIEW_SLOTS,
  buildLandingPreviewPrompt,
  LANDING_ART_STYLES,
  DEFAULT_LANDING_ART_STYLE,
  landingArtStyle,
  type LandingArtStyleKey,
  landingPreviewSlotById,
  type LandingPreviewSlot,
} from '@/lib/landingPreviewSlots';

/**
 * 系统设置 →「首页预览图」。
 *
 * 对外首页（`/home`）十幕，每幕一张示意图；这一屏负责把它们生出来、看一眼、
 * 不满意就带着改过的提示词再生一次。
 *
 * 四条设计取舍：
 *
 * 1. **提示词有默认值，且默认值是好用的那版**（`lib/landingPreviewSlots.ts`）。
 *    管理员打开弹窗看到的是一段能直接出图的完整提示词，不是空白框
 *    （`zero-friction-input`）。改过一次之后回填的是他自己那版，不是默认版——
 *    否则每次微调都要从头改一遍。
 * 2. **一个模型不行就自动换下一个**。池里 15 个出图模型全报 Healthy，实测只有
 *    两个真能出图，其余一律 400（这是模型池健康探针的问题，不是这一屏的）。
 *    只按优先级挑第一个 = 稳定挑中坏的那个，用户点一次错一次。所以失败时按池内
 *    顺序自动往下试，上限 `MODEL_FALLBACK_LIMIT` 个，并在卡片上写明正在试哪个——
 *    「自动换了模型」这件事不能不告诉人（`expectation-management`）。
 * 3. **缩略图只占一小条**。十幕排成十张大图要滚很久，而这一屏的用途是「扫一眼谁
 *    还没配、谁配得不对」，不是看图。所以缩略图压到 108px 宽的一条，点开才放大；
 *    放大弹层里直接给「重新生成」，看和换在同一个地方完成。
 * 4. **等待期给产物的形状**：生成中的缩略图是一块带斜纹的画框加秒表，不是转圈
 *    （`artifact-is-experience`）。一次「全部重新生成」十张并发跑，谁先出谁先落位。
 */

/**
 * 一次生成最多自动试几个模型。
 * 不设成「把池子试穿」：15 个模型逐个试要几分钟、烧十几次配额，而失败大多同因。
 * 试到第 3 个还不行，基本就是池子本身有问题，该去模型中心看，不该在这儿硬磨。
 */
const MODEL_FALLBACK_LIMIT = 3;

type SlotState = {
  status: 'idle' | 'running' | 'error';
  startedAt?: number;
  error?: string;
  /** 这一拍正在用哪个模型试（自动换模型时要让人看见换到哪了） */
  model?: string;
  /** 第几次尝试，从 1 起 */
  attempt?: number;
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
  const [zoomSlotId, setZoomSlotId] = useState<string | null>(null);
  /** 当前选的拍法。换一档再点生成，出来的就是另一种风格的同一个画面 */
  const [artStyle, setArtStyle] = useState<LandingArtStyleKey>(DEFAULT_LANDING_ART_STYLE);

  const controllersRef = useRef<AbortController[]>([]);
  /** 卸载后丢弃在途 SSE 回调，避免在已卸载组件上 setState */
  const aliveRef = useRef(true);

  /**
   * 把池子摊平成**一串可依次尝试的模型**，而不是「每个池挑一个代表」。
   *
   * 挑代表那种写法在这里是错的：池里 15 个模型全报 Healthy，实测只有两个能出图。
   * 只挑优先级最高的那个 = 每次都稳定挑中同一个坏的，用户点一次错一次。
   * 摊平之后，第一个失败就能顺着往下试。
   *
   * 摊平之后必须**按上游去重**：候选的身份对我们来说是 `(platformId, modelId)`——
   * 生图请求就只带这两样。同一个模型挂在两个池里就会摊出两条，兜底顺着往下试时
   * 等于把刚失败的那个上游原样再打一次，钱花两遍、结果注定一样。
   */
  const modelChain = useMemo(() => {
    const list: { key: string; label: string; poolName: string; modelId: string; platformId: string }[] = [];
    const seen = new Set<string>();
    pools.forEach((pool, pi) => {
      const sorted = [...(pool.models ?? [])].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
      sorted.forEach((m) => {
        // 明确标记不可用的直接不进候选；其余（含 Healthy 与降级）都留着，靠真实调用淘汰
        if (m.healthStatus === ModelHealthStatus.Unavailable) return;
        const upstream = `${m.platformId}::${m.modelId}`;
        if (seen.has(upstream)) return;   // 同一个上游只留优先级最高的那次出现
        seen.add(upstream);
        list.push({
          key: `${pi}:${pool.name}:${m.modelId}`,
          label: m.modelId,
          poolName: pool.name,
          modelId: m.modelId,
          platformId: m.platformId,
        });
      });
    });
    return list;
  }, [pools]);

  /** 用户选中的起点；没选就是链头 */
  const startIndex = useMemo(() => {
    const i = modelChain.findIndex((o) => o.key === selectedModelKey);
    return i >= 0 ? i : 0;
  }, [modelChain, selectedModelKey]);

  const hasModel = modelChain.length > 0;

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
   * 用一个指定模型跑一批槽位，返回**这一轮没出图的那些**（留给下一个模型接着试）。
   *
   * 一次 run 带 N 条 item，itemIndex 与 targets 下标一一对应 —— 回填时靠这个下标
   * 认领，别用 prompt 反查（同一段提示词可能被两个槽位共用）。
   */
  const runOnce = async (
    targets: { slot: LandingPreviewSlot; prompt: string }[],
    model: { modelId: string; platformId: string },
    attempt: number,
  ): Promise<{ slot: LandingPreviewSlot; prompt: string }[]> => {
    const now = Date.now();
    targets.forEach((t) =>
      patchState(t.slot.slot, { status: 'running', startedAt: now, model: model.modelId, attempt }),
    );

    const ac = new AbortController();
    controllersRef.current.push(ac);

    const created = await createImageGenRun({
      input: {
        appKey: 'visual-agent',
        modelId: model.modelId,
        platformId: model.platformId,
        items: targets.map((t) => ({ prompt: t.prompt, count: 1, size: t.slot.size })),
        // 必须要 url：这条 run 不带 workspaceId，Worker 不会把 base64 落成资产，
        // 而挂到首页槽位（adopt-image-run）引用的正是产物的 URL。要 b64_json 的话
        // 图生出来了、item.Url 却是空的，adopt 一律被拒。
        responseFormat: 'url',
        maxConcurrency: 3,
      },
      idempotencyKey: `landing_${now}_${Math.random().toString(16).slice(2)}`,
    });
    if (!created.success) return targets;

    const runId = String(created.data?.runId || '').trim();
    if (!runId) return targets;

    /** 这一轮已经出图并挂上去的槽位；剩下的就是要换模型再试的 */
    const settled = new Set<string>();
    const adoptions: Promise<void>[] = [];

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
          adoptions.push(
            adoptHomepageAssetFromRun({
              slot: target.slot.slot,
              runId,
              itemIndex,
              imageIndex: 0,
              prompt: target.prompt,
            }).then((res) => {
              if (!aliveRef.current) return;
              if (!res.success) {
                patchState(target.slot.slot, { status: 'error', error: res.error?.message || '挂到槽位失败' });
                // 挂载失败是我们这边的问题，换模型也救不了，标记为已了结不再重试
                settled.add(target.slot.slot);
                return;
              }
              settled.add(target.slot.slot);
              patchState(target.slot.slot, { status: 'idle' });
            }),
          );
        }
        // imageError 不在这里落状态：留给外层决定是换模型再试还是报错收场
      },
    });

    // 等挂载都落完再判定剩余，否则会把「已出图但 adopt 还在飞」的误判成失败又重跑一遍
    await Promise.all(adoptions);
    if (!aliveRef.current) return [];
    await reload();
    return targets.filter((t) => !settled.has(t.slot.slot));
  };

  /**
   * 生成一批槽位：一个模型不行就自动换下一个，最多 `MODEL_FALLBACK_LIMIT` 个。
   */
  const generate = async (targets: { slot: LandingPreviewSlot; prompt: string }[]) => {
    if (!hasModel) {
      toast.error('没有可用的文生图模型，请先在模型中心配置');
      return;
    }
    if (targets.length === 0) return;

    let pending = targets;
    let lastModel = '';
    // 上限取「还剩几个没试过的模型」，不是死的 MODEL_FALLBACK_LIMIT —— 取模会绕回去
    // 把同一个模型再跑一遍：只配了 1 个模型时，同一次昂贵的生图要白跑三遍，
    // 而失败文案还说「换了 3 个模型」。
    const rounds = Math.min(MODEL_FALLBACK_LIMIT, modelChain.length);
    let tried = 0;
    for (let i = 0; i < rounds && pending.length > 0; i++) {
      const model = modelChain[(startIndex + i) % modelChain.length];
      if (!model) break;
      lastModel = model.modelId;
      tried = i + 1;
      pending = await runOnce(pending, model, i + 1);
      if (!aliveRef.current) return;
    }

    if (pending.length === 0) return;
    // 试穿了还是不行：如实说试了几个、最后一个是谁，别只丢一句"生成失败"
    pending.forEach((t) =>
      patchState(t.slot.slot, {
        status: 'error',
        error: `试了 ${tried} 个模型都没出图（最后一个：${lastModel}）。多半是模型池本身有问题，去「模型中心 → 模型池」看一眼。`,
      }),
    );
  };

  const openDialog = (slot: LandingPreviewSlot) => {
    // 改过一次就回填他自己那版；没生成过才用默认词
    const stored = assets[slot.slot]?.prompt;
    setEditing({ slot, prompt: stored && stored.trim() ? stored : buildLandingPreviewPrompt(slot, artStyle) });
  };

  const handleGenerateAll = () => {
    void generate(
      LANDING_PREVIEW_SLOTS.map((s) => ({
        slot: s,
        prompt: assets[s.slot]?.prompt?.trim() || buildLandingPreviewPrompt(s, artStyle),
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
  const zoomSlot = zoomSlotId ? landingPreviewSlotById(zoomSlotId) : undefined;
  const zoomAsset = zoomSlot ? assets[zoomSlot.slot] : undefined;
  const zoomSrc = zoomAsset?.url
    ? (zoomAsset.updatedAt ? `${zoomAsset.url}?v=${Date.parse(zoomAsset.updatedAt) || ''}` : zoomAsset.url)
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 控制条：结论在前（多少张已生成），操作在后 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {generatedCount} / {LANDING_PREVIEW_SLOTS.length} 幕已有配图
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            首页两幕里的产物图。提示词已按位置写好默认值，点「生成」可当场改；换「拍法」再生成即整套换风格。
          </div>
        </div>

        {/* 拍法：换一档，下次生成的画面不变、观感全变 */}
        <div className="shrink-0" style={{ minWidth: '190px' }}>
          <Select value={artStyle} onChange={(e) => setArtStyle(e.target.value as LandingArtStyleKey)} uiSize="sm">
            {LANDING_ART_STYLES.map((st) => (
              <option key={st.key} value={st.key}>{st.label}</option>
            ))}
          </Select>
        </div>

        {/* 一个模型也没有时不摆选择器；有多个时让人能钉住起点（失败仍会自动往下试） */}
        {modelChain.length > 1 && (
          <div className="ml-auto shrink-0" style={{ minWidth: '220px' }}>
            <Select
              value={selectedModelKey ?? modelChain[0]?.key ?? ''}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              uiSize="sm"
            >
              {modelChain.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </Select>
          </div>
        )}

        <Button
          variant="secondary"
          onClick={handleGenerateAll}
          disabled={anyRunning || !hasModel}
          className={modelChain.length > 1 ? 'shrink-0' : 'ml-auto shrink-0'}
        >
          {anyRunning ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
          全部重新生成
        </Button>
      </div>

      {!hasModel && (
        <div
          className="text-xs"
          style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
        >
          当前没有可用的文生图模型，生成按钮不可用。请先到「模型中心 → 模型池」配置一个 text2img 池。
        </div>
      )}

      {/*
        一行一幕的紧凑列表，缩略图只占 108px 宽的一条。
        十幕排成十张大图要滚很久，而这一屏的用途是「扫一眼谁还没配、谁配得不对」，
        不是看图 —— 看图点开缩略图，放大层里连「重新生成」一起给。
      */}
      <div className="flex flex-col gap-2">
        {LANDING_PREVIEW_SLOTS.map((slot) => {
          const asset = assets[slot.slot];
          const st = states[slot.slot] ?? { status: 'idle' as const };
          const running = st.status === 'running';
          const elapsed = running && st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0;
          // tick 只为让上面这个秒数每秒重算一次；读一下它，避免被当成未使用
          void tick;
          const src = asset?.url
            ? (asset.updatedAt ? `${asset.url}?v=${Date.parse(asset.updatedAt) || ''}` : asset.url)
            : null;

          return (
            <div
              key={slot.slot}
              className="flex items-center gap-3 overflow-hidden"
              style={{
                padding: '8px 10px',
                borderRadius: '10px',
                border: '1px solid var(--border-secondary)',
                background: 'var(--bg-card)',
              }}
            >
              {/* 缩略图：3:2 的一小条，固定宽高，出图时不跳版 */}
              <button
                type="button"
                onClick={() => { if (src) setZoomSlotId(slot.id); }}
                disabled={!src}
                title={src ? '点击放大' : undefined}
                className="relative flex items-center justify-center shrink-0 overflow-hidden group"
                style={{
                  width: '108px',
                  height: '72px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                  background: running ? HATCH : 'var(--bg-secondary)',
                  backgroundColor: 'var(--bg-secondary)',
                  cursor: src ? 'zoom-in' : 'default',
                  padding: 0,
                }}
              >
                {src && !running && (
                  <>
                    <img src={src} alt={slot.label} className="w-full h-full" style={{ objectFit: 'cover' }} />
                    {/*
                      hover 时压一层同色遮罩再放图标。用 --bg-base + 半透明而不是黑色
                      字面量：浅色主题下压黑会变成一块脏灰（双皮肤棘轮也拦这条）。
                    */}
                    <span
                      className="absolute inset-0 items-center justify-center hidden group-hover:flex"
                      style={{ background: 'var(--bg-base)', opacity: 0.72 }}
                    >
                      <Maximize2 size={15} style={{ color: 'var(--text-primary)' }} />
                    </span>
                  </>
                )}
                {running && <MapSpinner size={16} />}
                {!src && !running && <ImageIcon size={16} style={{ color: 'var(--text-muted)' }} />}
              </button>

              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{slot.label}</span>
                  <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{slot.where}</span>
                  <span className="text-[11px] shrink-0 ml-auto" style={{ color: 'var(--text-muted)' }}>{slot.size}</span>
                </div>

                {running ? (
                  <span className="text-[11px] tabular-nums truncate" style={{ color: 'var(--text-secondary)' }}>
                    正在生成 · 已等待 {elapsed}s
                    {st.model ? ` · ${st.model}` : ''}
                    {st.attempt && st.attempt > 1 ? `（第 ${st.attempt} 个模型）` : ''}
                  </span>
                ) : st.status === 'error' ? (
                  <span className="text-[11px]" style={{ color: 'var(--semantic-danger-text)' }}>{st.error}</span>
                ) : (
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {src ? '点缩略图放大，或直接重新生成' : '还没有配图'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="secondary" size="sm" onClick={() => openDialog(slot)} disabled={running || !hasModel}>
                  <Sparkles size={13} />
                  {src ? '重新生成' : '生成'}
                </Button>
                {src && (
                  <Button variant="ghost" size="sm" onClick={() => void handleDelete(slot)} disabled={running}>
                    <Trash2 size={13} />
                    清除
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/*
        放大层：看图与换图在同一个地方完成 —— 点开是为了判断这张行不行，
        判断完就该能当场换掉，不该关掉再去列表里找那一行。
      */}
      {zoomSlot && zoomSrc && (
        <>
          <ImagePreviewDialog
            images={[{ url: zoomSrc, alt: zoomSlot.label }]}
            initialIndex={0}
            open
            onClose={() => setZoomSlotId(null)}
          />
          <div
            className="fixed left-1/2 -translate-x-1/2 flex items-center gap-2"
            style={{ bottom: '28px', zIndex: 2147483647 }}
          >
            <Button
              variant="primary"
              size="sm"
              onClick={() => { setZoomSlotId(null); openDialog(zoomSlot); }}
            >
              <Sparkles size={13} />
              换一张
            </Button>
          </div>
        </>
      )}

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
                前半段是当前「拍法」的风格约束（现在是{landingArtStyle(artStyle).label}：{landingArtStyle(artStyle).hint}），
                整套图共用，改它这一张就和别的不成套了；后半段是这张自己的画面描述，通常只需要改这里。
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ ...editing, prompt: buildLandingPreviewPrompt(editing.slot, artStyle) })}
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
