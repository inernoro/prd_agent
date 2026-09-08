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
  /**
   * 这件事的结局。取最后一次的结果，不是「有没有出现过失败」：中途一次超时后来成了，就是成了。
   *
   * 但「最后一次返回 200」只对**写入**成立 —— 写入的 HTTP 结果就是它的结局。
   * 以**查看**收尾的多步事件不成立：生图 run 还在排队、甚至已经失败，`map_visual_get_run`
   * 照样回 200，而网关的 `log.Status` 是纯按 HTTP 判的。照搬过来就是给一个失败的 run
   * 打绿色「成功」。所以这类事件要看**产物有没有真的出来**（closed-loop-acceptance 的判据），
   * 出来了才算成，没出来如实说 `pending`（不知道跑完没有），不猜成功也不猜失败。
   */
  status: 'success' | 'error' | 'denied' | 'pending' | string;
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
  // 幂等命中的重试不算「发起」：它没产生任何副作用，真正的那一次在更早的记录里。
  // 把它当发起点，下面的耗时就会从这次空转的重试算起，写成一个没发生过的「从发起到落地」。
  const hasOrigin = first.isWrite && !first.deduplicated;
  // 每条记录的 createdAt 是**发起时刻**（审计行在派发前取墙钟），执行耗时另存在 durationMs 里。
  // 所以「这件事花了多久」的终点是最后一步的 createdAt + durationMs，不是它的 createdAt ——
  // 只减 createdAt 等于把最后那一次调用本身的耗时白送掉：10:00 发起、10:00:30 发起最后一次轮询、
  // 15 秒后才拿到图，屏幕上会写「从发起到落地 30s」，而用户实际等了 45 秒。
  const elapsedMs = multiStep
    ? Math.max(
        0,
        new Date(last.createdAt).getTime() + (last.durationMs ?? 0) - new Date(first.createdAt).getTime(),
      )
    : last.durationMs;

  const key = first.artifact?.kind && first.artifact?.id
    ? `${first.keyId}|${first.artifact.kind}:${first.artifact.id}#${first.id}`
    : `row|${first.id}`;

  const artifact =
    steps.find((s) => !!s.artifact?.url)?.artifact ??
    steps.find((s) => !!s.artifact?.id)?.artifact ??
    null;

  const status = outcomeOf(last, artifact);

  return {
    // id 带上发起那一次的行 id：同一篇文档改两次是两件事，光用产物身份会撞 React key
    id: key,
    steps,
    first,
    last,
    status,
    elapsedMs,
    multiStep,
    hasOrigin,
    // 取最大不取求和：同一个 run 被幂等重试时每条都记着「这次要 N 张」，
    // 加起来会把一次重试说成出了两倍的图。
    imageCount: steps.reduce((n, s) => Math.max(n, s.imageCount), 0),
    isWrite: steps.some((s) => s.isWrite),
    // 地址是跑完才有的，所以从最新往回找第一条给得出地址的；都没有就退回带 id 的那条
    artifact,
  };
}

/**
 * 一件事的结局。
 *
 * 轮询那一次的 HTTP 200 只代表「问到了」，不代表那件事跑完了 —— 网关记 `log.Status`
 * 用的是纯传输层判据（`status is >= 200 and < 300`），生图 run 还在排队甚至已经失败，
 * `map_visual_get_run` 照样回 200。
 *
 * 这个判据必须是**唯一一处**，而且不许挂在「多步」上：
 * 上一版写成「以查看收尾 && 多步」，于是两个口子漏了 ——
 * ① 发起那次落在上一页、这一页只剩一次轮询的单步事件；
 * ② 按结果筛选时整条走 `soloGroup`，根本不经过分组。
 * 两条路都把排队中的 run 显示成绿色「成功」。（形状 3：判据分裂成多份然后各自漂移）
 *
 * 判据本身要窄：只有「在等一个异步产物」的读取才可能是「还没出结果」——
 * 产物是 image-run 而地址还没有。其它读取（列站点清单、看工作区）问到了就是问到了，
 * 一律判 pending 会把一整类正常的查询说成没结果。
 */
export function outcomeOf(
  last: McpCallLogDto,
  artifact: McpCallLogDto['artifact'] | null,
): CallGroup['status'] {
  if (last.status !== 'success') return last.status;
  // 「图还没出来」这件事与最后一步是写是读无关：入队（generate_image，写）本身就只回一个
  // runId，没有地址；客户端要是压根不来轮询，这件事会永远停在入队那一步。
  // 上一版把 isWrite 的判断放在前面，于是「只入队、还没轮询」的事件被打成绿色成功 ——
  // 而图并不存在（closed-loop-acceptance：产物没出现就不算成了）。
  // 判据只认产物：是一个还没有地址的 image-run，就还没出结果。
  if (artifact?.kind === 'image-run' && !artifact.url) return 'pending';
  return 'success';
}

/** 按结果筛选时用：一条流水就是一件事，不折 —— 但结局仍走同一个判据。 */
export function soloGroup(item: McpCallLogDto): CallGroup {
  const artifact = item.artifact ?? null;
  return {
    id: `row|${item.id}`,
    steps: [item],
    first: item,
    last: item,
    status: outcomeOf(item, artifact),
    elapsedMs: item.durationMs,
    multiStep: false,
    hasOrigin: item.isWrite,
    imageCount: item.imageCount,
    isWrite: item.isWrite,
    artifact,
  };
}

/**
 * 事件行显示的那个时刻。
 *
 * 必须与列表的排序键是同一个值。事件之间按「各自最后一步的时间」倒序（见 groupCalls 结尾），
 * 而这一列原来显示的是 first.createdAt —— 一个 10:00 发起、10:20 才跑完的生图事件，
 * 会排在 10:10 那次快调用**上面**却显示 10:00，看起来像列表没按时间排。
 * 发起时刻不丢：展开后的详情里单独写着。
 */
export function eventTime(group: CallGroup): string {
  return group.last.createdAt;
}
