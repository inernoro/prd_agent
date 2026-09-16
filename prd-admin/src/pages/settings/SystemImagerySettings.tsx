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
import { invalidateImagery } from '@/hooks/useImagery';
import {
  SYSTEM_IMAGERY_MODULES,
  IMAGERY_STYLES,
  applyImageryStyleToPrompt,
  buildImageryPrompt,
  imageryStyle,
  type ImageryModule,
  type ImagerySlot,
  type ImageryStyleKey,
} from '@/lib/imagery';

/**
 * 系统设置 →「系统配图」。
 *
 * 全站由模型生成的图片，都在这一屏出生、改稿、重生成。图位来自
 * `lib/imagery` 注册表——模块只声明「我有几个图位、默认提示词是什么」，
 * 接新模块不用碰这个文件。
 *
 * 五条设计取舍：
 *
 * 1. **提示词有默认值，且默认值是好用的那版**。管理员打开弹窗看到的是一段能直接
 *    出图的完整提示词，不是空白框（`zero-friction-input`）。改过一次之后回填的是
 *    他自己那版，不是默认版——否则每次微调都要从头改一遍。
 * 2. **一个模型不行就自动换下一个**。池里十几个出图模型全报 Healthy，实测只有
 *    两个真能出图，其余一律 400（这是模型池健康探针的问题，不是这一屏的）。
 *    只按优先级挑第一个 = 稳定挑中坏的那个，用户点一次错一次。所以失败时按池内
 *    顺序自动往下试，上限 `MODEL_FALLBACK_LIMIT` 个，并在行上写明正在试哪个——
 *    「自动换了模型」这件事不能不告诉人（`expectation-management`）。
 * 3. **缩略图只占一小条**。几十个图位排成大图要滚很久，而这一屏的用途是「扫一眼谁
 *    还没配、谁配得不对」，不是看图。所以缩略图压到 108px 宽的一条，点开才放大；
 *    放大弹层里直接给「重新生成」，看和换在同一个地方完成。
 * 4. **拍法按模块分别选**。对外首页要的是风景照，藏书阁要的是台面静物——一个全局
 *    风格档会逼着两组图共用一种味道。所以每组自己一个下拉，默认值来自模块声明。
 * 5. **先给判断再给数字**（`conclusion-before-numbers`）：顶部第一行是一句挂着数字
 *    的结论（哪个模块缺得最多），不是让人自己读一排计数去算。
 */

/**
 * 一次生成最多自动试几个模型。
 * 不设成「把池子试穿」：十几个模型逐个试要几分钟、烧十几次配额，而失败大多同因。
 * 试到第 3 个还不行，基本就是池子本身有问题，该去 LLM Gateway 控制台看，不该在这儿硬磨。
 */
const MODEL_FALLBACK_LIMIT = 3;

/**
 * 给预览图加一个跟着更新时间走的版本参数，换完图这一屏能立刻看到新的。
 *
 * 分隔符必须看着办：认领进来的地址可能自带 query（供应商的签名地址就是这样），
 * 无脑拼 `?` 会拼出 `...?sig=x?v=1`——query 被拼坏，签名跟着失效，于是
 * 公开页（用原始地址）好好的，管理端这一屏反而是裂的。
 */
function withCacheBust(url: string, updatedAt?: string | null): string {
  const v = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(v)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${v}`;
}

type SlotState = {
  status: 'idle' | 'running' | 'error';
  startedAt?: number;
  error?: string;
  /** 这一拍正在用哪个模型试（自动换模型时要让人看见换到哪了） */
  model?: string;
  /** 第几次尝试，从 1 起 */
  attempt?: number;
};

/** 一次生成的目标：图位 + 这一次实际要用的提示词 */
type Target = { slot: ImagerySlot; prompt: string };

/**
 * 生成中卡片的斜纹底：给等待一个「画布正在被填」的形状，而不是一个转圈。
 * 走 token 而非裸的白色透明叠加 —— 后者在浅色主题下会直接隐形（双皮肤棘轮盯着这条，
 * 连注释里写出那个字面量都会被计数，所以这里用文字描述）。
 */
const HATCH =
  'repeating-linear-gradient(45deg, var(--bg-tertiary) 0 12px, transparent 12px 24px)';

export default function SystemImagerySettings() {
  const [assets, setAssets] = useState<Record<string, HomepageAssetDto>>({});
  const [loading, setLoading] = useState(true);
  /*
   * 清单有没有真的拿到手。不记这一笔就会掉进一个花钱的坑：
   * 清单请求失败时 assets 停在空 map、loading 却被 finally 照常清掉，
   * 于是这一屏认为**每一个图位都缺图**，「生成缺失的 N 张」亮起来变成全量重画。
   * 管理员点下去，钱花了，本来好好的图被覆盖了一遍——而他看到的界面
   * 一个错字都没有（`predicate-and-wiring-discipline` 形状 10）。
   */
  const [inventoryFailed, setInventoryFailed] = useState(false);
  const [pools, setPools] = useState<ModelGroupForApp[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SlotState>>({});
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<{ module: ImageryModule; slot: ImagerySlot; prompt: string } | null>(null);
  const [zoomSlotKey, setZoomSlotKey] = useState<string | null>(null);

  /**
   * 每个模块自己的拍法。初始值来自模块声明——对外首页是风景照、藏书阁是台面静物，
   * 一个全局档会逼着两组图共用一种味道。
   */
  const [styleByModule, setStyleByModule] = useState<Record<string, ImageryStyleKey>>(() => {
    const init: Record<string, ImageryStyleKey> = {};
    SYSTEM_IMAGERY_MODULES.forEach((m) => { init[m.id] = m.defaultStyle; });
    return init;
  });

  const controllersRef = useRef<AbortController[]>([]);
  /** 卸载后丢弃在途 SSE 回调，避免在已卸载组件上 setState */
  const aliveRef = useRef(true);

  /**
   * 把池子摊平成**一串可依次尝试的模型**，而不是「每个池挑一个代表」。
   *
   * 挑代表那种写法在这里是错的：池里十几个模型全报 Healthy，实测只有两个能出图。
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
          // key 必须带 platformId：同一个模型名挂在两个平台下是常事，只按池 + 模型名
          // 做 key 会撞成同一个值，下拉里选第二条、findIndex 认回第一条，
          // 管理员根本挑不中他想要的那个平台
          key: `${pi}:${pool.name}:${m.platformId}:${m.modelId}`,
          label: m.modelId,
          poolName: pool.name,
          modelId: m.modelId,
          platformId: m.platformId,
        });
      });
    });
    return list;
  }, [pools]);

  /** 同一个模型名出现在多个平台下 —— 这些在下拉里必须把平台也显出来才分得清 */
  const ambiguousModelIds = useMemo(() => {
    const byModel = new Map<string, Set<string>>();
    for (const o of modelChain) {
      const set = byModel.get(o.modelId) ?? new Set<string>();
      set.add(o.platformId);
      byModel.set(o.modelId, set);
    }
    return new Set([...byModel].filter(([, platforms]) => platforms.size > 1).map(([id]) => id));
  }, [modelChain]);

  /** 用户选中的起点；没选就是链头 */
  const startIndex = useMemo(() => {
    const i = modelChain.findIndex((o) => o.key === selectedModelKey);
    return i >= 0 ? i : 0;
  }, [modelChain, selectedModelKey]);

  const hasModel = modelChain.length > 0;

  const reload = useCallback(async () => {
    // 这一屏是系统配图的唯一改动入口，改完就把消费侧那两份模块级缓存丢掉。
    // 不丢的话，同一个 SPA 会话里换完图再回消费页，看到的还是换之前那一份——
    // 而他刚刚才亲手换过，只能整页刷新才看得见。
    invalidateImagery();
    const res = await listHomepageAssets();
    if (!aliveRef.current) return;
    if (res.success) {
      const map: Record<string, HomepageAssetDto> = {};
      (res.data ?? []).forEach((a) => { map[a.slot] = a; });
      setAssets(map);
      setInventoryFailed(false);
      return;
    }
    // 拿不到清单就把「缺了几张」这个判断整个作废——宁可什么都不让点，
    // 也不能让人照着一份空清单去花钱重画一遍已经有的图。
    console.error('[SystemImagerySettings] 配图清单拉取失败:', res.error?.message);
    setInventoryFailed(true);
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

  /** 有任务在跑时每秒重绘一次，让行上的秒表真的在走 */
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
   * 用一个指定模型跑一批图位，返回**这一轮没出图的那些**（留给下一个模型接着试）。
   *
   * 一次 run 带 N 条 item，itemIndex 与 targets 下标一一对应 —— 回填时靠这个下标
   * 认领，别用 prompt 反查（同一段提示词可能被两个图位共用）。
   */
  const runOnce = async (
    targets: Target[],
    model: { modelId: string; platformId: string },
    attempt: number,
  ): Promise<Target[]> => {
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
        // 而挂到槽位（adopt-image-run）引用的正是产物的 URL。要 b64_json 的话
        // 图生出来了、item.Url 却是空的，adopt 一律被拒。
        responseFormat: 'url',
        maxConcurrency: 3,
      },
      idempotencyKey: `imagery_${now}_${Math.random().toString(16).slice(2)}`,
    });
    if (!created.success) return targets;

    const runId = String(created.data?.runId || '').trim();
    if (!runId) return targets;

    /** 这一轮已经出图并挂上去的图位；剩下的就是要换模型再试的 */
    const settled = new Set<string>();
    const adoptions: Promise<void>[] = [];

    const streamed = await streamImageGenRunWithRetry({
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
          // 出图即落位：把这张挂到图位上，管理员不用再点一次「保存」
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
                patchState(target.slot.slot, { status: 'error', error: res.error?.message || '挂到图位失败' });
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

    const remaining = targets.filter((t) => !settled.has(t.slot.slot));

    /*
     * 连接断了 ≠ 模型不行。
     *
     * 事件流重试 20 次仍连不上时，服务端那条 run 很可能还在跑、甚至已经跑完了；
     * 我们只是没看见 imageDone。这时把剩下的图位交给下一个模型重跑，等于为同一批图
     * 再付一次钱，而且最后还可能报「都没出图」——实际第一次就成了。
     * 所以：流本身失败时如实说断了，并且**不往下换模型**（返回空的剩余清单）。
     */
    if (!streamed.success && remaining.length > 0) {
      remaining.forEach((t) =>
        patchState(t.slot.slot, {
          status: 'error',
          error: '连接断了，没能看到出图结果。服务端那次生成可能已经完成——刷新这一屏看看，别急着重生成（会重复计费）。',
        }),
      );
      return [];
    }

    return remaining;
  };

  /**
   * 生成一批图位：一个模型不行就自动换下一个，最多 `MODEL_FALLBACK_LIMIT` 个。
   */
  const generate = async (targets: Target[]) => {
    if (!hasModel) {
      toast.error('没有可用的文生图模型，请先到 LLM Gateway 控制台（左下角「模型网关」）配置');
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
        error: `试了 ${tried} 个模型都没出图（最后一个：${lastModel}）。多半是模型池本身有问题，去 LLM Gateway 控制台（左下角「模型网关」→ 模型池）看一眼。`,
      }),
    );
  };

  /** 按当前拍法拼这一图位这一次要用的提示词（保住管理员改过的画面描述） */
  const targetOf = useCallback(
    (module: ImageryModule, slot: ImagerySlot): Target => ({
      slot,
      prompt: applyImageryStyleToPrompt(assets[slot.slot]?.prompt, slot, styleByModule[module.id]),
    }),
    [assets, styleByModule],
  );

  const openDialog = (module: ImageryModule, slot: ImagerySlot) => {
    // 回填他自己改过的那版画面描述，但前缀换成**当前选中的拍法**——
    // 弹窗里那行说明写的就是「前半段是当前拍法的风格约束」，回填旧拍法会自相矛盾
    setEditing({ module, slot, prompt: targetOf(module, slot).prompt });
  };

  const handleDelete = async (slot: ImagerySlot) => {
    const res = await deleteHomepageAsset({ slot: slot.slot });
    if (!res.success) {
      toast.error(res.error?.message || '删除失败');
      return;
    }
    toast.success(`已清除「${slot.label}」`);
    await reload();
  };

  /** 全站统计 —— 顶部结论条用 */
  const stats = useMemo(() => {
    let total = 0;
    let filled = 0;
    let running = 0;
    const missingByModule: { module: ImageryModule; missing: number }[] = [];
    SYSTEM_IMAGERY_MODULES.forEach((m) => {
      let mMissing = 0;
      m.slots.forEach((s) => {
        total += 1;
        if (assets[s.slot]?.url) filled += 1; else mMissing += 1;
        if (states[s.slot]?.status === 'running') running += 1;
      });
      missingByModule.push({ module: m, missing: mMissing });
    });
    const worst = [...missingByModule].sort((a, b) => b.missing - a.missing)[0];
    return { total, filled, missing: total - filled, running, worst };
  }, [assets, states]);

  /** 全站还缺的那些（不含正在生成的，那些已经在路上了，再点一次是重复计费） */
  const missingTargets = useMemo(
    () =>
      SYSTEM_IMAGERY_MODULES.flatMap((m) =>
        m.slots.filter((s) => !assets[s.slot]?.url && states[s.slot]?.status !== 'running').map((s) => targetOf(m, s)),
      ),
    [assets, states, targetOf],
  );

  if (loading) return <MapSectionLoader text="正在加载系统配图…" />;

  const zoomEntry = zoomSlotKey
    ? SYSTEM_IMAGERY_MODULES.flatMap((m) => m.slots).find((s) => s.slot === zoomSlotKey)
    : undefined;
  const zoomAsset = zoomEntry ? assets[zoomEntry.slot] : undefined;
  const zoomSrc = zoomAsset?.url ? withCacheBust(zoomAsset.url, zoomAsset.updatedAt) : null;
  const editingStyle = editing ? imageryStyle(styleByModule[editing.module.id]) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：先给判断，再给数字（conclusion-before-numbers） */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {stats.missing === 0
              ? `${stats.total} 个图位全部配好了`
              : `${stats.worst?.module.label} 还缺 ${stats.worst?.missing} 张${stats.missing > (stats.worst?.missing ?? 0) ? `，全站共缺 ${stats.missing} 张` : ''}`}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            共 {stats.total} 个图位 · 已配 {stats.filled} · 缺 {stats.missing}
            {stats.running > 0 ? ` · 生成中 ${stats.running}` : ''}
            。提示词已按位置写好默认值，点「生成」可当场改；换「拍法」再生成即整组换风格。
          </div>
        </div>

        {/* 一个模型也没有时不摆选择器；有多个时让人能钉住起点（失败仍会自动往下试） */}
        {modelChain.length > 1 && (
          <div className="shrink-0" style={{ minWidth: '220px' }}>
            <Select
              value={selectedModelKey ?? modelChain[0]?.key ?? ''}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              uiSize="sm"
            >
              {modelChain.map((o) => (
                // 同名模型来自不同平台时，标签也要带上平台，否则下拉里两条长得一模一样
                <option key={o.key} value={o.key}>
                  {ambiguousModelIds.has(o.modelId) ? `${o.label} · ${o.platformId}` : o.label}
                </option>
              ))}
            </Select>
          </div>
        )}

        <Button
          variant="primary"
          onClick={() => void generate(missingTargets)}
          disabled={anyRunning || !hasModel || inventoryFailed || missingTargets.length === 0}
          className="shrink-0"
        >
          {anyRunning ? <MapSpinner size={14} /> : <Sparkles size={14} />}
          生成缺失的 {missingTargets.length} 张
        </Button>
      </div>

      {!hasModel && (
        <div
          className="text-xs"
          style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
        >
          当前没有可用的文生图模型，生成按钮不可用。请先到 LLM Gateway 控制台（左下角「模型网关」→ 模型池）配置一个 text2img 池。
        </div>
      )}

      {inventoryFailed && (
        <div
          className="text-xs"
          style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--accent-fg-amber)' }}
        >
          配图清单没拉到，这一屏现在不知道哪些图位真的缺图，生成按钮已停用。
          刷新重试即可；在拉到清单之前不要生成，否则会把已经有的图重画一遍。
        </div>
      )}

      {/* 按模块分组：每组一个拍法、一个「整组重生成」 */}
      {SYSTEM_IMAGERY_MODULES.map((module) => {
        const style = styleByModule[module.id] ?? module.defaultStyle;
        const filled = module.slots.filter((s) => assets[s.slot]?.url).length;
        const moduleRunning = module.slots.some((s) => states[s.slot]?.status === 'running');

        return (
          <div
            key={module.id}
            style={{
              borderRadius: '12px',
              border: '1px solid var(--border-secondary)',
              background: 'var(--bg-nested)',
              overflow: 'hidden',
            }}
          >
            {/* 组头 */}
            <div
              className="flex items-center gap-2 flex-wrap"
              style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-secondary)' }}
            >
              <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{module.label}</span>
              <span
                className="text-[11px] shrink-0"
                style={{
                  padding: '1px 6px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                }}
              >
                {module.route}
              </span>
              <span
                className="text-[11px] shrink-0"
                style={{ color: filled === module.slots.length ? 'var(--accent-fg-success)' : 'var(--text-muted)' }}
              >
                {filled}/{module.slots.length} 已配
              </span>
              <span className="text-[11px] min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>{module.hint}</span>

              <div className="ml-auto flex items-center gap-2 shrink-0">
                {/* 拍法：换一档，下次生成的画面不变、观感全变 */}
                <div style={{ minWidth: '160px' }}>
                  <Select
                    value={style}
                    onChange={(e) =>
                      setStyleByModule((prev) => ({ ...prev, [module.id]: e.target.value as ImageryStyleKey }))
                    }
                    uiSize="sm"
                  >
                    {IMAGERY_STYLES.map((st) => (
                      <option key={st.key} value={st.key}>{st.label}</option>
                    ))}
                  </Select>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void generate(module.slots.map((s) => targetOf(module, s)))}
                  // 清单没拉到时三个生成入口都要停：上一版只守住了顶部那个批量按钮，
                  // 另外两个照常可点——守卫只接了三分之一（形状 2）。
                  disabled={moduleRunning || !hasModel || inventoryFailed}
                >
                  {moduleRunning ? <MapSpinner size={13} /> : <RefreshCw size={13} />}
                  整组重生成
                </Button>
              </div>
            </div>

            {/*
              一行一个图位的紧凑列表，缩略图只占 108px 宽的一条。
              几十个图位排成大图要滚很久，而这一屏的用途是「扫一眼谁还没配、谁配得不对」，
              不是看图 —— 看图点开缩略图，放大层里连「重新生成」一起给。
            */}
            <div className="flex flex-col">
              {module.slots.map((slot) => {
                const asset = assets[slot.slot];
                const st = states[slot.slot] ?? { status: 'idle' as const };
                const running = st.status === 'running';
                const elapsed = running && st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0;
                // tick 只为让上面这个秒数每秒重算一次；读一下它，避免被当成未使用
                void tick;
                const src = asset?.url ? withCacheBust(asset.url, asset.updatedAt) : null;

                return (
                  <div
                    key={slot.slot}
                    className="flex items-center gap-3 overflow-hidden"
                    style={{ padding: '8px 12px', borderTop: '1px solid var(--border-secondary)' }}
                  >
                    {/* 缩略图：3:2 的一小条，固定宽高，出图时不跳版 */}
                    <button
                      type="button"
                      onClick={() => { if (src) setZoomSlotKey(slot.slot); }}
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
                          {src ? '点缩略图放大，或直接重新生成' : '还没有配图，页面走兜底渲染'}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openDialog(module, slot)}
                        disabled={running || !hasModel || inventoryFailed}
                      >
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
          </div>
        );
      })}

      {/*
        放大层：看图与换图在同一个地方完成 —— 点开是为了判断这张行不行，
        判断完就该能当场换掉，不该关掉再去列表里找那一行。
      */}
      {zoomEntry && zoomSrc && (
        <>
          <ImagePreviewDialog
            images={[{ url: zoomSrc, alt: zoomEntry.label }]}
            initialIndex={0}
            open
            onClose={() => setZoomSlotKey(null)}
          />
          <div
            className="fixed left-1/2 -translate-x-1/2 flex items-center gap-2"
            style={{ bottom: '28px', zIndex: 2147483647 }}
          >
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const module = SYSTEM_IMAGERY_MODULES.find((m) => m.slots.some((s) => s.slot === zoomEntry.slot));
                setZoomSlotKey(null);
                if (module) openDialog(module, zoomEntry);
              }}
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
                前半段是当前「拍法」的风格约束（现在是{editingStyle?.label}：{editingStyle?.hint}），
                这一组图共用，改它这一张就和同组别的不成套了；后半段是这张自己的画面描述，通常只需要改这里。
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEditing({ ...editing, prompt: buildImageryPrompt(editing.slot, styleByModule[editing.module.id]) })
                  }
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
