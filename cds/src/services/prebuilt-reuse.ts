/**
 * 预构建镜像缺失时的「复用上一版」判定（2026-07-27 宕机复盘 P1）。
 *
 * 事故的临门一脚：某次 push 只改了 `cds/**`，CI 因组件代码未变而**正确地**跳过了
 * prd-admin / prd-api / llmgw-web 的镜像构建。但 CDS 按 `sha-<40hex>` 去拉这些组件
 * 镜像扑空后，一律当成「需要在宿主全量重编」，于是三个组件同时在宿主源码构建，
 * 把本已 100% 的根盘彻底压垮。
 *
 * 关键洞察：**拉不到 per-SHA 镜像 = CI 没为这个 sha 构建过该组件**，只有两种可能——
 *   (a) 该组件本次没有代码变更（path filter 跳过）→ 上一版镜像与本次代码**逐字节等价**，
 *       复用它既正确又免掉一次宿主重编；
 *   (b) CI 还没跑完 / CI 失败 → 上一版镜像与本次代码**不等价**，复用会静默部署旧代码。
 *
 * 两者必须区分开，否则要么白白重编（现状），要么静默发旧代码（比重编更糟）。
 * 区分方法不靠猜：镜像 tag 里带着构建它的那个 commit sha，直接在 worktree 里
 * `git diff <旧sha> <当前sha> -- <该组件的 workDir>`——没有差异就是情形 (a)，
 * 有差异或查不出来就走原来的源码编译路径。
 *
 * 本模块只做**纯判定**（可单测），真正的 git 调用与 docker 拉取由调用方注入。
 */

/** CDS/CI 给部署镜像打的 tag 形状：`sha-<40 位十六进制>`。 */
const SHA_TAG_PATTERN = /:sha-([0-9a-f]{40})$/;

/** 从镜像引用里取出构建它的 commit sha；不是 per-SHA tag 时返回 null。 */
export function shaFromImageTag(image: string): string | null {
  const m = SHA_TAG_PATTERN.exec((image || '').trim());
  return m ? m[1] : null;
}

/** 取镜像引用的仓库部分（去掉 `:tag`；仓库名里的 `/` 与端口号不受影响）。 */
export function imageRepositoryOf(image: string): string {
  const s = (image || '').trim();
  const idx = s.lastIndexOf(':');
  return idx > s.lastIndexOf('/') ? s.slice(0, idx) : s;
}

export interface ReuseCandidate {
  image: string;
  /** 构建该镜像的 commit sha。 */
  sha: string;
  /** 候选来源，仅用于日志/事件，让用户看得懂复用的是哪一版。 */
  origin: 'running' | 'ledger';
}

export interface CollectReuseCandidatesInput {
  /** 本次**想拉但拉不到**的镜像（决定了仓库归属与目标 sha）。 */
  intendedImage: string;
  /** 该分支该服务当前正在跑的镜像（ServiceState.deployedImage）。 */
  runningImage?: string | null;
  /** 版本台账里该分支该服务的历史构建镜像，**按时间由新到旧**。 */
  ledgerImages?: readonly string[];
}

/**
 * 收集「可以考虑复用」的候选，按优先级排序：当前在跑的那一版优先（它此刻就是活的、
 * 一定拉得到），其次是台账里由新到旧的历史版本。
 *
 * 三条硬过滤，任一不满足即不是候选：
 *  1. 必须与目标镜像**同仓库**——跨仓库复用等于把别的组件的镜像当成本组件跑；
 *  2. 必须是 per-SHA tag——`:latest` / `:main` 这类浮动 tag 指向什么内容不确定，
 *     无法据此断言「与本次代码等价」；
 *  3. 不能等于目标 sha 本身——那正是拉不到的那一个。
 */
export function collectReuseCandidates(input: CollectReuseCandidatesInput): ReuseCandidate[] {
  const targetSha = shaFromImageTag(input.intendedImage);
  const repo = imageRepositoryOf(input.intendedImage);
  if (!repo) return [];
  const out: ReuseCandidate[] = [];
  const seen = new Set<string>();
  const consider = (image: string | null | undefined, origin: ReuseCandidate['origin']): void => {
    const s = (image || '').trim();
    if (!s || seen.has(s)) return;
    if (imageRepositoryOf(s) !== repo) return;
    const sha = shaFromImageTag(s);
    if (!sha) return;
    if (targetSha && sha === targetSha) return;
    seen.add(s);
    out.push({ image: s, sha, origin });
  };
  consider(input.runningImage, 'running');
  for (const im of input.ledgerImages || []) consider(im, 'ledger');
  return out;
}

export interface PickReusableInput {
  candidates: readonly ReuseCandidate[];
  /**
   * 该组件在这两个 commit 之间是否**没有**任何改动。查不出来（git 失败、sha 不在
   * 本地历史里）必须返回 false —— 判不出来就当作有变更，宁可多编一次也不发旧代码。
   */
  isComponentUnchanged: (fromSha: string) => boolean;
}

/**
 * 选出第一个「与本次代码等价」的候选。全部不等价（或没有候选）返回 null，
 * 调用方照旧走源码编译——本模块只做减法，绝不改变「实在不行就重编」的兜底。
 */
export function pickReusableImage(input: PickReusableInput): ReuseCandidate | null {
  for (const cand of input.candidates) {
    if (input.isComponentUnchanged(cand.sha)) return cand;
  }
  return null;
}
