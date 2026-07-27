/**
 * 副本成员「停止后落状态」的唯一判定（Codex 第三十五轮 P1 的完整版）。
 *
 * `ContainerService.stop` 在 `docker stop` 非零退出时只记录事件、**不抛异常**。
 * 三处停止循环（分支停止路由、调度器降温、auto-lifecycle 自动停止）此前都是
 * 「try stop → 无条件 member.status = 'stopped'」：一个其实还活着的共享库副本
 * 就此从所有视野里消失——发布器把它摘出路由，成员对账只看 running 记录，
 * 孤儿收割器又认为它有主，于是没有任何一条链路会再回头看它，而它还在跑消费者
 * 和定时任务写主库。
 *
 * 第三十五轮只修了分支停止路由一处，另外两处照旧（Codex 原话就点了名）。抽成
 * 本函数即为杜绝「三处各修各的、修一处漏两处」——以后新增停止路径也只调它。
 */

export interface StoppableReplicaMember {
  containerName?: string;
  status: string;
  statusMessage?: string;
}

export interface SettleMemberAfterStopOptions {
  /** 复核容器是否仍在运行。查询失败时应返回 true（保守：宁可报警也不静默漏掉）。 */
  isRunning: (containerName: string) => Promise<boolean>;
  /** 无容器的 provisioning 成员被本次停止打断时写入的提示。 */
  interruptedMessage: string;
  /** 复核发现仍在运行时的回调（记事件 / 打日志），由调用方决定去向。 */
  onStillRunning?: (containerName: string, message: string) => void;
}

/**
 * 返回该成员最终落到的状态。'error' 表示容器仍在运行——调用方不应再把它当作
 * 已停止处理（分支状态、日志归档照常，但这个成员会红显并保留在视野里）。
 */
export async function settleMemberAfterStop(
  member: StoppableReplicaMember,
  opts: SettleMemberAfterStopOptions,
): Promise<'stopped' | 'error'> {
  const name = member.containerName;
  if (name) {
    const stillRunning = await opts.isRunning(name).catch(() => true);
    if (stillRunning) {
      const message = `停止失败：容器 ${name} 仍在运行（可能仍在读写主库），请在画布手动删除该副本或检查 docker`;
      member.status = 'error';
      member.statusMessage = message;
      opts.onStillRunning?.(name, message);
      return 'error';
    }
  } else if (member.status === 'provisioning') {
    member.statusMessage = opts.interruptedMessage;
  }
  member.status = 'stopped';
  return 'stopped';
}
