import type { SseEvent } from '@/lib/sse';
import type { DesignArtifactRunSummary, DesignTimingStats } from '@/services/real/webPages';

export type SiteGenerationProgressEvent =
  | { kind: 'phase'; message?: string; progress?: number }
  | { kind: 'model'; model: string; platform: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'delta'; text: string }
  /** OpenDesign 写出或更新页面文件时推一次整页正文；revision 单调递增，旧的丢弃。 */
  | { kind: 'preview'; html: string; revision: number }
  | { kind: 'done'; siteId: string; siteUrl?: string; destinationApplyError?: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' };

export function resolveGeneratedSiteId(run: DesignArtifactRunSummary): string | null {
  return run.artifactSiteId || run.producedArtifactSiteId || null;
}

/** 后端只给了模型名、没给平台名时的兜底称谓。三个消费点共用这一份，别各写各的。 */
export const GATEWAY_PLATFORM_FALLBACK = 'LLM Gateway';

/**
 * 刷新后从 run 读回徽章。流事件只在开头出现一次，错过就只能靠这条恢复，
 * 所以恢复路径必须和流事件用同一套兜底口径。
 */
export function resolveRunModelBadge(
  run: DesignArtifactRunSummary,
): { model: string; platform: string } | null {
  const model = run.resolvedModel?.trim();
  if (!model) return null;
  return { model, platform: run.resolvedPlatform?.trim() || GATEWAY_PLATFORM_FALLBACK };
}

export function parseSiteGenerationProgressEvent(event: SseEvent): SiteGenerationProgressEvent {
  if (!event.data) return { kind: 'unknown' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown' };
  }

  if (event.event === 'phase') {
    return {
      kind: 'phase',
      message: typeof data.message === 'string' ? data.message : undefined,
      progress: typeof data.progress === 'number' ? data.progress : undefined,
    };
  }
  // 实际执行的模型只在流的开头出现一次；面板顶部按「{模型} · {平台}」展示，
  // 值一律来自后端，前端不推断（.claude/rules/ai-model-visibility.md §2）。
  if (event.event === 'model' && typeof data.model === 'string' && data.model.trim()) {
    return {
      kind: 'model',
      model: data.model,
      platform: typeof data.platform === 'string' && data.platform.trim() ? data.platform : GATEWAY_PLATFORM_FALLBACK,
    };
  }
  if (event.event === 'thinking' && typeof data.text === 'string')
    return { kind: 'thinking', text: data.text };
  if (event.event === 'delta' && typeof data.text === 'string')
    return { kind: 'delta', text: data.text };
  if (event.event === 'preview' && typeof data.html === 'string' && data.html.trim()) {
    return {
      kind: 'preview',
      html: data.html,
      revision: typeof data.revision === 'number' && Number.isFinite(data.revision) ? data.revision : 0,
    };
  }
  if (event.event === 'done' && typeof data.siteId === 'string') {
    return {
      kind: 'done',
      siteId: data.siteId,
      siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : undefined,
      // 建站成功、归属失败是一种部分成功：终态事件带着它，调用方据此提示，
      // 不许让它长得跟完全成功一样。
      destinationApplyError: typeof data.destinationApplyError === 'string'
        ? data.destinationApplyError
        : undefined,
    };
  }
  if (event.event === 'cancelled') {
    return {
      kind: 'cancelled',
      message: typeof data.message === 'string' ? data.message : '网页生成已取消',
    };
  }
  if (event.event === 'error') {
    return {
      kind: 'error',
      message: typeof data.message === 'string' ? data.message : '网页生成失败',
    };
  }
  return { kind: 'unknown' };
}

// ─── 生成中的阶段列表 ───

export interface GenerationStage {
  /** 去掉「· 已运行 X」这类随时间变化的尾巴后的阶段名，用来判断是不是同一步。 */
  label: string;
  /** 这一步最近一次的完整说明（含轮次等细节）。 */
  detail: string;
  startedAtMs: number;
  /** 下一步开始的时刻；仍在进行中为 null。 */
  endedAtMs: number | null;
}

/**
 * 服务端的阶段文案会带上随时间变化的尾巴（「OpenDesign 正在设计并写出页面 · 已运行 3 分 05 秒」），
 * 直接拿整句判断「换阶段没有」，每秒都会冒出一行新阶段。这里只取「 · 」之前那一段当阶段名。
 */
export function generationStageLabel(message: string): string {
  const trimmed = message.trim();
  const cut = trimmed.indexOf(' · ');
  return (cut > 0 ? trimmed.slice(0, cut) : trimmed).trim();
}

/** 收到一条 phase 消息后更新阶段列表：同名只刷新说明，换名则结束上一步、开新的一步。 */
export function appendGenerationStage(
  stages: readonly GenerationStage[],
  message: string | undefined,
  nowMs: number,
): GenerationStage[] {
  if (!message || !message.trim()) return [...stages];
  const label = generationStageLabel(message);
  if (!label) return [...stages];
  const last = stages[stages.length - 1];
  if (last && last.label === label) {
    if (last.detail === message.trim()) return [...stages];
    return [...stages.slice(0, -1), { ...last, detail: message.trim() }];
  }
  const closed = last && last.endedAtMs == null
    ? [...stages.slice(0, -1), { ...last, endedAtMs: nowMs }]
    : [...stages];
  return [...closed, { label, detail: message.trim(), startedAtMs: nowMs, endedAtMs: null }];
}

/** 终态时把仍在进行的那一步收口，免得完成页上还挂着一个转圈的阶段。 */
export function closeGenerationStages(stages: readonly GenerationStage[], nowMs: number): GenerationStage[] {
  return stages.map((stage) => (stage.endedAtMs == null ? { ...stage, endedAtMs: nowMs } : stage));
}

/** mm:ss；超过一小时用 h:mm:ss。 */
export function formatGenerationClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 两种执行器的「经验值」耗时。这是产品文案里承诺给用户的量级（快速约 1–2 分钟、精细 9–12 分钟），
 * 不是按历史运行算出来的——只在真实样本不足时兜底，界面上必须写明「经验值、数据还在积累」，
 * 不许冒充实测。有足够样本时一律用后端 /api/design-artifacts/timing-stats 的 P50/P95。
 */
export const TYPICAL_RUNTIME_MINUTES: Record<string, { min: number; max: number }> = {
  'map-gateway': { min: 1, max: 2 },
  'open-design': { min: 9, max: 12 },
};

/** 某执行器网页生成的真实耗时（秒）。只有后端判定 estimateReady 时才会有值。 */
export interface GenerationTiming {
  sampleCount: number;
  p50Seconds: number;
  p95Seconds: number;
}

/**
 * 从耗时统计里挑出这个执行器的网页生成 P50/P95。样本数不够（后端 estimateReady=false）、
 * 缺百分位、或者统计没拿到，一律返回 null，调用方退回经验值——不拿两三个样本冒充规律。
 */
export function pickGenerationTiming(
  stats: DesignTimingStats | null | undefined,
  runtimeId: string | null | undefined,
  artifactType = 'web-page',
): GenerationTiming | null {
  if (!stats || !runtimeId) return null;
  const group = stats.groups.find((item) => item.runtime === runtimeId && item.artifactType === artifactType);
  const metric = group?.generation;
  if (!metric || !metric.estimateReady || metric.p50Seconds == null || metric.p95Seconds == null) return null;
  return { sampleCount: metric.sampleCount, p50Seconds: metric.p50Seconds, p95Seconds: metric.p95Seconds };
}

/** 不足一分钟按秒说，否则四舍五入到分钟。 */
export function formatEtaDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.max(1, Math.round(s))} 秒`;
  return `${Math.round(s / 60)} 分钟`;
}

/** 发送按钮上那几个字：「约 X 分钟」。真实数据优先，没有就用经验值，都没有给空串。 */
export function generationEtaShort(runtimeId: string | null | undefined, timing: GenerationTiming | null): string {
  if (timing) return `约 ${formatEtaDuration(timing.p50Seconds)}`;
  const typical = runtimeId ? TYPICAL_RUNTIME_MINUTES[runtimeId] : undefined;
  return typical ? `约 ${typical.min}–${typical.max} 分钟` : '';
}

/** 发送前那句预期说明，带上数字的来路：最近 N 次的中位数，或明说是经验值。 */
export function generationEtaSentence(runtimeId: string | null | undefined, timing: GenerationTiming | null): string {
  if (timing) {
    return `预计约 ${formatEtaDuration(timing.p50Seconds)}（最近 ${timing.sampleCount} 次中位数，慢的时候约 ${formatEtaDuration(timing.p95Seconds)}）`;
  }
  const typical = runtimeId ? TYPICAL_RUNTIME_MINUTES[runtimeId] : undefined;
  return typical ? `按经验值约 ${typical.min}–${typical.max} 分钟，真实耗时数据还在积累` : '';
}

export function remainingEstimateText(
  runtimeId: string | null | undefined,
  elapsedSeconds: number,
  timing: GenerationTiming | null = null,
): string {
  if (timing) {
    // P50 / P95 是历史总耗时的里程碑，不是剩余时间：还在跑的任务本身就已经比一部分快样本慢，
    // 拿它减去已用时间会低估；P95 也不是上限。所以只摆「已进行多久」与两个里程碑，不承诺还剩多少。
    const n = timing.sampleCount;
    const elapsed = formatEtaDuration(elapsedSeconds);
    const p50 = formatEtaDuration(timing.p50Seconds);
    const p95 = formatEtaDuration(timing.p95Seconds);
    if (elapsedSeconds < timing.p50Seconds) {
      return `已进行 ${elapsed}；最近 ${n} 次里一半在 ${p50}内完成，慢的约 ${p95}`;
    }
    if (elapsedSeconds < timing.p95Seconds) {
      return `已进行 ${elapsed}，超过最近 ${n} 次的中位数（约 ${p50}）；慢的那一档约 ${p95}完成`;
    }
    return `已进行 ${elapsed}，比最近 ${n} 次里 95% 的任务都久（约 ${p95}），任务仍在继续`;
  }
  const typical = runtimeId ? TYPICAL_RUNTIME_MINUTES[runtimeId] : undefined;
  if (!typical) return '正在积累耗时数据，暂不预估剩余时间';
  const elapsedMinutes = elapsedSeconds / 60;
  const low = Math.max(0, Math.ceil(typical.min - elapsedMinutes));
  const high = Math.max(0, Math.ceil(typical.max - elapsedMinutes));
  if (high <= 0) return `已超过经验耗时（${typical.min}–${typical.max} 分钟），任务仍在继续`;
  if (low <= 0) return `按经验值估算（耗时数据还在积累），预计还需不到 ${high} 分钟`;
  return `按经验值估算（耗时数据还在积累），预计还需 ${low}–${high} 分钟`;
}

/** 「风格：编辑风格 · 提示词版本 1a2b3c4d」；两项都没有就不出这句。 */
export function runProvenanceText(run: {
  styleName?: string | null;
  promptFingerprint?: string | null;
} | null | undefined): string {
  if (!run) return '';
  const parts: string[] = [];
  if (run.styleName?.trim()) parts.push(`风格：${run.styleName.trim()}`);
  if (run.promptFingerprint?.trim()) parts.push(`提示词版本 ${run.promptFingerprint.trim().slice(0, 8)}`);
  return parts.join(' · ');
}
