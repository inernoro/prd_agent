import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clapperboard, Film, Maximize2, Play, RefreshCw, Sparkles, Wand2, X } from 'lucide-react';
import { PageHeader } from '@/components/design/PageHeader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  createImageGenRun,
  getVisualAgentImageGenModels,
  scriptStoryboard,
  streamImageGenRunWithRetry,
} from '@/services';
import { createVisualVideoRunReal, getVisualVideoRunReal, cancelVisualVideoRunReal } from '@/services/real/videoAgent';
import type { ModelGroupForApp } from '@/types/modelGroup';

type Aspect = '16:9' | '9:16' | '1:1';

type SceneVM = {
  index: number;
  topic: string;
  keyframePrompt: string;
  motionPrompt: string;
  duration: number;
  kfStatus: 'idle' | 'running' | 'done' | 'error';
  kfUrl?: string | null;
  /** 关键帧公开 HTTPS URL（COS），用于图生视频的首帧 */
  kfPublicUrl?: string | null;
  /** 渲染该关键帧时所用画幅——图生视频须沿用它，避免用户改画幅后用旧帧出错比例 */
  kfAspect?: Aspect;
  kfError?: string | null;
  /** 关键帧提示词在出图后被编辑过、当前帧已与提示词不一致：转视频前必须重绘，否则会用旧帧 + 新词出错配视频 */
  kfDirty?: boolean;
  editing?: boolean;
  /** image-to-video「动起来」状态 */
  vidStatus?: 'idle' | 'running' | 'done' | 'error';
  vidUrl?: string | null;
  vidError?: string | null;
  vidPhase?: string | null;
};

const ASPECTS: { key: Aspect; label: string; size: string; ratio: string }[] = [
  { key: '16:9', label: '横屏 16:9', size: '1280x720', ratio: '16 / 9' },
  { key: '9:16', label: '竖屏 9:16', size: '720x1280', ratio: '9 / 16' },
  { key: '1:1', label: '方形 1:1', size: '1024x1024', ratio: '1 / 1' },
];

const EXAMPLE_BRIEF =
  '一杯手冲咖啡的诞生：清晨的窗边，阳光斜照，热水缓缓注入滤杯，咖啡液滴落，蒸汽升腾，最后端起一杯香气四溢的咖啡。整体温暖治愈，电影质感。';

function safeJsonParse(raw: string): Record<string, unknown> | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export default function VisualStoryboardPage() {
  const [brief, setBrief] = useState('');
  const [style, setStyle] = useState('');
  const [aspect, setAspect] = useState<Aspect>('16:9');

  const [pools, setPools] = useState<ModelGroupForApp[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);

  const [phase, setPhase] = useState<'idle' | 'scripting' | 'rendering'>('idle');
  const [title, setTitle] = useState('');
  const [scenes, setScenes] = useState<SceneVM[]>([]);
  const [preview, setPreview] = useState<{ open: boolean; src: string; topic: string }>({ open: false, src: '', topic: '' });

  const controllersRef = useRef<AbortController[]>([]);
  // 每发起一轮「生成分镜」自增，作废上一轮在途的关键帧 SSE 回调 + 图生视频轮询，
  // 避免旧任务把过期的关键帧/错误/视频状态画到新分镜板的同 sceneIndex 上（stale-response guard）。
  const genRef = useRef(0);
  // 每个 sceneIndex 一个「关键帧运行 token」：后发的单镜重绘顶替该镜 token，
  // 使先前批次（或上一次重绘）对该镜的 SSE 回填与流结束兜底变成 no-op——
  // 避免「批次仍在跑、其中一镜被单独重绘」时批次兜底把正在重绘的镜误判为失败。
  const sceneKfGen = useRef<Map<number, number>>(new Map());
  // 正在「动起来」(图生视频)的镜头锁：sceneIndex -> 持锁的 genRef 代次。vidStatus='running' 是异步 state，
  // 两次快速点击会在它落地前都通过守卫，用同步 ref 去重防重复提交。按代次记锁，使「重新生成分镜」后新板能
  // 立即动起来（旧代次残留锁被顶替），且旧轮询的 finally 只在仍持本代次锁时才释放，不会清掉新板的锁。
  const animatingRef = useRef<Map<number, number>>(new Map());

  const aspectInfo = useMemo(() => ASPECTS.find((a) => a.key === aspect) ?? ASPECTS[0], [aspect]);

  // 每个有模型的池 = 一个可选关键帧模型（取池内最高优先级模型）。
  // 不再硬绑 pool[0]：单个 OpenRouter 模型（如 gpt-5.4-image-2）偶发 404 时，
  // 用户可在下拉里换到其他可用出图模型，关键帧/图生视频不被单一模型拖垮。
  const modelOptions = useMemo(() => {
    const opts: { key: string; poolName: string; modelName: string; platformId: string }[] = [];
    pools.forEach((pool, idx) => {
      if (pool.models && pool.models.length > 0) {
        const sorted = [...pool.models].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
        const m = sorted[0];
        opts.push({ key: `${idx}:${pool.name}`, poolName: pool.name, modelName: m.modelId, platformId: m.platformId });
      }
    });
    return opts;
  }, [pools]);

  const activeModel = useMemo(() => {
    const opt = modelOptions.find((o) => o.key === selectedModelKey) ?? modelOptions[0];
    return opt ? { name: opt.poolName, modelName: opt.modelName, platformId: opt.platformId } : null;
  }, [modelOptions, selectedModelKey]);

  useEffect(() => {
    let alive = true; // 卸载/重挂后丢弃过期模型响应，避免在已卸载组件上 setState
    setModelsLoading(true);
    getVisualAgentImageGenModels()
      .then((res) => {
        if (alive && res.success) setPools(res.data ?? []);
      })
      .finally(() => {
        if (alive) setModelsLoading(false);
      });
    return () => {
      alive = false;
      controllersRef.current.forEach((c) => c.abort());
      controllersRef.current = [];
      genRef.current += 1; // 卸载时作废所有在途 SSE + 图生视频轮询，避免卸载后还 setScenes
    };
  }, []);

  const busy = phase !== 'idle';

  /** 为一批镜头渲染关键帧（复用视觉创作生图引擎：创建 run → SSE 增量回填） */
  const renderKeyframes = async (targets: { sceneIndex: number; prompt: string }[]) => {
    if (!activeModel || targets.length === 0) return;
    const myGen = genRef.current; // 捕获本轮代次；若期间用户重新生成分镜则本批回调全部失效
    // 为本次运行的每个目标镜头占用一个 token；后发的重绘会再次自增、顶替所有权。
    const myTokens = new Map<number, number>();
    for (const t of targets) {
      const next = (sceneKfGen.current.get(t.sceneIndex) ?? 0) + 1;
      sceneKfGen.current.set(t.sceneIndex, next);
      myTokens.set(t.sceneIndex, next);
    }
    // 该镜是否仍归本次运行所有（未被新一轮全量生成或后发单镜重绘顶替）
    const owns = (idx: number) => genRef.current === myGen && sceneKfGen.current.get(idx) === myTokens.get(idx);
    const size = aspectInfo.size;
    const myAspect = aspect; // 记录本批关键帧的画幅，绑定到镜头，供图生视频沿用

    // 标记这批镜头为 running，并清掉旧的图生视频状态——重绘/重生关键帧后，
    // 卡片渲染优先看 vidUrl，若不清会继续显示上一版视频、看不到新关键帧。
    setScenes((prev) =>
      prev.map((s) =>
        targets.some((t) => t.sceneIndex === s.index)
          ? { ...s, kfStatus: 'running', kfError: null, kfDirty: false, vidStatus: 'idle', vidUrl: null, vidError: null, vidPhase: null }
          : s,
      ),
    );

    const ac = new AbortController();
    controllersRef.current.push(ac);

    const idem = `sb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const created = await createImageGenRun({
      input: {
        appKey: 'visual-agent',
        modelId: activeModel.modelName,
        platformId: activeModel.platformId,
        items: targets.map((t) => ({ prompt: t.prompt, count: 1, size })),
        size,
        responseFormat: 'b64_json',
        maxConcurrency: 3,
      },
      idempotencyKey: idem,
    });
    if (!created.success) {
      toast.error(created.error?.message || '创建关键帧任务失败');
      setScenes((prev) =>
        prev.map((s) =>
          targets.some((t) => t.sceneIndex === s.index) && owns(s.index) ? { ...s, kfStatus: 'error', kfError: created.error?.message || '失败' } : s,
        ),
      );
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      // 创建成功却没返回 runId：把本批 running 的镜头复位为 error，避免 spinner 卡死
      setScenes((prev) =>
        prev.map((s) =>
          targets.some((t) => t.sceneIndex === s.index) && owns(s.index) ? { ...s, kfStatus: 'error', kfError: '创建任务未返回 runId，请重试' } : s,
        ),
      );
      return;
    }

    await streamImageGenRunWithRetry({
      runId,
      afterSeq: 0,
      maxAttempts: 20,
      signal: ac.signal,
      onEvent: (evt) => {
        if (genRef.current !== myGen) return; // 已被新一轮生成作废，忽略过期回调
        if (!evt.data) return;
        const o = safeJsonParse(evt.data);
        if (!o) return;
        const t = String(o.type || '');
        if (t === 'imageDone') {
          const itemIndex = Number(o.itemIndex ?? -1);
          const tgt = targets[itemIndex];
          if (!tgt || !owns(tgt.sceneIndex)) return; // 该镜已被后发重绘顶替，忽略本批回填
          const b64 = (o.base64 as string | null | undefined) ?? null;
          const url = (o.url as string | null | undefined) ?? null;
          const originalUrl = (o.originalUrl as string | null | undefined) ?? null;
          const src = url || (b64 ? (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`) : null);
          // 图生视频首帧需要公开 HTTPS 链接（base64 不可用）：优先原图 COS URL
          const publicUrl = /^https?:/.test(String(originalUrl)) ? originalUrl : /^https?:/.test(String(url)) ? url : null;
          setScenes((prev) =>
            prev.map((s) => (s.index === tgt.sceneIndex ? { ...s, kfStatus: 'done', kfUrl: src, kfPublicUrl: publicUrl, kfAspect: myAspect, kfDirty: false } : s)),
          );
        } else if (t === 'imageError') {
          const itemIndex = Number(o.itemIndex ?? -1);
          const tgt = targets[itemIndex];
          if (!tgt || !owns(tgt.sceneIndex)) return; // 该镜已被后发重绘顶替，忽略本批错误
          const msg = String((o.errorMessage as string | undefined) ?? '关键帧生成失败');
          setScenes((prev) => prev.map((s) => (s.index === tgt.sceneIndex ? { ...s, kfStatus: 'error', kfError: msg } : s)));
        }
      },
    });

    // 流结束兜底：仍在 running 的标记为 error。仅处理本次运行仍拥有的镜头——
    // 被后发重绘顶替的镜头（owns=false）由它自己的运行负责，不在此误判失败。
    if (genRef.current !== myGen) return;
    setScenes((prev) =>
      prev.map((s) =>
        targets.some((t) => t.sceneIndex === s.index) && s.kfStatus === 'running' && owns(s.index)
          ? { ...s, kfStatus: 'error', kfError: '生成超时或连接中断，请重试' }
          : s,
      ),
    );
  };

  const handleGenerate = async () => {
    const b = brief.trim();
    if (!b) {
      toast.warning('请先填写想法或粘贴一段文章');
      return;
    }
    if (!activeModel) {
      toast.warning('暂无可用生图模型，请先在「模型池管理」配置生图模型池');
      return;
    }
    if (busy) return;

    // 新一轮：作废上一轮所有在途 SSE / 视频轮询，旧回调（含上一板的关键帧/动起来）一律失效
    controllersRef.current.forEach((c) => c.abort());
    controllersRef.current = [];
    genRef.current += 1;
    const myGen = genRef.current; // 捕获本轮，拆分镜返回后据此判断是否已被卸载/新一轮作废

    setPhase('scripting');
    setScenes([]);
    setTitle('');

    const res = await scriptStoryboard({ brief: b, style: style.trim() || undefined });
    if (genRef.current !== myGen) return; // 已被卸载/新一轮作废，丢弃过期脚本响应
    if (!res.success || !res.data) {
      setPhase('idle');
      toast.error(res.error?.message || '分镜生成失败，请重试');
      return;
    }

    setTitle(res.data.title || '未命名分镜');
    const vms: SceneVM[] = res.data.scenes.map((s) => ({
      index: s.index,
      topic: s.topic,
      keyframePrompt: s.keyframePrompt,
      motionPrompt: s.motionPrompt,
      duration: s.duration,
      kfStatus: 'idle',
    }));
    setScenes(vms);
    setPhase('rendering');

    await renderKeyframes(vms.map((s) => ({ sceneIndex: s.index, prompt: s.keyframePrompt })));
    if (genRef.current === myGen) setPhase('idle');
  };

  const regenerateScene = async (sceneIndex: number) => {
    const s = scenes.find((x) => x.index === sceneIndex);
    if (!s || !activeModel) return;
    // 该镜正在转视频时不允许重绘：单镜重绘不会 bump genRef，旧 animateScene 轮询会用上一帧的成片
    // 覆盖刚重绘的新关键帧（Codex review）。等视频结束（done/error）后再重绘。
    if (s.vidStatus === 'running') return;
    await renderKeyframes([{ sceneIndex, prompt: s.keyframePrompt }]);
  };

  /** 让关键帧动起来：图生视频（首帧 = 已确认的关键帧，复用视频智能体直出链路 + Wan 2.6） */
  const animateScene = async (sceneIndex: number) => {
    const s = scenes.find((x) => x.index === sceneIndex);
    if (!s || s.kfStatus !== 'done') return;
    if (s.kfDirty) {
      toast.warning('关键帧提示词已修改，请先「重绘」这一镜，再转视频（否则会用旧帧配新词）');
      return;
    }
    if (s.vidStatus === 'running') return; // 同镜正在转视频，避免重复触发
    const myGen = genRef.current; // 本轮代次：既作为轮询作废依据，也作为「动起来」锁的所有权标识
    // 同步去重：仅当「同一代次」的同镜已在提交/轮询时拦住连点。旧代次（重新生成分镜前）残留的锁不算占用——
    // 否则新板「动起来」会撞上旧板未结束的 11 分钟轮询所占的 sceneIndex，静默无响应（Bugbot review）。
    if (animatingRef.current.get(sceneIndex) === myGen) return;
    if (!s.kfPublicUrl) {
      toast.warning('该关键帧暂无公开链接，无法转视频，请先重绘这一镜');
      return;
    }
    animatingRef.current.set(sceneIndex, myGen); // 本代次取得该镜锁；旧代次残留值被顶替，新板可立即动起来
    try {
      setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidStatus: 'running', vidError: null, vidPhase: '提交中' } : x)));

      // Wan 2.6 仅支持 5/10s：分镜时长就近取 5
      const duration = (s.duration || 5) >= 8 ? 10 : 5;
      const directPrompt = `${s.keyframePrompt}. Camera & motion: ${s.motionPrompt || 'subtle natural motion, cinematic'}`;

      const created = await createVisualVideoRunReal({
        mode: 'direct',
        directPrompt,
        directFirstFrameUrl: s.kfPublicUrl,
        directAspectRatio: s.kfAspect ?? aspect, // 沿用关键帧出图时的画幅，避免用户改画幅后首帧比例错配
        directResolution: '720p',
        directDuration: duration,
        articleTitle: `分镜 ${sceneIndex + 1}：${s.topic}`,
      });
      if (genRef.current !== myGen) {
        // 提交期间被新一轮生成/卸载作废：run 已在后端创建但结果已无法回到 UI，
        // 取消它避免 worker 继续烧视频额度（用户主动替换工作，非被动断开，不违反 server-authority）。
        if (created.success && created.data?.runId) {
          void cancelVisualVideoRunReal(created.data.runId).catch(() => {});
        }
        return;
      }
      if (!created.success || !created.data?.runId) {
        setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidStatus: 'error', vidError: created.error?.message || '提交失败' } : x)));
        return;
      }
      const runId = created.data.runId;

      // 轮询期间任一 stale 退出都必须取消后端 run，否则新板/卸载后 worker 仍在烧视频额度（Bugbot review）。
      const bailIfStale = () => {
        if (genRef.current !== myGen) {
          void cancelVisualVideoRunReal(runId).catch(() => {});
          return true;
        }
        return false;
      };

      // 轮询直出结果（服务器权威：后台 worker 提交 → 轮询 OpenRouter → 下载 COS）。
      // 客户端窗口须 >= 后端 worker 的 10 分钟终态期，否则 6-10 分钟才完成的视频会被误判「生成超时」。
      const deadline = Date.now() + 11 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        if (bailIfStale()) return; // 已被新一轮生成/卸载作废，停止轮询并取消后端 run
        const res = await getVisualVideoRunReal(runId);
        if (bailIfStale()) return; // fetch 期间被作废，丢弃结果并取消后端 run
        if (!res.success || !res.data) continue;
        const run = res.data;
        const st = String(run.status || '');
        if (st === 'Completed' && run.videoAssetUrl) {
          setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidStatus: 'done', vidUrl: run.videoAssetUrl, vidPhase: null } : x)));
          return;
        }
        if (st === 'Failed' || st === 'Cancelled') {
          setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidStatus: 'error', vidError: run.errorMessage || '视频生成失败' } : x)));
          return;
        }
        // 进度文案（拉取 → 生成 → 下载）
        const phaseLabel = run.currentPhase === 'downloading' ? '下载中' : run.currentPhase === 'videogen-polling' ? '生成中' : '生成中';
        setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidPhase: phaseLabel } : x)));
      }
      if (bailIfStale()) return; // 超时落地前若已被新一轮作废，取消后端 run 不回填旧板
      setScenes((prev) => prev.map((x) => (x.index === sceneIndex ? { ...x, vidStatus: 'error', vidError: '生成超时，请重试' } : x)));
    } finally {
      // 仅本代次所有者才释放：避免旧板轮询退出时清掉新板（已重新生成分镜）刚取得的同镜锁
      if (animatingRef.current.get(sceneIndex) === myGen) animatingRef.current.delete(sceneIndex);
    }
  };

  const fillExample = () => {
    setBrief(EXAMPLE_BRIEF);
    setStyle('温暖治愈的电影感，柔和自然光，浅景深，胶片颗粒');
  };

  const doneCount = scenes.filter((s) => s.kfStatus === 'done').length;
  const totalDuration = scenes.reduce((acc, s) => acc + (s.duration || 0), 0);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <PageHeader
        title="视觉分镜台"
        description="一句话或一篇文章，先长成一组电影分镜的关键帧画面，逐镜精修后即可让它动起来"
      />

      {/* 输入区：零摩擦 */}
      <GlassCard animated glow>
        <div className="flex items-center gap-2 mb-3">
          <Clapperboard size={16} style={{ color: 'var(--text-secondary)' }} />
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            创作意图
          </div>
          <button
            type="button"
            onClick={fillExample}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1 text-xs rounded-full px-2.5 h-6 transition-colors"
            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <Sparkles size={12} />
            试试示例
          </button>
        </div>

        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          disabled={busy}
          className="w-full min-h-[96px] rounded-[16px] px-4 py-3 text-sm outline-none resize-y"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          placeholder="描述你想要的视频画面，或直接粘贴一篇文章 / PRD —— AI 会把它拆成一组镜头"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            disabled={busy}
            className="flex-1 min-w-[200px] rounded-[14px] px-3 h-10 text-sm outline-none"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            placeholder="统一视觉风格（可选，留空让 AI 自定，如：赛博朋克霓虹 / 水彩绘本 / 纪录片写实）"
          />
          <div className="flex items-center gap-1 p-1 rounded-[12px]" style={{ border: '1px solid var(--border-subtle)' }}>
            {ASPECTS.map((a) => {
              const active = a.key === aspect;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setAspect(a.key)}
                  disabled={busy}
                  className="px-2.5 h-8 rounded-[9px] text-xs font-semibold transition-all"
                  style={{
                    background: active ? 'var(--gold-gradient, rgba(99,102,241,0.85))' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
          <Button variant="primary" onClick={handleGenerate} disabled={busy || !brief.trim() || !activeModel}>
            {phase === 'scripting' ? <MapSpinner size={16} /> : <Wand2 size={16} />}
            {phase === 'scripting' ? '正在拆分镜…' : phase === 'rendering' ? '生成关键帧中…' : '生成分镜'}
          </Button>
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {modelsLoading ? (
            '加载生图模型中…'
          ) : modelOptions.length === 0 ? (
            '暂无生图模型池 —— 请先在「模型池管理」创建一个「视频生成 / 文生图」模型池'
          ) : (
            <>
              <span className="shrink-0">关键帧模型</span>
              {modelOptions.length > 1 ? (
                <select
                  value={selectedModelKey ?? modelOptions[0]?.key ?? ''}
                  onChange={(e) => setSelectedModelKey(e.target.value)}
                  disabled={busy}
                  className="h-7 rounded-md px-2 text-xs"
                  style={{
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border, rgba(255,255,255,0.14))',
                  }}
                >
                  {modelOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.poolName}（{o.modelName}）
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>：{activeModel?.name || activeModel?.modelName}</span>
              )}
            </>
          )}
        </div>
      </GlassCard>

      {/* 分镜台 */}
      <GlassCard animated glow className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className="flex items-center gap-2 shrink-0">
            <Film size={16} style={{ color: 'var(--text-secondary)' }} />
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {title || '分镜画面'}
            </div>
            {scenes.length > 0 ? (
              <div className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
                {doneCount}/{scenes.length} 关键帧 · 约 {totalDuration}s
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
            {scenes.length === 0 && phase === 'idle' ? (
              <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center gap-3">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-subtle)' }}
                >
                  <Clapperboard size={26} style={{ color: 'var(--text-secondary)' }} />
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  还没有分镜
                </div>
                <div className="text-xs max-w-[360px]" style={{ color: 'var(--text-muted)' }}>
                  在上方写下想法或粘贴一篇文章，点「生成分镜」。AI 会把它拆成一组镜头，每个镜头先长出一张关键帧画面。
                </div>
              </div>
            ) : (
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
              >
                {(phase === 'scripting'
                  ? (Array.from({ length: 4 }).map((_, i) => ({
                      index: -1 - i,
                      topic: '',
                      keyframePrompt: '',
                      motionPrompt: '',
                      duration: 0,
                      kfStatus: 'running' as const,
                      skeleton: true,
                    })) as Array<SceneVM & { skeleton?: boolean }>)
                  : (scenes as Array<SceneVM & { skeleton?: boolean }>)
                ).map((s, i) => {
                  const skeleton = s.skeleton;
                  return (
                    <div
                      key={skeleton ? `sk-${i}` : `sc-${s.index}`}
                      className="rounded-[18px] overflow-hidden flex flex-col transition-all duration-300"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      {/* 画面区 */}
                      <div
                        className="relative w-full"
                        style={{
                          // 用该镜出图时的画幅渲染卡片，避免改全局画幅后旧镜被错误取景
                          aspectRatio: (ASPECTS.find((a) => a.key === (s.kfAspect ?? aspect))?.ratio ?? aspectInfo.ratio),
                          background: 'rgba(0,0,0,0.22)',
                        }}
                      >
                        {!skeleton && s.vidUrl && s.vidStatus !== 'running' && s.vidStatus !== 'error' ? (
                          <>
                            <video
                              src={s.vidUrl}
                              className="w-full h-full block"
                              style={{ objectFit: 'cover', background: '#000' }}
                              controls
                              loop
                              muted
                              autoPlay
                              playsInline
                            />
                            <div
                              className="absolute left-2 top-2 inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 h-6"
                              style={{ background: 'rgba(99,102,241,0.85)', color: '#fff' }}
                            >
                              <Film size={11} /> 视频
                            </div>
                          </>
                        ) : !skeleton && s.kfStatus === 'done' && s.kfUrl ? (
                          <>
                            <img
                              src={s.kfUrl}
                              alt={s.topic}
                              className="w-full h-full block"
                              style={{ objectFit: 'cover' }}
                            />
                            <button
                              type="button"
                              onClick={() => setPreview({ open: true, src: s.kfUrl!, topic: s.topic })}
                              className="absolute left-2 bottom-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center"
                              style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff' }}
                              title="放大预览"
                              aria-label="放大预览"
                            >
                              <Maximize2 size={14} />
                            </button>
                            {s.vidStatus === 'running' ? (
                              <div
                                className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                                style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
                              >
                                <MapSpinner size={20} />
                                <span className="text-xs font-semibold" style={{ color: '#fff' }}>
                                  让画面动起来 · {s.vidPhase || '生成中'}…
                                </span>
                                <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.7)' }}>
                                  Wan 2.6 图生视频，约 1-3 分钟
                                </span>
                              </div>
                            ) : null}
                            {s.vidStatus === 'error' ? (
                              <div
                                className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] text-center"
                                style={{ background: 'rgba(127,29,29,0.85)', color: '#fff' }}
                              >
                                {s.vidError || '视频生成失败'}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                            {(!skeleton && s.kfStatus === 'error') ? (
                              <>
                                <span className="text-xs px-3 text-center" style={{ color: 'rgba(239,68,68,0.95)' }}>
                                  {s.kfError || '生成失败'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => regenerateScene(s.index)}
                                  className="inline-flex items-center gap-1 text-xs rounded-full px-2.5 h-6"
                                  style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                                >
                                  <RefreshCw size={12} /> 重试
                                </button>
                              </>
                            ) : (
                              <>
                                <div
                                  className="w-full h-full absolute inset-0"
                                  style={{
                                    background:
                                      'linear-gradient(100deg, rgba(255,255,255,0.02) 30%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.02) 70%)',
                                    backgroundSize: '200% 100%',
                                    animation: 'shimmer 1.4s linear infinite',
                                  }}
                                />
                                <div className="relative flex items-center gap-2">
                                  <MapSpinner size={16} />
                                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                    {skeleton ? '正在拆分镜…' : '正在绘制画面…'}
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {/* 序号 + 时长角标 */}
                        {!skeleton ? (
                          <div
                            className="absolute right-2 top-2 inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 h-6"
                            style={{ background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.14)' }}
                          >
                            #{i + 1} · {s.duration}s
                          </div>
                        ) : null}
                      </div>

                      {/* 信息区 */}
                      <div className="p-3 flex flex-col gap-2 flex-1 min-h-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {skeleton ? ' ' : s.topic}
                        </div>

                        {!skeleton ? (
                          s.editing ? (
                            <textarea
                              value={s.keyframePrompt}
                              onChange={(e) =>
                                setScenes((prev) =>
                                  prev.map((x) =>
                                    x.index === s.index
                                      ? {
                                          ...x,
                                          keyframePrompt: e.target.value,
                                          // 已出图/出图中时改词 → 标记 dirty，转视频前强制重绘，避免旧帧配新词
                                          kfDirty: x.kfStatus === 'done' || x.kfStatus === 'running' ? true : x.kfDirty,
                                        }
                                      : x,
                                  ),
                                )
                              }
                              className="w-full min-h-[64px] rounded-[10px] px-2 py-1.5 text-xs outline-none resize-y"
                              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                            />
                          ) : (
                            <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }} title={s.keyframePrompt}>
                              {s.keyframePrompt}
                            </div>
                          )
                        ) : (
                          <div className="h-8 rounded-[8px]" style={{ background: 'rgba(255,255,255,0.03)' }} />
                        )}

                        {!skeleton ? (
                          <div className="mt-auto flex items-center gap-1.5 pt-1">
                            <button
                              type="button"
                              onClick={() =>
                                setScenes((prev) => prev.map((x) => (x.index === s.index ? { ...x, editing: !x.editing } : x)))
                              }
                              className="inline-flex items-center gap-1 text-[11px] rounded-[9px] px-2 h-7"
                              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                              {s.editing ? '收起' : '改提示词'}
                            </button>
                            <button
                              type="button"
                              onClick={() => regenerateScene(s.index)}
                              disabled={s.kfStatus === 'running' || s.vidStatus === 'running'}
                              className="inline-flex items-center gap-1 text-[11px] rounded-[9px] px-2 h-7 disabled:opacity-50"
                              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                              <RefreshCw size={11} /> 重绘
                            </button>
                            <button
                              type="button"
                              onClick={() => animateScene(s.index)}
                              disabled={s.kfStatus !== 'done' || s.vidStatus === 'running'}
                              title="图生视频：以这张关键帧为首帧，让画面动起来（Wan 2.6）"
                              className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold rounded-[9px] px-2 h-7 disabled:opacity-50 transition-all"
                              style={{
                                border: '1px solid rgba(99,102,241,0.4)',
                                color: s.vidStatus === 'done' ? 'var(--text-secondary)' : '#c7d2fe',
                                background: s.vidStatus === 'done' ? 'transparent' : 'rgba(99,102,241,0.12)',
                              }}
                            >
                              {s.vidStatus === 'running' ? <MapSpinner size={11} /> : <Play size={11} />}
                              {s.vidStatus === 'done' ? '重生成' : s.vidStatus === 'running' ? '生成中' : '动起来'}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </GlassCard>

      {preview.open ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setPreview((p) => ({ ...p, open: false }))}
        >
          <button
            type="button"
            onClick={() => setPreview((p) => ({ ...p, open: false }))}
            className="absolute right-5 top-5 h-9 w-9 rounded-full inline-flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)' }}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
          <img
            src={preview.src}
            alt={preview.topic}
            className="block max-w-full max-h-full rounded-[12px]"
            style={{ objectFit: 'contain' }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
