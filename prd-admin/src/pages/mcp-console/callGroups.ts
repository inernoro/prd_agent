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
  /**
   * 这件事的第一步是不是真正的「发起动作」（一次写入）。
   *
   * 入队那一次落在上一页时，这一页只剩下几次轮询：它们确实是同一件事，该折成一行，
   * 但这一行没有发起 —— 此时 elapsedMs 是「这几次查看之间的跨度」，不是「从发起到落地」。
   * 不把这件事说出来，详情里那句「从发起到落地 Xs」就是在编一个没看见的时刻。
   */
  hasOrigin: boolean;
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
 * ## 一件事 = 一次动作 + 它之后的若干次查看
 *
 * 光按产物身份（`kind:id`）归并是**不够**的，而且会说谎：同一篇文档被改两次，
 * `map_kb_update_entry` 两次都回同一个 entryId；同一个工作区被写两次，两次都回同一个
 * workspaceId。只按身份折，这两次不同的编辑会并成一行 —— 最新那次的「成功」把上一次的
 * 失败盖掉，而展示的参数摘要来自那次不相干的旧编辑。审计面板一旦这样说谎，不如没有。
 *
 * 所以判据是**动作 + 后续查看**：
 *   - 一次**写入**（非幂等命中）开启一件新的事；
 *   - 之后同一产物上的**读取**（轮询）折进这件事；
 *   - 幂等命中的重试不算新动作（它没产生任何副作用），折进当前这件；
 *   - 没有产物身份的行、以及找不到前序动作的孤立读取，各自成行。
 *
 * 归并靠数据本身已有的关联（产物 id + 写/读语义），不另造一个 correlation id：
 * 入队回 runId、之后每次轮询查的还是同一个 runId。另存一个派生字段等于把同一个判断
 * 存成两份，早晚漂。
 *
 * 键上必须带 keyId：产物 id 在库里全局唯一没错，但两台客户端轮询同一个 run 是合法的，
 * 混成一行会把「谁干的」这件事说错。
 */
export function groupCalls(items: McpCallLogDto[]): CallGroup[] {
  // 入参是列表接口的顺序（最新在前）。按时间正序走一遍才分得清「谁是发起、谁是后续查看」。
  const chronological = [...items].reverse();

  const buckets: McpCallLogDto[][] = [];
  const keyOf = (item: McpCallLogDto) => {
    const kind = item.artifact?.kind;
    const id = item.artifact?.id;
    return kind && id ? `${item.keyId}|${kind}:${id}` : null;
  };
  /** 每个产物身份上「还开着的那件事」在 buckets 里的下标。 */
  const open = new Map<string, number>();

  for (const item of chronological) {
    const key = keyOf(item);
    if (key === null) {
      buckets.push([item]);      // 被挡下、参数错、纯读类工具：一次失败本来就是一件独立的事
      continue;
    }

    // 写入就是一次新动作，除非它是幂等命中的重试（那次什么都没产生，属于同一件事）
    const startsNewAction = item.isWrite && !item.deduplicated;
    const openIndex = open.get(key);
    if (!startsNewAction && openIndex !== undefined) {
      buckets[openIndex].push(item);
      continue;
    }

    open.set(key, buckets.length);
    buckets.push([item]);
  }

  // 还原成「最新在前」：事件之间按各自最后一步的时间倒序，事件内部也倒序
  return buckets
    .map(toGroup)
    .sort((a, b) => new Date(b.last.createdAt).getTime() - new Date(a.last.createdAt).getTime());
}

/** 桶里是时间正序（发起在前）。对外的 steps 是倒序，与列表一致。 */
function toGroup(chronoSteps: McpCallLogDto[]): CallGroup {
  const first = chronoSteps[0];
  const last = chronoSteps[chronoSteps.length - 1];
  const steps = [...chronoSteps].reverse();
  const multiStep = steps.length > 1;
  const hasOrigin = first.isWrite;
  const elapsedMs = multiStep
    ? Math.max(0, new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime())
    : last.durationMs;

  const key = first.artifact?.kind && first.artifact?.id
    ? `${first.keyId}|${first.artifact.kind}:${first.artifact.id}#${first.id}`
    : `row|${first.id}`;

  return {
    // id 带上发起那一次的行 id：同一篇文档改两次是两件事，光用产物身份会撞 React key
    id: key,
    steps,
    first,
    last,
    status: last.status,
    elapsedMs,
    multiStep,
    hasOrigin,
    // 取最大不取求和：同一个 run 被幂等重试时每条都记着「这次要 N 张」，
    // 加起来会把一次重试说成出了两倍的图。
    imageCount: steps.reduce((n, s) => Math.max(n, s.imageCount), 0),
    isWrite: steps.some((s) => s.isWrite),
    // 地址是跑完才有的，所以从最新往回找第一条给得出地址的；都没有就退回带 id 的那条
    artifact:
      steps.find((s) => !!s.artifact?.url)?.artifact ??
      steps.find((s) => !!s.artifact?.id)?.artifact ??
      null,
  };
}
