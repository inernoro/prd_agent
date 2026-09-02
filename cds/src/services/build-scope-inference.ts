/**
 * 构建范围的推断 —— 让「划范围」这件事不必由用户从空白开始。
 *
 * ## 为什么要有它
 *
 * 一个仓库喂多个项目之后，「本项目关心哪些路径」变成了要紧事：没声明就等于全通配，
 * 任何一次推送都把所有项目重建一遍。但把这件事做成一个空文本框，就是把系统已经知道
 * 的答案硬塞回给用户去猜——他要先想「填什么」，填完还要担心「填得对不对」。
 *
 * 系统其实知道。每个服务的启动命令第一句几乎都是 `cd <目录> &&`，compose 上的
 * `cds.build-scope` 标签也会带上来。所以这里把这些线索翻译成建议，界面拿它当默认值，
 * 用户只需要点一下确认，或者改。
 *
 * ## 一条硬边界：推断只做建议，不自动生效
 *
 * 分发判据（这次推送有没有波及这个项目）读的是**已声明**的范围，空 = 全通配 = 兜底
 * 全建。推断值绝不能悄悄顶上去：猜窄了会让某个项目的推送被判成「未波及」而静默跳过
 * 部署，分支停在旧行为上且没有任何信号——这正是这一块最不能引入的失败模式。
 * 所以推断的产物是「建议 + 依据」，落不落地由人点那一下。
 *
 * 纯函数：不读状态、不碰磁盘、不碰网络。
 */

/** 一条建议：范围本身，加上「凭什么这么说」。 */
export interface ScopeGuess {
  scope: string[];
  /** declared = 本来就声明了，不是猜的 */
  source: 'declared' | 'command' | 'workDir';
  /** 给人看的依据，界面直接显示，别各自再拼一份 */
  why: string;
}

/** 推断只认得下面这些线索。取字段而不是取整个 BuildProfile，便于单测与复用。 */
export interface ScopeSourceProfile {
  id: string;
  name?: string;
  buildScope?: string[];
  workDir?: string;
  command?: string;
  deployModes?: Record<string, { buildScope?: string[]; command?: string } | undefined>;
}

/** 容器里仓库根的挂载点。命令里写的 `/repo/llmgw/web` 说的就是仓库内的 `llmgw/web`。 */
const CONTAINER_REPO_ROOT = /^\/repo\//;

/**
 * 把命令里 `cd X` 的那个 X 归一成仓库内相对目录。归不出来就返回 null。
 *
 * 拒收的几类：仓库根自身（`.` / `/repo`）—— 那等于全通配，做不出任何区分；
 * 含 `..` 的（跳出仓库，语义不明）；`/repo/` 之外的绝对路径（那是容器里的别处，
 * 与仓库文件无关，比如 `cd /tmp`）。
 */
export function normalizeRepoRelativeDir(raw: string): string | null {
  let dir = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!dir) return null;
  if (dir === '/repo' || dir === '/repo/') return null;
  if (CONTAINER_REPO_ROOT.test(dir)) dir = dir.replace(CONTAINER_REPO_ROOT, '');
  if (dir.startsWith('/')) return null;
  dir = dir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!dir || dir === '.') return null;
  if (dir.split('/').some((seg) => seg === '..')) return null;
  return dir;
}

/**
 * 从启动命令里读出服务待的目录。
 *
 * 只认**第一条** `cd`：命令后面常有 `cd dist && node server.js` 这种二次切换，
 * 那是产物目录不是源码目录，跟着它走会把范围缩到一个构建产物上。
 */
export function dirFromCommand(command: string | undefined): string | null {
  if (!command) return null;
  const match = /(?:^|[;&|]|\bthen\b|\bdo\b)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
  if (!match) return null;
  return normalizeRepoRelativeDir(match[1]);
}

/** 收集一个 profile 上所有**已声明**的范围（含各部署模式），去重。 */
export function declaredScope(profile: ScopeSourceProfile): string[] {
  const out = new Set<string>();
  for (const list of [profile.buildScope, ...Object.values(profile.deployModes || {}).map((m) => m?.buildScope)]) {
    for (const entry of list || []) {
      const trimmed = typeof entry === 'string' ? entry.trim() : '';
      if (trimmed) out.add(trimmed);
    }
  }
  return [...out];
}

/**
 * 给一个服务出一条范围建议。
 *
 * 优先级：已声明 > 启动命令里的 `cd` > workDir。已声明就直接回声明值并标 `declared`
 * —— 那不是猜的，界面据此不该再劝用户去填。
 */
export function inferProfileScope(profile: ScopeSourceProfile): ScopeGuess | null {
  const declared = declaredScope(profile);
  if (declared.length > 0) {
    return { scope: declared, source: 'declared', why: '已经声明过' };
  }

  // 各部署模式的命令也算数：dev 模式常带 cd，而 express 模式只有镜像没有命令。
  const commands = [profile.command, ...Object.values(profile.deployModes || {}).map((m) => m?.command)];
  for (const command of commands) {
    const dir = dirFromCommand(command);
    if (dir) {
      return { scope: [`${dir}/**`], source: 'command', why: `启动命令里 cd ${dir}` };
    }
  }

  const workDir = normalizeRepoRelativeDir(profile.workDir || '');
  if (workDir) {
    return { scope: [`${workDir}/**`], source: 'workDir', why: `工作目录是 ${workDir}` };
  }
  return null;
}

export interface ProjectScopeSuggestion {
  /** 建议的项目级范围（各服务建议的并集） */
  scope: string[];
  /** 已经声明过范围的服务数 */
  declaredCount: number;
  /** 靠推断才有范围的服务数 —— 这些就是「点一下就能固定下来」的部分 */
  guessedCount: number;
  /** 一句依据，界面直接用 */
  why: string;
  /** 逐个服务的明细，供对话框预勾选 */
  perProfile: Array<{ profileId: string; name: string; guess: ScopeGuess | null }>;
}

/**
 * 把一个项目名下所有服务的建议汇成项目级建议。
 *
 * 只要有**任何一个**服务连线索都没有，就不出项目级建议：那种情况下按已知的几个服务
 * 收窄范围，会把那个未知服务需要的路径挡在外面，推送到它就静默不重建。宁可继续全通配。
 */
export function inferProjectScope(profiles: readonly ScopeSourceProfile[]): ProjectScopeSuggestion | null {
  if (profiles.length === 0) return null;
  const perProfile = profiles.map((p) => ({
    profileId: p.id,
    name: p.name || p.id,
    guess: inferProfileScope(p),
  }));
  if (perProfile.some((entry) => entry.guess === null)) return null;

  const scope = new Set<string>();
  let declaredCount = 0;
  let guessedCount = 0;
  for (const entry of perProfile) {
    const guess = entry.guess!;
    for (const s of guess.scope) scope.add(s);
    if (guess.source === 'declared') declaredCount += 1;
    else guessedCount += 1;
  }
  if (scope.size === 0) return null;

  // 依据要具体到能核对。「按启动命令看出来的」这种话用户没法验证，
  // 「启动命令里 cd cds」他扫一眼就知道对不对 —— 后者才消得掉「填得对不对」的疑虑。
  const guessed = perProfile.filter((e) => e.guess && e.guess.source !== 'declared');
  const why = guessedCount === 0
    ? '全部来自已声明的范围'
    : guessed.length === 1
      ? guessed[0].guess!.why
      : guessed.map((e) => `${e.name}：${e.guess!.why}`).join('；');
  return { scope: [...scope], declaredCount, guessedCount, why, perProfile };
}
