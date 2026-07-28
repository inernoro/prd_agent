/**
 * 远端发布产物的回收判定 + 线上漂移判定（阶段三：记账）。
 *
 * 病根：CDS 的 generated-compose / generated-static 每发一次就在目标机器上留下
 * 一个 `git worktree`（源码 + node_modules + 构建中间物，最重的一份），static 还额外
 * 留一份成品 `.releases/<releaseId>`。这些目录**只增不减** —— 发布脚本从建立那天起
 * 就没有任何一处删过它们，CDS 侧也从不读回远端现场。生产机器的磁盘因此单调下降，
 * 而「线上现在到底跑的是哪一版」CDS 只能凭自己的台账猜。
 *
 * 本模块是这两件事的**纯函数**：吃「远端实际清单 + CDS 台账 + 在用符号链接」，
 * 吐「能删哪些 / 每个被保留的原因 / 线上漂没漂」。不碰 SSH，便于把每一条安全边界
 * 写成回归断言（照 image-retention.ts 的形状，它是同一类问题的先例）。
 *
 * 三个必须记住的远端事实（写错任何一条都会删到生产正在用的目录）：
 *  1. 产物在**仓库的兄弟目录**（`$(dirname "$PWD")/.cds-releases/<targetId>/`），
 *     不在仓库内。路径由远端脚本用 `$PWD` 现算，所以本模块只生成「在远端复算一遍」
 *     的命令，绝不在 TS 里用 path.dirname 自己推 —— 相对路径或软链会让两边算出不同目录。
 *  2. `current` / `previous` 两个符号链接由 CDS 生成的脚本自己维护，是回滚的人工兜底；
 *     判据必须取**远端 readlink 实读值**，不能拿台账推断（见第 3 条）。
 *  3. 探测失败后的自动恢复会造出 `rel_xxxx-auto-restore` 这个目录，而这次 run
 *     **从未进过台账**（release-service 只是合成一个 restoreRun 直接执行）。
 *     它却完全可能正是 current 指向的那一份。「只按台账保护」的方案第一刀就砍生产。
 */

import path from 'node:path';
import type { ReleaseExecutionMode, ReleaseRun, ReleaseStrategy, ReleaseTarget } from '../types.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';
import { isSuccessfulReleaseRun, KEEP_SUCCESSFUL_RELEASE_RUNS } from './release-retention.js';

/**
 * 「保留最近 N 份产物」的 N。
 *
 * 唯一判定源是 `KEEP_SUCCESSFUL_RELEASE_RUNS` —— 它就是发布中心版本下拉给用户的
 * 回滚可达范围（routes/releases.ts 取该目标最近 N 条成功 run）。产物回收是这个数字的
 * 第二个消费方，各写一个字面量就会长出「UI 上还能选的版本，远端现场已经被删干净」
 * 的错位。本仓库前几轮 review 反复栽在同一判定分裂成多份上，故这里只做转发。
 *
 * 一条必须写明的诚实边界：generated-* 的回滚是**用历史 commit 重建 worktree 重发**
 * （新 releaseId、新目录），所以删掉旧产物**并不会**让回滚失效。N 对齐的真实意义是
 * 「你在 UI 上还能选的那些版本，远端现场还在，可查可比对」，外加保住 previous 兜底。
 * 别把它读成「不删就回滚不了」。
 */
export const RELEASE_ARTIFACT_KEEP_RECENT = KEEP_SUCCESSFUL_RELEASE_RUNS;

/**
 * CDS 自产发布产物的目录形状：`rel_` + 16 位十六进制，可带 `-auto-restore` 后缀。
 * 形状即归属 —— 不匹配的目录（运维手建、别的工具留下的）一个字节都不碰。
 */
export const RELEASE_ARTIFACT_ID_PATTERN = /^rel_[0-9a-f]{16}(-auto-restore)?$/;

const AUTO_RESTORE_SUFFIX = '-auto-restore';

export function isReleaseArtifactId(name: string): boolean {
  return RELEASE_ARTIFACT_ID_PATTERN.test(name);
}

/**
 * 远端目录路径的规范化身份 —— 「两个目标是不是指着同一个目录」的**唯一判据**。
 *
 * 事故值（Codex P1）：共用检测原本是 `a.trim() === b.trim()` 的裸字符串比较。
 * `/opt/site` 与 `/opt/site/` 都能通过 `validateReleaseStrategy`，却被判为「不共用」，
 * 于是共用保护被关掉，回收把**另一个目标**台账里的成品当孤儿删掉 —— 直接砍到别人的生产。
 * `/opt//site`、`/opt/site/.` 、`/opt/x/../site` 同理。
 *
 * 只做词法规范化，不解析符号链接：路径在远端，本机 realpath 无从谈起。因此这是
 * 「必要不充分」的判据 —— 它能认出所有词法上的同一目录，认不出软链指向同一处的两个路径。
 * 后者留在 debt 里；词法这一层至少不能自己先漏。
 */
export function normalizeRemoteDirectoryIdentity(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const absolute = trimmed.startsWith('/');
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // 绝对路径在根部吃掉多余的 `..`（`/..` 就是 `/`）；相对路径必须保留，
      // 否则 `../a` 与 `a` 会被判成同一个目录。
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined;
}

/**
 * 两个远端目录是否是同一个。空路径一律判 false —— 「都没配」不构成共用，
 * 那会把所有未配 publicDirectory 的目标互相绑定，共用保护反而误伤到不相干的目标。
 */
export function isSameRemoteDirectory(a: string, b: string): boolean {
  const left = normalizeRemoteDirectoryIdentity(a);
  const right = normalizeRemoteDirectoryIdentity(b);
  return Boolean(left) && left === right;
}

/**
 * 剥掉自动恢复后缀。剥出来的是**那次失败发布**的 id，不是线上真正在跑的版本 ——
 * 真正在跑的是它的 previousReleaseId。漂移判定不剥这一层，一次正常的自动恢复
 * 就会被报成生产漂移（假阳性），告警响几次人就学会忽略了。
 */
export function stripAutoRestoreSuffix(name: string): { id: string; autoRestore: boolean } {
  return name.endsWith(AUTO_RESTORE_SUFFIX)
    ? { id: name.slice(0, -AUTO_RESTORE_SUFFIX.length), autoRestore: true }
    : { id: name, autoRestore: false };
}

/** 远端一次只读盘点的结果。路径一律是远端复算出来的绝对路径，basename 才是 releaseId。 */
export interface RemoteReleaseInventory {
  /** readlink current 的原值；空字符串 = 链接不存在。 */
  currentTarget: string;
  /** readlink previous 的原值；空字符串 = 链接不存在。 */
  previousTarget: string;
  /** `.cds-releases/<targetId>/worktrees` 下的目录名。 */
  worktrees: string[];
  /** generated-static 的 `<publicDirectory>/.releases` 下的目录名；compose 模式恒为空。 */
  versions: string[];
  /** 远端复算出的产物根（观测用，删除命令不吃它，见文件头第 1 条）。 */
  releaseRoot: string;
  worktreeRoot: string;
}

export type ReleaseRemoteDriftStatus = 'in-sync' | 'drifted' | 'unknown' | 'not-applicable';

export interface ReleaseRemoteDrift {
  status: ReleaseRemoteDriftStatus;
  /** 远端 current 的 basename 原值（可能带 -auto-restore）。 */
  rawRemoteReleaseId?: string;
  /** 剥壳并回溯后、远端真正在跑的版本。 */
  remoteReleaseId?: string;
  /** CDS 认知的当前线上版本（最新一条成功 run）。 */
  expectedReleaseId?: string;
  message: string;
}

export interface ReleaseRemoteDriftInput {
  mode: ReleaseExecutionMode;
  /** 读不回来时传 undefined，一律判 unknown，绝不猜。 */
  inventory?: RemoteReleaseInventory;
  readError?: string;
  /** CDS 认知的当前线上版本；从未成功发布过时传空串。 */
  expectedReleaseId: string;
  /** 台账里已知的全部 releaseId，用来判「远端那一版根本不是 CDS 发的」。 */
  knownReleaseIds: readonly string[];
  /** releaseId → previousReleaseId。自动恢复剥壳后要靠它回溯真正在线的版本。 */
  previousByReleaseId?: Readonly<Record<string, string | undefined>>;
}

/**
 * 远端 current 与 CDS 认知是否一致。**只判定，不产出任何修正动作** ——
 * 计划第六节明确要求「只告警不自愈」：线上被人手工改过时，自动纠正等于毁灭现场证据。
 */
export function detectReleaseRemoteDrift(input: ReleaseRemoteDriftInput): ReleaseRemoteDrift {
  if (input.mode === 'existing-script') {
    return {
      status: 'not-applicable',
      message: 'existing-script 模式由项目自己的脚本发布，CDS 未在远端建立 current 指针，无从比对',
    };
  }
  if (!input.inventory) {
    return {
      status: 'unknown',
      message: `读不回远端发布现场${input.readError ? `：${input.readError}` : ''}`,
    };
  }
  const raw = path.posix.basename(input.inventory.currentTarget || '');
  if (!raw) {
    return { status: 'unknown', message: '远端 current 符号链接不存在，可能尚未通过 CDS 发布过' };
  }
  if (!isReleaseArtifactId(raw)) {
    return {
      status: 'drifted',
      rawRemoteReleaseId: raw,
      expectedReleaseId: input.expectedReleaseId || undefined,
      message: `远端 current 指向 ${raw}，不是 CDS 发布产物的形状，线上已被 CDS 之外的手段改过`,
    };
  }

  const { id: stripped, autoRestore } = stripAutoRestoreSuffix(raw);
  // 自动恢复目录是「那次失败发布」的派生名；线上真正跑的是它 previousReleaseId 指的版本。
  const restored = autoRestore ? input.previousByReleaseId?.[stripped] : undefined;
  const effective = autoRestore ? (restored || stripped) : stripped;
  const known = new Set(input.knownReleaseIds);

  if (input.expectedReleaseId && effective === input.expectedReleaseId) {
    return {
      status: 'in-sync',
      rawRemoteReleaseId: raw,
      remoteReleaseId: effective,
      expectedReleaseId: input.expectedReleaseId,
      message: autoRestore
        ? `远端与 CDS 一致（${effective}，经一次自动恢复回到该版本）`
        : `远端与 CDS 一致（${effective}）`,
    };
  }
  if (!known.has(effective)) {
    return {
      status: 'drifted',
      rawRemoteReleaseId: raw,
      remoteReleaseId: effective,
      expectedReleaseId: input.expectedReleaseId || undefined,
      message: `远端 current 指向 ${effective}，该版本不在 CDS 台账里，可能有人绕过 CDS 手工发布过`,
    };
  }
  return {
    status: 'drifted',
    rawRemoteReleaseId: raw,
    remoteReleaseId: effective,
    expectedReleaseId: input.expectedReleaseId || undefined,
    message: input.expectedReleaseId
      ? `远端 current 是 ${effective}，CDS 认为线上应是 ${input.expectedReleaseId}`
      : `远端 current 是 ${effective}，但 CDS 台账里没有任何成功发布记录`,
  };
}

export interface ReleaseArtifactRetentionInput {
  mode: ReleaseExecutionMode;
  /** 读不回来时传 undefined —— 宁可漏收，不可误删。 */
  inventory?: RemoteReleaseInventory;
  /** 该目标台账里的全部 run（顺序无所谓，内部自己按 startedAt 排）。 */
  ledgerRuns: ReadonlyArray<Pick<ReleaseRun, 'releaseId' | 'status' | 'startedAt'>>;
  /** 该目标上是否还有非终态 run。有则整轮跳过：发布中途删产物 = 和执行体抢同一棵 worktree。 */
  hasInFlightRun: boolean;
  drift: ReleaseRemoteDriftStatus;
  keepRecent?: number;
  maxRemovals?: number;
  /**
   * generated-static 的 publicDirectory 是否被同一个 CDS 内的其他启用目标共用。
   * worktree 路径天然按 targetId 隔离，`.releases` **不隔离** —— 两个目标配了同一个
   * publicDirectory 就会互删对方的成品。共用时退化为「只删本目标台账里的 id」。
   */
  publicDirectoryShared?: boolean;
}

export interface ReleaseArtifactRetentionPlan {
  /** 待删的 worktree 目录名（basename）。 */
  removeWorktrees: string[];
  /** 待删的 static 成品目录名（basename）。 */
  removeVersions: string[];
  /** 被保留的目录 → 原因，进日志/事件供复盘。 */
  keptReasons: Record<string, string>;
  /**
   * 满足删除条件却被 maxRemovals 截断的数量。必须如实报出 ——
   * 「清理跑过了」不等于「已经清干净了」（image-retention.ts 同款教训）。
   */
  deferred: number;
  /** 整轮被拦下的原因；有值时 remove 恒为空。 */
  skippedReason?: string;
}

const EMPTY_PLAN: Omit<ReleaseArtifactRetentionPlan, 'skippedReason'> = {
  removeWorktrees: [],
  removeVersions: [],
  keptReasons: {},
  deferred: 0,
};

/**
 * 算出本轮可回收的远端产物。安全边界任一命中即整轮或整项跳过，逐条都有回归断言：
 *
 *  1. existing-script：CDS 没在远端建过任何东西，一个字节都不碰；
 *  2. 读不回来（SSH 失败 / current 链接缺失 / 解析不出条目）：不删；
 *  3. 目标上有在途 run：不删；
 *  4. 漂移状态不是 in-sync：不删（drifted 时删除等于毁灭现场证据）；
 *  5. current / previous 指向的两份绝不删，**即使超出 N**，判据取远端实读值；
 *  6. 最近 N 份台账成功 run 及其 `-auto-restore` 派生目录不删；
 *  7. 形状不匹配的目录不碰；
 *  8. static 且 publicDirectory 被共用时，只删本目标台账内的 id，其余计入 deferred。
 */
export function computeReleaseArtifactRetentionPlan(
  input: ReleaseArtifactRetentionInput,
): ReleaseArtifactRetentionPlan {
  if (input.mode === 'existing-script') {
    return { ...EMPTY_PLAN, skippedReason: 'existing-script 模式下 CDS 未在远端建立任何产物，不做回收' };
  }
  if (input.hasInFlightRun) {
    return { ...EMPTY_PLAN, skippedReason: '该发布目标仍有进行中的发布，回收会与执行体抢同一棵 worktree' };
  }
  if (input.drift !== 'in-sync') {
    return { ...EMPTY_PLAN, skippedReason: `远端现场状态为 ${input.drift}，未确认一致前不回收` };
  }
  const inventory = input.inventory;
  if (!inventory) {
    return { ...EMPTY_PLAN, skippedReason: '读不回远端发布现场，宁可漏收也不误删' };
  }
  const currentName = path.posix.basename(inventory.currentTarget || '');
  if (!currentName) {
    return { ...EMPTY_PLAN, skippedReason: '远端 current 符号链接缺失，无法确认哪一份正在服务' };
  }

  const keepRecent = Math.max(0, Math.floor(input.keepRecent ?? RELEASE_ARTIFACT_KEEP_RECENT));
  const keptReasons: Record<string, string> = {};
  const protectedNames = new Map<string, string>();

  const ledgerIds = new Set(input.ledgerRuns.map((run) => run.releaseId));
  const recentSuccessful = input.ledgerRuns
    .filter(isSuccessfulReleaseRun)
    .slice()
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, keepRecent);
  for (const run of recentSuccessful) {
    const reason = `最近 ${keepRecent} 个可回滚版本之一（发布中心版本选择器里还看得见）`;
    protectedNames.set(run.releaseId, reason);
    // 派生目录跟着本体一起保：它是那次发布探测失败后自动恢复留下的现场。
    protectedNames.set(`${run.releaseId}${AUTO_RESTORE_SUFFIX}`, `${reason}的自动恢复现场`);
  }

  // 符号链接的保护理由**最后写**，故意覆盖「最近 N 之一」：复盘时「它正在服务」
  // 比「它排在第几」有用得多，而且这是唯一一条不依赖台账、取远端实读值的理由。
  const previousName = path.posix.basename(inventory.previousTarget || '');
  protectedNames.set(currentName, 'current 符号链接正指向它（线上正在服务的那一份）');
  if (previousName) {
    protectedNames.set(previousName, 'previous 符号链接指向它（发布脚本自己维护的人工回退兜底）');
  }

  const restrictStaticToLedger = input.mode === 'generated-static' && input.publicDirectoryShared === true;

  const pickCandidates = (names: readonly string[], kind: 'worktree' | 'version'): string[] => {
    const out: string[] = [];
    for (const name of names) {
      if (!isReleaseArtifactId(name)) {
        keptReasons[name] = '不是 CDS 发布产物的目录形状，不在回收范围';
        continue;
      }
      const protectedReason = protectedNames.get(name);
      if (protectedReason) {
        keptReasons[name] = protectedReason;
        continue;
      }
      if (kind === 'version' && restrictStaticToLedger && !ledgerIds.has(stripAutoRestoreSuffix(name).id)) {
        keptReasons[name] = '该发布目录与其他发布目标共用，且该版本不在本目标台账里，不越界删除';
        continue;
      }
      out.push(name);
    }
    return out.sort();
  };

  const worktreeCandidates = pickCandidates(inventory.worktrees, 'worktree');
  const versionCandidates = pickCandidates(inventory.versions, 'version');
  const total = worktreeCandidates.length + versionCandidates.length;
  const budget = Math.max(0, Math.floor(input.maxRemovals ?? total));
  const removeWorktrees = worktreeCandidates.slice(0, budget);
  const removeVersions = versionCandidates.slice(0, Math.max(0, budget - removeWorktrees.length));
  return {
    removeWorktrees,
    removeVersions,
    keptReasons,
    deferred: total - removeWorktrees.length - removeVersions.length,
  };
}

/**
 * 一次只读盘点命令：同一次 SSH 往返同时取回「回收候选（目录清单）」与「漂移输入
 * （两个符号链接）」。两件事拆成两条命令等于把生产机器多打一次，且两次之间线上
 * 可能已经变了，比对的就不是同一时刻的现场。
 *
 * 用 `readlink` 而不是 `readlink -f`：脚本写进去的就是绝对目标路径，`-f` 会继续
 * 往下解析，遇到 publicDirectory 自身是软链时读回的 basename 就对不上 releaseId。
 * 末尾 `exit 0` 是必需的 —— `ls` 在目录不存在时非零退出，会被 sshExec 判成命令失败，
 * 「这台机器还没发布过」于是变成「读不回来」。
 */
export function buildReleaseInventoryCommand(
  target: ReleaseTarget,
  strategy: ReleaseStrategy,
): string | null {
  if (!target.ssh) return null;
  if (strategy.mode === 'existing-script') return null;
  const appPath = shellQuote(target.ssh.appPath);
  const targetId = shellQuote(target.id);
  const head = `cd ${appPath} || exit 1; repo="$PWD"; parent="$(dirname "$repo")"; wt="$parent/.cds-releases/"${targetId}"/worktrees"`;
  if (strategy.mode === 'generated-compose') {
    return [
      head,
      'root="$(dirname "$wt")"',
      `printf 'CDS_RELEASE_ROOT=%s\\n' "$root"`,
      `printf 'CDS_RELEASE_WORKTREE_ROOT=%s\\n' "$wt"`,
      `printf 'CDS_RELEASE_CURRENT=%s\\n' "$(readlink "$root/current" 2>/dev/null)"`,
      `printf 'CDS_RELEASE_PREVIOUS=%s\\n' "$(readlink "$root/previous" 2>/dev/null)"`,
      `ls -1 "$wt" 2>/dev/null | sed 's/^/CDS_RELEASE_WORKTREE=/'`,
      'exit 0',
    ].join('; ');
  }
  const publishRoot = shellQuote(strategy.publicDirectory || '');
  return [
    head,
    `root=${publishRoot}`,
    `printf 'CDS_RELEASE_ROOT=%s\\n' "$root"`,
    `printf 'CDS_RELEASE_WORKTREE_ROOT=%s\\n' "$wt"`,
    `printf 'CDS_RELEASE_CURRENT=%s\\n' "$(readlink "$root/current" 2>/dev/null)"`,
    `printf 'CDS_RELEASE_PREVIOUS=%s\\n' "$(readlink "$root/previous" 2>/dev/null)"`,
    `ls -1 "$wt" 2>/dev/null | sed 's/^/CDS_RELEASE_WORKTREE=/'`,
    `ls -1 "$root/.releases" 2>/dev/null | sed 's/^/CDS_RELEASE_VERSION=/'`,
    'exit 0',
  ].join('; ');
}

export function parseRemoteReleaseInventory(stdout: string): RemoteReleaseInventory {
  const inventory: RemoteReleaseInventory = {
    currentTarget: '',
    previousTarget: '',
    worktrees: [],
    versions: [],
    releaseRoot: '',
    worktreeRoot: '',
  };
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'CDS_RELEASE_CURRENT') inventory.currentTarget = value;
    else if (key === 'CDS_RELEASE_PREVIOUS') inventory.previousTarget = value;
    else if (key === 'CDS_RELEASE_ROOT') inventory.releaseRoot = value;
    else if (key === 'CDS_RELEASE_WORKTREE_ROOT') inventory.worktreeRoot = value;
    else if (key === 'CDS_RELEASE_WORKTREE' && value) inventory.worktrees.push(value);
    else if (key === 'CDS_RELEASE_VERSION' && value) inventory.versions.push(value);
  }
  return inventory;
}

/**
 * 删除命令。worktree 必须走 `git worktree remove --force` 而不是裸 `rm -rf`：
 * 后者会在仓库的 `.git/worktrees/` 里留一堆孤儿元数据，久了 `git worktree add`
 * 会因为「已注册但目录不存在」直接失败（worktree.ts 为此专门有 prune 兜底）。
 * static 的成品目录没有 git 元数据，`rm -rf` 即可。
 *
 * 路径同样在远端复算（见文件头第 1 条），TS 侧只传经过形状校验的 basename。
 */
export function buildReleaseReclaimCommand(
  target: ReleaseTarget,
  strategy: ReleaseStrategy,
  plan: Pick<ReleaseArtifactRetentionPlan, 'removeWorktrees' | 'removeVersions'>,
): string | null {
  if (!target.ssh) return null;
  if (strategy.mode === 'existing-script') return null;
  const worktrees = plan.removeWorktrees.filter(isReleaseArtifactId);
  const versions = strategy.mode === 'generated-static' ? plan.removeVersions.filter(isReleaseArtifactId) : [];
  if (worktrees.length === 0 && versions.length === 0) return null;

  const appPath = shellQuote(target.ssh.appPath);
  const targetId = shellQuote(target.id);
  const parts = [
    `cd ${appPath} || exit 1`,
    'repo="$PWD"',
    'parent="$(dirname "$repo")"',
    `wt="$parent/.cds-releases/"${targetId}"/worktrees"`,
  ];
  if (worktrees.length > 0) {
    parts.push(
      `for name in ${worktrees.map(shellQuote).join(' ')}; do `
      + 'git -C "$repo" worktree remove --force "$wt/$name" >/dev/null 2>&1 || rm -rf "$wt/$name"; '
      + `printf 'CDS_RELEASE_RECLAIMED_WORKTREE=%s\\n' "$name"; done`,
    );
    parts.push('git -C "$repo" worktree prune >/dev/null 2>&1 || true');
  }
  if (versions.length > 0) {
    parts.push(`root=${shellQuote(strategy.publicDirectory || '')}`);
    parts.push(
      `for name in ${versions.map(shellQuote).join(' ')}; do `
      + 'rm -rf "$root/.releases/$name"; '
      + `printf 'CDS_RELEASE_RECLAIMED_VERSION=%s\\n' "$name"; done`,
    );
  }
  parts.push('exit 0');
  return parts.join('; ');
}
