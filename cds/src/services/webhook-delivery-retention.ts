import type { GithubWebhookDelivery } from '../types.js';

// ── Webhook 投递日志保留策略（2026-06-27）──────────────────────────────
// 背景：githubWebhookDeliveries 历史上是「全局 ring buffer」——state.ts 写入时
// 截断、mongo-split / mongo-backing 持久化时再各自截断。三处都是**全局**上限，
// 且数值不一致（state.ts=1000、mongo-split=200、mongo-backing=1000）。在多项目
// 实例上，某个忙分支几分钟就能用自己的 push/CI 事件把全局 buffer 灌满，把安静
// 分支（如 main）的 push 历史挤光 → 用户看到「main webhook 只有 1 条」。
// 2026-05-14 曾把 state.ts 的上限从 200 调到 1000，但 mongo-split 持久化仍按 200
// 截断，迁到 split 存储后旧 200 上限「复活」，等于把那次修复悄悄回退了。
//
// 本模块把保留策略收敛成**唯一 SSOT**：按 retention key（优先 branchId）保证每个
// key 最近 PER_BRANCH_MIN 条永不被其它 key 的流量挤掉，再用 GLOBAL_MAX 兜住总量。
// 所有写入 / 持久化层都调用 pruneWebhookDeliveries，杜绝某一层悄悄用更小的全局
// 上限二次截断。
// ──────────────────────────────────────────────────────────────────────

/** 每个 retention key（分支）保证保留的最近条数——不被其它分支流量挤掉。 */
export const WEBHOOK_DELIVERY_PER_BRANCH_MIN = 40;

/** 全局硬上限——兜住总量（≈ 单文档体积），优先保护 per-branch 配额。 */
export const WEBHOOK_DELIVERY_GLOBAL_MAX = 1000;

/**
 * 保留分组键：优先 branchId（分支详情抽屉按它过滤），退而用 repo#ref，
 * 再退而 'unattributed'（验签失败 / 非业务事件等无分支归属的投递）。
 */
export function webhookDeliveryRetentionKey(delivery: GithubWebhookDelivery): string {
  if (delivery.branchId) return `branch:${delivery.branchId}`;
  if (delivery.repoFullName) return `repo:${delivery.repoFullName}#${delivery.ref || ''}`;
  return 'unattributed';
}

/**
 * 按「每分支保最近 N + 全局兜底 M」裁剪投递列表。
 *
 * 入参 list 为**时间正序**（最旧在前，最新在后，与 state 内存数组一致），
 * 返回同样正序的子集。规则：
 *  1. 从最新往最旧扫，每个 retention key 的前 perBranchMin 条标记为「受保护」
 *     —— 保证每个分支最近 perBranchMin 条始终留存，与其它分支流量无关；
 *  2. 受保护条目全部保留；剩余全局预算（globalMax - 受保护数）用「最新优先」
 *     填充非保护条目；
 *  3. 极端情况下（活跃分支极多，受保护数本身就超过 globalMax）按「最新优先」
 *     把最旧的受保护条目也丢弃，保证最终不超过 globalMax（绝不无界增长）。
 */
export function pruneWebhookDeliveries(
  list: GithubWebhookDelivery[],
  globalMax: number = WEBHOOK_DELIVERY_GLOBAL_MAX,
  perBranchMin: number = WEBHOOK_DELIVERY_PER_BRANCH_MIN,
): GithubWebhookDelivery[] {
  if (list.length <= perBranchMin) return list;
  if (list.length <= globalMax && globalMax >= list.length) {
    // 还没到全局上限：每个分支天然都没被挤，无需裁剪。
    return list;
  }

  const n = list.length;
  const perKeyCount = new Map<string, number>();
  const isProtected = new Array<boolean>(n).fill(false);

  // 1) 从最新往最旧标记 per-branch 受保护配额。
  for (let i = n - 1; i >= 0; i--) {
    const key = webhookDeliveryRetentionKey(list[i]);
    const count = (perKeyCount.get(key) || 0) + 1;
    perKeyCount.set(key, count);
    if (count <= perBranchMin) isProtected[i] = true;
  }

  // 2) 保留受保护 + 用剩余预算从最新往最旧填充非保护。
  const protectedCount = isProtected.reduce((acc, p) => acc + (p ? 1 : 0), 0);
  let nonProtectedBudget = Math.max(0, globalMax - protectedCount);
  const keep = new Array<boolean>(n).fill(false);
  for (let i = n - 1; i >= 0; i--) {
    if (isProtected[i]) {
      keep[i] = true;
      continue;
    }
    if (nonProtectedBudget > 0) {
      keep[i] = true;
      nonProtectedBudget--;
    }
  }

  // 3) 受保护数本身超过 globalMax 时，从最旧端再砍，硬兜住总量。
  let kept = keep.reduce((acc, k) => acc + (k ? 1 : 0), 0);
  if (kept > globalMax) {
    let over = kept - globalMax;
    for (let i = 0; i < n && over > 0; i++) {
      if (keep[i]) {
        keep[i] = false;
        over--;
      }
    }
  }

  const out: GithubWebhookDelivery[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(list[i]);
  return out;
}
