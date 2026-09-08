/**
 * 总览这一屏「该说什么」的唯一判定处。
 *
 * 为什么要有这个模块（台账 D11）：判断句、色调、入口卡标签、骨架屏注解四处文案，
 * 原先各自写成一串三元表达式，各看各的变量。同一片区域连续六轮 review 都在报
 * 「同屏两句话互相矛盾」——每次修都是给某一处再加一个条件，而条件树越深，下一处
 * 分岔就越难看见。第六轮时判断句已经是五层嵌套三元、内含一层三元。
 *
 * 换的写法：先把事实归约成**一个有限状态**，再由状态查表得到四处文案。新增一档
 * 只动表、不动条件树；每一档都能被单测穷举。依据是同一个 PR 里另一次成功的改造
 * ——轮询的并发取舍抽成独立模块并配真并发测试之后，那条线再没出过新发现。
 */

/** 分支生命周期里「正在往目标态走」的三档。其余档位都是静止态。 */
const TRANSITIONING = new Set(['building', 'starting', 'restarting']);

export type OverviewState =
  /** 有服务处于 error。优先级最高——它盖过其它一切描述。 */
  | 'broken'
  /**
   * 分支级失败，且服务集还没建立起来。
   *
   * 只在**一个服务都没有**时才有这一档：有服务时它们各自的状态更具体，分支上那个
   * error 标记反而是旧消息。webhook 派发失败会把刚建出来的空分支置成 error，这一档
   * 就是为它准备的——否则会在失败横幅底下写「尚未配置服务 · 先去构建配置」，而没
   * 配置根本不是原因（Codex P2，核对属实）。
   */
  | 'failed'
  /** 正在开通：分支在途，但服务集还没分配出来（执行器建分支时就是这一档）。 */
  | 'provisioning'
  /** 静止态但一个服务都没配。 */
  | 'unconfigured'
  /** 在途，且服务已全就绪——重新部署时旧容器还在服务，属于这一档。 */
  | 'redeploying'
  /** 在途，且还有服务没起来。 */
  | 'deploying'
  /** 在跑且全就绪。 */
  | 'healthy'
  /** 在跑但还有服务没起来。 */
  | 'partial'
  /** 没在跑、也不在途。 */
  | 'stopped';

export interface OverviewFacts {
  /**
   * 分支原始生命周期状态（`idle` / `building` / `starting` / `running` /
   * `restarting` / `stopping` / `stopped` / `error`）。缺省视为不在途——老调用方
   * 行为不变。
   */
  lifecycle?: string;
  /** SSE 给的权威运行态。 */
  running: boolean;
  serviceCount: number;
  readyCount: number;
  badCount: number;
  /** 配了几个入口。只影响 broken 那句的后半段。 */
  entryCount: number;
  /** 实时快照回来没有。只影响骨架屏注解。 */
  metricsReady: boolean;
}

export interface OverviewCopy {
  state: OverviewState;
  /** 顶部判断句。 */
  verdict: string;
  /** 判断句左侧圆点与语气。 */
  tone: 'ok' | 'bad' | 'idle';
  /** 入口卡副标题。 */
  entryLabel: string;
  /**
   * 「为什么现在没有曲线」这一句。有服务时渲染在骨架屏里，一个服务都没有时渲染在
   * 那块虚线空态里——两处互斥，同一个字段。
   * `undefined` 表示交回骨架屏自己讲「已攒 N 帧 · 约还需 X 秒」——有容器在跑时
   * 那才是真相，不该被生命周期盖掉。
   */
  skeletonNote?: string;
}

export function isTransitioning(lifecycle?: string): boolean {
  return lifecycle !== undefined && TRANSITIONING.has(lifecycle);
}

/** 事实 → 状态。顺序即优先级，读下来就是判定树。 */
export function deriveOverviewState(f: OverviewFacts): OverviewState {
  const moving = isTransitioning(f.lifecycle);
  if (f.badCount > 0) return 'broken';
  if (f.serviceCount === 0) {
    // 有服务时不看这个标记：那时每个服务自己的状态更具体，也更新。
    if (f.lifecycle === 'error') return 'failed';
    return moving ? 'provisioning' : 'unconfigured';
  }
  if (moving) return f.readyCount === f.serviceCount ? 'redeploying' : 'deploying';
  if (f.running) return f.readyCount === f.serviceCount ? 'healthy' : 'partial';
  return 'stopped';
}

const ENTRY_READY = ' · 服务已就绪';
const ENTRY_DEPLOYING = ' · 正在部署，入口可能短暂不可达';
const ENTRY_NOT_READY = ' · 服务未就绪，暂不可达';

/**
 * 状态 → 四处文案。
 *
 * 骨架屏注解只在**一个容器都没起来**时才由状态决定；只要有容器在跑，采样就真的在
 * 进行，注解交回骨架屏（或在实时快照没回来时说一句「正在读取指标…」）。
 */
export function overviewCopy(f: OverviewFacts): OverviewCopy {
  const state = deriveOverviewState(f);
  const missing = f.serviceCount - f.readyCount;
  const sampling = f.readyCount > 0;
  const pendingNote = sampling ? (f.metricsReady ? undefined : '正在读取指标…') : undefined;

  switch (state) {
    case 'broken':
      return {
        state,
        verdict: `有 ${f.badCount} 个服务异常，${f.entryCount > 0 ? '入口可能打不开' : '分支未就绪'}`,
        tone: 'bad',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: sampling ? pendingNote : '服务异常 · 没有容器可采样',
      };
    case 'failed':
      return {
        state,
        verdict: '上次部署失败，服务还没建立起来',
        tone: 'bad',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: '上次部署失败，服务集还没建立起来。修好后重新部署。',
      };
    case 'provisioning':
      return {
        state,
        verdict: '正在开通，服务还没分配',
        tone: 'idle',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: '分支正在开通，服务集还没分配出来，稍等。',
      };
    case 'unconfigured':
      return {
        state,
        verdict: '尚未配置服务',
        tone: 'idle',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: '该分支还没有任何 service，先去构建配置 / 部署。',
      };
    case 'redeploying':
      return {
        state,
        verdict: '正在部署，当前服务仍在运行',
        tone: 'idle',
        entryLabel: ENTRY_DEPLOYING,
        skeletonNote: pendingNote,
      };
    case 'deploying':
      return {
        state,
        verdict: `正在部署，${missing} 个服务还没起来`,
        tone: 'idle',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: sampling ? pendingNote : '正在部署 · 容器起来后开始采样',
      };
    case 'healthy':
      return {
        state,
        verdict: '一切正常，可以直接验收',
        tone: 'ok',
        entryLabel: ENTRY_READY,
        skeletonNote: pendingNote,
      };
    case 'partial':
      return {
        state,
        verdict: `还有 ${missing} 个服务没起来`,
        tone: 'idle',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: sampling ? pendingNote : '没有容器可采样',
      };
    case 'stopped':
    default:
      return {
        state: 'stopped',
        verdict: '分支未运行',
        tone: 'idle',
        entryLabel: ENTRY_NOT_READY,
        skeletonNote: sampling ? pendingNote : '分支未运行 · 没有容器可采样',
      };
  }
}
