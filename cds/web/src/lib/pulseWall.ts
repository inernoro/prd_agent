/*
 * 脉搏墙与盲区地图的几何判据。
 *
 * 两个都只是「把已有事实换一种摆法」，所以判定全在这里、纯函数、可测；
 * 组件只负责画。理由与 ownerBoard 同一条：判据一旦散进组件，
 * 下一次改配色就会顺手把口径也改了，而那种漂移不会有任何东西变红。
 *
 * ── 脉搏墙 ────────────────────────────────────────────────────
 * 一条业务一行心跳线，线高是那一段的平均响应耗时。它要回答的是「他干活了吗」，
 * 而这件事此前只能靠一行时间戳回答——时间戳要人自己算，心跳线不用：
 * **探针停了，线就断在那里**。
 *
 * 所以这里最要紧的一条判据是：**没有样本的那一段必须断开，不许连过去。**
 * 把空桶画成 0 是最容易犯、也最难被发现的错——0 在这张图上读作「零延迟」，
 * 于是一段没人检查的时间会渲染成一条贴着地板的、看起来很健康的线。
 * 断开是唯一诚实的画法（no-rootless-tree：没有的数据不编）。
 *
 * ── 盲区地图 ──────────────────────────────────────────────────
 * 项目 × 环境。核心判据只有一条：**没有业务监控的格子不许是绿的。**
 * 它不是「好着」，是「不知道」——而把「没人盯」渲染成绿色，等于用一个假绿
 * 把最该管的项目藏起来，正是这条链最开始那个问题（容器全绿不代表业务能用）的放大版。
 */
import type { MonitorEnvironment, UptimeBucket, UptimeTargetSummary } from './monitorCenter';
import { ENVIRONMENT_ORDER, assessCell, assessFreshness, isBusinessTarget, worstHealth, type CellHealth } from './ownerBoard';

// ── 脉搏墙 ──────────────────────────────────────────────────────

export interface PulseGeometry {
  /** viewBox 宽（逻辑单位，SVG 自己缩放到容器） */
  width: number;
  height: number;
  /** 上下留白：线贴边会被容器裁掉半个笔宽 */
  pad: number;
}

export const PULSE_GEOMETRY: PulseGeometry = { width: 560, height: 44, pad: 4 };

export interface Pulse {
  /**
   * 折线分段。**断开处真的断开**，不连线也不补 0。
   * 一段连续的有样本区间是一个 segment；中间只要有一个空桶就分段。
   */
  segments: string[];
  /**
   * 孤立样本：前后都没有相邻样本，连不成线的那些点。
   *
   * 不许因为「连不成线」就丢掉——它们是真实发生过的检查。6 小时探一次的监控
   * 在 24 小时里只有四个样本，全是孤立点；要求两点成段会让这样一整行凭空消失，
   * 看起来像「这条监控不存在」，而它其实一直好好地在跑（2026-09-15 线上实测发现）。
   */
  dots: Array<{ x: number; y: number; down: boolean }>;
  /** 失败桶的位置，单独标点——线还在（它有耗时），但那一段是红的。 */
  downs: Array<{ x: number; y: number }>;
  /** 纵轴上界（ms）。null = 这一行一个耗时样本都没有，画不出线。 */
  peakMs: number | null;
  /** 画出了点的桶数 / 总桶数。差得多说明这条线大半是断的。 */
  filled: number;
  /**
   * 有过采样的桶数（不管测没测到耗时）。
   *
   * 与 filled 分开是因为两种「画不出线」的下一步完全不同：一次采样都没有
   * 是「没人在查它」，有采样却没测到耗时是「查了但这条线画不出来」。
   * 合成一句会把前者说成后者，而前者才是要紧的那个。
   */
  sampled: number;
  total: number;
}

/**
 * 纵轴按**每行自己的峰值**归一，不共用全局刻度。
 *
 * 一条 30ms 的和一条 3 秒的放在同一把尺子上，前者会被压成一条直线——
 * 而这张图看的是「有没有在跳」和「形状变了没有」，不是「谁比谁快」。
 * 绝对数值由卡片上的平均响应负责，不归这条线管。
 */
export function buildPulse(
  buckets: ReadonlyArray<UptimeBucket>,
  geom: PulseGeometry = PULSE_GEOMETRY,
): Pulse {
  const total = buckets.length;
  const sampled = buckets.filter((b) => b.up + b.down > 0).length;
  const measured = buckets.filter((b) => typeof b.avgLatencyMs === 'number' && b.avgLatencyMs !== null);
  const peakMs = measured.length > 0 ? Math.max(...measured.map((b) => b.avgLatencyMs as number)) : null;
  if (total === 0 || peakMs === null) {
    return { segments: [], dots: [], downs: [], peakMs: null, filled: 0, sampled, total };
  }

  const step = total > 1 ? geom.width / (total - 1) : geom.width;
  const floor = geom.height - geom.pad;
  const span = geom.height - geom.pad * 2;
  // 峰值为 0（全是 0ms 的样本）时不许除以 0：那种数据画成一条贴顶线没有意义，压到地板上。
  const scale = peakMs > 0 ? span / peakMs : 0;

  const segments: string[] = [];
  const dots: Array<{ x: number; y: number; down: boolean }> = [];
  const downs: Array<{ x: number; y: number }> = [];
  let run: Array<{ x: number; y: number; down: boolean }> = [];
  let filled = 0;

  // 一段连续样本结束：两个点以上画线，只有一个点就画点。两者都不许丢。
  const flush = (): void => {
    if (run.length > 1) segments.push(run.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' '));
    else if (run.length === 1) dots.push(run[0]);
    run = [];
  };

  buckets.forEach((bucket, i) => {
    const ms = bucket.avgLatencyMs;
    const x = i * step;
    // status === 'none' 与 avgLatencyMs === null 都表示这一段没有样本。
    // 两个条件都判：前者是服务端的结论，后者是它的原料，缺一条就会漏掉半边情况。
    if (bucket.status === 'none' || typeof ms !== 'number') {
      flush();
      return;
    }
    filled += 1;
    const y = floor - ms * scale;
    const down = bucket.down > 0;
    run.push({ x, y, down });
    if (down) downs.push({ x, y });
  });
  flush();

  return { segments, dots, downs, peakMs, filled, sampled, total };
}

/**
 * 「点这么少」到底正不正常，只有跟**它自己的间隔**比才知道。
 *
 * 2026-09-15 线上实测踩到的：MAP 名下多数业务监控 6 小时探一次，24 小时里本来
 * 就只有 4 个样本。第一版拿「填充率 < 25%」判，一律写成「线是断的，大半时间
 * 没人在查它」——对这几条是**纯属冤枉**，它们一次没漏。
 *
 * 这和新鲜度环是同一条道理：绝对数量没有意义，除以它自己的节奏才有。
 * 拿不到间隔就不下这个结论（判不了就不说，别猜）。
 */
export const PULSE_SPARSE_RATIO = 0.6;

/** 按间隔算这条监控在窗口里本该有几次检查。间隔不可用时返回 null。 */
export function expectedSamples(intervalSeconds: number | undefined, windowMs: number, buckets: number): number | null {
  if (!intervalSeconds || intervalSeconds <= 0 || buckets <= 0) return null;
  // 上限是桶数：探得比桶还密时，一个桶里的多次采样只会合成一个点。
  return Math.min(buckets, Math.max(1, Math.round(windowMs / (intervalSeconds * 1000))));
}

/** 这一行有没有任何东西可画。线、孤立点，有一样就算。 */
export function hasPulseInk(pulse: Pulse): boolean {
  return pulse.segments.length > 0 || pulse.dots.length > 0;
}

export function describePulse(pulse: Pulse, expected?: number | null): string {
  if (pulse.total === 0) return '还没有采样';
  // 「一次都没采到」与「采到了但没测出耗时」的下一步完全不同，不许合成一句。
  if (pulse.sampled === 0) return '近 24 小时一次采样都没有 —— 没人在查它';
  if (pulse.peakMs === null) return '有采样但没有测得耗时 —— 这条线画不出来';
  // 只有跟它自己该有的次数比，才判得出「少」。比不了就不判（拿不到间隔时 expected 为空）。
  if (typeof expected === 'number' && expected > 0 && pulse.filled < expected * PULSE_SPARSE_RATIO) {
    return `本该检查 ${expected} 次，只落到 ${pulse.filled} 次 —— 中间漏过`;
  }
  const peak = pulse.peakMs >= 1000 ? `${(pulse.peakMs / 1000).toFixed(1)}s` : `${Math.round(pulse.peakMs)}ms`;
  // 全是孤立点时说清楚：那不是「线断了」，是这条监控本来就隔很久才查一次。
  const shape = pulse.segments.length === 0 && pulse.dots.length > 0
    ? `${pulse.dots.length} 次检查（间隔太长，连不成线）· ` : '';
  return `${shape}峰值 ${peak}${pulse.downs.length > 0 ? ` · ${pulse.downs.length} 段有失败` : ''}`;
}

// ── 盲区地图 ────────────────────────────────────────────────────

/**
 * 一格的三种状态。
 *
 * `blind` 是这张图存在的全部理由，所以它是一个**独立的档**，
 * 不是「没有数据」的一种。渲染上必须和 watched 长得完全不一样（镂空、虚线），
 * 而不是浅一点的绿。
 */
export type BlindCellKind = 'watched' | 'blind' | 'absent';

export interface BlindCell {
  environment: MonitorEnvironment;
  label: string;
  kind: BlindCellKind;
  /** 业务监控条数（watched 才有意义） */
  businessCount: number;
  /** 基础设施目标条数——blind 格子上要说清「它只盯着这些」 */
  infraCount: number;
  /** 最差档（watched 才有） */
  worst?: CellHealth;
}

export interface BlindRow {
  id: string;
  name: string;
  cells: BlindCell[];
  /** 这个项目在任何环境有过业务监控吗 */
  watched: boolean;
  /** 有问题的业务条数（排序用） */
  trouble: number;
}

export interface BlindspotMap {
  /** 列：这一批目标里真实出现过的环境，按固定次序 */
  environments: MonitorEnvironment[];
  environmentLabels: string[];
  rows: BlindRow[];
  /** 一条业务监控都没有的项目数 —— 这张图的头条 */
  blindProjects: number;
  /** 有人盯的项目数 */
  watchedProjects: number;
}

export function buildBlindspotMap(
  targets: ReadonlyArray<UptimeTargetSummary>,
  now: number,
): BlindspotMap {
  const byProject = new Map<string, UptimeTargetSummary[]>();
  for (const t of targets) {
    const list = byProject.get(t.projectId);
    if (list) list.push(t);
    else byProject.set(t.projectId, [t]);
  }

  const present = ENVIRONMENT_ORDER.filter((env) => targets.some((t) => t.environment === env));
  const labelOf = (env: MonitorEnvironment): string =>
    targets.find((t) => t.environment === env)?.environmentLabel ?? env;

  const rows: BlindRow[] = [];
  for (const [id, list] of byProject) {
    const cells: BlindCell[] = present.map((env) => {
      const here = list.filter((t) => t.environment === env);
      const business = here.filter(isBusinessTarget);
      const label = labelOf(env);
      if (business.length > 0) {
        // 取最差走 ownerBoard 的 worstHealth——「谁比谁严重」这张表只许有一份。
        const worst = worstHealth(business.map((t) => assessCell(t, assessFreshness(t, now))));
        return { environment: env, label, kind: 'watched', businessCount: business.length, infraCount: here.length - business.length, worst };
      }
      // 有目标但没有业务监控 = 洞；连目标都没有 = 这个项目没有这个环境。
      // 两者渲染必须分开：前者是「该盯没盯」，后者是「不适用」，混作一谈会把
      // 一张本该刺眼的图稀释成一片灰。
      return {
        environment: env, label,
        kind: here.length > 0 ? 'blind' : 'absent',
        businessCount: 0,
        infraCount: here.length,
      };
    });

    const watched = cells.some((c) => c.kind === 'watched');
    const trouble = cells.filter((c) => c.worst && c.worst !== 'up').length;
    rows.push({ id, name: list[0]?.projectId || id, cells, watched, trouble });
  }

  // 有问题的排最前，然后是没人盯的（它们才是这张图要喊的），最后是好着的。
  rows.sort((a, b) =>
    b.trouble - a.trouble
    || Number(a.watched) - Number(b.watched)
    || a.name.localeCompare(b.name));

  return {
    environments: present,
    environmentLabels: present.map(labelOf),
    rows,
    blindProjects: rows.filter((r) => !r.watched).length,
    watchedProjects: rows.filter((r) => r.watched).length,
  };
}

/** 盲区地图的头条。项目数不是结论，「有几个没人盯」才是。 */
export function describeBlindspots(map: BlindspotMap): string {
  const total = map.rows.length;
  if (total === 0) return '这个实例里还没有任何项目';
  if (map.blindProjects === 0) return `${total} 个项目都有业务监控盯着`;
  return `${total} 个项目里，${map.blindProjects} 个没有一条业务监控`;
}
