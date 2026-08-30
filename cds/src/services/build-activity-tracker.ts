/**
 * 构建活动追踪器（2026-06-23）。
 *
 * 用户痛点：「一个不怎么用的项目在作死地反复构建——分支很少但很频繁」。
 * 光看实时 docker stats 抓不到这种「此刻没在构建、但一小时内构建了 40 次」的
 * 抖动型 CPU 杀手。本追踪器在内存里记录每一次 deploy 的发生时间（按项目），
 * 资源面板据此算出「近 1h / 近 24h 构建次数」，把频繁构建的项目排到前面。
 *
 * 设计取舍：
 *   - 纯内存 ring buffer，进程重启清空。这没关系——风暴是「正在进行时」，
 *     重启后几分钟内就会重新填满；我们要的是实时信号不是历史账本。
 *   - 写入路径（deploy 端点）零额外 I/O，只 push 一个对象 + 偶尔裁剪。
 *   - 读取路径按时间窗聚合，O(n)，n 被 24h 裁剪 + 上限封住。
 */

export interface BuildActivityEvent {
  projectId: string;
  branchId: string;
  at: number;
  trigger: string;
  /**
   * 本次部署的 commit SHA（可缺省）。自 2026-08-29 起用于「同一提交反复部署」的
   * 空转判定 —— 见 assessDeployLoop。缺省时判定一律放行（见该函数注释）。
   */
  commitSha?: string;
}

export interface BuildActivitySummary {
  recentBuilds1h: number;
  recentBuilds24h: number;
  lastBuildAt: number | null;
}

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 1000;
/** ring buffer 上限：单实例几十个项目、最坏每分钟几十次构建，5000 足够覆盖 24h。 */
const RING_MAX = 5000;

let ring: BuildActivityEvent[] = [];

function prune(nowMs: number): void {
  const cutoff = nowMs - WINDOW_24H_MS;
  // 先按时间窗裁掉过期事件
  if (ring.length && ring[0].at < cutoff) {
    let firstFresh = 0;
    while (firstFresh < ring.length && ring[firstFresh].at < cutoff) firstFresh++;
    if (firstFresh > 0) ring = ring.slice(firstFresh);
  }
  // 再按硬上限裁掉最旧的（防御性，正常不会触发）
  if (ring.length > RING_MAX) ring = ring.slice(ring.length - RING_MAX);
}

/** 记录一次构建/部署发生（deploy 端点在通过全部前置校验后调用）。 */
export function recordBuild(
  projectId: string,
  branchId: string,
  trigger = 'unknown',
  commitSha?: string,
): void {
  const at = Date.now();
  ring.push({ projectId: projectId || 'default', branchId, at, trigger, commitSha: normalizeSha(commitSha) });
  prune(at);
}

/* ------------------------------------------------------------------------ *
 * 空转部署熔断（2026-08-29）
 *
 * 事故：mdimp 的分支 bootstrap 步骤在写完 profile override 之后自己再发一次
 * POST /api/branches/:id/deploy。该步骤每轮都判定「override 变了」，于是构成一个
 * 按构造无法收敛的环：部署 → bootstrap → 触发部署 → …。实测 main 分支上连续
 * 十余轮背靠背部署（每轮结束后 3~4 秒下一轮就起，全是同一个 commit），分支永远
 * 停在 building、预览域名长期 503，宿主构建槽被独占，同项目其它分支一并饿死。
 *
 * CDS 侧当时**完全没有察觉**：branch-operation-coordinator 只防「并发」撞车，
 * 而这个环是严格串行的（每轮等上一轮结束才起），协调器从头到尾没被触发；
 * build-activity-tracker 虽然记了次数，却只喂资源面板展示，没有任何判定或告警。
 *
 * 判据选择（对齐 predicate-and-wiring-discipline 形状 1「判据别比该管的范围窄」）：
 *
 *   - 按 (branchId, commitSha) 计数，**不按次数总量**。开发者连续推 10 次是 10 个
 *     不同的 SHA，永远不会命中；空转环的特征恰恰是「同一个 commit 反复部署」。
 *   - 推新提交自然清零，这是天然且零成本的逃生门，所以误伤代价很小。
 *   - 不按 trigger 过滤。triggerFromRequest 在缺 x-cds-trigger 头时一律回落
 *     'manual'，CDS 自己的 Web 面板和一个失控脚本在这个字段上**完全不可区分**——
 *     真实事故里那个自触发脚本记录下来就是 'manual'。按 trigger 过滤会漏掉它。
 *   - SHA 比较做前缀归一：同一个提交可能以 7 位短号或 40 位全长送进来，
 *     直接字符串相等会把同一个提交判成两个，判据当场失效。
 *   - 无 SHA 一律放行。不知道提交是什么就无法区分「空转」与「正常连推」，
 *     此时宁可不拦——护栏误伤真实工作比漏掉一次空转更糟。
 * ------------------------------------------------------------------------ */

/** 空转判定的观察窗口。 */
const LOOP_WINDOW_MS = 30 * 60 * 1000;
/** 达到此数即告警（仍放行）。 */
const LOOP_WARN_COUNT = 3;
/** 达到此数即拒绝后续同 (分支, 提交) 的部署。 */
const LOOP_TRIP_COUNT = 6;

export type DeployLoopLevel = 'ok' | 'warn' | 'trip';

export interface DeployLoopAssessment {
  level: DeployLoopLevel;
  /** 窗口内同 (分支, 提交) 的既有部署次数，不含本次。 */
  sameCommitCount: number;
  windowMinutes: number;
  warnAt: number;
  tripAt: number;
  /** 供告警/拒绝文案直接引用，避免调用方再拼一遍。 */
  commitSha: string | null;
}

function normalizeSha(sha?: string | null): string | undefined {
  const trimmed = String(sha ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : undefined;
}

/** 两个 SHA 是否指同一个提交（容忍 7 位短号与 40 位全长混用）。 */
function sameCommit(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/**
 * 判定某分支是否在对同一个提交空转部署。deploy 端点在受理请求前调用。
 *
 * 返回的 sameCommitCount **不含本次**，所以 `level === 'trip'` 的含义是
 * 「此前已经部署过 tripAt 次同一个提交，这一次不该再放行」。
 */
export function assessDeployLoop(
  branchId: string,
  commitSha?: string | null,
  nowMs = Date.now(),
): DeployLoopAssessment {
  const sha = normalizeSha(commitSha);
  const base: Omit<DeployLoopAssessment, 'level' | 'sameCommitCount'> = {
    windowMinutes: Math.round(LOOP_WINDOW_MS / 60_000),
    warnAt: LOOP_WARN_COUNT,
    tripAt: LOOP_TRIP_COUNT,
    commitSha: sha ?? null,
  };
  // 不知道提交是什么就无法区分空转与正常连推，放行。
  if (!sha || !branchId) return { ...base, level: 'ok', sameCommitCount: 0 };

  const since = nowMs - LOOP_WINDOW_MS;
  let sameCommitCount = 0;
  for (const ev of ring) {
    if (ev.at < since) continue;
    if (ev.branchId !== branchId) continue;
    if (!ev.commitSha || !sameCommit(ev.commitSha, sha)) continue;
    sameCommitCount++;
  }

  const level: DeployLoopLevel = sameCommitCount >= LOOP_TRIP_COUNT
    ? 'trip'
    : sameCommitCount >= LOOP_WARN_COUNT
      ? 'warn'
      : 'ok';
  return { ...base, level, sameCommitCount };
}

/** 单项目在 sinceMs 之后的构建次数。 */
export function countBuildsSince(projectId: string, sinceMs: number): number {
  let count = 0;
  for (const ev of ring) {
    if (ev.projectId === projectId && ev.at >= sinceMs) count++;
  }
  return count;
}

/** 聚合所有项目的近 1h / 24h 构建次数 + 最近一次构建时间。 */
export function summarizeBuildActivity(nowMs = Date.now()): Map<string, BuildActivitySummary> {
  const since1h = nowMs - WINDOW_1H_MS;
  const since24h = nowMs - WINDOW_24H_MS;
  const out = new Map<string, BuildActivitySummary>();
  for (const ev of ring) {
    if (ev.at < since24h) continue;
    let entry = out.get(ev.projectId);
    if (!entry) {
      entry = { recentBuilds1h: 0, recentBuilds24h: 0, lastBuildAt: null };
      out.set(ev.projectId, entry);
    }
    entry.recentBuilds24h++;
    if (ev.at >= since1h) entry.recentBuilds1h++;
    if (entry.lastBuildAt === null || ev.at > entry.lastBuildAt) entry.lastBuildAt = ev.at;
  }
  return out;
}

/** 测试隔离用：清空 ring。 */
export function __resetBuildActivityForTests(): void {
  ring = [];
}
