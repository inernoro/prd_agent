/**
 * 发布控制台的「我现在在哪」判定。
 *
 * 用户 2026-08-15：「我从发布中心页跳转到发布页忽然发现，是已经发布过的，会给用户
 * 一种『我在那、我在干什么、现在怎么做的过程』，很有心智负担。这些没有被标记为
 * 已发布吗？」
 *
 * 根因在页面里那一行 `const shown = run || row?.latestRun`：本次没发起任何操作时，
 * 它退回展示该环境**上一次历史发布**。于是标题写「发布成功」、进度条满格绿、步骤
 * 全部打勾、日志区是那次的日志——整屏都在说「你刚刚成功发布了一版」，而用户其实
 * 什么都没做。历史被渲染成了现在时。
 *
 * 这里把三件事分开判，页面只负责渲染：
 *   1. 这一屏展示的是**本次操作**还是**历史记录**（session vs history）；
 *   2. 当前选中的版本**是不是已经在线上**（再发一次不会改变线上内容）；
 *   3. 由此得到的标题、说明、主按钮文案。
 *
 * 抽成纯函数是因为这三句话删掉之后页面照样跑、测试照样绿，只是用户又开始
 * 分不清自己在哪——正是需要守卫钉住的那种改动。
 */

export type ConsolePhase =
  /** 本次没发起任何操作，屏幕上展示的是历史记录。 */
  | 'history'
  /** 这个环境从来没发布过，等着用户发第一版。 */
  | 'never'
  /** 本次发起的发布正在跑。 */
  | 'running'
  /** 本次发起的发布已结束。 */
  | 'session';

export interface ConsoleStanceInput {
  /** 本次会话发起的 run（页面里的 `run`）。没有就是 null。 */
  sessionRun: { status: string } | null;
  /** 该环境最近一次历史发布（`row.latestRun`）。 */
  latestRun: { status: string; commitSha?: string; operator?: string; startedAt?: string } | null;
  /** 线上正在跑的 commit（`row.currentCommit`）。 */
  liveCommit: string;
  /** 当前选中要发布的那一版 commit。 */
  selectedCommit: string;
  running: boolean;
  failed: boolean;
}

export interface ConsoleStance {
  phase: ConsolePhase;
  /** banner 主标题。历史态必须带「上次」，否则读起来像刚发生。 */
  title: string;
  /**
   * 主标题右边那枚状态标签。历史态给「历史记录」，让人一眼知道这不是本次动作。
   * 不需要标签时为空串。
   */
  badge: string;
  /** 选中的版本是否就是线上那一版。 */
  selectedIsLive: boolean;
  /** 主按钮文案。 */
  primaryLabel: string;
  /**
   * 一句话说清「你现在在哪、按下去会发生什么」。空串表示不需要额外解释
   * （正在跑 / 本次刚发完，屏幕本身已经说清楚了）。
   */
  hint: string;
}

/** 短 sha 比较：两边都可能是全长或 7 位，统一截断再比，避免「同一版判成不同版」。 */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  if (!x || !y) return false;
  return x.slice(0, 7) === y.slice(0, 7);
}

/**
 * 屏幕上这条 run，是不是这个环境**当前**那一版。
 *
 * 「看日志」翻出一条历史记录时，页面的 `shown` 会指向它，但结论条和回滚按钮说的
 * 都是「当前环境」——于是翻一条三天前的成功记录，屏幕上写着「已切到 abc1234」，
 * 而线上跑的其实是后来那一版；「回滚」也变成撤销一条早已不是当前版本的发布
 * （Codex review P2，2026-08-16）。
 *
 * 判据只认身份不认 commit：
 * - 本次会话自己发起的那条永远算当前——刚发完时 center 还没刷回来，
 *   按 latestRun 判会把自己刚发的那版说成历史。
 * - 否则要等于这个目标最新的那条。翻看的历史记录若正好就是最新那条，
 *   它本来就是当前，照样算。
 *
 * 拿 commit 比（`shown.commitSha === row.currentCommit`）看着更直接，但那是另一个
 * 问题的答案：同一个 commit 可以发过好几次，回滚回旧版又会让 currentCommit 与一条
 * 老 run 相等——都会把历史记录判成当前。
 */
export function isShownRunCurrent(input: {
  shownReleaseId?: string;
  sessionReleaseId?: string;
  latestReleaseId?: string;
}): boolean {
  const shown = (input.shownReleaseId || '').trim();
  if (!shown) return false;
  return shown === (input.sessionReleaseId || '').trim()
    || shown === (input.latestReleaseId || '').trim();
}

export function buildConsoleStance(input: ConsoleStanceInput): ConsoleStance {
  const { sessionRun, latestRun, liveCommit, selectedCommit, running, failed } = input;
  const selectedIsLive = sameCommit(selectedCommit, liveCommit);

  if (running) {
    return {
      phase: 'running',
      title: '发布中',
      badge: '',
      selectedIsLive,
      primaryLabel: '发布中',
      hint: '',
    };
  }

  // 本次会话真的发起过：屏幕上是「你刚做的事」，照旧说现在时。
  if (sessionRun) {
    return {
      phase: 'session',
      title: failed ? '发布失败' : '发布成功',
      badge: '',
      selectedIsLive,
      primaryLabel: failed ? '重新发布' : '再发一次',
      hint: '',
    };
  }

  if (!latestRun) {
    return {
      phase: 'never',
      title: '待发布',
      badge: '',
      selectedIsLive: false,
      primaryLabel: '开始发布',
      hint: '这个环境还没有发布过，下面这一版会是它的第一版。',
    };
  }

  // 历史态。这里是本次改动的重点：标题必须带「上次」，并且明确告诉用户
  // 「你还没做任何事」，否则满格绿的进度条会被读成「我刚发布成功了」。
  const sha = latestRun.commitSha ? latestRun.commitSha.slice(0, 7) : '';
  // 「哪一版、谁发的」拼成一段定语，缺哪一段就整段不出——
  // 拼出「由 不是本次操作」这种半截话比不写更糟。
  const by = [sha, latestRun.operator].filter(Boolean).join(' · ');
  const whose = by ? `（${by}）` : '';
  return {
    phase: 'history',
    title: failed ? '上次发布失败' : '上次发布成功',
    badge: '历史记录',
    selectedIsLive,
    primaryLabel: selectedIsLive ? '重新发布这一版' : '开始发布',
    hint: selectedIsLive
      ? `下面是上一次发布${whose}留下的记录，不是本次操作。这一版已经在线上，再发一次只是重跑一遍流程，线上内容不会变。`
      : `下面是上一次发布${whose}留下的记录，不是本次操作。选好版本后点「开始发布」才会真正发。`,
  };
}
