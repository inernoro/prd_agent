/**
 * CDS 自更新失败归因（唯一判定源）。
 *
 * 背景：CDS 的「更新」不是下载一个包重启，而是在生产机上**重新构建整个 CDS**——
 * git fetch → pnpm install → 前后端 tsc --noEmit → esbuild → dist 原子切换 → 重启。
 * 任何一步失败都会中止。此前每个失败点各自拼一句中文壳，把 git / pnpm / tsc / esbuild
 * 的**原始英文 stderr** 截断后原样塞进 message：
 *
 *   拉取远程更新失败: fatal: could not read Username for 'https://github.com'...
 *   self-update 已中止 — 新代码未通过预检: <一大段 tsc 英文报错>
 *
 * 壳是中文，芯是英文，而芯才是需要读懂的那部分。用户 2026-07-30 的原话是
 * 「为什么 cds 普通更新总是有问题报错，还是英文错」。
 *
 * 本模块把失败收敛成「一句中文主要原因 + 一条可执行的恢复动作」，英文原文降级到
 * 独立的 raw 字段由前端折叠展示。对齐 rule.platform.production-release-safety §5
 * 「错误必须收敛为一个主要原因」，与 scripts/llmgw-prod-preflight.py 的
 * _diagnose_route_self_test_failure 同一套纪律。
 *
 * 判定必须集中在这里（predicate-and-wiring-discipline 形状 3：判据分裂会各自漂移）。
 * 新增失败形态只改本文件 + 补一条守卫用例，不要在调用点就地判断。
 */

/** 失败发生在哪一步。与 SSE step 名对齐，便于前端高亮对应阶段。 */
export type SelfUpdateFailureStage =
  | 'concurrency'
  | 'fetch'
  | 'gate'
  | 'checkout'
  | 'reset'
  | 'install'
  | 'typecheck'
  | 'build'
  | 'swap'
  | 'restart'
  | 'unknown';

export interface SelfUpdateFailureDiagnosis {
  stage: SelfUpdateFailureStage;
  /** 一句话中文主要原因——前端的主文案。 */
  cause: string;
  /** 一条可执行的恢复动作。永远非空：不许只报错不给出路。 */
  nextAction: string;
  /** 外部工具原始输出（通常是英文）。前端降级到「展开详情」，不做主文案。 */
  raw: string;
}

export interface SelfUpdateFailureInput {
  stage: SelfUpdateFailureStage;
  /** 外部命令的 stdout+stderr 合并输出。 */
  raw?: string;
  /** 闸门类失败的机器码（如 non_fast_forward_update_requires_intent）。 */
  code?: string;
  /** 调用点已有的中文说明（闸门 message）。有 code 时优先作为 cause。 */
  message?: string;
  /** 目标分支，用于把恢复动作写具体。 */
  branch?: string;
}

/** 闸门 code → 恢复动作。message 本身已是中文，这里只补「下一步做什么」。 */
const GATE_NEXT_ACTIONS: Record<string, string> = {
  non_fast_forward_update_requires_intent:
    '这不是故障，是防覆盖闸门：目标版本不包含当前正在跑的提交，直接切过去会丢掉已部署的代码。'
    + '确认要切就走「CDS 系统设置 → 更新与重启 → 强制更新」，选「发布新版本」或「回滚旧版本」并填写原因；'
    + '若本意只是拉取当前分支的最新提交，请把目标分支改回当前分支。',
  invalid_transition_intent: '把切换意图改成 release（发布新版本）或 rollback（回滚旧版本）两者之一，再重试。',
  expected_from_sha_required:
    '先读一次 CDS 自身状态拿到当前提交 SHA，随请求回传 expectedFromSha，确保不是基于过期状态覆盖生产。',
  expected_from_sha_mismatch:
    '当前 CDS 提交已经变了（可能有人刚更新过）。刷新页面重新读取状态后再发起本次切换。',
  transition_reason_required: '补一条 8-300 字符的切换原因（写清为什么要发布或回滚），再重试。',
  invalid_transition_sha: '目标版本号不合法，确认分支名或提交 SHA 拼写无误后重试。',
};

/**
 * 英文原文 → 中文归因的模式表。**顺序即优先级**：越具体的排越前面。
 *
 * 每条只做一件事：认出一种外部工具的失败口吻，翻成一句人话 + 一条下一步。
 */
interface FailurePattern {
  /** 命中任一即算这一类。全部小写匹配。 */
  match: string[];
  /** 限定只在这些阶段生效；省略表示不限阶段。 */
  stages?: SelfUpdateFailureStage[];
  cause: string;
  nextAction: string;
}

const FAILURE_PATTERNS: FailurePattern[] = [
  // ── 磁盘 / 内存：最优先，因为它会伪装成任意一步的失败 ──────────────
  {
    match: ['no space left on device', 'enospc'],
    cause: '生产机磁盘已满，构建产物写不下去。',
    nextAction: '先清理磁盘（`docker system prune -f` 清无用镜像层，或清理旧构建产物），确认剩余空间后重试更新。',
  },
  {
    match: ['javascript heap out of memory', 'out of memory', 'killed'],
    cause: '构建过程内存耗尽被系统杀掉，通常是编译前端时机器内存不够。',
    nextAction: '确认生产机空闲内存；必要时先停掉占内存的分支预览容器再重试更新。',
  },

  // ── git 认证 / 网络 ────────────────────────────────────────────────
  {
    match: [
      'could not read username',
      'authentication failed',
      'permission denied (publickey)',
      'support for password authentication was removed',
      'terminal prompts disabled',
      'invalid username or password',
    ],
    cause: 'git 拉取时认证失败，CDS 没能拿到访问仓库的有效凭据。',
    nextAction: '到「CDS 系统设置 → GitHub」检查 App 安装与 token 是否过期；重新授权后重试更新。',
  },
  {
    match: [
      'could not resolve host',
      'connection timed out',
      'failed to connect',
      'rpc failed',
      'early eof',
      'unable to access',
      'ssl_error',
      'tls handshake',
      'network is unreachable',
    ],
    cause: '生产机连不上代码仓库，属于网络或上游可用性问题，不是代码问题。',
    nextAction: '确认生产机到 GitHub 的出网正常（可在机器上试 `git ls-remote`），网络恢复后重试更新。',
  },
  {
    match: ["couldn't find remote ref", 'did not match any file', 'unknown revision', 'pathspec'],
    cause: '目标分支在远程不存在，可能已被合并后删除或名字写错了。',
    nextAction: '在更新面板重新选一个存在的分支（一般是 main），再重试。',
  },
  {
    match: ['your local changes would be overwritten', 'untracked working tree files', 'cannot lock ref', 'index.lock'],
    cause: '生产机上的代码目录不干净（有未提交改动或残留的 git 锁），git 拒绝覆盖。',
    nextAction: '登录生产机检查 CDS 仓库目录状态：确认没有需要保留的本地改动后清理干净，再重试更新。',
  },

  // ── 依赖安装 ──────────────────────────────────────────────────────
  {
    match: ['err_pnpm_outdated_lockfile', 'frozen-lockfile', 'lockfile is not up to date'],
    cause: 'package.json 与 pnpm-lock.yaml 对不上，锁文件没跟着依赖改动一起提交。',
    nextAction: '在开发端跑一次 `pnpm install` 生成新的 pnpm-lock.yaml 并提交，推送后再更新。',
  },
  {
    match: ['err_pnpm_ignored_builds', 'ignored build scripts'],
    cause: 'pnpm 拦下了未批准的原生依赖构建脚本，放行会导致启动时崩溃循环。',
    nextAction: '在开发端用 `pnpm approve-builds` 批准这些依赖并提交配置，推送后再更新。',
  },
  {
    match: ['err_pnpm_', 'eresolve', 'peer dep'],
    stages: ['install'],
    cause: '依赖安装失败，pnpm 报了依赖树相关错误。',
    nextAction: '展开下面的原始输出看 pnpm 的具体错误码；多数需要在开发端修好依赖声明并提交锁文件。',
  },

  // ── 类型检查 / 编译 ───────────────────────────────────────────────
  {
    match: ['error ts'],
    cause: '新代码类型检查没过，编译不出可运行的版本，CDS 已保留旧版本继续运行。',
    nextAction: '展开原始输出看首个 `error TS` 指向的文件和行号，在开发端修好并推送后再更新。',
  },
  {
    match: ['[error]', 'build failed', 'transform failed', 'could not resolve'],
    stages: ['build', 'typecheck'],
    cause: '打包失败，通常是引用了不存在的模块或依赖没装上。',
    nextAction: '展开原始输出看 esbuild/vite 指向的模块名，确认它已在 package.json 声明并提交锁文件。',
  },
];

const STAGE_FALLBACK: Record<SelfUpdateFailureStage, { cause: string; nextAction: string }> = {
  concurrency: {
    cause: '已有一次更新正在进行，本次请求被拒绝以避免两次构建互相串台。',
    nextAction: '等当前那次更新跑完（面板上能看到进度），再发起本次更新。',
  },
  fetch: {
    cause: '拉取远程代码失败，更新在第一步就停住了。',
    nextAction: '展开原始输出看 git 的具体报错；多数是凭据过期或出网异常。',
  },
  gate: {
    cause: '版本切换被防覆盖闸门拦下。',
    nextAction: '按提示补齐切换意图、当前提交 SHA 和原因，或改回快进式更新。',
  },
  checkout: {
    cause: '切换到目标分支失败，代码目录仍停在原分支。',
    nextAction: '展开原始输出确认分支是否存在、工作区是否干净，再重试。',
  },
  reset: {
    cause: '对齐到远程分支失败，本地仓库状态与远程冲突。',
    nextAction: '登录生产机确认 CDS 仓库目录没有需要保留的本地改动，清理后重试。',
  },
  install: {
    cause: '依赖安装失败，新版本没有可用的 node_modules。',
    nextAction: '展开原始输出看 pnpm 的具体错误码；CDS 已保留旧版本继续运行。',
  },
  typecheck: {
    cause: '新代码没通过类型检查，CDS 已中止更新并继续跑旧版本。',
    nextAction: '展开原始输出定位首个报错文件，在开发端修好推送后再更新。',
  },
  build: {
    cause: '新代码编译失败，CDS 已中止更新并继续跑旧版本。',
    nextAction: '展开原始输出定位编译错误，在开发端修好推送后再更新。',
  },
  swap: {
    cause: '新版本产物替换失败，已尝试回滚到旧版本。',
    nextAction: '确认 CDS 当前仍可访问；若已不可用，登录生产机手动恢复上一版产物目录。',
  },
  restart: {
    cause: '更新流程在重启阶段出错。',
    nextAction: '确认 CDS 进程是否已起来；未起来则登录生产机看服务日志。',
  },
  unknown: {
    cause: '更新失败，未能归类到已知的失败形态。',
    nextAction: '展开下面的原始输出定位问题；若反复出现，把这段原文反馈给维护者补充归因规则。',
  },
};

/** 原始输出里最有信息量的那几行——首个 error/fatal 行优先，否则取开头。 */
function condenseRaw(raw: string, limit = 1200): string {
  const trimmed = raw.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n…（已截断，完整输出见执行日志）`;
}

/**
 * 把一次自更新失败收敛成「一个主要原因 + 一条恢复动作 + 原始输出」。
 *
 * 纯函数：不读文件、不发请求、不依赖时间，可直接单测（compute-then-send 的算/发分离）。
 */
export function diagnoseSelfUpdateFailure(input: SelfUpdateFailureInput): SelfUpdateFailureDiagnosis {
  const raw = condenseRaw(input.raw || '');
  const stage = input.stage;

  // 闸门类失败：message 已经是写好的中文，只需要补一条「下一步」。
  if (input.code && GATE_NEXT_ACTIONS[input.code]) {
    return {
      stage,
      cause: (input.message || '').trim() || STAGE_FALLBACK.gate.cause,
      nextAction: GATE_NEXT_ACTIONS[input.code],
      raw,
    };
  }

  const haystack = `${raw}\n${input.message || ''}`.toLowerCase();
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.stages && !pattern.stages.includes(stage)) continue;
    if (!pattern.match.some((needle) => haystack.includes(needle))) continue;
    return { stage, cause: pattern.cause, nextAction: pattern.nextAction, raw };
  }

  const fallback = STAGE_FALLBACK[stage] ?? STAGE_FALLBACK.unknown;
  // 调用点传了中文 message 时优先用它当 cause——它比阶段兜底更具体。
  // 但只在它确实是中文说明时才用：raw 里的英文原文不许升级成主文案。
  const message = (input.message || '').trim();
  const messageIsChinese = /[一-龥]/.test(message);
  return {
    stage,
    cause: messageIsChinese ? message : fallback.cause,
    nextAction: fallback.nextAction,
    raw,
  };
}

/**
 * 兼容旧客户端的单串文案。
 *
 * 老版本前端只读 SSE payload 的 message 字段，看不到 cause/nextAction。
 * 这里把两者拼成一条，保证即使前端没升级，用户看到的也是中文归因而不是英文原文。
 */
export function formatSelfUpdateFailureMessage(diagnosis: SelfUpdateFailureDiagnosis): string {
  return `${diagnosis.cause}\n下一步：${diagnosis.nextAction}`;
}
