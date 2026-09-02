/**
 * project-scope —— 「这次 push 该不该惊动这个项目」的唯一判据。
 *
 * ## 为什么需要它
 *
 * 一个仓库可以同时喂多个 CDS 项目（本仓库就是：主项目 prd-agent 与自托管项目
 * cds-self 共用 inernoro/prd_agent）。今天 push 分发只认第一个项目，作用域这一层
 * 压根不存在，于是只改 `cds/**` 的一次提交也会把主项目五个服务全走一遍部署。
 *
 * 服务级早就有 `buildScope`（声明「CI 构建这个组件的输入路径」，逐条对齐
 * workflow 的 path filter），用来判断「这个组件这次变没变、镜像能不能复用」。
 * 项目级要问的是同一个问题、粗一档：**这个项目关不关心这批改动**。所以项目
 * 作用域**不新写一份声明**，直接取该项目名下全部服务 buildScope 的并集
 * （predicate-and-wiring-discipline 形状 3：同一个判断不许有第二份来源）。
 *
 * ## 两条刻意的取舍
 *
 * 1. **未声明即全通配**。项目名下没有任何 buildScope 时，作用域为空，判定恒为
 *    命中 —— 与今天的行为逐字节一致，零回归。要收窄就去声明 buildScope。
 * 2. **判不准时 fail-open（算命中）**。漏判的后果是「该部署的项目静默不动」，
 *    那是最难发现的一类退化；误判的后果只是多部署一次，可见、可接受。所以
 *    路径清单为空（GitHub 没给出改动文件，比如提交数超限被截断）时一律命中。
 *
 * ## 匹配语义
 *
 * buildScope 条目对齐 GitHub Actions 的 path filter 写法，实际出现的形态就三种：
 * `prd-api/**`、`llmgw/serving/**`、`.github/workflows/branch-image.yml`。
 * 因此支持 `**`（跨目录）、`*`（单层，不跨 `/`）、`?`，另加一条人性化规则：
 * **不含通配符的条目按「它自己或它下面的一切」匹配**，因为写 `cds` 的人想表达
 * 的一定是 `cds/` 整棵树，而不是一个叫 cds 的文件。这条规则只会让作用域变宽，
 * 与 fail-open 的方向一致。
 *
 * 纯函数：不读文件、不查 state、不碰 docker，可直接单测。
 */

import { normalizeBuildScope } from './prebuilt-reuse.js';

/** 判定所需的最小服务形状：只看它声明的构建输入范围。 */
export interface ScopedProfileLike {
  buildScope?: string[];
  /** 各部署模式各自可声明 buildScope，取并集时一并计入。 */
  deployModes?: Record<string, { buildScope?: string[] } | undefined>;
}

export interface ProjectScopeDecision {
  /** 本次改动是否落进该项目的作用域。未声明作用域时恒为 true。 */
  matched: boolean;
  /** 该项目声明的作用域（并集、去重）。空数组 = 未声明 = 全通配。 */
  scope: string[];
  /** true 表示「没有声明作用域」，与「声明了但没命中」是两回事。 */
  unscoped: boolean;
  /** 命中的改动路径样例，最多几条，供投递记录写清楚「凭什么算命中」。 */
  matchedPaths: string[];
  /** 人话原因，直接写进 webhook 投递记录。 */
  reason: string;
}

/** 匹配时最多回带几条命中样例 —— 只为可读，不参与判定。 */
const MAX_MATCHED_SAMPLES = 5;

/**
 * 取一个项目的作用域：名下全部服务 buildScope（含各部署模式声明）的并集。
 *
 * 归一化复用 `normalizeBuildScope`（同一份判据）：它会拒掉仓库根等价物
 * （`.` / `**` 之类）与越界路径。被拒的条目对本模块的语义恰好也是「等于没声明」。
 *
 * **只要有一个服务没声明范围，整个项目就退回全通配**（返回空数组，2026-09-02
 * Codex P1）。取并集看着自然，但半划状态下是错的：项目里 A 服务划了 `prd-api/**`、
 * B 服务没划，并集就是 `prd-api/**`，于是只改到 B 目录的推送被判「未波及」，
 * **整个项目静默不部署**——而没划范围的那个服务本来的语义恰恰是「什么都可能影响我」。
 * 失败方向必须朝安全的一边：宁可多建一次，不能悄悄不建。
 */
/** 这份声明里到底有没有写东西（区分「没声明」与「声明了但被归一化拒掉」）。 */
function hasDeclaredEntries(candidate: readonly string[] | undefined): boolean {
  return Array.isArray(candidate)
    && candidate.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

export function resolveProjectScope(profiles: readonly ScopedProfileLike[] | undefined): string[] {
  const list = profiles || [];
  const out = new Set<string>();
  for (const profile of list) {
    const declared = new Set<string>();
    for (const candidate of [profile.buildScope, ...Object.values(profile.deployModes || {}).map((m) => m?.buildScope)]) {
      const normalized = normalizeBuildScope(candidate);
      if (!normalized) {
        /*
         * 「压根没声明」与「声明了但被拒」不是一回事（2026-09-02 Codex P1）。
         *
         * 被拒的那些（`**` / `.` 这类仓库根等价物、绝对路径、含 `..`）是用户**显式
         * 写下的**声明，语义是「整个仓库都可能影响我」。让同一条服务上另一份更窄的
         * 声明把它顶掉，就把 fail-open 反转成了 fail-closed：顶层写着 `**`、某个
         * 部署模式写着 `cds/**`，结果只留 `cds/**`，改别处就静默不部署。
         * 所以只要出现一条被拒的声明，整个项目退回全通配。
         */
        if (hasDeclaredEntries(candidate)) return [];
        continue;
      }
      for (const entry of normalized) declared.add(entry);
    }
    // 这个服务一条都没声明 → 它可能被任何改动影响 → 项目级判据只能全通配
    if (declared.size === 0) return [];
    for (const entry of declared) out.add(entry);
  }
  return [...out];
}

/** 把一条 buildScope 条目编译成正则。语义见文件头注释。 */
export function scopeEntryToRegExp(entry: string): RegExp {
  const trimmed = entry.replace(/^\.\//, '').replace(/\/+$/, '');
  const hasWildcard = /[*?]/.test(trimmed);
  if (!hasWildcard) {
    // 不含通配符：它自己，或它下面的一切。
    const literal = escapeRegExp(trimmed);
    return new RegExp(`^${literal}(?:/.*)?$`);
  }
  let pattern = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '*') {
      if (trimmed[i + 1] === '*') {
        // `**` 跨目录。`foo/**` 要能匹配 foo 自己下面的直接文件，也要能匹配深层，
        // 所以把前面那个 `/` 一起吃掉后允许空串。
        i += 1;
        if (pattern.endsWith('/')) {
          pattern = `${pattern.slice(0, -1)}(?:/.*)?`;
        } else {
          pattern += '.*';
        }
        // 紧跟的 `/` 已被上面的可选组吸收，跳过它，避免出现 `(?:/.*)?/`
        if (trimmed[i + 1] === '/') i += 1;
        continue;
      }
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') { pattern += '[^/]'; continue; }
    pattern += escapeRegExp(char);
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 单条路径是否落进作用域。作用域为空时恒 true（未声明 = 全通配）。 */
export function pathInScope(scope: readonly string[], filePath: string): boolean {
  if (scope.length === 0) return true;
  const normalized = String(filePath || '').trim().replace(/^\/+/, '').replace(/^\.\//, '');
  if (!normalized) return false;
  return scope.some((entry) => scopeEntryToRegExp(entry).test(normalized));
}

/**
 * 主判据：这批改动该不该惊动这个作用域的项目。
 */
export function decideProjectScope(
  scope: readonly string[],
  changedPaths: readonly string[],
): ProjectScopeDecision {
  const scopeList = [...scope];
  if (scopeList.length === 0) {
    return {
      matched: true,
      scope: scopeList,
      unscoped: true,
      matchedPaths: [],
      reason: '该项目未声明构建输入范围，按全通配处理（与未启用作用域时行为一致）',
    };
  }
  const paths = (changedPaths || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (paths.length === 0) {
    // GitHub 在提交数超限时不给完整改动清单。判不准就算命中：
    // 漏判是静默退化，误判只是多部署一次。
    return {
      matched: true,
      scope: scopeList,
      unscoped: false,
      matchedPaths: [],
      reason: '本次 push 没有可用的改动文件清单，无法判定范围，按命中处理',
    };
  }
  const matchedPaths: string[] = [];
  for (const path of paths) {
    if (!pathInScope(scopeList, path)) continue;
    if (matchedPaths.length < MAX_MATCHED_SAMPLES) matchedPaths.push(path);
    else break;
  }
  if (matchedPaths.length > 0) {
    return {
      matched: true,
      scope: scopeList,
      unscoped: false,
      matchedPaths,
      reason: `改动命中项目构建范围（例如 ${matchedPaths.join('、')}）`,
    };
  }
  return {
    matched: false,
    scope: scopeList,
    unscoped: false,
    matchedPaths: [],
    reason: `本次 ${paths.length} 个改动文件都不在该项目的构建范围（${scopeList.join(' ')}）内`,
  };
}
