/**
 * 部署镜像保留策略（2026-07-27 宕机复盘 P0：磁盘打满的真正引擎）。
 *
 * 事故复盘发现的机制——
 *   1. CDS 给每个部署版本按 `sha-<40hex>` 打 tag，宿主上一版一份镜像；
 *   2. 版本台账有上限（MAX_DEPLOYMENT_VERSIONS_PER_PROJECT=100），**淘汰记录时不删镜像**；
 *   3. janitor 每小时跑的是 `docker image prune -f`，只清**悬空**镜像——
 *      这些镜像有 tag，永不悬空。
 * 三者叠加 = 镜像单调增长且 CDS 一旦忘掉记录就再也认不出它们。生产宿主实测
 * 5099 个镜像 / containerd 159GB（占已用空间 56%）。
 *
 * 本模块是回收决策的**纯函数**：吃「台账里的镜像 + 宿主上的镜像 + 在用镜像」，
 * 吐「删除候选」。不碰 docker；执行器在每次普通/强制删除前均须重新核对原生引用。
 * ID、其他 tag 别名与计划形成后的新容器引用不能仅凭这张字符串快照排除。
 *
 * 安全边界（任一命中即不删）：
 *   - 被任何容器引用（含已停止容器——停止容器还能重启，删了镜像就起不来）
 *   - 每个 (分支, 服务) 最近 N 代
 *   - 不匹配 CDS 自己的 per-SHA tag 形状（别人的镜像、基础镜像一律不碰）
 */

/** 台账里一条「某分支某服务的某一代镜像」。 */
export interface LedgerImageRef {
  image: string;
  branchId: string;
  profileId: string;
  /** ISO 时间，用来定「最近 N 代」。 */
  createdAt: string;
}

export interface ImageRetentionInput {
  /** 来自 deploymentVersions 台账。 */
  ledger: LedgerImageRef[];
  /** 宿主上实际存在的镜像（`docker images --format '{{.Repository}}:{{.Tag}}'`）。 */
  hostImages: string[];
  /** 被任何容器（含已停止）引用的镜像（`docker ps -a --format '{{.Image}}'`）。 */
  inUseImages: string[];
  /** 每个 (分支, 服务) 保留几代。 */
  keepGenerations: number;
  /** 单轮最多删几个，避免一次 sweep 长时间占住 docker 与磁盘 IO。 */
  maxRemovals?: number;
}

export interface ImageRetentionPlan {
  /** 本轮建议删除的镜像（已按安全边界过滤、已截断到 maxRemovals）。 */
  remove: string[];
  /** 命中保留规则的镜像 → 保留原因（可观测，进日志/事件）。 */
  keptReasons: Record<string, string>;
  /** 满足删除条件但被 maxRemovals 截断的数量——必须被日志如实报出，
   *  否则「清理跑过了」会被误读成「已经清干净了」。 */
  deferred: number;
}

/**
 * CDS 自产镜像的 tag 形状：`<任意仓库>:sha-<40 位十六进制>`。
 * 只回收这个形状，等于把「别人的镜像 / 基础镜像 / 手工 tag」整体排除在外。
 */
export const CDS_SHA_TAG_PATTERN = /:sha-[0-9a-f]{40}$/;

export function isCdsShaTaggedImage(image: string): boolean {
  return CDS_SHA_TAG_PATTERN.test(image);
}

/** 归一化 docker 输出里的镜像引用（去空白；`<none>:<none>` 视为悬空，不归本模块管）。 */
function normalizeImages(list: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of list) {
    const s = (raw || '').trim();
    if (!s || s.startsWith('<none>')) continue;
    out.add(s);
  }
  return out;
}

/** 取镜像引用的仓库部分（去掉 `:tag`；仓库名里的 `/` 与端口号不受影响）。 */
export function imageRepository(image: string): string {
  const named = image.trim().split('@', 1)[0];
  const idx = named.lastIndexOf(':');
  return idx > named.lastIndexOf('/') ? named.slice(0, idx) : named;
}

/** 台账是 tag@digest、Docker 列表是 tag；仅在合法 digest 后缀时投影为同一 tag。
 * digest-only 没有足够信息指认宿主 tag，调用方必须保留整个对应仓库。
 */
function tagReference(image: string): string | undefined {
  const ref = image.trim();
  const at = ref.indexOf('@');
  const named = at < 0 ? ref : ref.slice(0, at);
  if (at >= 0 && !/^sha256:[0-9a-f]{64}$/.test(ref.slice(at + 1))) return undefined;
  return named.lastIndexOf(':') > named.lastIndexOf('/') ? named : undefined;
}

/**
 * 计算本轮可回收的镜像。
 *
 * 「台账外镜像」的处理（存量泄漏的主体）：宿主上形如 per-SHA 的镜像若在台账里找不到
 * （版本记录已被 100 条上限淘汰），CDS 已不再持有它的任何回滚价值——只要没有容器引用
 * 就可回收。这正是**只靠台账清理永远够不到**的那部分。
 *
 * 但仅凭 tag 形状回收是危险的（Codex 第二十八轮 P1）：同一台 docker daemon 上可能跑着
 * **多个 CDS master**（本仓库为此专门有 `computeCdsInstanceId`），也可能有别的应用用同样的
 * `sha-<40hex>` tag 约定。一个 master 扫一遍就把另一个 master 的回滚镜像缓存删了。
 * 故台账外回收**必须限定在本 master 部署过的仓库集合**内：别的 master 只要部署的是别的
 * 仓库就完全不受影响。
 *
 * 残留边界（已知、可接受）：两个 master 在同一 daemon 上部署**同一个仓库**时仍会互相
 * 回收对方的台账外镜像。这类镜像是可从 registry 重新拉取的缓存（不是数据），且该拓扑
 * 本身即共享构建缓存；真要严格隔离需要给镜像打实例 label，而镜像由 CI 构建、CDS 只负责
 * 拉取，没有打标时机。
 */
export function computeImageRetentionPlan(input: ImageRetentionInput): ImageRetentionPlan {
  const keepGenerations = Math.max(1, Math.floor(input.keepGenerations));
  const inUse = new Set<string>();
  const protectedRepos = new Set<string>();
  for (const ref of normalizeImages(input.inUseImages)) {
    const tag = tagReference(ref);
    if (tag) inUse.add(tag);
    else if (ref.includes('@')) protectedRepos.add(imageRepository(ref));
  }
  const hostImages = normalizeImages(input.hostImages);
  const keptReasons: Record<string, string> = {};

  // 1. 每个 (分支, 服务) 的最近 N 代 —— 台账里同一组按时间倒序取前 N。
  const byGroup = new Map<string, LedgerImageRef[]>();
  for (const ref of input.ledger) {
    if (!ref.image) continue;
    const key = `${ref.branchId}\u0000${ref.profileId}`; // 转义写法：字面 NUL 会让 git 把整个 .ts 当二进制，diff/blame/评审全瞎（Codex 第三十四轮 P2）
    const arr = byGroup.get(key);
    if (arr) arr.push(ref); else byGroup.set(key, [ref]);
  }
  const keepByGeneration = new Set<string>();
  for (const [, refs] of byGroup) {
    const sorted = [...refs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const seen = new Set<string>();
    for (const ref of sorted) {
      if (seen.size >= keepGenerations) break;
      const tag = tagReference(ref.image);
      const identity = tag || ref.image.trim();
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!tag) {
        protectedRepos.add(imageRepository(ref.image));
        continue;
      }
      keepByGeneration.add(tag);
      keptReasons[tag] = `最近 ${keepGenerations} 代之一（${ref.branchId}/${ref.profileId}）`;
    }
  }

  // 2. 归属边界：只回收**本 master 部署过的仓库**下的 per-SHA 镜像。
  //    共享 docker daemon 的多 master 拓扑下，这条是别人镜像不被误删的唯一依据。
  const ownedRepos = new Set(input.ledger.filter((r) => !!tagReference(r.image)).map((r) => imageRepository(r.image)).filter(Boolean));

  // 3. 候选 = 本 master 仓库下的 per-SHA 镜像（台账内外都算，台账外的正是存量泄漏主体）
  const candidates: string[] = [];
  for (const image of hostImages) {
    if (!isCdsShaTaggedImage(image)) {
      keptReasons[image] = '非 CDS per-SHA 镜像，不在回收范围';
      continue;
    }
    if (!ownedRepos.has(imageRepository(image))) {
      keptReasons[image] = '仓库不属于本 CDS 实例的部署台账（可能是同宿主其他 master 或其他应用的镜像）';
      continue;
    }
    if (protectedRepos.has(imageRepository(image))) {
      keptReasons[image] = '近期或在用引用无法指认宿主 tag，保守保留整个仓库';
      continue;
    }
    if (inUse.has(image)) {
      keptReasons[image] = '被容器引用（含已停止容器，删了就无法重启）';
      continue;
    }
    if (keepByGeneration.has(image)) continue;
    candidates.push(image);
  }

  // 3. 稳定排序（同输入同输出，便于测试与复盘），再按单轮上限截断
  candidates.sort();
  const maxRemovals = Math.max(0, Math.floor(input.maxRemovals ?? candidates.length));
  const remove = candidates.slice(0, maxRemovals);
  return { remove, keptReasons, deferred: candidates.length - remove.length };
}
