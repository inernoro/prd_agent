/*
 * 演练视图 —— 只读地把面板推到它「本该变红」的那几档。
 *
 * 这个文件存在的理由是一个如实记下的取证缺口（doc/plan.platform.business-monitoring.md）：
 * 面板最要紧的两档——**探测器停摆**与**单条逾期未检查**——在健康系统上**演示不出来**。
 * 不是没做，是做对了反而看不见：探测循环 60 秒一轮、每条间隔下限 20 秒，于是任何一条的
 * 年龄上限约等于「间隔 + 60 秒」，永远够不到「3 个间隔」那条线。这两档只在探针真的
 * 不干活时才亮，而那时没人会有闲心截图。
 *
 * 于是它们此前只有单测，没有线上观测。一条**不会红的证据比没有证据更糟**
 * （predicate-and-wiring-discipline 形状 4b）——「我写了单测」和「我看见它红过」
 * 之间差着的正是这条链要治的那种自欺。
 *
 * 这里的做法刻意只有一句话：**判据一个字都不动，只换喂给它的输入。**
 *   演练 = (真实 targets, 真实 ctx) --纯函数--> (被扰动的 targets, 被扰动的 ctx)
 *   然后照样喂给 buildOwnerBoard / buildGlobalBoard。
 *
 * 这一点是它作为取证手段成立的**全部**理由。如果演练自己算一套结论，它证明的就只是
 * 「演练代码会说这句话」，跟真实判据对不对没有半点关系——那是形状 3（判据分裂成两份
 * 各自漂移）最经典的长相，而且伪装成一个测试工具，比普通的分裂更难被发现。
 *
 * 三条硬约束：
 *   1. **纯函数，零副作用**：不发请求、不写库、不触发通知。守卫 rehearsal-readonly.test.ts
 *      扫这个文件里不许出现 fetch / apiRequest。
 *   2. **有限枚举，不是自由旋钮**：五档写死，对应 headline 的五级优先级阶梯。给一个
 *      「把时间往前拨 N 分钟」的滑块看着更灵活，实际会把取证变成手艺活——而且拨过头
 *      先触发停摆（它盖过一切），单条逾期那一档永远轮不到，滑块反而演示不出它要演示的东西。
 *   3. **自报家门**：每一档都说清自己动了什么。演练截图混进真实证据堆是这个功能唯一的
 *      危险，所以造出来的值必须自己带标签，UI 也必须整屏挂牌（closed-loop-acceptance：
 *      截图 caption 与截图内容不符就是造假）。
 */
import type { ObserveMode, UptimeSample, UptimeTargetSummary } from './monitorCenter';
import { OVERDUE_INTERVALS, isBusinessTarget, type OwnerBoardContext } from './ownerBoard';

export type RehearsalId = 'live' | 'prober-stalled' | 'down' | 'overdue' | 'stale';

/** 演练造数据时给的固定说辞。出现在卡片理由里，让单张卡截出来也认得出是假的。 */
export const REHEARSAL_MARK = '演练数据';

/** 停摆演练把「上一轮探测」拨到多久以前。取 11 分钟：远超任何合理的轮次间隔。 */
const STALLED_AGO_MS = 11 * 60 * 1000;
/** 演练里认为「探针刚跑过」的年龄。 */
const FRESH_AGO_MS = 15 * 1000;
/** 没有间隔可依据时的兜底间隔（秒）。只用于造演练数据，不参与真实判定。 */
const FALLBACK_INTERVAL_SECONDS = 300;

export interface RehearsalInput {
  targets: ReadonlyArray<UptimeTargetSummary>;
  ctx: OwnerBoardContext;
}

export interface RehearsalStage extends RehearsalInput {
  /** 这一档到底动了哪个值（人话）。`live` 没有。 */
  changed?: string;
  /**
   * 这一档在当前视角下演不了，以及为什么。
   *
   * 「演不了」必须显式说出来，不许静默退回真实数据——那会让人对着一屏真实的绿灯
   * 以为自己看的是演练结果，恰好是这个工具最不该造成的误会。
   */
  blocked?: string;
}

export interface RehearsalScenario {
  id: RehearsalId;
  /** 按钮上的短标签 */
  label: string;
  /** 这一档要证明面板会说什么——按钮的 title，也是截图的 caption 该写的那句 */
  proves: string;
  apply(input: RehearsalInput): RehearsalStage;
}

/**
 * 挑一条来扰动。
 *
 * 按名字 + 环境排序取第一条：同一批数据每次演练动的都是同一条，
 * 截图之间可比。随机挑会让「上次那张图和这次这张图哪里不一样」变成一个谜。
 */
function pickBusiness(targets: ReadonlyArray<UptimeTargetSummary>): UptimeTargetSummary | undefined {
  return [...targets]
    .filter(isBusinessTarget)
    .sort((a, b) => a.name.localeCompare(b.name) || a.environment.localeCompare(b.environment))[0];
}

function replace(
  targets: ReadonlyArray<UptimeTargetSummary>,
  id: string,
  patch: Partial<UptimeTargetSummary>,
): UptimeTargetSummary[] {
  return targets.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

function sampleAt(target: UptimeTargetSummary, t: number, extra?: Partial<UptimeSample>): UptimeSample {
  return { t, up: true, ms: target.lastSample?.ms ?? 0, ...extra };
}

/** 探针健康的 ctx：演练单条异常时必须把探测器按成健康的，否则停摆那一档会盖住它。 */
function healthyProber(ctx: OwnerBoardContext): OwnerBoardContext {
  return { now: ctx.now, prober: { stalled: false, lastCycleAt: ctx.now - FRESH_AGO_MS } };
}

const NO_BUSINESS = '这个视角里还没有业务监控，没有可以推到异常的对象 —— 先加一条，或换个项目';

export const REHEARSALS: ReadonlyArray<RehearsalScenario> = [
  {
    id: 'live',
    label: '真实',
    proves: '当前真实数据，没有任何扰动',
    apply: (input) => ({ ...input }),
  },
  {
    // 顺序就是 headline 的优先级阶梯：停摆 > 故障 > 逾期 > 零样本 > 全部正常。
    // 逐档点一遍，等于把这条判据链从头到尾看了一遍。
    id: 'prober-stalled',
    label: '探测器停摆',
    proves: '探测器不跑了，下面所有绿灯都不作数 —— 这一档必须盖过其余全部结论',
    apply: (input) => {
      if (!pickBusiness(input.targets)) return { ...input, blocked: NO_BUSINESS };
      return {
        targets: input.targets,
        ctx: { now: input.ctx.now, prober: { stalled: true, lastCycleAt: input.ctx.now - STALLED_AGO_MS } },
        changed: `把「探测器上一轮」拨到 11 分钟前（真实值原样保留在下方那句「真实结论」里）`,
      };
    },
  },
  {
    id: 'down',
    label: '有故障',
    proves: '一条业务判据没过，它该置顶，并且说清是哪个环境、什么值不对',
    apply: (input) => {
      const target = pickBusiness(input.targets);
      if (!target) return { ...input, blocked: NO_BUSINESS };
      return {
        targets: replace(input.targets, target.id, {
          status: 'down',
          measured: true,
          lastSample: sampleAt(target, input.ctx.now - FRESH_AGO_MS, {
            up: false,
            code: 500,
            err: `${REHEARSAL_MARK}：判据未通过（HTTP 500）`,
          }),
        }),
        ctx: healthyProber(input.ctx),
        changed: `把「${target.name}」（${target.environmentLabel}）按成故障`,
      };
    },
  },
  {
    id: 'overdue',
    label: '逾期未检查',
    proves: '探针早该跑却没跑 —— 它上一次是绿的，但那是旧闻，绿灯不作数',
    apply: (input) => {
      const target = pickBusiness(input.targets);
      if (!target) return { ...input, blocked: NO_BUSINESS };
      const interval = target.intervalSeconds > 0 ? target.intervalSeconds : FALLBACK_INTERVAL_SECONDS;
      // 拨过线半个间隔就够：刚好压线的数据会让「判据边界是不是对的」变成一道算术题。
      const age = interval * (OVERDUE_INTERVALS + 0.5) * 1000;
      return {
        targets: replace(input.targets, target.id, {
          intervalSeconds: interval,
          status: 'up',
          measured: true,
          lastSample: sampleAt(target, input.ctx.now - age),
        }),
        ctx: healthyProber(input.ctx),
        changed: `把「${target.name}」（${target.environmentLabel}）的上次检查拨到 ${Math.round(age / 60000)} 分钟前，探测器按健康算`,
      };
    },
  },
  {
    id: 'stale',
    label: '零样本',
    proves: '被动监控判据过了，但窗口里一次真实调用都没有 —— 那不是正常，是没人用过',
    apply: (input) => {
      const target = pickBusiness(input.targets);
      if (!target) return { ...input, blocked: NO_BUSINESS };
      return {
        targets: replace(input.targets, target.id, {
          observeMode: 'passive' as ObserveMode,
          sampleCount: 0,
          status: 'up',
          measured: true,
          lastSample: sampleAt(target, input.ctx.now - FRESH_AGO_MS),
        }),
        ctx: healthyProber(input.ctx),
        changed: `把「${target.name}」（${target.environmentLabel}）按成被动监控、窗口内 0 次调用`,
      };
    },
  },
];

export function rehearsalById(id: RehearsalId): RehearsalScenario {
  // 找不到就退回 live 而不是抛错：一个坏掉的 URL 参数不该让整屏白掉。
  return REHEARSALS.find((r) => r.id === id) ?? REHEARSALS[0];
}

export function applyRehearsal(id: RehearsalId, input: RehearsalInput): RehearsalStage {
  return rehearsalById(id).apply(input);
}
