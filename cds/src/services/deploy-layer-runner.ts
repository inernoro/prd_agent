/**
 * deploy-layer-runner — 部署层内 fan-out 的收敛执行器。
 *
 * 病根（2026-07-16 队列堵死复盘，同分支 3 个 building run × 6 服务 = 18 个
 * 队列位）：层内并行此前用 `await Promise.all(layer.items.map(...))`——首个
 * 服务抛出 BranchOperationSupersededError 时 Promise.all **立刻** reject，
 * 控制流跳到部署收尾（finally → completeBranchOperation 释放分支租约），
 * 而其余兄弟服务闭包（含停在 build-gate 队列里的等待者）**脱管续跑**。
 * 租约一释放，下一个 manual deploy 立即拿到新租约 → 同分支多个部署叠加，
 * 每个都往全局构建队列塞一整层服务。
 *
 * 本执行器的两条保证：
 * 1. **首败即广播**：任一服务 reject 时 abort 共享 signal——停在 build-gate
 *    队列里的兄弟等待者被立即踢出（配合 build-gate 的 signal 支持）。
 * 2. **全部落地才返回**：用 allSettled 语义等**所有**服务闭包终结（含被踢出
 *    后的收尾）才把错误抛给调用方——部署收尾（释放租约）绝不会发生在还有
 *    兄弟闭包存活的时刻，根治「脱管闭包 + 重复租约」。
 *
 * 纯函数、无 I/O，错误挑选策略由调用方注入（部署循环偏好 Superseded 错误：
 * 整个 run 收敛为 cancelled 而不是 failed）。
 */

export interface RunLayerOptions {
  /**
   * 多个服务同时失败时挑选要向上抛的那个。缺省取第一个。
   * 部署循环用它实现「Superseded 优先、真实构建错误次之、被踢出的排队
   * 取消垫底」，避免兄弟被踢产生的次生错误掩盖根因。
   */
  pickError?: (errors: unknown[]) => unknown;
}

export async function runLayerWithSharedAbort<T>(
  items: T[],
  runOne: (item: T, signal: AbortSignal) => Promise<void>,
  options: RunLayerOptions = {},
): Promise<void> {
  if (items.length === 0) return;
  const controller = new AbortController();
  const results = await Promise.allSettled(
    items.map(async (item) => {
      try {
        await runOne(item, controller.signal);
      } catch (err) {
        // 首败广播：踢出仍在排队的兄弟（幂等，重复 abort 无害）。
        controller.abort();
        throw err;
      }
    }),
  );
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  if (errors.length === 0) return;
  throw options.pickError ? options.pickError(errors) : errors[0];
}
