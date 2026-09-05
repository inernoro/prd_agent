import type { McpCallLogDto } from '@/services/contracts/mcpConsole';

export interface CallGroup {
  /** 稳定 id：既用于 React key，也用于展开态 */
  id: string;
  /** 这件事包含的调用，按时间**倒序**（与列表一致，最新在前） */
  steps: McpCallLogDto[];
  /** 发起那一次 —— 参数摘要写着「它当时想干什么」都在这条上 */
  first: McpCallLogDto;
  /** 最后一次 —— 结果、产物地址都在这条上 */
  last: McpCallLogDto;
  /** 这件事的结局。取最后一次的结果，不是「有没有出现过失败」：中途一次超时后来成了，就是成了 */
  status: string;
  /** 多步时是墙上时钟（从发起到落地），单步时就是那次调用自己的耗时 —— 两者语义不同，展示时要分开说 */
  elapsedMs: number;
  multiStep: boolean;
  imageCount: number;
  isWrite: boolean;
  artifact: McpCallLogDto['artifact'];
}

/**
 * 把调用流水折成「一件事一行」。
 *
 * 为什么要折：一次生图在流水里是 1 次入队 + N 次轮询 = N+1 行，长得一模一样，
 * 而用户想知道的只有一件事 ——「那张图出来没有」。不折的话，真正的信息被自己的噪音淹掉。
 *
 * 归并键是**产物身份**（`kind:id`），不是另造一个 correlation id：
 * 入队回的是 runId，之后每次轮询查的还是同一个 runId，这条关联本来就在数据里。
 * 另存一个派生字段等于把同一个判断存成两份，早晚漂（判据分裂的老形状）。
 *
 * 键上必须带 keyId：产物 id 在库里全局唯一没错，但两台客户端轮询同一个 run 是合法的，
 * 混成一行会把「谁干的」这件事说错 —— 而这块面板是审计用的。
 *
 * 没有产物身份的行（被挡下、参数错、纯读类工具）各自成行 —— 一次失败本来就是一件独立的事。
 */
export function groupCalls(items: McpCallLogDto[]): CallGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, McpCallLogDto[]>();

  for (const item of items) {
    const kind = item.artifact?.kind;
    const id = item.artifact?.id;
    const key = kind && id ? `${item.keyId}|${kind}:${id}` : `row|${item.id}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else {
      buckets.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => {
    // 入参是倒序（最新在前），所以桶里第 0 条是最后一次、末条是发起那次
    const steps = buckets.get(key)!;
    const last = steps[0];
    const first = steps[steps.length - 1];
    const multiStep = steps.length > 1;
    const elapsedMs = multiStep
      ? Math.max(0, new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime())
      : last.durationMs;

    return {
      id: key,
      steps,
      first,
      last,
      status: last.status,
      elapsedMs,
      multiStep,
      // 取最大不取求和：同一个 run 被重试时每条都记着「这次要 N 张」，
      // 加起来会把一次重试说成出了两倍的图。
      imageCount: steps.reduce((n, s) => Math.max(n, s.imageCount), 0),
      isWrite: steps.some((s) => s.isWrite),
      // 地址是跑完才有的，所以从最新往回找第一条给得出地址的；都没有就退回带 id 的那条
      artifact:
        steps.find((s) => !!s.artifact?.url)?.artifact ??
        steps.find((s) => !!s.artifact?.id)?.artifact ??
        null,
    };
  });
}
